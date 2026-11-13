/**
 * QQ 服务工具台 —— Host 半边。
 *
 * 职责：
 * 1. 按顺序托管 SnowLuma 与 qqbridge（只管理自己 spawn 的进程树；外部实例只连接不杀）；
 * 2. 为两个控制台各起一个只监听 127.0.0.1 的受限同源门户（剥离 frame 头 + 注入认证）；
 * 3. 通过 /qq-desk/api/* 把状态、真实终端输出、启停、设置和自动认证暴露给页面；
 * 4. 自动启动绑定宿主生命周期：apply() 时按设置启动，宿主 dispose 时清理。
 *
 * 认证边界（四类凭据不混用）：
 * - SnowLuma WebUI 密码 / 会话令牌 → 宿主 credentials 服务，记录键 qq-service-desk/*
 * - SnowLuma OneBot 令牌 → 只从 SnowLuma config/onebot_*.json 读取，仅用于 /get_status 探测
 * - qqbridge 控制台令牌 → 只从 qq-bridge/config.json 或 state/console-token 读取
 * - DSH 宿主认证 → 不下发、不复制；qqbridge 用 DSH_HOME 自己铸造会话 cookie
 */
import fs from 'node:fs';
import path from 'node:path';
import { SettingsStore } from './lib/settings.js';
import { Supervisor, childEnv } from './lib/supervisor.js';
import { ConsoleProxy, injectSnowLumaToken, readBearer } from './lib/proxy.js';
import { httpRequest, normalizeBaseUrl } from './lib/probe.js';
import * as services from './lib/services.js';
import {
  abortError,
  createRedactor,
  formatDuration,
  isAbort,
  randomToken,
  sleep,
  stripAnsi,
  timeLabel,
  truncate,
  waitFor,
} from './lib/util.js';

export const inject = ['webServer'];

const ROUTE = '/qq-desk';
const HOST_BUILD = '2026-11-13.2';
const PASSWORD_KEY = 'qq-service-desk/snowluma-password';
const SESSION_KEY = 'qq-service-desk/snowluma-session';
const MAX_BODY = 256 * 1024;
const CONSOLE_THEME_SCRIPT = (mode) => `<script data-qq-service-desk="theme">try{if(!localStorage.getItem("snowluma_ui_appearance")){localStorage.setItem("snowluma_ui_appearance",JSON.stringify({mode:${JSON.stringify(mode === 'light' ? 'light' : 'dark')}}))}}catch(e){}</script>`;

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        fail(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        const value = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          reject(Object.assign(new Error('请求体必须是 JSON 对象'), { statusCode: 400 }));
          return;
        }
        resolve(value);
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', fail);
    req.on('aborted', () => fail(Object.assign(new Error('请求中断'), { statusCode: 400 })));
  });
}

function phase(id, label, state = 'pending', detail = '') {
  return { id, label, state, detail };
}

export function apply(ctx) {
  const log = (level, message) => {
    const line = `[qq-service-desk] ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };

  if (!ctx.webServer) {
    log('error', 'webServer 服务不可用，QQ 服务工具台未激活');
    return;
  }

  const dshHome = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
  const dshProfile = process.env.DSH_PROFILE || '';
  const dshOrigin = (() => {
    try {
      return ctx.webServer.getOrigin();
    } catch {
      return 'http://127.0.0.1:3080';
    }
  })();

  const store = new SettingsStore(dshHome);
  const redact = createRedactor();
  let credentials = null;
  try {
    credentials = ctx.get('credentials') || null;
  } catch {
    credentials = null;
  }

  const state = {
    version: 1,
    phase: 'boot',
    startedAt: null,
    autoStart: store.get().autoStart,
    autoStartAt: null,
    userStopped: false,
    overall: { state: 'stopped', text: '未启动', detail: '工具台已就绪，等待启动' },
    phases: [],
    settings: store.get(),
    env: {
      dshHome,
      dshProfile,
      dshOrigin,
      hostBuild: HOST_BUILD,
      portalRoot: dshOrigin + ROUTE,
      nodeVersion: process.versions.node,
      electron: process.versions.electron || null,
      credentialsAvailable: false,
    },
    auth: {
      snowluma: { state: 'unknown', configured: false, note: '尚未检测' },
    },
    snowluma: {
      state: 'stopped',
      managed: false,
      external: false,
      pid: null,
      startedAt: null,
      uptimeMs: null,
      url: store.get().snowLumaUrl,
      portalUrl: null,
      detail: '未启动',
      error: null,
      nextStep: null,
      auth: { state: 'unknown', note: '' },
      onebot: { state: 'unknown', online: false, uin: null, nickname: null, good: null, detail: '' },
      progress: [phase('detect', '检查已有实例'), phase('spawn', '启动进程'), phase('console', '控制台就绪'), phase('onebot', 'OneBot 接口'), phase('qq', 'QQ 登录'), phase('auth', '自动登录')],
      logSeq: 0,
    },
    qqbridge: {
      state: 'stopped',
      managed: false,
      external: false,
      pid: null,
      startedAt: null,
      uptimeMs: null,
      url: store.get().qqBridgeConsoleUrl,
      portalUrl: null,
      detail: '未启动',
      error: null,
      nextStep: null,
      link: { dshReady: false, baseUrl: '', mode: null, note: '' },
      upstream: { connected: false, degraded: null, good: null, accountOnline: null, lastPacketAgoMs: null, hint: null },
      progress: [phase('detect', '检查已有实例'), phase('spawn', '启动进程'), phase('console', '控制台就绪'), phase('link', '连接 DSH 宿主'), phase('upstream', 'SnowLuma 上游')],
      logSeq: 0,
    },
    logRevision: 0,
    updatedAt: Date.now(),
  };

  const sup = {
    snowluma: new Supervisor({ name: 'snowluma', label: 'SnowLuma', maxLines: store.get().logLines, redact }),
    qqbridge: new Supervisor({ name: 'qqbridge', label: 'qqbridge', maxLines: store.get().logLines, redact }),
  };

  const desk = new Desk(ctx, { log, store, state, sup, redact, dshHome, dshProfile, dshOrigin, credentials });
  const disposeProxy = ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: (req, res) => desk.handleHttp(req, res).catch((error) => {
      log('error', `路由处理失败：${error instanceof Error ? error.stack || error.message : String(error)}`);
      if (!res.headersSent) json(res, 500, { ok: false, error: '内部错误' });
      else res.end();
    }),
  });

  const disposers = [disposeProxy];
  disposers.push(ctx.on('dispose', () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* 卸载阶段静默 */
      }
    }
    void desk.dispose();
  }));

  desk.boot();
  log('info', `QQ 服务工具台已挂载：${dshOrigin}${ROUTE}（自动启动=${store.get().autoStart ? '开' : '关'}）`);
}

/* ========================================================================== */

class Desk {
  constructor(ctx, { log, store, state, sup, redact, dshHome, dshProfile, dshOrigin, credentials }) {
    this.ctx = ctx;
    this.log = log;
    this.store = store;
    this.state = state;
    this.sup = sup;
    this.redact = redact;
    this.dshHome = dshHome;
    this.dshProfile = dshProfile;
    this.dshOrigin = dshOrigin;
    this.credentials = credentials;
    this.abort = new AbortController();
    this.queue = Promise.resolve();
    this.busyAction = null;
    this.sseClients = new Set();
    this.pendingLogs = { snowluma: [], qqbridge: [] };
    this.logFlushTimer = null;
    this.pollTimer = null;
    this.stateBroadcastTimer = null;
    this.lastStateJson = '';
    this.detected = { snowlumaConsole: null, snowlumaCheckedAt: 0, onebot: null };
    this.snowToken = '';
    this.shields = {
      snowluma: null,
      qqbridge: null,
    };
    this.gate = randomToken(18);
    this.awaitingQQ = false;
    this.resumeGuard = false;
    this.disposed = false;
    this.lastLoginAttemptAt = 0;
    this.lastAuthCaptureAt = 0;
    this.snowPasswordCache = null;
    this.sessionCache = null;
    this.userTheme = 'dark';
    this.untracked = { snowluma: false, qqbridge: false };
    this.activeToken = null;
    for (const name of ['snowluma', 'qqbridge']) {
      this.sup[name].addListener((event) => this.onSupervisorEvent(name, event));
    }
  }

  /** 就绪等待：超时返回，不抛；failFast 返回原因时立即结束（例如进程已退出）。 */
  async waitUntil(check, { timeoutMs = 30000, intervalMs = 700, signal, failFast } = {}) {
    const startedAt = Date.now();
    for (;;) {
      if (signal?.aborted) throw abortError();
      const value = await check();
      if (value) return { ok: true };
      const failReason = failFast ? failFast() : null;
      if (failReason) return { ok: false, fast: true, detail: failReason };
      if (Date.now() - startedAt >= timeoutMs) return { ok: false, timeout: true, elapsedMs: Date.now() - startedAt };
      await sleep(intervalMs, signal);
    }
  }

  /* ---------- 生命周期 ---------- */

  boot() {
    this.state.env.credentialsAvailable = Boolean(this.getCredentials());
    this.state.settings = this.store.get();
    this.state.autoStart = this.store.get().autoStart;
    this.refreshState('stopped', '未启动', '工具台已就绪，等待启动');
    void this.setupProxies().catch((error) => this.log('warn', `门户初始化失败：${error.message}`));
    this.pollTimer = setInterval(() => void this.poll(), 3000);
    this.pollTimer.unref?.();
    if (this.store.get().autoStart) {
      this.state.autoStartAt = Date.now() + 1200;
      setTimeout(() => {
        if (this.disposed || !this.state.autoStart) return;
        if (this.state.userStopped) return;
        this.log('info', '随客户端自动启动：开始顺序启动 SnowLuma → qqbridge');
        void this.enqueue('auto-start', () => this.startAll('auto'));
      }, 1200).unref?.();
    } else {
      this.state.autoStartAt = null;
    }
    void this.probeIdleState();
  }

  async dispose() {
    this.disposed = true;
    clearInterval(this.pollTimer);
    clearTimeout(this.stateBroadcastTimer);
    if (this.logFlushTimer) clearTimeout(this.logFlushTimer);
    this.abort.abort();
    for (const client of this.sseClients) {
      try {
        client.res.end();
      } catch {
        /* ignore */
      }
    }
    this.sseClients.clear();
    for (const proxy of Object.values(this.shields)) {
      try {
        await proxy?.close();
      } catch {
        /* ignore */
      }
    }
    if (this.store.get().stopOnExit) {
      this.log('info', '宿主退出：按设置停止插件托管的服务（qqbridge → SnowLuma）');
      try {
        await this.sup.qqbridge.stop({ graceMs: 8000 });
      } catch {
        /* ignore */
      }
      try {
        await this.sup.snowluma.stop({ graceMs: 8000 });
      } catch {
        /* ignore */
      }
    } else {
      this.log('info', '宿主退出：设置要求保留服务进程，未执行停止');
    }
    for (const name of ['snowluma', 'qqbridge']) this.sup[name].dispose();
  }

  async probeIdleState() {
    // 宿主刚就绪时先看一眼是否已有外部实例，让 UI 不至于显示"未启动"。
    try {
      const probe = await services.findSnowLumaConsole(this.store.get().snowLumaUrl, { timeoutMs: 800 });
      if (probe.ok) {
        this.detected.snowlumaConsole = probe.url;
        this.state.snowluma.state = 'external';
        this.state.snowluma.external = true;
        this.state.snowluma.managed = false;
        this.state.snowluma.url = probe.url;
        this.state.snowluma.detail = '检测到外部已在运行的 SnowLuma（只连接，不托管）';
        this.setPhase('snowluma', 'detect', 'done', '外部实例');
      }
      const tokenInfo = services.readQQBridgeConsoleToken(this.store.get().qqBridgeDir);
      const presence = await services.probeQQBridgeConsole(this.store.get().qqBridgeConsoleUrl, tokenInfo.token || 'x'.repeat(20), { timeoutMs: 800 });
      if (presence.reason === 'marker-missing' || presence.ok || presence.reason === 'unauthorized') {
      this.state.qqbridge.state = 'external';
        this.state.qqbridge.external = true;
        this.state.qqbridge.detail = '检测到外部已在运行的 qqbridge（只连接，不托管）';
        this.setPhase('qqbridge', 'detect', 'done', '外部实例');
      }
      if ((this.state.snowluma.external || this.state.qqbridge.external) && this.state.overall.state === 'stopped') {
        this.state.overall = { state: 'degraded', text: '已连接外部实例', detail: '检测到外部实例：工具台只连接，不托管、不停止' };
        this.refreshState('degraded', '已连接外部实例', this.state.overall.detail);
      }
      this.broadcastState();
    } catch {
      /* 只是预检，不阻塞 */
    }
  }

  onSupervisorEvent(name, event) {
    if (this.disposed) return;
    if (event.type === 'log') {
      this.state[name].logSeq = this.sup[name].seq;
      this.pendingLogs[name].push(event.line);
      if (!this.logFlushTimer) {
        this.logFlushTimer = setTimeout(() => this.flushLogs(), 80);
        this.logFlushTimer.unref?.();
      }
      return;
    }
    if (event.type === 'status') {
      const snapshot = event.snapshot;
      const target = this.state[name];
      if (snapshot.status === 'starting') {
        target.state = 'starting';
        target.managed = true;
        target.pid = snapshot.pid;
        target.startedAt = snapshot.startedAt;
        target.detail = '进程已启动，等待服务就绪';
      } else if (snapshot.status === 'stopping') {
        target.state = 'stopping';
        target.detail = '正在停止…';
      } else if (snapshot.status === 'exited' || snapshot.status === 'error') {
        target.managed = false;
        target.pid = null;
        target.state = snapshot.status === 'error' ? 'error' : target.state === 'stopping' ? 'stopped' : 'error';
        if (target.state === 'error') {
          target.error = snapshot.error || `进程已退出（code=${snapshot.exit?.code ?? '未知'}）`;
          target.detail = '进程已退出';
          target.nextStep = '查看下方终端输出定位原因，然后点击「启动」重试';
        }
      }
      this.broadcastState();
      return;
    }
    if (event.type === 'clear') {
      this.pendingLogs[name] = [];
      for (const client of this.sseClients) this.sseSend(client, { type: 'clear', name });
      return;
    }
  }

  flushLogs() {
    this.logFlushTimer = null;
    for (const name of ['snowluma', 'qqbridge']) {
      const lines = this.pendingLogs[name].splice(0);
      if (!lines.length) continue;
      this.state[name].logSeq = this.sup[name].seq;
      for (const client of this.sseClients) this.sseSend(client, { type: 'logs', name, lines });
    }
  }

  /* ---------- 状态 / 广播 ---------- */

  setPhase(service, id, state, detail) {
    const list = this.state[service].progress;
    const item = list.find((entry) => entry.id === id);
    if (!item) return;
    item.state = state;
    item.detail = detail || '';
    item.at = Date.now();
  }

  resetPhases(service) {
    this.state[service].progress = this.state[service].progress.map((item) => ({ id: item.id, label: item.label, state: 'pending', detail: '' }));
  }

  refreshState(overallState, text, detail) {
    this.state.overall = { state: overallState, text, detail: detail || '' };
    for (const name of ['snowluma', 'qqbridge']) {
      const svc = this.state[name];
      if (svc.startedAt && svc.state !== 'stopped' && svc.state !== 'error') svc.uptimeMs = Date.now() - svc.startedAt;
      const pid = this.sup[name].pid;
      if (pid) svc.pid = pid;
      svc.managed = Boolean(pid);
      svc.external = Boolean(svc.external && !pid);
    }
    this.state.updatedAt = Date.now();
    this.state.logRevision = (this.state.logRevision || 0) + 1;
    this.broadcastState();
  }

  broadcastState() {
    if (this.disposed) return;
    const payload = { type: 'state', state: this.publicState() };
    const json = JSON.stringify(payload);
    if (json === this.lastStateJson) return;
    this.lastStateJson = json;
    for (const client of this.sseClients) this.sseSend(client, payload);
  }

  sseSend(client, payload) {
    try {
      client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
      return true;
    } catch {
      this.sseClients.delete(client);
      return false;
    }
  }

  /** 顶部启动顺序条：由各服务真实阶段推导，不单独维护第二份真相。 */
  buildSequence() {
    const s = this.state.snowluma;
    const q = this.state.qqbridge;
    const onebotStep = s.progress.find((item) => item.id === 'onebot');
    const qqStep = s.progress.find((item) => item.id === 'qq');
    const linkStep = q.progress.find((item) => item.id === 'link');
    const detectDone = s.progress.find((item) => item.id === 'detect')?.state === 'done'
      || q.progress.find((item) => item.id === 'detect')?.state === 'done';
    const step = (id, label, state, detail = '') => ({ id, label, state, detail });
    const fromService = (state) => {
      if (state === 'running' || state === 'external') return 'done';
      if (state === 'starting' || state === 'stopping') return 'active';
      if (state === 'error') return 'failed';
      if (state === 'waiting-login' || state === 'degraded') return 'waiting';
      return 'pending';
    };
    return [
      step('detect', '检查实例', detectDone ? 'done' : this.state.overall.state === 'starting' ? 'active' : 'pending'),
      step('snowluma', 'SnowLuma', fromService(s.state), s.detail),
      step('onebot', 'OneBot 接口', onebotStep?.state === 'done' ? 'done' : onebotStep?.state || 'pending', s.onebot.detail || ''),
      step('qq', 'QQ 登录', qqStep?.state || 'pending', s.onebot.online ? (s.onebot.nickname || '已登录') : '等待登录'),
      step('qqbridge', 'qqbridge', fromService(q.state), q.detail),
      step(
        'link',
        '桥接连接',
        q.state === 'stopped' || q.state === 'error'
          ? 'pending'
          : (linkStep?.state === 'done' || q.link.dshReady ? 'done' : linkStep?.state || 'pending'),
        q.state === 'stopped' || q.state === 'error'
          ? '等待 qqbridge 启动'
          : (q.link.dshReady ? '已连接当前客户端宿主' : '等待连接'),
      ),
    ];
  }

  publicState() {
    const { settings } = this.store;
    const s = this.state;
    return {
      version: s.version,
      overall: s.overall,
      phases: s.phases,
      sequence: this.buildSequence(),
      autoStart: s.autoStart,
      userStopped: s.userStopped,
      updatedAt: s.updatedAt,
      env: s.env,
      auth: {
        snowluma: {
          state: s.snowluma.auth.state,
          note: s.snowluma.auth.note,
          configured: s.auth.snowluma.configured,
        credentialStore: Boolean(this.getCredentials()),
        },
      },
      snowluma: {
        state: s.snowluma.state,
        managed: s.snowluma.managed,
        external: s.snowluma.external,
        pid: s.snowluma.pid,
        startedAt: s.snowluma.startedAt,
        uptimeMs: s.snowluma.startedAt ? Date.now() - s.snowluma.startedAt : s.snowluma.uptimeMs,
        url: s.snowluma.url,
        portalUrl: s.snowluma.portalUrl,
        detail: s.snowluma.detail,
        error: s.snowluma.error,
        nextStep: s.snowluma.nextStep,
        onebot: s.snowluma.onebot,
        progress: s.snowluma.progress,
        logSeq: s.snowluma.logSeq,
        logCount: this.sup.snowluma.lines.length,
      },
      qqbridge: {
        state: s.qqbridge.state,
        managed: s.qqbridge.managed,
        external: s.qqbridge.external,
        pid: s.qqbridge.pid,
        startedAt: s.qqbridge.startedAt,
        uptimeMs: s.qqbridge.startedAt ? Date.now() - s.qqbridge.startedAt : s.qqbridge.uptimeMs,
        url: s.qqbridge.url,
        portalUrl: s.qqbridge.portalUrl,
        detail: s.qqbridge.detail,
        error: s.qqbridge.error,
        nextStep: s.qqbridge.nextStep,
        link: s.qqbridge.link,
        upstream: s.qqbridge.upstream,
        progress: s.qqbridge.progress,
        logSeq: s.qqbridge.logSeq,
        logCount: this.sup.qqbridge.lines.length,
      },
      settings: {
        snowLumaDir: settings.snowLumaDir,
        qqBridgeDir: settings.qqBridgeDir,
        nodePath: settings.nodePath,
        snowLumaUrl: settings.snowLumaUrl,
        oneBotHttpUrl: settings.oneBotHttpUrl,
        oneBotWsUrl: settings.oneBotWsUrl,
        qqBridgeConsoleUrl: settings.qqBridgeConsoleUrl,
        consolePorts: settings.consolePorts,
        autoStart: settings.autoStart,
        stopOnExit: settings.stopOnExit,
        autoRestart: settings.autoRestart,
        timeouts: settings.timeouts,
        logLines: settings.logLines,
        ui: settings.ui,
      },
      diagnostics: this.diagnostics(),
      busy: this.busyAction,
    };
  }

  diagnostics() {
    const settings = this.store.get();
    let bridgeConfig = null;
    try {
      bridgeConfig = services.readQQBridgeConfig(settings.qqBridgeDir);
    } catch {
      bridgeConfig = null;
    }
    const tokenInfo = services.readQQBridgeConsoleToken(settings.qqBridgeDir);
    return {
      dshHome: this.dshHome,
      dshProfile: this.dshProfile,
      dshOrigin: this.dshOrigin,
      bridgeBaseUrl: bridgeConfig?.dshBaseUrl || null,
      bridgeBaseMatchesHost: bridgeConfig ? normalizeBaseUrl(bridgeConfig.dshBaseUrl) === normalizeBaseUrl(this.dshOrigin) : null,
      bridgeConsoleTokenSource: tokenInfo.source,
      bridgeConsoleTokenPresent: Boolean(tokenInfo.token),
      snowLumaConsoleDetected: this.detected.snowlumaConsole || null,
      oneBotDetected: this.detected.onebot || null,
      snowLumaNodeExists: safeExists(settings.nodePath),
      nodeResolved: resolveNodeCommand(settings).command,
      snowLumaDirExists: safeExists(settings.snowLumaDir),
      qqBridgeDirExists: safeExists(settings.qqBridgeDir),
      snowLumaEntryExists: safeExists(path.join(settings.snowLumaDir, 'index.mjs')),
      qqBridgeEntryExists: safeExists(path.join(settings.qqBridgeDir, 'src', 'bridge.js')),
      snowLumaOneBot: this.describeOneBotConfig(),
      autoStartBridge: bridgeConfig?.autoStartBridge === true,
    };
  }

  describeOneBotConfig() {
    const dir = this.store.get().snowLumaDir;
    try {
      const list = services.readSnowLumaOneBotConfig(dir);
      return list.map((entry) => ({
        uin: entry.uin,
        httpPort: entry.http?.port ?? null,
        httpTokenPresent: Boolean(entry.http?.token),
        wsPort: entry.ws?.port ?? null,
        wsTokenPresent: Boolean(entry.ws?.token),
      }));
    } catch {
      return [];
    }
  }

  get(service) {
    return this.state[service];
  }

  /* ---------- 操作队列 ---------- */

  /**
   * 串行化操作，并让新操作抢占旧操作的等待：
   * 例如自动启动正卡在「等待 QQ 登录」时，用户点「全部停止」必须立刻生效，
   * 而不是排在 5 分钟等待之后。取消只作用于等待/重试，不会误杀进程。
   */
  enqueue(action, task) {
    this.cancelPending(`切换操作：${action}`);
    const previous = this.queue;
    this.busyAction = action;
    this.broadcastState();
    const run = async () => {
      await Promise.race([previous.catch(() => {}), sleep(6000)]);
      if (this.disposed) return { ok: false, error: '插件已卸载' };
      try {
        return await task();
      } catch (error) {
        if (isAbort(error)) return { ok: false, cancelled: true, error: '操作已取消' };
        this.log('error', `${action} 失败：${error instanceof Error ? error.message : String(error)}`);
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      } finally {
        if (this.busyAction === action) this.busyAction = null;
        this.broadcastState();
      }
    };
    this.queue = run();
    return this.queue;
  }

  cancelPending(reason = '已取消') {
    this.abort.abort(abortError());
    this.abort = new AbortController();
    this.awaitingQQ = false;
    if (this.busyAction) this.log('info', `取消进行中的启动等待：${reason}`);
  }

  /* ---------- 门户 ---------- */

  async setupProxies() {
    const settings = this.store.get();
    const snowUrl = this.state.snowluma.url || settings.snowLumaUrl;
    if (!this.shields.snowluma) {
      this.shields.snowluma = new ConsoleProxy({
        name: 'snowluma',
        label: 'SnowLuma',
        upstreamOrigin: snowUrl,
        listenPort: settings.consolePorts.snowluma,
        gate: this.gate,
        redact: this.redact,
        log: this.log,
        extraRequestHeaders: (req) => {
          const headers = {};
          const bearer = readBearer(req.headers);
          if (bearer) {
            headers.authorization = `Bearer ${bearer}`;
            void this.captureSnowLumaToken(bearer);
          } else if (this.snowToken) {
            headers.authorization = `Bearer ${this.snowToken}`;
          }
          return headers;
        },
        rewriteHtml: (html, info) => {
          const hint = info?.url?.searchParams?.get('theme');
          if (hint === 'light' || hint === 'dark') this.userTheme = hint;
          let out = html;
          if (this.snowToken) out = injectSnowLumaToken(out, this.snowToken);
          out = out.replace(/<head[^>]*>/i, (match) => `${match}${CONSOLE_THEME_SCRIPT(this.userTheme)}`);
          return out;
        },
      });
      try {
        const port = await this.shields.snowluma.listen();
        this.state.snowluma.portalUrl = this.shields.snowluma.url;
        this.state.snowluma.portalPort = port;
        this.log('info', `SnowLuma 控制台门户：${this.shields.snowluma.url ? '127.0.0.1:' + port : '未就绪'}`);
      } catch (error) {
        this.log('warn', `SnowLuma 控制台门户监听失败：${error.message}`);
        this.state.snowluma.portalUrl = null;
      }
    } else if (this.state.snowluma.url && this.shields.snowluma.upstream.href !== new URL(this.state.snowluma.url).href) {
      this.shields.snowluma.upstream = new URL(this.state.snowluma.url);
    }

    if (!this.shields.qqbridge) {
      this.shields.qqbridge = new ConsoleProxy({
        name: 'qqbridge',
        label: 'qqbridge',
        upstreamOrigin: settings.qqBridgeConsoleUrl,
        listenPort: settings.consolePorts.qqbridge,
        gate: this.gate,
        redact: this.redact,
        log: this.log,
        extraRequestHeaders: () => {
          const token = services.readQQBridgeConsoleToken(this.store.get().qqBridgeDir).token;
          return token ? { 'x-console-token': token } : {};
        },
        rewriteHtml: (html) => {
          const token = services.readQQBridgeConsoleToken(this.store.get().qqBridgeDir).token;
          if (!token) return html;
          const script = `<script data-qq-service-desk="1">try{localStorage.setItem("consoleToken",${JSON.stringify(token)})}catch(e){}</script>`;
          return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (match) => `${match}${script}`) : `${script}${html}`;
        },
      });
      try {
        const port = await this.shields.qqbridge.listen();
        this.state.qqbridge.portalUrl = this.shields.qqbridge.url;
        this.state.qqbridge.portalPort = port;
        this.log('info', `qqbridge 控制台门户：127.0.0.1:${port}`);
      } catch (error) {
        this.log('warn', `qqbridge 控制台门户监听失败：${error.message}`);
        this.state.qqbridge.portalUrl = null;
      }
    }
    this.broadcastState();
  }

  async rebuildProxies() {
    for (const name of ['snowluma', 'qqbridge']) {
      const proxy = this.shields[name];
      if (!proxy) continue;
      try {
        await proxy.close();
      } catch {
        /* ignore */
      }
      this.shields[name] = null;
      if (name === 'snowluma') this.state.snowluma.portalUrl = null;
      else this.state.qqbridge.portalUrl = null;
    }
    await this.setupProxies();
  }

  async captureSnowLumaToken(token) {
    if (!token || token === this.snowToken) return;
    if (Date.now() - this.lastAuthCaptureAt < 5000) return;
    this.lastAuthCaptureAt = Date.now();
    const auth = await services.snowLumaAuthState(this.currentSnowUrl(), token);
    if (auth.state !== 'ok') return;
    this.snowToken = token;
    this.state.snowluma.auth = { state: 'ok', note: '已复用浏览器会话' };
    this.state.auth.snowluma.state = 'ok';
    await this.saveSessionToken(token);
    this.broadcastState();
  }

  currentSnowUrl() {
    return this.state.snowluma.url || this.store.get().snowLumaUrl;
  }

  /* ---------- SnowLuma ---------- */

  async ensureSnowLuma(ac) {
    const svc = this.state.snowluma;
    const settings = this.store.get();
    this.resetPhases('snowluma');
    this.setPhase('snowluma', 'detect', 'active', '正在检查 127.0.0.1:5099');
    this.refreshState('starting', '启动中', '正在检查 SnowLuma 实例');

    const probe = await services.findSnowLumaConsole(settings.snowLumaUrl, { timeoutMs: 1200, signal: ac.signal });
    if (probe.ok) {
      this.detected.snowlumaConsole = probe.url;
      svc.url = probe.url;
      svc.external = !this.sup.snowluma.pid;
      svc.state = this.sup.snowluma.pid ? 'running' : 'external';
      svc.managed = Boolean(this.sup.snowluma.pid);
      svc.detail = svc.external ? '已连接外部实例' : '运行中';
      this.setPhase('snowluma', 'detect', 'done', svc.external ? '外部实例' : '本插件实例');
      this.setPhase('snowluma', 'spawn', 'done', svc.external ? '无需启动' : '已启动');
      this.setPhase('snowluma', 'console', 'done', probe.url);
      if (this.shields.snowluma) this.shields.snowluma.upstream = new URL(probe.url);
      await this.ensureSnowLumaAuth(ac, probe.url);
      return true;
    }

    // 没有实例：按设置启动（Node 缺失时回退 SnowLuma 自带 node.exe 或 Electron 的 Node 模式）
    const node = resolveNodeCommand(settings);
    if (!safeExists(path.join(settings.snowLumaDir, 'index.mjs'))) throw new Error(`SnowLuma 目录里没有 index.mjs：${settings.snowLumaDir}`);
    this.setPhase('snowluma', 'detect', 'done', '未发现实例');
    const started = this.sup.snowluma.start({
      argv: [node.command, 'index.mjs'],
      cwd: settings.snowLumaDir,
      env: childEnv({
        dshHome: this.dshHome,
        dshProfile: this.dshProfile,
        nodeDir: path.dirname(node.command),
        extra: node.env,
      }),
      label: 'SnowLuma',
    });
    if (!started) throw new Error('SnowLuma 进程已在启动或运行中');
    svc.startedAt = Date.now();
    svc.error = null;
    svc.nextStep = null;
    this.setPhase('snowluma', 'spawn', 'active', `pid=${this.sup.snowluma.pid}`);
    this.refreshState('starting', '启动中', 'SnowLuma 进程已启动，等待控制台监听');

    let detectedUrl = null;
    const ready = await this.waitUntil(async () => {
      const found = await services.findSnowLumaConsole(settings.snowLumaUrl, { timeoutMs: 1200, signal: ac.signal });
      if (found.ok) {
        detectedUrl = found.url;
        return true;
      }
      this.setPhase('snowluma', 'spawn', 'active', `pid=${this.sup.snowluma.pid || '—'} · 等待控制台响应`);
      return false;
    }, {
      timeoutMs: settings.timeouts.snowLumaReadyMs,
      intervalMs: 800,
      signal: ac.signal,
      failFast: () => (this.sup.snowluma.status === 'exited' || this.sup.snowluma.status === 'error'
        ? `进程已退出（code=${this.sup.snowluma.exit?.code ?? '未知'}）`
        : null),
    });

    if (!ready.ok) {
      const tail = this.sup.snowluma.readLines({ tail: true, limit: 12 }).map((line) => line.text).join('\n');
      this.sup.snowluma.markFailed(ready.detail || 'SnowLuma 控制台在超时时间内没有就绪');
      await this.sup.snowluma.stop({ graceMs: settings.timeouts.stopGraceMs });
      svc.state = 'error';
      svc.error = ready.detail || 'SnowLuma 控制台在超时时间内没有就绪';
      svc.detail = '启动失败';
      svc.nextStep = '检查下方终端输出；确认 5099 端口未被占用，然后重试';
      this.setPhase('snowluma', 'console', 'failed', ready.detail || '等待超时');
      this.setPhase('snowluma', 'spawn', 'failed', ready.detail || '启动失败');
      this.refreshState('error', '启动失败', 'SnowLuma 控制台未能就绪');
      throw new Error(`SnowLuma 控制台未能就绪${tail ? `\n${truncate(tail, 600)}` : ''}`);
    }

    this.detected.snowlumaConsole = detectedUrl;
    svc.url = detectedUrl;
    svc.state = 'running';
    svc.managed = true;
    svc.external = false;
    svc.error = null;
    svc.detail = '运行中';
    this.setPhase('snowluma', 'spawn', 'done', `pid=${this.sup.snowluma.pid}`);
    this.setPhase('snowluma', 'console', 'done', detectedUrl);
    this.sup.snowluma.markRunning();
    if (this.shields.snowluma) this.shields.snowluma.upstream = new URL(detectedUrl);
    this.refreshState('starting', '启动中', 'SnowLuma 控制台已就绪，检测 OneBot 与登录状态');
    await this.ensureSnowLumaAuth(ac, detectedUrl);
    return true;
  }

  /* ---------- SnowLuma 认证 ---------- */

  async ensureSnowLumaAuth(ac, url) {
    const svc = this.state.snowluma;
    this.setPhase('snowluma', 'auth', 'active', '读取已保存的会话/密码');
    // 1) 复用浏览器会话令牌
    const session = await this.readRecord(SESSION_KEY);
    const tokenCandidate = this.snowToken || (typeof session?.payload?.token === 'string' ? session.payload.token : '');
    if (tokenCandidate) {
      const auth = await services.snowLumaAuthState(url, tokenCandidate, { signal: ac.signal });
      if (auth.state === 'ok') {
        this.snowToken = tokenCandidate;
        this.redact.add(tokenCandidate);
        svc.auth = { state: 'ok', note: '已复用有效会话' };
        this.state.auth.snowluma = { ...this.state.auth.snowluma, state: 'ok', configured: Boolean((await this.readRecord(PASSWORD_KEY))?.payload?.secret) };
        this.setPhase('snowluma', 'auth', 'done', '已复用会话');
        return { ok: true, reused: true };
      }
      if (auth.state === 'unauthorized') {
        this.snowToken = '';
        await this.deleteRecord(SESSION_KEY);
      }
    }
    // 2) 已保存密码 → 自动登录（失败不重试，避免触发 5 次/15 分钟锁定）
    const passwordRecord = await this.readRecord(PASSWORD_KEY);
    const password = typeof passwordRecord?.payload?.secret === 'string' ? passwordRecord.payload.secret : '';
    const configured = Boolean(password);
    this.state.auth.snowluma.configured = configured;
    if (password) {
      this.setPhase('snowluma', 'auth', 'active', '用已保存密码登录');
      const result = await services.snowLumaLogin(url, password, { signal: ac.signal });
      if (result.ok) {
        this.snowToken = result.token;
        this.redact.add(result.token);
        await this.saveSessionToken(result.token);
        svc.auth = { state: 'ok', note: '已用保存的密码自动登录' };
        this.state.auth.snowluma = { ...this.state.auth.snowluma, state: 'ok', configured: true };
        this.setPhase('snowluma', 'auth', 'done', '自动登录成功');
        this.broadcastState();
        return { ok: true };
      }
      const kind = result.kind || 'error';
      const note = kind === 'bad-password'
        ? '保存的密码不正确（控制台会因连续失败锁定 15 分钟，已停止自动重试）'
        : kind === 'rate-limited'
          ? '登录尝试过多，SnowLuma 已暂时锁定，请稍后在控制台手动登录'
          : kind === 'totp'
            ? '该控制台启用了二次验证，需要在控制台内手动完成'
            : `自动登录失败：${result.message || kind}`;
      svc.auth = { state: 'needed', note };
      this.state.auth.snowluma = { ...this.state.auth.snowluma, state: 'needed', note, configured: true };
      this.setPhase('snowluma', 'auth', 'waiting', note);
      this.broadcastState();
      return { ok: false, kind, note };
    }
    // 3) 没有密码 → 等待用户在控制台登录（门户可手动登录，登录后会被捕获复用）
    svc.auth = { state: 'needed', note: '尚未保存 SnowLuma 密码；请在控制台登录，或在设置里录入密码' };
    this.state.auth.snowluma = { ...this.state.auth.snowluma, state: 'needed', note: svc.auth.note, configured: false };
    this.setPhase('snowluma', 'auth', 'waiting', '等待登录');
    this.broadcastState();
    return { ok: false, kind: 'no-password' };
  }

  /* ---------- OneBot / QQ 登录 ---------- */

  resolveOneBot() {
    const settings = this.store.get();
    const bridgeCfg = services.readQQBridgeConfig(settings.qqBridgeDir);
    const list = services.readSnowLumaOneBotConfig(settings.snowLumaDir);
    // 优先 qqbridge 的 ownerQQ（机器人实际服务账号），其余作为候选令牌依次尝试；
    // SnowLuma 会按当前登录账号使用对应 onebot_*.json，插件不假定是哪一份。
    const preferredUin = bridgeCfg.ownerQQ ? String(bridgeCfg.ownerQQ) : null;
    const ordered = preferredUin
      ? [...list].sort((a, b) => (a.uin === preferredUin ? -1 : 0) - (b.uin === preferredUin ? -1 : 0))
      : list;
    const chosen = ordered[0] || null;
    const tokens = [...new Set(ordered.map((entry) => entry.http?.token).filter(Boolean))];
    if (bridgeCfg.snowluma?.accessToken && !tokens.includes(bridgeCfg.snowluma.accessToken)) tokens.push(bridgeCfg.snowluma.accessToken);
    return {
      httpUrl: chosen?.http ? `http://${chosen.http.host}:${chosen.http.port}` : settings.oneBotHttpUrl,
      wsUrl: chosen?.ws ? `ws://${chosen.ws.host}:${chosen.ws.port}` : settings.oneBotWsUrl,
      tokens,
      token: tokens[0] || '',
      uin: preferredUin || chosen?.uin || null,
      candidates: ordered.map((entry) => entry.uin),
      source: list.length ? 'config/onebot_*.json' : 'settings',
    };
  }

  async readOneBotStatus(ac) {
    const target = this.resolveOneBot();
    let status = { ok: false, online: false, message: '没有可用的 OneBot 令牌' };
    for (const token of target.tokens) {
      const attempt = await services.oneBotStatus(target.httpUrl, token, { signal: ac?.signal, timeoutMs: 3000 });
      status = attempt;
      if (attempt.ok) break;
      if (!attempt.offline) continue;
    }
    this.detected.onebot = {
      httpUrl: target.httpUrl,
      wsUrl: target.wsUrl,
      uin: status.uin ?? target.uin,
      nickname: status.nickname ?? null,
      ok: Boolean(status.ok),
      online: Boolean(status.online),
      offline: Boolean(status.offline),
      message: status.message || '',
      candidates: target.candidates,
      checkedAt: Date.now(),
    };
    const svc = this.state.snowluma;
    if (status.ok) {
      svc.onebot = {
        state: status.online ? 'online' : 'offline',
        online: Boolean(status.online),
        good: status.good !== false,
        uin: status.uin ?? target.uin,
        nickname: status.nickname ?? null,
        detail: status.online ? 'QQ 已登录' : 'OneBot 已就绪，但 QQ 未登录',
        httpUrl: target.httpUrl,
      };
      for (const token of target.tokens) this.redact.add(token);
    } else {
      svc.onebot = {
        state: status.offline ? 'waiting' : 'error',
        online: false,
        good: null,
        uin: target.uin,
        nickname: null,
        detail: status.offline ? 'OneBot HTTP 尚未监听（QQ 未登录或尚未启动）' : `OneBot 探测失败：${status.message || status.status}`,
        httpUrl: target.httpUrl,
      };
    }
    this.broadcastState();
    return svc.onebot;
  }

  applyOneBotPhase(onebot) {
    this.setPhase('snowluma', 'onebot', onebot.state === 'online' ? 'done' : 'active', onebot.detail);
    this.setPhase('snowluma', 'qq', onebot.online ? 'done' : 'waiting', onebot.online ? (onebot.nickname || '已登录') : '等待扫码/登录');
  }

  /* ---------- qqbridge ---------- */

  async ensureQQBridge(ac) {
    const svc = this.state.qqbridge;
    const settings = this.store.get();
    this.resetPhases('qqbridge');
    this.setPhase('qqbridge', 'detect', 'active', '检查控制台 3100');
    this.refreshState('starting', '启动中', '正在检查 qqbridge 实例');

    const tokenBefore = services.readQQBridgeConsoleToken(settings.qqBridgeDir);
    const presence = await services.probeQQBridgeConsole(settings.qqBridgeConsoleUrl, tokenBefore.token || 'x'.repeat(24), { timeoutMs: 1200, signal: ac.signal });
    const portAlive = presence.reason !== 'offline';
    if (tokenBefore.token && (presence.ok || presence.reason === 'unauthorized' || presence.reason === 'marker-missing')) {
      svc.state = this.sup.qqbridge.pid ? 'running' : 'external';
      svc.external = !this.sup.qqbridge.pid;
      svc.managed = Boolean(this.sup.qqbridge.pid);
      svc.detail = svc.external ? '已连接外部实例' : '运行中';
      this.setPhase('qqbridge', 'detect', 'done', svc.external ? '外部实例' : '本插件实例');
      this.setPhase('qqbridge', 'spawn', 'done', svc.external ? '无需启动' : '已启动');
      this.setPhase('qqbridge', 'console', 'done', settings.qqBridgeConsoleUrl);
      await this.finishQQBridge(ac);
      return true;
    }
    if (!tokenBefore.token && portAlive) {
      // 端口上确实有控制台，但令牌文件还没出现：等桥接把令牌落盘
      const tokenWait = await waitFor(() => Boolean(services.readQQBridgeConsoleToken(settings.qqBridgeDir).token), {
        timeoutMs: 8000,
        intervalMs: 400,
        signal: ac.signal,
      });
      if (!tokenWait.ok) throw new Error('qqbridge 控制台在监听，但读不到控制台令牌（config.consoleToken / state/console-token）');
      this.setPhase('qqbridge', 'detect', 'done', '发现外部实例并读取到令牌');
      svc.external = true;
      svc.state = 'external';
      this.setPhase('qqbridge', 'console', 'done', settings.qqBridgeConsoleUrl);
      await this.finishQQBridge(ac);
      return true;
    }

    const node = resolveNodeCommand(settings);
    if (!safeExists(path.join(settings.qqBridgeDir, 'src', 'bridge.js'))) throw new Error(`qqbridge 目录里没有 src/bridge.js：${settings.qqBridgeDir}`);
    this.setPhase('qqbridge', 'detect', 'done', '未发现实例');
    const started = this.sup.qqbridge.start({
      argv: [node.command, path.join('src', 'bridge.js')],
      cwd: settings.qqBridgeDir,
      env: childEnv({
        dshHome: this.dshHome,
        dshProfile: this.dshProfile,
        nodeDir: path.dirname(node.command),
        extra: node.env,
      }),
      label: 'qqbridge',
    });
    if (!started) throw new Error('qqbridge 进程已在启动或运行中');
    svc.startedAt = Date.now();
    svc.error = null;
    svc.nextStep = null;
    this.setPhase('qqbridge', 'spawn', 'active', `pid=${this.sup.qqbridge.pid}`);
    this.refreshState('starting', '启动中', 'qqbridge 进程已启动，等待控制台与令牌就绪');

    const ready = await this.waitUntil(async () => {
      const info = services.readQQBridgeConsoleToken(settings.qqBridgeDir);
      if (!info.token) {
        const raw = await services.probeQQBridgeConsole(settings.qqBridgeConsoleUrl, 'x'.repeat(24), { timeoutMs: 800, signal: ac.signal });
        if (raw.reason === 'offline' && (this.sup.qqbridge.status === 'exited' || this.sup.qqbridge.status === 'error')) return false;
        return false;
      }
      const probe = await services.probeQQBridgeConsole(settings.qqBridgeConsoleUrl, info.token, { timeoutMs: 1000, signal: ac.signal });
      if (probe.ok) return true;
      return false;
    }, {
      timeoutMs: settings.timeouts.qqBridgeReadyMs,
      intervalMs: 700,
      signal: ac.signal,
      failFast: () => (this.sup.qqbridge.status === 'exited' || this.sup.qqbridge.status === 'error'
        ? `进程已退出（code=${this.sup.qqbridge.exit?.code ?? '未知'}）`
        : null),
    });

    if (!ready.ok) {
      const tail = this.sup.qqbridge.readLines({ tail: true, limit: 14 }).map((line) => line.text).join('\n');
      this.sup.qqbridge.markFailed(ready.detail || 'qqbridge 控制台在超时时间内没有就绪');
      await this.sup.qqbridge.stop({ graceMs: settings.timeouts.stopGraceMs });
      svc.state = 'error';
      svc.error = ready.detail || 'qqbridge 控制台在超时时间内没有就绪';
      svc.detail = '启动失败';
      svc.nextStep = '检查下方终端；若日志提示「控制台端口已被占用 / 已有实例在运行」，说明存在旧实例，请先结束它';
      this.setPhase('qqbridge', 'console', 'failed', ready.detail || '等待超时');
      this.setPhase('qqbridge', 'spawn', 'failed', ready.detail || '启动失败');
      this.refreshState('error', '启动失败', 'qqbridge 控制台未能就绪');
      throw new Error(`qqbridge 控制台未能就绪${tail ? `\n${truncate(tail, 600)}` : ''}`);
    }

    svc.state = 'running';
    svc.managed = true;
    svc.external = false;
    svc.detail = '运行中';
    svc.error = null;
    this.setPhase('qqbridge', 'spawn', 'done', `pid=${this.sup.qqbridge.pid}`);
    this.setPhase('qqbridge', 'console', 'done', settings.qqBridgeConsoleUrl);
    this.sup.qqbridge.markRunning();
    await this.finishQQBridge(ac);
    return true;
  }

  async finishQQBridge(ac) {
    const settings = this.store.get();
    this.refreshState('starting', '启动中', '检测 qqbridge 与当前客户端的连接');
    this.setPhase('qqbridge', 'link', 'active', '等待 DSH 宿主链路');
    const token = services.readQQBridgeConsoleToken(settings.qqBridgeDir).token;
    const result = await waitFor(async () => {
      const status = await services.qqBridgeStatus(settings.qqBridgeConsoleUrl, token, { signal: ac.signal });
      if (!status.ok) return false;
      this.applyBridgeStatus(status, token);
      return status.dshReady ? true : false;
    }, {
      timeoutMs: settings.timeouts.bridgeLinkMs,
      intervalMs: 1500,
      signal: ac.signal,
      onTick: () => this.setPhase('qqbridge', 'link', 'active', 'qqbridge 已启动，等待连上 DSH 宿主'),
    });
    if (!result.ok) {
      const bridgeCfg = services.readQQBridgeConfig(settings.qqBridgeDir);
      this.setPhase('qqbridge', 'link', 'failed', '未能连上 DSH 宿主');
      this.state.qqbridge.state = 'degraded';
      this.state.qqbridge.error = '桥接没有连上当前 DSH 宿主';
      this.state.qqbridge.detail = '连接异常：DSH 未就绪';
      this.state.qqbridge.nextStep = `确认 qqbridge/config.json 的 dsh.baseUrl 为 ${this.dshOrigin}，且插件以 DSH_HOME=${this.dshHome} 启动桥接`;
      this.state.qqbridge.link = {
        dshReady: false,
        baseUrl: bridgeCfg.dshBaseUrl || null,
        mode: null,
        note: `宿主认证依赖 DSH_HOME 里的会话签名密钥；当前插件托管环境 DSH_HOME=${this.dshHome}`,
      };
      this.refreshState('degraded', '连接异常', 'qqbridge 未连上当前客户端宿主');
      return false;
    }
    this.setPhase('qqbridge', 'link', 'done', 'DSH 已连接');
    const upstream = this.state.qqbridge.upstream;
    const upstreamBad = upstream.connected !== true || upstream.degraded === true || upstream.accountOnline === false;
    this.setPhase('qqbridge', 'upstream', upstreamBad ? 'failed' : 'done', upstreamBad
      ? (upstream.connected !== true ? '尚未连上 SnowLuma' : upstream.degraded ? 'SnowLuma 接收链路异常' : 'QQ 未登录')
      : 'SnowLuma 上游正常');
    if (upstreamBad) {
      this.state.qqbridge.state = 'degraded';
      this.state.qqbridge.detail = upstream.connected !== true ? '连接异常：尚未连上 SnowLuma' : '连接异常：SnowLuma 上游未就绪';
      this.state.qqbridge.nextStep = upstream.connected !== true
        ? 'SnowLuma 的 OneBot WS（3001）还没起来：先在 SnowLuma 控制台完成 QQ 进程注入/登录'
        : (upstream.hint || '在 SnowLuma 控制台确认 QQ 已登录且接收链路正常');
      this.refreshState('degraded', '连接异常', '桥接已连接 DSH，但 SnowLuma 上游未就绪');
      return false;
    }
    this.state.qqbridge.state = 'running';
    this.state.qqbridge.detail = '运行中';
    this.state.qqbridge.error = null;
    this.state.qqbridge.nextStep = null;
    this.refreshState('running', '运行中', 'SnowLuma 与 qqbridge 均已就绪');
    return true;
  }

  applyBridgeStatus(status, token) {
    const svc = this.state.qqbridge;
    const settings = this.store.get();
    const bridgeCfg = services.readQQBridgeConfig(settings.qqBridgeDir);
    svc.link = {
      dshReady: Boolean(status.dshReady),
      baseUrl: bridgeCfg.dshBaseUrl || null,
      mode: status.mode ?? null,
      note: status.dshReady ? '已连接当前 DSH 客户端宿主' : '尚未连接 DSH 宿主',
    };
    const sl = status.snowluma || null;
    svc.upstream = {
      connected: sl?.connected === true,
      degraded: sl?.degraded === true,
      good: sl?.good ?? null,
      accountOnline: sl?.accountOnline ?? null,
      lastPacketAgoMs: sl?.lastPacketAgoMs ?? null,
      hint: sl?.hint ?? null,
    };
    if (token) this.redact.add(token);
    if (sl) {
      this.state.snowluma.onebot.online = sl.accountOnline === true;
      if (sl.accountOnline === true) this.state.snowluma.onebot.state = 'online';
      else if (sl.connected === true) this.state.snowluma.onebot.state = 'offline';
    }
    if (status.dshReady && !svc.progress.find((p) => p.id === 'link')?.at) this.setPhase('qqbridge', 'link', 'active', 'DSH 已连接');
    this.broadcastState();
  }

  /* ---------- 总流程 ---------- */

  async startAll(trigger = 'manual') {
    if (this.disposed) return { ok: false, error: '插件已卸载' };
    const ac = this.abort;
    this.state.userStopped = false;
    this.state.startedAt = Date.now();
    this.state.overall = { state: 'starting', text: '启动中', detail: '按顺序启动 SnowLuma → 检测 OneBot/QQ → 启动 qqbridge' };
    this.refreshState('starting', '启动中', '开始顺序启动');
    try {
      await this.ensureSnowLuma(ac);
      const onebot = await this.readOneBotStatus(ac);
      this.applyOneBotPhase(onebot);
      if (!onebot.online) {
        this.awaitingQQ = true;
        this.state.snowluma.state = 'waiting-login';
        this.state.snowluma.detail = '等待 QQ 登录';
        this.state.snowluma.nextStep = 'SnowLuma 尚未接管 QQ：请在 SnowLuma 控制台「进程注入」里加载已登录的 QQ 进程，或在 QQ 客户端完成登录；登录成功后会自动继续启动 qqbridge';
        this.state.overall = { state: 'waiting-login', text: '等待登录', detail: 'SnowLuma 已就绪，等待 QQ 登录后自动继续启动 qqbridge' };
        this.setPhase('snowluma', 'qq', 'waiting', '等待 QQ 登录');
        this.setPhase('snowluma', 'onebot', onebot.state === 'online' ? 'done' : 'active', onebot.detail);
        this.refreshState('waiting-login', '等待登录', this.state.overall.detail);
        this.log('info', '等待 QQ 登录；检测到登录后会自动继续启动 qqbridge（可随时手动停止）');
        return { ok: false, waiting: true, message: '等待 QQ 登录' };
      }
      await this.ensureQQBridge(ac);
      const ok = this.state.overall.state === 'running';
      this.log('info', `启动序列结束：${this.state.overall.text}`);
      return { ok, state: this.state.overall };
    } catch (error) {
      if (isAbort(error)) return { ok: false, cancelled: true };
      this.state.overall = { state: 'error', text: '启动失败', detail: error.message || String(error) };
      this.refreshState('error', '启动失败', error.message || String(error));
      return { ok: false, error: error.message || String(error) };
    }
  }

  async startService(service) {
    if (this.disposed) return { ok: false, error: '插件已卸载' };
    if (!['snowluma', 'qqbridge'].includes(service)) return { ok: false, error: '未知服务' };
    if (service === 'snowluma') {
      if (this.state.snowluma.state === 'running' || this.state.snowluma.state === 'starting' || this.state.snowluma.state === 'external') {
        return { ok: true, already: true, state: this.state.snowluma };
      }
      const ac = this.abort;
      this.state.userStopped = false;
      this.state.snowluma.auth.state = this.state.snowluma.auth.state === 'failed' ? 'unknown' : this.state.snowluma.auth.state;
      try {
        const ok = await this.ensureSnowLuma(ac);
        const onebot = await this.readOneBotStatus(ac);
        this.applyOneBotPhase(onebot);
        let qq = onebot.online;
        if (!qq) {
          this.awaitingQQ = true;
          this.state.snowluma.state = 'waiting-login';
          this.state.snowluma.detail = '等待 QQ 登录';
          this.state.snowluma.nextStep = '在 SnowLuma 控制台完成 QQ 进程注入/登录；登录成功后会自动继续';
        } else {
          this.awaitingQQ = false;
        }
        this.state.overall = { state: qq ? 'starting' : 'waiting-login', text: qq ? '启动中' : '等待登录', detail: qq ? 'SnowLuma 已就绪' : 'SnowLuma 已就绪，等待 QQ 登录' };
        this.refreshState(this.state.overall.state, this.state.overall.text, this.state.overall.detail);
        return { ok, waiting: !qq };
      } catch (error) {
        this.state.overall = { state: 'error', text: '启动失败', detail: error.message };
        this.refreshState('error', '启动失败', error.message);
        return { ok: false, error: error.message };
      }
    }
    if (this.state.qqbridge.state === 'running' || this.state.qqbridge.state === 'starting' || this.state.qqbridge.state === 'external') {
      return { ok: true, already: true, state: this.state.qqbridge };
    }
    const qqOnline = this.state.snowluma.onebot.online === true;
    const ac = this.abort;
    this.state.userStopped = false;
    try {
      await this.ensureQQBridge(ac);
      return {
        ok: this.state.qqbridge.state === 'running',
        warning: qqOnline ? null : 'QQ 尚未登录；qqbridge 已启动，但会持续处于连接异常状态直到 SnowLuma 上游恢复',
        state: this.state.qqbridge,
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async stopAll(reason = 'manual') {
    if (this.disposed) return { ok: false, error: '插件已卸载' };
    this.state.userStopped = true;
    this.awaitingQQ = false;
    this.refreshState('stopping', '停止中', '先停 qqbridge，再停 SnowLuma');
    this.state.qqbridge.state = 'stopping';
    this.state.qqbridge.detail = '正在停止…';
    const bridgeStop = await this.stopServiceProcess('qqbridge');
    this.state.snowluma.state = 'stopping';
    this.state.snowluma.detail = '正在停止…';
    const snowStop = await this.stopServiceProcess('snowluma');
    const external = [];
    if (bridgeStop.external) external.push('qqbridge');
    if (snowStop.external) external.push('SnowLuma');
    for (const name of ['snowluma', 'qqbridge']) {
      const svc = this.state[name];
      if (external.includes(name === 'snowluma' ? 'SnowLuma' : 'qqbridge')) {
        svc.state = 'external';
        svc.detail = '外部实例仍在运行（工具台不会停止非本插件启动的进程）';
        svc.managed = false;
        svc.pid = null;
        continue;
      }
      this.resetPhases(name);
      this.state[name].state = 'stopped';
      this.state[name].detail = '已停止（手动）';
      this.state[name].error = null;
      this.state[name].nextStep = null;
      this.state[name].pid = null;
      this.state[name].managed = false;
      this.state[name].startedAt = null;
      this.state[name].uptimeMs = null;
      this.state[name].external = false;
      this.state[name].logSeq = this.sup[name].seq;
    }
    this.state.snowluma.auth = { state: 'unknown', note: '' };
    this.state.qqbridge.link = { dshReady: false, baseUrl: this.state.qqbridge.link.baseUrl, mode: null, note: '' };
    if (external.length) {
      this.state.overall = { state: 'degraded', text: '已连接外部实例', detail: `已停止插件托管的进程；外部实例仍在运行：${external.join('、')}` };
      this.refreshState('degraded', '已连接外部实例', this.state.overall.detail);
    } else {
      this.state.overall = { state: 'stopped', text: '已停止', detail: '手动停止后不会自动重启；需要时请再次点击启动' };
      this.refreshState('stopped', '已停止', '手动停止后保持停止，不会自动拉起');
    }
    this.log('info', '全部停止完成（qqbridge → SnowLuma），等待用户再次启动');
    return { ok: true, external };
  }

  async stopServiceProcess(service) {
    const svc = this.state[service];
    if (svc.external && !this.sup[service].pid) {
      svc.detail = '外部实例：工具台不会停止非本插件启动的进程';
      this.log('warn', `${service} 是外部实例，按约定不停止`);
      return { ok: false, external: true };
    }
    const settings = this.store.get();
    const result = await this.sup[service].stop({ graceMs: settings.timeouts.stopGraceMs });
    svc.managed = false;
    svc.pid = null;
    return result;
  }

  async restartService(service) {
    this.awaitingQQ = false;
    if (service === 'qqbridge') {
      await this.stopServiceProcess('qqbridge');
      this.state.qqbridge.state = 'stopped';
      this.refreshState('stopping', '停止中', 'qqbridge 已停止，准备重启');
      const ac = this.abort;
      await this.ensureQQBridge(ac);
      return { ok: this.state.qqbridge.state === 'running' };
    }
    await this.stopServiceProcess('snowluma');
    const ac = this.abort;
    const ok = await this.ensureSnowLuma(ac);
    const onebot = await this.readOneBotStatus(ac);
    this.applyOneBotPhase(onebot);
    const qq = onebot.online;
    if (!qq) {
      this.awaitingQQ = true;
      this.state.snowluma.state = 'waiting-login';
      this.state.overall = { state: 'waiting-login', text: '等待登录', detail: 'SnowLuma 已重启，等待 QQ 登录' };
      this.refreshState('waiting-login', '等待登录', this.state.overall.detail);
    } else if (this.state.qqbridge.state === 'degraded' || this.state.qqbridge.state === 'stopped') {
      await this.ensureQQBridge(ac);
    }
    return { ok, waiting: !qq };
  }

  /* ---------- 轮询 ---------- */

  async poll() {
    if (this.disposed || this.state.overall.state === 'stopping') return;
    const settings = this.store.get();
    const busy = Boolean(this.busyAction);
    try {
      // SnowLuma：仅在进程存在或外部实例时探测
      const snowRunning = this.sup.snowluma.pid !== null || ['running', 'external', 'degraded', 'waiting-login'].includes(this.state.snowluma.state);
      if (snowRunning && !busy) {
        if (!this.detected.snowlumaConsole) {
          const probe = await services.findSnowLumaConsole(settings.snowLumaUrl, { timeoutMs: 800 });
          if (probe.ok) {
            this.detected.snowlumaConsole = probe.url;
            this.state.snowluma.url = probe.url;
            if (this.shields.snowluma) this.shields.snowluma.upstream = new URL(probe.url);
          }
        } else {
          const alive = await httpRequest(this.detected.snowlumaConsole, { timeoutMs: 900, maxBody: 64 * 1024 });
          if (!alive.ok) {
            if (this.state.snowluma.external && !this.sup.snowluma.pid) {
              this.state.snowluma.state = 'stopped';
              this.state.snowluma.external = false;
              this.state.snowluma.detail = '外部实例已退出';
              this.detected.snowlumaConsole = null;
              this.refreshState(this.computeOverall(), this.overallText(), 'SnowLuma 外部实例已退出');
            } else if (this.sup.snowluma.status === 'exited') {
              this.state.snowluma.state = 'error';
              this.state.snowluma.error = 'SnowLuma 进程已退出';
              this.state.snowluma.nextStep = '查看终端输出后重启';
            }
          }
        }
        const onebot = await this.readOneBotStatus(this.abort);
        if (this.awaitingQQ && onebot.state === 'online' && !this.resumeGuard && !this.state.userStopped) {
          this.resumeGuard = true;
          setTimeout(() => {
            this.resumeGuard = false;
            if (this.disposed || this.state.userStopped) return;
            this.log('info', '检测到 QQ 已登录，自动继续启动 qqbridge');
            this.awaitingQQ = false;
            this.state.snowluma.state = 'running';
            this.state.snowluma.detail = '运行中';
            this.state.snowluma.nextStep = null;
            this.applyOneBotPhase(onebot);
            this.state.overall = { state: 'starting', text: '启动中', detail: 'QQ 已登录，正在启动 qqbridge' };
            this.refreshState('starting', '启动中', this.state.overall.detail);
            void this.enqueue('resume-after-login', () => this.ensureQQBridge(this.abort));
          }, 300).unref?.();
        }
      }
      // qqbridge：仅在运行/外部/异常时探测
      const bridgeAlive = this.sup.qqbridge.pid !== null || ['running', 'external', 'degraded'].includes(this.state.qqbridge.state);
      if (bridgeAlive && !busy && !this.state.qqbridge.externalStopped) {
        const token = services.readQQBridgeConsoleToken(settings.qqBridgeDir).token;
        const status = await services.qqBridgeStatus(settings.qqBridgeConsoleUrl, token, { timeoutMs: 2500 });
          if (status.ok) {
          this.applyBridgeStatus(status, token);
          if (!status.dshReady && this.state.qqbridge.state === 'running') {
            this.state.qqbridge.state = 'degraded';
            this.state.qqbridge.detail = '连接异常：DSH 链路中断';
            this.state.qqbridge.nextStep = '等待桥接自动重连；若持续失败，检查 DSH_HOME 与 dsh.baseUrl';
            this.setPhase('qqbridge', 'link', 'failed', 'DSH 链路中断');
            this.refreshState(this.computeOverall(), this.overallText(), 'qqbridge 与 DSH 的连接中断');
          } else if (status.dshReady
            && status.snowluma?.connected === true
            && status.snowluma?.degraded !== true
            && status.snowluma?.accountOnline !== false
            && this.state.qqbridge.state === 'degraded') {
            this.state.qqbridge.state = 'running';
            this.state.qqbridge.detail = '运行中';
            this.state.qqbridge.nextStep = null;
            this.setPhase('qqbridge', 'link', 'done', 'DSH 已连接');
            this.setPhase('qqbridge', 'upstream', 'done', 'SnowLuma 上游正常');
            this.refreshState(this.computeOverall(), this.overallText(), '服务恢复正常');
          } else if (status.dshReady
            && (status.snowluma?.connected !== true || status.snowluma?.degraded === true || status.snowluma?.accountOnline === false)
            && this.state.qqbridge.state === 'running') {
            this.state.qqbridge.state = 'degraded';
            this.state.qqbridge.detail = '连接异常：SnowLuma 上游未就绪';
            this.state.qqbridge.nextStep = status.snowluma?.hint || '确认 SnowLuma 已接管 QQ 且接收链路正常';
            this.setPhase('qqbridge', 'upstream', 'failed', 'SnowLuma 上游未就绪');
            this.refreshState(this.computeOverall(), this.overallText(), 'SnowLuma 上游未就绪，桥接暂不可用');
          }
        } else if (status.reason === 'offline') {
          if (this.sup.qqbridge.status === 'exited') {
            this.state.qqbridge.state = 'error';
            this.state.qqbridge.error = 'qqbridge 进程已退出';
            this.state.qqbridge.nextStep = '查看终端输出后重启';
            if (this.state.overall.state === 'running') this.refreshState('error', '连接异常', 'qqbridge 已退出');
          } else if (this.state.qqbridge.external && !this.sup.qqbridge.pid) {
            this.state.qqbridge.state = 'stopped';
            this.state.qqbridge.external = false;
            this.state.qqbridge.detail = '外部实例已退出';
            this.refreshState(this.computeOverall(), this.overallText(), 'qqbridge 外部实例已退出');
          }
          this.state.qqbridge.link.dshReady = false;
        }
      }
      // 整体状态
      this.recomputeOverall();
    } catch (error) {
      if (!isAbort(error)) this.log('warn', `状态轮询失败：${error.message}`);
    }
  }

  computeOverall() {
    const s = this.state.snowluma;
    const q = this.state.qqbridge;
    if (this.state.overall.state === 'stopped' && !s.managed && !q.managed) return 'stopped';
    if (s.state === 'error' || q.state === 'error') return 'error';
    if (q.state === 'degraded') return 'degraded';
    if (q.state === 'running' && s.onebot.online) return 'running';
    if (s.state === 'waiting-login' || this.awaitingQQ) return 'waiting-login';
    if (s.state === 'external' || q.state === 'external') return 'degraded';
    // 只停掉其中一个服务时，不应继续显示「启动中/运行中」。
    if ((s.state === 'running' || s.state === 'external') && (q.state === 'stopped' || q.state === 'stopping')) return 'partial';
    if ((q.state === 'running' || q.state === 'degraded') && (s.state === 'stopped' || s.state === 'stopping')) return 'partial';
    return 'starting';
  }

  overallText() {
    return {
      stopped: '已停止',
      starting: '启动中',
      'waiting-login': '等待登录',
      running: '运行中',
      partial: '部分运行',
      degraded: '连接异常',
      error: '失败',
      stopping: '停止中',
    }[this.state.overall.state] || '未知';
  }

  recomputeOverall() {
    if (this.busyAction || this.state.overall.state === 'stopped') return;
    const next = this.computeOverall();
    if (next === this.state.overall.state) return;
    const texts = {
      running: '运行中',
      'waiting-login': '等待登录',
      partial: '部分运行',
      degraded: '连接异常',
      starting: '启动中',
      error: '失败',
    };
    this.state.overall = {
      state: next,
      text: texts[next] || next,
      detail: next === 'running' ? 'SnowLuma 与 qqbridge 均已就绪' : next === 'waiting-login' ? '等待 QQ 登录后继续' : next === 'partial' ? '只有一个服务在运行，另一个已停止' : next === 'degraded' ? '部分环节未就绪，详见各服务卡片' : '服务状态异常',
    };
    this.refreshState(this.state.overall.state, this.state.overall.text, this.state.overall.detail);
  }

  /* ---------- 凭据 ---------- */

  async readRecord(key) {
    const credentials = this.getCredentials();
    if (!credentials) return null;
    try {
      return await credentials.readRecord(key);
    } catch {
      return null;
    }
  }

  async deleteRecord(key) {
    const credentials = this.getCredentials();
    if (!credentials) return;
    try {
      await credentials.deleteRecord(key);
    } catch {
      /* ignore */
    }
  }

  /**
   * credentials 是可选服务：插件 apply 时它可能还没就绪，因此按需解析，
   * 而不是在构造时缓存一次 undefined。解析到后缓存引用。
   */
  getCredentials() {
    if (this.credentials) return this.credentials;
    try {
      const service = this.ctx.get('credentials');
      if (service) this.credentials = service;
      return service || null;
    } catch {
      return null;
    }
  }

  async saveSessionToken(token) {
    const credentials = this.getCredentials();
    if (!credentials || !token) return;
    try {
      await credentials.modifyRecord(SESSION_KEY, async () => ({
        kind: 'grant',
        payload: { version: 1, token, obtainedAt: new Date().toISOString() },
      }));
    } catch (error) {
      this.log('warn', `保存 SnowLuma 会话失败：${error.message}`);
    }
  }

  async savePassword(password) {
    const credentials = this.getCredentials();
    if (!credentials) throw new Error('credentials 服务不可用，无法安全保存密码');
    if (typeof password !== 'string' || password.length < 1 || password.length > 512) throw new Error('密码长度不合法');
    await credentials.modifyRecord(PASSWORD_KEY, async () => ({
      kind: 'grant',
      payload: { version: 1, secret: password },
    }));
    this.redact.add(password);
    this.state.auth.snowluma.configured = true;
  }

  async clearPassword() {
    const credentials = this.getCredentials();
    if (!credentials) return;
    await credentials.deleteRecord(PASSWORD_KEY);
    this.state.auth.snowluma.configured = false;
    this.state.snowluma.auth = { state: this.snowToken ? 'ok' : 'needed', note: '已清除保存的密码' };
    this.broadcastState();
  }

  async loginSnowLuma() {
    const url = this.currentSnowUrl();
    const record = await this.readRecord(PASSWORD_KEY);
    const password = typeof record?.payload?.secret === 'string' ? record.payload.secret : '';
    if (!password) return { ok: false, error: '尚未保存 SnowLuma 密码，请先在设置里录入' };
    if (Date.now() - this.lastLoginAttemptAt < 15000) return { ok: false, error: '自动登录过频，请稍候再试（避免触发控制台锁定）' };
    this.lastLoginAttemptAt = Date.now();
    const result = await services.snowLumaLogin(url, password);
    if (result.ok) {
      this.snowToken = result.token;
      this.redact.add(result.token);
      await this.saveSessionToken(result.token);
      this.state.snowluma.auth = { state: 'ok', note: '自动登录成功' };
      this.state.auth.snowluma = { ...this.state.auth.snowluma, state: 'ok', configured: true };
      this.setPhase('snowluma', 'auth', 'done', '自动登录成功');
      this.broadcastState();
      return { ok: true };
    }
    this.state.snowluma.auth = { state: 'needed', note: result.message || result.kind };
    this.broadcastState();
    return { ok: false, error: result.message || result.kind };
  }

  /* ---------- 设置 ---------- */

  async updateSettings(patch) {
    const previousPorts = JSON.stringify(this.store.get().consolePorts);
    const next = this.store.update(patch);
    this.state.settings = next;
    this.state.autoStart = next.autoStart;
    for (const name of ['snowluma', 'qqbridge']) this.sup[name].maxLines = next.logLines;
    if (JSON.stringify(next.consolePorts) !== previousPorts) {
      this.log('info', '控制台门户端口已变化，重新监听');
      await this.rebuildProxies();
    }
    this.refreshState(this.state.overall.state, this.state.overall.text, this.state.overall.detail);
    return next;
  }

  /* ---------- HTTP 路由 ---------- */

  async handleHttp(req, res) {
    const url = new URL(req.url || '/', `http://127.0.0.1${ROUTE}`);
    const sub = url.pathname.slice(ROUTE.length) || '/';
    const method = req.method || 'GET';
    // 同源写操作守卫：只接受工具台页面发来的 application/json 请求，
    // 拒绝跨站表单/beacon，避免本机其它网页借 DSH cookie 触发启停。
    if (method !== 'GET' && method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin) {
        try {
          const supplied = new URL(String(origin));
          const expected = new URL(this.dshOrigin);
          const loopback = (host) => host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host);
          if (!loopback(supplied.hostname) || supplied.port !== expected.port || !loopback(expected.hostname)) {
            json(res, 403, { ok: false, error: '跨站请求被拒绝' });
            return;
          }
        } catch {
          json(res, 403, { ok: false, error: '跨站请求被拒绝' });
          return;
        }
      }
      if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) {
        json(res, 415, { ok: false, error: '请求必须是 application/json' });
        return;
      }
    }
    if (method === 'GET' && (sub === '/api/state' || sub === '/api/state/')) {
      json(res, 200, { ok: true, state: this.publicState() });
      return;
    }
    if (method === 'GET' && sub === '/api/diagnostics') {
      json(res, 200, { ok: true, diagnostics: this.diagnostics(), state: this.publicState() });
      return;
    }
    if (method === 'GET' && sub === '/api/stream') {
      this.openSse(req, res);
      return;
    }
    if (method === 'GET' && sub === '/api/logs') {
      const name = url.searchParams.get('service');
      const supervisor = this.sup[name];
      if (!supervisor) {
        json(res, 400, { ok: false, error: '未知服务' });
        return;
      }
      const since = Number(url.searchParams.get('since') || 0);
      const limit = Math.min(4000, Math.max(1, Number(url.searchParams.get('limit') || 800)));
      const search = url.searchParams.get('search') || '';
      const tail = url.searchParams.get('tail') === '1';
      const lines = supervisor.readLines({ since, limit, search, tail });
      json(res, 200, { ok: true, service: name, lines, seq: supervisor.seq, status: supervisor.snapshot() });
      return;
    }
    if (method === 'GET' && sub === '/api/export') {
      const name = url.searchParams.get('service');
      const supervisor = this.sup[name];
      if (!supervisor) {
        json(res, 400, { ok: false, error: '未知服务' });
        return;
      }
      const lines = supervisor.lines.map((line) => `${line.time} [${line.stream}] ${stripAnsi(line.text)}`);
      const text = this.redact.redact(lines.join('\r\n'));
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename="${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.log"`,
        'cache-control': 'no-store',
      });
      res.end(`\ufeff${text}`);
      return;
    }
    if (method === 'POST' && sub === '/api/action') {
      const body = await readBody(req);
      const action = String(body.action || '');
      const service = String(body.service || '');
      const result = await this.enqueue(action || 'action', async () => {
        if (action === 'start-all' || action === 'continue') return this.startAll('manual');
        if (action === 'stop-all') return this.stopAll('manual');
        if (action === 'start') return this.startService(service);
        if (action === 'stop') {
          if (!['snowluma', 'qqbridge'].includes(service)) return { ok: false, error: '未知服务' };
          const stopped = await this.stopServiceProcess(service);
          const svc = this.state[service];
          if (stopped.external) {
            svc.state = 'external';
            svc.detail = '外部实例仍在运行（工具台不会停止非本插件启动的进程）';
            return { ok: false, external: true, error: '这是外部实例，工具台不会停止它' };
          }
          svc.state = 'stopped';
          svc.detail = '已停止（手动）';
          svc.managed = false;
          svc.pid = null;
          svc.startedAt = null;
          svc.uptimeMs = null;
          svc.external = false;
          this.resetPhases(service);
          if (service === 'qqbridge') {
            svc.link = { dshReady: false, baseUrl: svc.link.baseUrl, mode: null, note: '已手动停止' };
            svc.upstream = { connected: false, degraded: null, good: null, accountOnline: null, lastPacketAgoMs: null, hint: null };
          } else {
            svc.onebot = { state: 'unknown', online: false, uin: null, nickname: null, good: null, detail: '' };
            svc.auth = { state: 'unknown', note: '' };
          }
          this.state.userStopped = true;
          const nextOverall = this.computeOverall();
          const texts = { stopped: '已停止', starting: '启动中', 'waiting-login': '等待登录', running: '运行中', partial: '部分运行', degraded: '连接异常', error: '失败', stopping: '停止中' };
          this.state.overall = {
            state: nextOverall,
            text: texts[nextOverall] || nextOverall,
            detail: `已手动停止 ${service === 'snowluma' ? 'SnowLuma' : 'qqbridge'}`,
          };
          this.refreshState(this.state.overall.state, this.state.overall.text, this.state.overall.detail);
          return { ok: true };
        }
        if (action === 'restart') {
          if (!['snowluma', 'qqbridge'].includes(service)) return { ok: false, error: '未知服务' };
          return this.restartService(service);
        }
        if (action === 'clear-logs') {
          if (this.sup[service]) {
            this.sup[service].clear();
            return { ok: true };
          }
          return { ok: false, error: '未知服务' };
        }
        if (action === 'login-snowluma') return this.loginSnowLuma();
        if (action === 'update-ui') {
          const ui = body.ui && typeof body.ui === 'object' ? body.ui : {};
          const next = this.store.update({ ui });
          this.state.settings = next;
          this.broadcastState();
          return { ok: true, ui: next.ui };
        }
        return { ok: false, error: `未知操作：${action}` };
      });
      this.broadcastState();
      json(res, 200, { ok: Boolean(result?.ok), result, state: this.publicState() });
      return;
    }
    if (method === 'GET' && sub === '/api/settings') {
      json(res, 200, { ok: true, settings: this.store.get() });
      return;
    }
    if (method === 'POST' && sub === '/api/settings') {
      const body = await readBody(req);
      if (body.action === 'reset') {
        const next = this.store.reset();
        this.state.settings = next;
        this.state.autoStart = next.autoStart;
        await this.rebuildProxies();
        this.refreshState(this.state.overall.state, this.state.overall.text, this.state.overall.detail);
        json(res, 200, { ok: true, settings: next, state: this.publicState() });
        return;
      }
      const next = await this.updateSettings(body.settings || body);
      json(res, 200, { ok: true, settings: next, state: this.publicState() });
      return;
    }
    if (method === 'GET' && sub === '/api/credentials') {
      const password = await this.readRecord(PASSWORD_KEY);
      json(res, 200, {
        ok: true,
        snowluma: {
          configured: Boolean(password?.payload?.secret),
          sessionPresent: Boolean(this.snowToken || (await this.readRecord(SESSION_KEY))?.payload?.token),
          credentialsAvailable: Boolean(this.credentials),
        },
      });
      return;
    }
    if (method === 'POST' && sub === '/api/credentials') {
      const body = await readBody(req);
      if (body.action === 'clear') {
        await this.clearPassword();
        json(res, 200, { ok: true, configured: false });
        return;
      }
      const password = typeof body.snowlumaPassword === 'string' ? body.snowlumaPassword : '';
      if (!password) {
        json(res, 400, { ok: false, error: '缺少 snowlumaPassword' });
        return;
      }
      try {
        await this.savePassword(password);
        const login = await this.loginSnowLuma();
        json(res, 200, { ok: true, configured: true, login });
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
      }
      return;
    }
    if (method === 'GET' && (sub === '/' || sub === '')) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('QQ 服务工具台 Host 路由已就绪');
      return;
    }
    json(res, 404, { ok: false, error: '未知接口' });
  }

  openSse(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const client = { res };
    this.sseClients.add(client);
    this.sseSend(client, { type: 'hello', state: this.publicState() });
    for (const name of ['snowluma', 'qqbridge']) {
      const lines = this.sup[name].readLines({ tail: true, limit: 200 });
      if (lines.length) this.sseSend(client, { type: 'logs', name, lines });
    }
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
        this.sseClients.delete(client);
      }
    }, 15000);
    heartbeat.unref?.();
    req.on('close', () => {
      clearInterval(heartbeat);
      this.sseClients.delete(client);
    });
  }
}

function safeExists(target) {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

/**
 * 找到可用的 Node：设置里的路径 → SnowLuma 自带 node.exe → Electron 的 Node 模式。
 * 这样打包后即使没有单独安装 Node 也能运行（SnowLuma 发行版通常自带 node.exe）。
 */
function resolveNodeCommand(settings) {
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  const candidates = [
    settings?.nodePath,
    settings?.snowLumaDir ? path.join(settings.snowLumaDir, exe) : '',
  ];
  for (const candidate of candidates) {
    if (candidate && safeExists(candidate)) return { command: candidate, env: {} };
  }
  return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}
