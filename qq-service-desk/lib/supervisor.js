/**
 * 托管进程：只管理本插件 spawn 的实例。
 *
 * 关键约束（来自需求）：
 * - 记录 pid 与子进程；停止时按进程树杀（Windows: taskkill /T /F），外部实例永不触碰；
 * - 输出用 UTF-8 解码（中文正常），保留 ANSI 转义交给前端着色；
 * - 日志是有上限的环形缓存，清空显示不影响业务数据；
 * - 手动停止会清掉等待/重试；本类不做任何自动重启。
 */
import { spawn } from 'node:child_process';
import { createRedactor, randomToken, timeLabel } from './util.js';

function bufferLine(text) {
  return String(text ?? '').replace(/\r$/, '');
}

export class Supervisor {
  constructor({ name, label, maxLines = 4000, redact }) {
    this.name = name;
    this.label = label;
    this.maxLines = maxLines;
    this.redactor = redact || createRedactor();
    this.listeners = new Set();
    this.child = null;
    this.pid = null;
    this.status = 'stopped';
    this.startedAt = null;
    this.exitedAt = null;
    this.exit = null;
    this.error = null;
    this.lastActivityAt = null;
    this.lines = [];
    this.seq = 0;
    this.partial = { stdout: '', stderr: '' };
    this.stopRequested = false;
    this.startedBy = 'plugin';
    this.extra = {};
    this.disposed = false;
  }

  addListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* 订阅者异常不影响进程管理 */
      }
    }
  }

  #pushLine(stream, rawText) {
    const text = this.redactor.redact(bufferLine(rawText));
    if (!text && /^\s*$/.test(text) === false) return;
    const line = {
      seq: ++this.seq,
      at: Date.now(),
      time: timeLabel(),
      stream,
      text,
    };
    this.lines.push(line);
    this.lastActivityAt = line.at;
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
    this.#emit({ type: 'log', name: this.name, line });
  }

  #consume(stream, chunk) {
    const text = this.partial[stream] + chunk;
    const parts = text.split('\n');
    this.partial[stream] = parts.pop() ?? '';
    for (const part of parts) this.#pushLine(stream, part);
    if (this.partial[stream].length > 8000) {
      this.#pushLine(stream, this.partial[stream]);
      this.partial[stream] = '';
    }
  }

  snapshot() {
    return {
      name: this.name,
      label: this.label,
      status: this.status,
      managed: this.status !== 'stopped' && this.pid !== null,
      pid: this.pid,
      startedAt: this.startedAt,
      exitedAt: this.exitedAt,
      exit: this.exit,
      error: this.error,
      lastActivityAt: this.lastActivityAt,
      logSeq: this.seq,
      lineCount: this.lines.length,
      extra: this.extra,
    };
  }

  /** 幂等启动：已在运行 / 启动中直接返回 false。 */
  start({ argv, cwd, env, label }) {
    if (this.child || this.status === 'starting' || this.status === 'running' || this.status === 'stopping') return false;
    if (!Array.isArray(argv) || argv.length === 0) throw new Error('缺少启动命令');
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    this.child = child;
    this.pid = child.pid ?? null;
    this.status = 'starting';
    this.startedAt = Date.now();
    this.exitedAt = null;
    this.exit = null;
    this.error = null;
    this.stopRequested = false;
    this.lines = [];
    this.seq = 0;
    this.partial = { stdout: '', stderr: '' };
    this.extra = { label: label || null };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => this.#consume('stdout', chunk));
    child.stderr?.on('data', (chunk) => this.#consume('stderr', chunk));
    child.on('error', (error) => {
      this.error = error?.message || String(error);
      this.status = 'error';
      this.#emit({ type: 'status', name: this.name, snapshot: this.snapshot() });
    });
    child.on('exit', (code, signal) => {
      for (const stream of ['stdout', 'stderr']) {
        if (this.partial[stream]) {
          this.#pushLine(stream, this.partial[stream]);
          this.partial[stream] = '';
        }
      }
      this.exit = { code, signal };
      this.exitedAt = Date.now();
      this.child = null;
      this.pid = null;
      this.status = this.stopRequested ? 'stopped' : 'exited';
      this.#emit({ type: 'status', name: this.name, snapshot: this.snapshot() });
      this.#emit({ type: 'exit', name: this.name, exit: this.exit, stopRequested: this.stopRequested });
    });
    this.#emit({ type: 'status', name: this.name, snapshot: this.snapshot() });
    return true;
  }

  markRunning() {
    if (this.status === 'starting') {
      this.status = 'running';
      this.#emit({ type: 'status', name: this.name, snapshot: this.snapshot() });
    }
  }

  markFailed(message) {
    this.error = message;
    if (this.status === 'starting') {
      this.status = 'error';
      this.#emit({ type: 'status', name: this.name, snapshot: this.snapshot() });
    }
  }

  async stop({ graceMs = 12000 } = {}) {
    const child = this.child;
    if (!child || !this.pid) {
      this.status = 'stopped';
      this.pid = null;
      return { ok: true, already: true };
    }
    this.stopRequested = true;
    this.status = 'stopping';
    this.#emit({ type: 'status', name: this.name, snapshot: this.snapshot() });
    const pid = this.pid;
    const exited = new Promise((resolve) => {
      if (!this.child) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => resolve(false), graceMs);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    await killTree(pid);
    const done = await exited;
    if (!done) {
      // 再给一次强制终止，仍不保证一定成功；调用方据 running 状态如实显示
      await killTree(pid, true);
    }
    this.status = 'stopped';
    this.#emit({ type: 'status', name: this.name, snapshot: this.snapshot() });
    return { ok: done, pid };
  }

  dispose() {
    this.disposed = true;
    this.listeners.clear();
  }

  readLines({ since = 0, limit = 1000, search = '', tail = false } = {}) {
    let lines = this.lines;
    if (search) {
      const query = String(search).toLowerCase();
      lines = lines.filter((line) => line.text.toLowerCase().includes(query));
    }
    if (tail) lines = lines.slice(-limit);
    else if (since > 0) lines = lines.filter((line) => line.seq > since).slice(0, limit);
    else lines = lines.slice(-limit);
    return lines;
  }

  clear() {
    this.lines = [];
    this.seq = 0;
    this.partial = { stdout: '', stderr: '' };
    this.#emit({ type: 'clear', name: this.name });
  }
}

/** Windows 用 taskkill 杀整棵进程树；其他平台走进程组。 */
export function killTree(pid, force = false) {
  return new Promise((resolve) => {
    if (!pid) {
      resolve(false);
      return;
    }
    if (process.platform === 'win32') {
      const child = spawn('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : ['/F'])], {
        windowsHide: true,
        stdio: 'ignore',
      });
      child.on('error', () => resolve(false));
      child.on('exit', () => resolve(true));
      return;
    }
    try {
      process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}

export function childEnv({ dshHome, dshProfile, nodeDir, extra = {}, remove = [] }) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DSH_LAUNCH_TOKEN;
  for (const key of remove) delete env[key];
  if (dshHome) env.DSH_HOME = dshHome;
  if (dshProfile) env.DSH_PROFILE = dshProfile;
  if (nodeDir) env.PATH = `${nodeDir};${env.PATH || env.Path || ''}`;
  env.DSH_NO_OPEN = '1';
  env.QQ_DESK_MANAGED = randomToken(12);
  env.PYTHONIOENCODING = env.PYTHONIOENCODING || 'utf-8';
  return { ...env, ...extra };
}
