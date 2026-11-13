/**
 * 受限同源门户：每个服务一个只监听 127.0.0.1 的小反向代理。
 *
 * 为什么不是直接 iframe 原地址：
 * - SnowLuma 与 qqbridge 控制台都发 `X-Frame-Options: DENY`，且 SnowLuma 还有
 *   `Content-Security-Policy: frame-ancestors 'none'`，直接嵌会被浏览器拦掉；
 * - 两者都要认证：SnowLuma 是 `Authorization: Bearer`（令牌存在 localStorage），
 *   qqbridge 是 `x-console-token` 头或 `?token=`。
 *
 * 做法：代理挂在自己的回环端口根路径，资源/接口路径原样转发，因此不需要改写
 * 第三方页面里的绝对路径；只在边界上做四件事：
 *   1. 剥离 frame 相关响应头（范围仅限本代理的两个端口）；
 *   2. 注入各自认证（qqbridge 头；SnowLuma 在 HTML 里写入 localStorage 令牌）；
 *   3. 访问闸门：iframe 首次带 ?qd=<一次性令牌> 换 HttpOnly cookie，之后按 cookie 放行；
 *   4. 转发时清掉 DSH 自己的 cookie（不把客户端宿主凭据带给第三方本地服务）。
 */
import http from 'node:http';
import { URL } from 'node:url';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const FRAME_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
]);

const DSH_COOKIE_PREFIX = 'dsh-auth-';

function parseCookies(header) {
  const out = new Map();
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    out.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return out;
}

function filteredCookieHeader(header, gateCookieName) {
  const cookies = parseCookies(header);
  cookies.delete(gateCookieName);
  for (const name of [...cookies.keys()]) {
    if (name.startsWith(DSH_COOKIE_PREFIX)) cookies.delete(name);
  }
  if (cookies.size === 0) return '';
  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

export class ConsoleProxy {
  constructor({
    name,
    label,
    upstreamOrigin,
    listenPort,
    gate,
    redact,
    rewriteHtml,
    extraRequestHeaders,
    onUpstream,
    log = () => {},
  }) {
    this.name = name;
    this.label = label;
    this.upstream = new URL(String(upstreamOrigin));
    this.listenPort = Number(listenPort) || 0;
    this.gate = gate;
    this.gateCookie = `qd_${name}_gate`;
    this.redact = redact;
    this.rewriteHtml = rewriteHtml || null;
    this.extraRequestHeaders = extraRequestHeaders || (() => ({}));
    this.onUpstream = onUpstream || (() => {});
    this.log = log;
    this.server = null;
    this.port = null;
  }

  get origin() {
    return this.port ? `http://127.0.0.1:${this.port}` : null;
  }

  get url() {
    return this.port ? `${this.origin}/?qd=${encodeURIComponent(this.gate)}` : null;
  }

  async listen() {
    const server = http.createServer((req, res) => {
      this.#handle(req, res).catch((error) => {
        this.log('warn', `${this.label} 门户请求失败：${error instanceof Error ? error.message : String(error)}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        }
        res.end('门户代理异常');
      });
    });
    server.on('upgrade', (req, socket) => {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    server.on('clientError', (error, socket) => {
      try {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      } catch {
        /* ignore */
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.listenPort, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.port = server.address().port;
    return this.port;
  }

  async close() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.port = null;
    await new Promise((resolve) => {
      server.close(() => resolve());
      setTimeout(resolve, 1500).unref?.();
    });
  }

  #gateAccepted(req, url) {
    const supplied = url.searchParams.get('qd');
    if (supplied && supplied === this.gate) return 'query';
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.get(this.gateCookie) === this.gate) return 'cookie';
    // 门户内的子资源（脚本 / 接口 / 图标）天然是同源请求，用 Sec-Fetch-Site 判定即可，
    // 不依赖 cookie：Electron 与浏览器的第三方 cookie 策略不同，cookie 失败会让 iframe 白屏。
    const dest = String(req.headers['sec-fetch-dest'] || '');
    const site = String(req.headers['sec-fetch-site'] || '');
    const isDocument = dest === 'document' || dest === 'iframe' || dest === '';
    const looksDocument = isDocument && String(req.headers.accept || '').includes('text/html');
    if (!looksDocument && site === 'same-origin') return 'same-origin';
    return false;
  }

  async #handle(req, res) {
    const url = new URL(req.url || '/', this.origin || `http://127.0.0.1:${this.listenPort}`);
    const gateState = this.#gateAccepted(req, url);
    if (!gateState) {
      res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`<!doctype html><meta charset="utf-8"><title>请从 QQ 服务工具台打开</title>
<body style="font-family:system-ui;background:#14171c;color:#e8ecf4;padding:32px;line-height:1.7">
<h2>请从「QQ 服务工具台」打开这个控制台</h2>
<p>这个端口只接受工具台生成的临时门户链接，避免其它本机程序借用已登录状态。</p></body>`);
      return;
    }
    const target = new URL(url.pathname + url.search, this.upstream);
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers['proxy-connection'];
    delete headers['accept-encoding'];
    headers.accept_encoding = 'identity';
    const cookie = filteredCookieHeader(req.headers.cookie, this.gateCookie);
    if (cookie) headers.cookie = cookie;
    else delete headers.cookie;
    headers.host = this.upstream.host;
    const originHeader = `http://${this.upstream.host}`;
    if (headers.origin) headers.origin = originHeader;
    if (headers.referer) {
      try {
        const ref = new URL(String(headers.referer));
        headers.referer = `${originHeader}${ref.pathname}${ref.search}`;
      } catch {
        headers.referer = `${originHeader}/`;
      }
    }
    Object.assign(headers, this.extraRequestHeaders(req, url) || {});

    const upstreamReq = http.request(
      {
        protocol: this.upstream.protocol,
        hostname: this.upstream.hostname,
        port: this.upstream.port || 80,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode || 502;
        this.onUpstream({ url: target.pathname, status, method: req.method });
        const responseHeaders = {};
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          const lower = key.toLowerCase();
          if (HOP_BY_HOP.has(lower) || FRAME_HEADERS.has(lower)) continue;
          responseHeaders[key] = value;
        }
        responseHeaders['cache-control'] = 'no-store';
        const contentType = String(upstreamRes.headers['content-type'] || '');
        const isHtml = contentType.includes('text/html');
        if (isHtml && this.rewriteHtml) {
          const chunks = [];
          let total = 0;
          upstreamRes.on('data', (chunk) => {
            total += chunk.length;
            if (total <= 8 * 1024 * 1024) chunks.push(chunk);
          });
          upstreamRes.on('end', () => {
            let body = Buffer.concat(chunks).toString('utf8');
            try {
              body = this.rewriteHtml(body, { url: target, req });
            } catch (error) {
              this.log('warn', `${this.label} HTML 注入失败：${error instanceof Error ? error.message : String(error)}`);
            }
            delete responseHeaders['content-length'];
            delete responseHeaders['content-encoding'];
            res.writeHead(status, responseHeaders);
            res.end(body);
          });
          upstreamRes.on('error', () => {
            if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('上游响应中断');
          });
          return;
        }
        res.writeHead(status, responseHeaders);
        upstreamRes.pipe(res);
      },
    );
    upstreamReq.on('error', (error) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const message = this.redact.redact(error?.message || String(error));
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(this.label)}暂不可用</title>
<body style="font-family:system-ui;background:#14171c;color:#e8ecf4;padding:28px;line-height:1.7">
<h2>${escapeHtml(this.label)}控制台暂不可用</h2>
<p>代理连不上上游 <code>${escapeHtml(this.upstream.origin)}</code>。</p>
<p style="color:#9aa7ba">${escapeHtml(message)}</p>
<p>请在上方工具台确认服务已启动，然后重试。</p></body>`);
    });
    req.pipe(upstreamReq);
    req.on('aborted', () => upstreamReq.destroy());
  }
}

/** 把令牌写进 iframe 文档的 localStorage（SnowLuma 的唯一认证通道）。 */
export function injectSnowLumaToken(html, token) {
  if (!token) return html;
  const script = `<script data-qq-service-desk="1">try{localStorage.setItem("snowluma_token",${JSON.stringify(token)})}catch(e){}</script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (match) => `${match}${script}`);
  return `${script}${html}`;
}

/** 读取浏览器带来的 Bearer 令牌，用于复用有效会话（不落盘到设置文件）。 */
export function readBearer(headers) {
  const value = headers?.authorization || headers?.Authorization;
  if (!value) return '';
  const text = Array.isArray(value) ? value[0] : value;
  const match = String(text).match(/^Bearer\s+([A-Za-z0-9._~+/-]{16,})$/i);
  return match ? match[1] : '';
}
