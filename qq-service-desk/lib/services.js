/**
 * 两个真实服务的协议细节（全部来自现有服务实现，不做模拟）：
 *
 * SnowLuma
 * - WebUI 默认 127.0.0.1:5099；标题标记 `<title>SnowLuma 控制台</title>`；
 *   端口被占用时自身会向上顺延（launcher 最多探测 50 个）。
 * - 鉴权是 Bearer：POST /api/login {password} → {success,token}；
 *   /api/* 需要 `Authorization: Bearer <token>`；GET /api/status 可用于校验令牌。
 * - OneBot HTTP（默认 3000）用 `Authorization: Bearer <accessToken>`，
 *   POST /get_status 返回账号在线与接收链路健康度。
 *
 * qqbridge
 * - 控制台默认 127.0.0.1:3100，标题 `<title>QQ 桥接控制台</title>`；
 *   令牌来自 config.consoleToken 或 state/console-token；
 *   请求可带 `?token=` 或 `x-console-token` 头；Host 头必须是 127.0.0.1:<端口>。
 * - GET /api/status 返回 dshReady 与 snowluma 上游健康快照。
 */
import fs from 'node:fs';
import path from 'node:path';
import { httpRequest, normalizeBaseUrl, withPath } from './probe.js';

export const SNOWLUMA_TITLE = '<title>SnowLuma 控制台</title>';
export const QQBRIDGE_TITLE = '<title>QQ 桥接控制台</title>';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** 读取 SnowLuma 控制台实际端口：从基础地址起最多探测 50 个（与服务自身顺延一致）。 */
export async function findSnowLumaConsole(baseUrl, { timeoutMs = 1500, signal } = {}) {
  const base = new URL(String(baseUrl));
  const start = Number(base.port || 80);
  for (let offset = 0; offset < 50; offset += 1) {
    const port = start + offset;
    if (port > 65535) break;
    const url = new URL(base.toString());
    url.port = String(port);
    url.pathname = '/';
    const res = await httpRequest(url.toString(), {
      timeoutMs,
      signal,
      headers: { accept: 'text/html' },
      maxBody: 512 * 1024,
    });
    if (res.ok && /text\/html/i.test(res.headers?.get('content-type') || '') && res.text.includes(SNOWLUMA_TITLE)) {
      return { ok: true, url: `${url.origin}/`, port };
    }
  }
  return { ok: false, url: null, port: null };
}

export async function snowLumaAuthState(baseUrl, token, { timeoutMs = 2500, signal } = {}) {
  if (!token) return { state: 'none' };
  const res = await httpRequest(withPath(baseUrl, '/api/status'), {
    timeoutMs,
    signal,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (res.status === 200 && res.json?.status === 'running') return { state: 'ok' };
  if (res.status === 401) return { state: 'unauthorized' };
  if (res.status === 0) return { state: 'offline', message: res.message };
  return { state: 'error', status: res.status, message: res.message || res.text?.slice(0, 160) };
}

/** 密码只在本机进程内短暂存在；错误信息不回显密码。 */
export async function snowLumaLogin(baseUrl, password, { timeoutMs = 8000, signal } = {}) {
  if (!password) return { ok: false, kind: 'missing-password' };
  const res = await httpRequest(withPath(baseUrl, '/api/login'), {
    method: 'POST',
    timeoutMs,
    signal,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: { password },
  });
  if (res.status === 0) return { ok: false, kind: 'offline', message: res.message };
  if (res.status === 429) return { ok: false, kind: 'rate-limited', message: res.json?.message || '登录尝试过多，已暂时锁定' };
  if (res.status === 200 && res.json?.needsTotp) return { ok: false, kind: 'totp', message: '该控制台启用了二次验证（TOTP），需要在控制台内手动登录' };
  if (res.status === 401) {
    return { ok: false, kind: res.json?.needsTotp ? 'totp' : 'bad-password', message: res.json?.message || '密码不正确' };
  }
  if (res.ok && res.json?.success && typeof res.json.token === 'string' && res.json.token.length >= 16) {
    return {
      ok: true,
      token: res.json.token,
      mustChangePassword: Boolean(res.json.mustChangePassword),
      note: res.json.mustChangePassword ? '控制台要求先修改初始密码，修改后才能读取完整状态' : '',
    };
  }
  return { ok: false, kind: 'error', status: res.status, message: res.json?.message || res.text?.slice(0, 160) || res.message };
}

/** 从 SnowLuma 的 per-UIN OneBot 配置里取 HTTP/WS 服务与令牌（只取第一个 HTTP 服务，与服务实际行为一致）。 */
export function readSnowLumaOneBotConfig(snowLumaDir) {
  const configDir = path.join(snowLumaDir, 'config');
  let files = [];
  try {
    files = fs.readdirSync(configDir).filter((name) => /^onebot_\d+\.json$/.test(name));
  } catch {
    files = [];
  }
  const candidates = [];
  for (const file of files) {
    const doc = readJson(path.join(configDir, file));
    if (!doc || typeof doc !== 'object') continue;
    const http = Array.isArray(doc.networks?.httpServers) ? doc.networks.httpServers[0] : null;
    const ws = Array.isArray(doc.networks?.wsServers) ? doc.networks.wsServers[0] : null;
    const uin = (file.match(/^onebot_(\d+)\.json$/) || [])[1] || '';
    candidates.push({
      uin,
      http: http ? { host: http.host || '127.0.0.1', port: Number(http.port) || 3000, token: String(http.accessToken || '') } : null,
      ws: ws ? { host: ws.host || '127.0.0.1', port: Number(ws.port) || 3001, token: String(ws.accessToken || '') } : null,
    });
  }
  return candidates;
}

export async function oneBotStatus(httpUrl, accessToken, { timeoutMs = 3000, signal } = {}) {
  if (!httpUrl) return { ok: false, online: false, message: '未配置 OneBot HTTP 地址' };
  const res = await httpRequest(`${normalizeBaseUrl(httpUrl)}/get_status`, {
    method: 'POST',
    timeoutMs,
    signal,
    headers: {
      'content-type': 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: {},
  });
  if (res.status === 0) return { ok: false, online: false, offline: true, message: res.message };
  if (!res.ok) return { ok: false, online: false, status: res.status, message: res.json?.message || res.text?.slice(0, 160) || res.message };
  const data = res.json?.data || res.json || {};
  return {
    ok: true,
    online: data.online === true || data.online === 1 || data.status === 'online',
    good: data.good !== false,
    uin: data.uin ?? data.user_id ?? null,
    nickname: data.nickname ?? null,
    raw: data,
  };
}

export async function oneBotLoginInfo(httpUrl, accessToken, { timeoutMs = 3000, signal } = {}) {
  const res = await httpRequest(`${normalizeBaseUrl(httpUrl)}/get_login_info`, {
    method: 'POST',
    timeoutMs,
    signal,
    headers: {
      'content-type': 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: {},
  });
  const data = res.json?.data || res.json || {};
  return { ok: res.ok, uin: data.user_id ?? data.uin ?? null, nickname: data.nickname ?? null };
}

export function readQQBridgeConfig(qqBridgeDir) {
  const doc = readJson(path.join(qqBridgeDir, 'config.json')) || {};
  return {
    dshBaseUrl: String(doc.dsh?.baseUrl || '').trim(),
    consolePort: Number(doc.consolePort) || 3100,
    consoleToken: String(doc.consoleToken || '').trim(),
    ownerQQ: doc.ownerQQ === undefined || doc.ownerQQ === null ? null : String(doc.ownerQQ),
    allowPrivate: doc.allow?.private ?? null,
    allowGroups: doc.allow?.groups ?? null,
    snowluma: {
      httpUrl: String(doc.snowluma?.httpUrl || '').trim(),
      wsUrl: String(doc.snowluma?.wsUrl || '').trim(),
      accessToken: String(doc.snowluma?.accessToken || '').trim(),
    },
    autoStartBridge: doc.social?.shared?.autoStartBridge === true,
  };
}

const CONSOLE_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

export function readQQBridgeConsoleToken(qqBridgeDir) {
  const config = readQQBridgeConfig(qqBridgeDir);
  if (CONSOLE_TOKEN_RE.test(config.consoleToken)) return { token: config.consoleToken, source: 'config.json#consoleToken' };
  try {
    const token = fs.readFileSync(path.join(qqBridgeDir, 'state', 'console-token'), 'utf8').trim();
    if (CONSOLE_TOKEN_RE.test(token)) return { token, source: 'state/console-token' };
  } catch {
    /* 桥接还没生成过令牌 */
  }
  return { token: '', source: null };
}

/** 控制台 HTTP 就绪判定：带令牌取首页，标题命中即视为服务在。 */
export async function probeQQBridgeConsole(baseUrl, token, { timeoutMs = 2000, signal } = {}) {
  if (!token) return { ok: false, reason: 'no-token' };
  const res = await httpRequest(`${normalizeBaseUrl(baseUrl)}/`, {
    timeoutMs,
    signal,
    headers: {
      'x-console-token': token,
      accept: 'text/html',
    },
    maxBody: 1024 * 1024,
  });
  if (!res.ok) return { ok: false, reason: res.status === 401 ? 'unauthorized' : res.status === 0 ? 'offline' : `http-${res.status}`, res };
  return { ok: res.text.includes(QQBRIDGE_TITLE), reason: res.text.includes(QQBRIDGE_TITLE) ? 'ok' : 'marker-missing', res };
}

export async function qqBridgeStatus(baseUrl, token, { timeoutMs = 3000, signal } = {}) {
  if (!token) return { ok: false, reason: 'no-token' };
  const res = await httpRequest(`${normalizeBaseUrl(baseUrl)}/api/status`, {
    timeoutMs,
    signal,
    headers: { 'x-console-token': token, accept: 'application/json' },
  });
  if (res.status === 0) return { ok: false, reason: 'offline', message: res.message };
  if (!res.ok) return { ok: false, reason: res.status === 401 ? 'unauthorized' : `http-${res.status}`, message: res.json?.error || res.message };
  const data = res.json || {};
  return {
    ok: true,
    dshReady: data.dshReady === true,
    mode: data.mode ?? null,
    roleMode: data.roleMode ?? null,
    ownerQQ: data.ownerQQ ?? null,
    allowGroups: data.allowGroups ?? [],
    allowPrivate: data.allowPrivate ?? [],
    snowluma: data.snowluma || null,
    activity: Array.isArray(data.activity) ? data.activity.slice(-6) : [],
  };
}

export async function qqBridgeEndpoint(baseUrl, token, pathname, { method = 'GET', body, timeoutMs = 4000, signal } = {}) {
  const res = await httpRequest(`${normalizeBaseUrl(baseUrl)}${pathname}`, {
    method,
    timeoutMs,
    signal,
    headers: {
      'x-console-token': token,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : body,
  });
  return res;
}
