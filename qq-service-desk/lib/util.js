/**
 * 通用工具：脱敏、ANSI 处理、超时、原子写盘、ID。
 *
 * 安全约定：所有要进 UI / SSE / 导出文件的文本都先过 redact()；
 * 凭据值注册进 secrets 集合后会被逐字替换，避免任何日志把令牌原样带出。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|\u001b[()][A-Za-z0-9]/g;

export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI_RE, '');
}

export function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

/** 固定替换集合：调用方负责 add；redact 不修改集合。 */
export function createRedactor() {
  const secrets = new Set();
  return {
    add(value) {
      const text = String(value ?? '');
      if (text.length >= 6) secrets.add(text);
    },
    remove(value) {
      secrets.delete(String(value ?? ''));
    },
    list() {
      return [...secrets];
    },
    redact(input) {
      let text = String(input ?? '');
      for (const secret of secrets) {
        if (secret.length >= 6) text = text.split(secret).join('***');
      }
      return text
        // URL 查询串里的令牌
        .replace(/([?&](?:token|access_token|accessToken|consoleToken|key|secret)=)[^&\s"'<>]+/gi, '$1***')
        // Authorization 头
        .replace(/((?:authorization|proxy-authorization)\s*[:=]\s*)(?:bearer\s+)?[^\s,"'}]+/gi, '$1***')
        // 常见 key=value / key: value 形态
        .replace(/((?:accessToken|consoleToken|api[_-]?key|password|passwd|secret|token)\s*[:=]\s*)[^\s,"'}]+/gi, '$1***')
        // DSH 会话 cookie
        .replace(/(dsh-auth-[A-Za-z0-9_-]+=)[^;\s]+/g, '$1***')
        // 明显的长随机串（base64url / hex），只在 40+ 长度时兜底
        .replace(/\b[A-Za-z0-9_-]{40,}\b/g, (match) => (/^[0-9a-fA-F]+$/.test(match) || /[A-Z]/.test(match) || /[0-9]/.test(match) ? '***' : match))
        // SnowLuma 密码哈希/盐字段
        .replace(/("(?:passwordHash|passwordSalt|secret|token)"\s*:\s*")[^"]+(")/g, '$1***$2');
    },
  };
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

export function abortError() {
  const error = new Error('操作已取消');
  error.name = 'AbortError';
  return error;
}

export function isAbort(error) {
  return error?.name === 'AbortError';
}

/** 轮询等待 predicate 为真；返回 { ok, elapsedMs, lastDetail }，不抛超时异常。 */
export async function waitFor(predicate, { timeoutMs = 30000, intervalMs = 500, signal, onTick } = {}) {
  const startedAt = Date.now();
  let lastDetail = null;
  let lastError = null;
  for (;;) {
    if (signal?.aborted) throw abortError();
    let value;
    try {
      value = await predicate();
    } catch (error) {
      value = false;
      lastError = error;
    }
    if (value && value !== false) return { ok: true, value, elapsedMs: Date.now() - startedAt };
    lastDetail = value ?? lastError?.message ?? null;
    if (onTick) {
      try {
        onTick(lastDetail);
      } catch {
        /* 进度回调不影响等待 */
      }
    }
    if (Date.now() - startedAt >= timeoutMs) return { ok: false, elapsedMs: Date.now() - startedAt, detail: lastDetail };
    await sleep(Math.min(intervalMs, Math.max(50, timeoutMs - (Date.now() - startedAt))), signal);
  }
}

/** 原子写：同目录 tmp 文件 + rename，避免半截 JSON。 */
export function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function randomToken(bytes = 18) {
  return randomBytes(bytes).toString('base64url');
}

export function nowIso() {
  return new Date().toISOString();
}

const TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function timeLabel(date = new Date()) {
  return TIME_FORMAT.format(date);
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  if (total < 1000) return `${total}ms`;
  const sec = Math.floor(total / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  if (min < 60) return rest ? `${min} 分 ${rest} 秒` : `${min} 分`;
  const hour = Math.floor(min / 60);
  return `${hour} 小时 ${min % 60} 分`;
}

export function truncate(text, max = 400) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
