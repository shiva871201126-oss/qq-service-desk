/**
 * 本机 HTTP 探测：只访问 127.0.0.1 / ::1，短超时，限制响应体大小。
 * 所有调用都带 AbortSignal，手动停止时能立刻取消等待。
 */
const DEFAULT_TIMEOUT = 2500;
const MAX_BODY = 512 * 1024;

export async function httpRequest(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT,
    signal,
    maxBody = MAX_BODY,
    raw = false,
  } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), Math.max(200, timeoutMs));
  const onOuterAbort = () => controller.abort(new Error('aborted'));
  signal?.addEventListener?.('abort', onOuterAbort, { once: true });
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: controller.signal,
      redirect: 'manual',
      cache: 'no-store',
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    const text = buffer.subarray(0, maxBody).toString('utf8');
    let json = null;
    if (!raw && /json/i.test(response.headers.get('content-type') || '')) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return {
      ok: response.status >= 200 && response.status < 400,
      status: response.status,
      headers: response.headers,
      text,
      json,
      truncated: buffer.length > maxBody,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      headers: null,
      text: '',
      json: null,
      error,
      message: error?.name === 'AbortError' ? (signal?.aborted ? '已取消' : '请求超时') : error?.message || String(error),
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onOuterAbort);
  }
}

export function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** 只允许回环目标，避免设置被误填成远程地址后把凭据发出去。 */
export function assertLoopbackUrl(url, label = '地址') {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error(`${label}不是合法 URL：${url}`);
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) throw new Error(`${label}协议不受支持：${parsed.protocol}`);
  if (!isLoopbackHost(parsed.hostname)) throw new Error(`${label}必须是本机回环地址（127.0.0.1 / localhost），当前为 ${parsed.hostname}`);
  return parsed;
}

export function withPath(baseUrl, pathname) {
  const url = new URL(String(baseUrl));
  url.pathname = pathname;
  url.search = '';
  return url.toString();
}

export function normalizeBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

export async function checkHtmlMarker(url, marker, { timeoutMs = 2000, signal } = {}) {
  const res = await httpRequest(url, {
    timeoutMs,
    signal,
    headers: { accept: 'text/html,application/xhtml+xml' },
    maxBody: 2 * 1024 * 1024,
  });
  if (!res.ok) return { ok: false, res };
  const looksHtml = /text\/html/i.test(res.headers?.get('content-type') || '');
  if (!looksHtml) return { ok: false, res, reason: 'not-html' };
  return { ok: res.text.includes(marker), res, reason: res.text.includes(marker) ? 'ok' : 'marker-missing' };
}
