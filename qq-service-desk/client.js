/**
 * QQ 服务工具台 —— 浏览器端页面。
 *
 * 挂载点：
 *   1. main 槽位（key: qq-service-desk）—— 整块面板
 *   2. sidebar.panellist —— 侧边栏入口（与 main 的 key 同名，点击自动切面板）
 *
 * 所有数据来自宿主 /qq-desk/api/*：状态快照、SSE 增量日志、启停动作、设置与凭据。
 * 页面本身不启动任何东西；重复打开/刷新只会重复订阅同一份宿主状态。
 *
 * 注意：DSH 把客户端文件当普通脚本装载，所以整份文件必须包在 IIFE 里，
 * 顶层不得出现会与其它插件冲突的 lexical 声明。
 */
(() => {
  window.__ModuleLoader__.load({
    id: '@tqyb/qq-service-desk',
    factory(require) {
      const React = require('react');
      const h = React.createElement;
      const { useState, useEffect, useMemo, useRef, useCallback } = React;

      const BASE = '/qq-desk';
      const PANEL_KEY = 'qq-service-desk';
      const PANEL_TITLE = 'QQ 服务工具台';
      const SERVICE_META = {
        snowluma: {
          id: 'snowluma',
          name: 'SnowLuma',
          subtitle: 'QQ 网关 · OneBot v11',
          accent: '#2f81f7',
          consoleLabel: 'SnowLuma 控制台',
          note: '控制台包含 QQ 登录/进程注入、节点配置、日志与调试。',
        },
        qqbridge: {
          id: 'qqbridge',
          name: 'qqbridge',
          subtitle: 'QQ ↔ DeepSeek Harness 桥接',
          accent: '#2ea043',
          consoleLabel: 'qqbridge 控制台',
          note: '控制台包含白名单、会话、角色、社交状态与用量。',
        },
      };

      const api = async (path, options) => {
        const res = await fetch(`${BASE}${path}`, {
          cache: 'no-store',
          ...(options || {}),
          headers: { 'content-type': 'application/json', ...(options?.headers || {}) },
        });
        const text = await res.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          throw new Error(`接口返回非 JSON（HTTP ${res.status}）：${text.slice(0, 160)}`);
        }
        if (!res.ok) {
          const error = new Error(data?.error || `HTTP ${res.status}`);
          error.status = res.status;
          error.payload = data;
          throw error;
        }
        return data;
      };

      const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });

      // ---------------------------------------------------------------- 主题

      function detectTheme() {
        try {
          const probe = document.body || document.documentElement;
          const scheme = (getComputedStyle(probe).colorScheme || '').toLowerCase();
          if (scheme.includes('dark')) return 'dark';
          if (scheme.includes('light')) return 'light';
          const raw = getComputedStyle(probe).getPropertyValue('--dsw-alias-bg-base').trim();
          if (!raw || raw === 'transparent') {
            const layer = getComputedStyle(probe).getPropertyValue('--dsw-alias-label-primary').trim();
            if (layer) return /^#(?:f|e|d)/i.test(layer) ? 'dark' : 'light';
          }
          let r;
          let g;
          let b;
          if (/^#[0-9a-f]{3,8}$/i.test(raw)) {
            const hex = raw.slice(1);
            if (hex.length === 3) {
              r = parseInt(hex[0] + hex[0], 16);
              g = parseInt(hex[1] + hex[1], 16);
              b = parseInt(hex[2] + hex[2], 16);
            } else {
              r = parseInt(hex.slice(0, 2), 16);
              g = parseInt(hex.slice(2, 4), 16);
              b = parseInt(hex.slice(4, 6), 16);
            }
          } else {
            const match = raw.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            if (!match) throw new Error('no token color');
            r = Number(match[1]);
            g = Number(match[2]);
            b = Number(match[3]);
          }
          return (r * 299 + g * 587 + b * 114) / 1000 > 140 ? 'light' : 'dark';
        } catch {
          try {
            return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
          } catch {
            return 'dark';
          }
        }
      }

      function useThemeMode() {
        const [mode, setMode] = useState(() => detectTheme());
        useEffect(() => {
          const update = () => setMode(detectTheme());
          const observer = new MutationObserver(update);
          observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
          observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
          const timer = setInterval(update, 4000);
          return () => {
            observer.disconnect();
            clearInterval(timer);
          };
        }, []);
        return mode;
      }

      // ---------------------------------------------------------------- 状态

      function useDeskState(theme) {
        const [state, setState] = useState(null);
        const [connected, setConnected] = useState(false);
        const [error, setError] = useState(null);
        const logsRef = useRef({ snowluma: [], qqbridge: [] });
        const [logVersion, setLogVersion] = useState(0);
        const flushTimer = useRef(0);
        const pending = useRef({ snowluma: [], qqbridge: [] });

        const flush = useCallback(() => {
          flushTimer.current = 0;
          let changed = false;
          for (const name of ['snowluma', 'qqbridge']) {
            const items = pending.current[name].splice(0);
            if (!items.length) continue;
            const current = logsRef.current[name];
            const lastSeq = current.length ? current[current.length - 1].seq : 0;
            const fresh = items.filter((line) => line.seq > lastSeq);
            if (!fresh.length) continue;
            logsRef.current[name] = current.concat(fresh).slice(-5000);
            changed = true;
          }
          if (changed) setLogVersion((v) => v + 1);
        }, []);

        const scheduleFlush = useCallback(() => {
          if (flushTimer.current) return;
          flushTimer.current = setTimeout(flush, 90);
        }, [flush]);

        const applyState = useCallback((next) => {
          setState(next);
          setError(null);
        }, []);

        useEffect(() => {
          let disposed = false;
          let source = null;
          let retry = 0;
          let live = false;
          const tick = async () => {
            try {
              const data = await api('/api/state');
              if (!disposed) applyState(data.state);
            } catch (err) {
              if (!disposed) setError(err.message);
            }
          };
          tick();
          const open = () => {
            try {
              source = new EventSource(`${BASE}/api/stream`);
            } catch (err) {
              setError(err.message);
              return;
            }
            source.onopen = () => {
              retry = 0;
              live = true;
              setConnected(true);
              tick();
            };
            source.onerror = () => {
              live = false;
              setConnected(false);
              retry += 1;
              if (source) source.close();
              const delay = Math.min(15000, 800 * Math.max(1, retry));
              setTimeout(() => {
                if (!disposed) open();
              }, delay);
            };
            source.onmessage = (event) => {
              let payload;
              try {
                payload = JSON.parse(event.data);
              } catch {
                return;
              }
              if (payload.type === 'hello') {
                applyState(payload.state);
                setConnected(true);
              } else if (payload.type === 'state') {
                applyState(payload.state);
              } else if (payload.type === 'logs') {
                if (!payload.lines?.length) return;
                pending.current[payload.name]?.push(...payload.lines);
                scheduleFlush();
              } else if (payload.type === 'clear') {
                logsRef.current[payload.name] = [];
                pending.current[payload.name] = [];
                setLogVersion((v) => v + 1);
              }
            };
          };
          open();
          const backup = setInterval(() => {
            if (!live) tick();
          }, 5000);
          return () => {
            disposed = true;
            clearInterval(backup);
            if (flushTimer.current) clearTimeout(flushTimer.current);
            if (source) source.close();
          };
        }, [applyState, scheduleFlush]);

        // 首次订阅完成前补拉一次历史日志
        useEffect(() => {
          let cancelled = false;
          (async () => {
            for (const name of ['snowluma', 'qqbridge']) {
              try {
                const data = await api(`/api/logs?service=${name}&tail=1&limit=300`);
                if (cancelled || !data.ok) continue;
                const existing = logsRef.current[name];
                if (!existing.length) {
                  logsRef.current[name] = data.lines || [];
                  scheduleFlush();
                  setLogVersion((v) => v + 1);
                }
              } catch {
                /* 服务未启动时也可用 */
              }
            }
          })();
          return () => {
            cancelled = true;
          };
        }, [scheduleFlush]);

        return { state, connected, error, logs: logsRef.current, logVersion, refresh: () => api('/api/state').then((d) => applyState(d.state)).catch((e) => setError(e.message)) };
      }

      // ---------------------------------------------------------------- 通用 UI

      function Badge({ tone, children, dot }) {
        return h('span', { className: `qd-badge qd-badge-${tone}`, 'data-dot': dot ? '1' : '0' }, children);
      }

      function Button({ variant = 'ghost', busy, disabled, children, title, ...rest }) {
        return h(
          'button',
          {
            type: 'button',
            className: `qd-btn qd-btn-${variant}`,
            disabled: disabled || busy,
            title,
            'aria-busy': busy ? 'true' : undefined,
            ...rest,
          },
          busy ? h('span', { className: 'qd-spinner', 'aria-hidden': true }) : null,
          children,
        );
      }

      function Switch({ checked, onChange, label, disabled }) {
        return h(
          'label',
          { className: `qd-switch ${disabled ? 'qd-disabled' : ''}`, title: label },
          h('input', { type: 'checkbox', checked, disabled, onChange: (event) => onChange(event.target.checked) }),
          h('span', { className: 'qd-switch-track', 'aria-hidden': true }, h('span', { className: 'qd-switch-thumb' })),
          h('span', { className: 'qd-switch-label' }, label),
        );
      }

      const STATE_META = {
        stopped: { text: '已停止', tone: 'idle' },
        starting: { text: '启动中', tone: 'busy' },
        'waiting-login': { text: '等待登录', tone: 'wait' },
        running: { text: '运行中', tone: 'ok' },
        degraded: { text: '连接异常', tone: 'warn' },
        partial: { text: '部分运行', tone: 'warn' },
        stopping: { text: '停止中', tone: 'busy' },
        external: { text: '已连接外部实例', tone: 'info' },
        error: { text: '失败', tone: 'error' },
      };

      function stateMeta(state) {
        return STATE_META[state] || { text: state || '未知', tone: 'idle' };
      }

      function Seqi({ step }) {
        const glyph = { done: '✓', active: '◐', waiting: '◷', failed: '!', pending: '·' }[step.state] || '·';
        return h(
          'div',
          { className: `qd-seq-step qd-seq-${step.state}`, title: step.detail || step.label },
          h('span', { className: 'qd-seq-dot', 'aria-hidden': true }, glyph),
          h('span', { className: 'qd-seq-label' }, step.label),
        );
      }

      function StatusLine({ service, onAction, busy }) {
        const meta = stateMeta(service.state);
        const running = ['running', 'degraded', 'waiting-login'].includes(service.state);
        const external = service.state === 'external' || service.external;
        const canStart = ['stopped', 'error'].includes(service.state) && !busy;
        // 停止不跟随其它操作禁用：宿主会把新操作排在旧等待之前（例如等待 QQ 登录时点停止）。
        const canStop = (service.managed || running) && !external && busy !== 'stop-all' && busy !== `stop:${service.id}`;
        const canRestart = (service.managed || running) && !external && !busy;
        return h(
          'header',
          { className: 'qd-svc-head' },
          h(
            'div',
            { className: 'qd-svc-title' },
            h('h2', null, SERVICE_META[service.id].name),
            h('span', { className: 'qd-svc-sub' }, SERVICE_META[service.id].subtitle),
            h(Badge, { tone: meta.tone, dot: true }, meta.text),
            service.pid ? h('span', { className: 'qd-svc-pid' }, `pid ${service.pid}`) : null,
            external ? h('span', { className: 'qd-svc-ext' }, '外部实例') : null,
          ),
          h(
            'div',
            { className: 'qd-svc-actions' },
              h(Button, { variant: 'primary', busy: busy === `start:${service.id}`, disabled: !canStart, onClick: () => onAction('start', service.id), title: canStart ? '启动该服务' : '当前状态无需启动' }, '启动'),
            h(Button, { variant: 'danger', disabled: !canStop, onClick: () => onAction('stop', service.id), title: external ? '外部实例不会被工具台停止' : canStop ? '停止该服务' : '当前无可停止的托管实例' }, '停止'),
            h(Button, { disabled: !canRestart, onClick: () => onAction('restart', service.id), title: '先停止再启动' }, '重启'),
          ),
        );
      }

      // ---------------------------------------------------------------- 终端

      const ANSI_COLORS = {
        30: '#5b6474', 31: '#e5534b', 32: '#3fb950', 33: '#d29922', 34: '#4c8dff', 35: '#bc8cff', 36: '#39c5cf', 37: '#c9d1d9',
        90: '#7d8590', 91: '#ff7b72', 92: '#7ee787', 93: '#e3b341', 94: '#79c0ff', 95: '#d2a8ff', 96: '#56d4dd', 97: '#f0f6fc',
      };

      function ansiToSpans(text) {
        const spans = [];
        const re = /\u001b\[([0-9;]*)m/g;
        let last = 0;
        let fg = null;
        let bold = false;
        let dim = false;
        let underline = false;
        let match;
        const push = (value) => {
          if (!value) return;
          spans.push({ text: value, fg, bold, dim, underline });
        };
        while ((match = re.exec(text)) !== null) {
          push(text.slice(last, match.index));
          last = re.lastIndex;
          const codes = (match[1] || '0').split(';').filter(Boolean).map(Number);
          if (!codes.length) codes.push(0);
          for (let i = 0; i < codes.length; i += 1) {
            const code = codes[i];
            if (code === 0) {
              fg = null;
              bold = false;
              dim = false;
              underline = false;
            } else if (code === 1) bold = true;
            else if (code === 2) dim = true;
            else if (code === 4) underline = true;
            else if (code === 22) {
              bold = false;
              dim = false;
            } else if (code === 24) underline = false;
            else if (code === 39) fg = null;
            else if (ANSI_COLORS[code]) fg = ANSI_COLORS[code];
            else if (code === 38 && codes[i + 1] === 5) {
              const n = codes[i + 2];
              fg = n >= 16 ? hsv256(n) : ANSI_COLORS[30 + (n % 8)] || '#c9d1d9';
              i += 2;
            } else if (code === 38 && codes[i + 1] === 2) {
              fg = `rgb(${codes[i + 2] || 0},${codes[i + 3] || 0},${codes[i + 4] || 0})`;
              i += 4;
            }
          }
        }
        push(text.slice(last));
        return spans;
      }

      function hsv256(n) {
        const level = (v) => Math.round((v / 5) * 255);
        if (n < 16) return '#c9d1d9';
        if (n >= 232) {
          const v = 8 + (n - 232) * 10;
          return `rgb(${v},${v},${v})`;
        }
        const idx = n - 16;
        return `rgb(${level(Math.floor(idx / 36))},${level(Math.floor(idx / 6) % 6)},${level(idx % 6)})`;
      }

      function levelOf(text) {
        const plain = text.replace(/\u001b\[[0-9;]*m/g, '');
        if (/\b(ERROR|FATAL|错误|失败)\b/i.test(plain)) return 'error';
        if (/\b(WARN|警告)\b/i.test(plain)) return 'warn';
        if (/\b(DEBUG)\b/i.test(plain)) return 'dim';
        if (/\b(INFO|已就绪|已启动|已连接)\b/i.test(plain)) return 'info';
        return 'normal';
      }

      function LogLine({ line, query }) {
        const spans = useMemo(() => ansiToSpans(line.text), [line.text]);
        const level = useMemo(() => levelOf(line.text), [line.text]);
        const content = [];
        for (let i = 0; i < spans.length; i += 1) {
          const span = spans[i];
          const style = {
            color: span.fg || undefined,
            fontWeight: span.bold ? 600 : undefined,
            opacity: span.dim ? 0.7 : undefined,
            textDecoration: span.underline ? 'underline' : undefined,
          };
          if (query) {
            const lower = span.text.toLowerCase();
            const needle = query.toLowerCase();
            let cursor = 0;
            let index = lower.indexOf(needle, cursor);
            while (index >= 0) {
              content.push(span.text.slice(cursor, index));
              content.push(h('mark', { key: `${i}-${index}` }, span.text.slice(index, index + needle.length)));
              cursor = index + needle.length;
              index = lower.indexOf(needle, cursor);
            }
            content.push(h('span', { key: `${i}-t`, style }, span.text.slice(cursor)));
          } else {
            content.push(h('span', { key: i, style }, span.text));
          }
        }
        const hasTime = /^\d{2}:\d{2}:\d{2}/.test(line.text);
        return h(
          'div',
          { className: `qd-log-line qd-log-${line.stream === 'stderr' ? 'err' : level}`, 'data-seq': line.seq },
          hasTime ? null : h('span', { className: 'qd-log-time' }, line.time || ''),
          h('span', { className: 'qd-log-text' }, content),
        );
      }

      function Terminal({ service, lines, onAction, busy }) {
        const meta = SERVICE_META[service.id];
        const [open, setOpen] = useState(() => localStorage.getItem('qd.terminalOpen') !== '0');
        const [height, setHeight] = useState(() => {
          const saved = Number(localStorage.getItem('qd.terminalHeight'));
          return Number.isFinite(saved) && saved >= 90 ? saved : 200;
        });
        const [query, setQuery] = useState('');
        const [paused, setPaused] = useState(false);
        const [expanded, setExpanded] = useState(false);
        const [copied, setCopied] = useState('');
        const bodyRef = useRef(null);
        const dragRef = useRef(null);

        const filtered = useMemo(() => {
          const needle = query.trim().toLowerCase();
          const list = needle ? lines.filter((line) => line.text.toLowerCase().includes(needle)) : lines;
          return list.slice(-1200);
        }, [lines, query]);

        useEffect(() => {
          if (paused || !open || expanded) return;
          const el = bodyRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        }, [filtered.length, paused, open, expanded]);

        useEffect(() => {
          localStorage.setItem('qd.terminalOpen', open ? '1' : '0');
        }, [open]);
        useEffect(() => {
          localStorage.setItem('qd.terminalHeight', String(height));
        }, [height]);

        useEffect(() => {
          const onMove = (event) => {
            const start = dragRef.current;
            if (!start) return;
            const next = Math.min(620, Math.max(90, start.height + (start.y - event.clientY)));
            setHeight(next);
          };
          const onUp = () => {
            dragRef.current = null;
            document.body.classList.remove('qd-resizing');
          };
          window.addEventListener('pointermove', onMove);
          window.addEventListener('pointerup', onUp);
          return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
          };
        }, []);

        const copy = async () => {
          const text = filtered.map((line) => `${line.time} ${line.text}`).join('\n');
          try {
            await navigator.clipboard.writeText(text);
            setCopied('已复制');
          } catch {
            try {
              const area = document.createElement('textarea');
              area.value = text;
              document.body.appendChild(area);
              area.select();
              document.execCommand('copy');
              area.remove();
              setCopied('已复制');
            } catch {
              setCopied('复制失败');
            }
          }
          setTimeout(() => setCopied(''), 1500);
        };

        const exportLog = async () => {
          try {
            const res = await fetch(`${BASE}/api/export?service=${service.id}`, { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = `${service.id}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            setTimeout(() => URL.revokeObjectURL(url), 4000);
          } catch (error) {
            setCopied(`导出失败：${error.message}`);
            setTimeout(() => setCopied(''), 2500);
          }
        };

        const terminalBody = h(
          'div',
          { className: 'qd-term-body', ref: bodyRef, role: 'log', 'aria-label': `${meta.name} 实时输出` },
          filtered.length
            ? filtered.map((line) => h(LogLine, { key: `${line.seq}-${line.at}`, line, query: query.trim() }))
            : h('div', { className: 'qd-term-empty' }, busy ? '正在启动，日志即将出现…' : '暂无输出。服务启动后这里会实时显示 stdout / stderr。'),
        );

        const tools = h(
          'div',
          { className: 'qd-term-tools' },
          h('input', {
            className: 'qd-input qd-term-search',
            placeholder: '搜索日志…',
            value: query,
            onChange: (event) => setQuery(event.target.value),
            'aria-label': '搜索日志',
          }),
          h('span', { className: 'qd-term-count' }, query.trim() ? `${filtered.length} / ${lines.length}` : `${lines.length} 行`),
          h(Button, { onClick: () => setPaused((v) => !v), variant: paused ? 'warn' : 'ghost', title: '暂停/恢复自动滚动' }, paused ? '已暂停滚动' : '暂停滚动'),
          h(Button, { onClick: copy, title: '复制当前显示内容' }, copied || '复制'),
          h(Button, { onClick: () => onAction('clear-logs', service.id), disabled: busy, title: '清空显示缓存（不影响业务数据）' }, '清空'),
          h(Button, { onClick: exportLog, title: '导出脱敏后的日志文件' }, '导出'),
          h(Button, { onClick: () => setExpanded((v) => !v), title: '放大/还原终端' }, expanded ? '还原' : '放大'),
          h(Button, { onClick: () => setOpen(false), title: '折叠终端' }, '折叠'),
        );

        return h(
          'section',
          { className: `qd-term ${open ? '' : 'qd-term-closed'} ${expanded ? 'qd-term-expanded' : ''}`, style: open && !expanded ? { height: `${height}px` } : undefined },
          h(
            'div',
            { className: 'qd-term-head' },
            h('span', { className: 'qd-term-title' }, h('span', { className: 'qd-term-dot', 'aria-hidden': true }), `${meta.name} 终端输出`),
            h('span', { className: 'qd-term-hint' }, '真实 stdout / stderr · 已脱敏'),
            h('span', { className: 'qd-spacer' }),
            open ? tools : h(Button, { onClick: () => setOpen(true) }, '展开终端'),
          ),
          open ? h(
            React.Fragment,
            null,
            expanded ? null : h('div', {
              className: 'qd-term-resize',
              role: 'separator',
              'aria-label': '调整终端高度',
              onPointerDown: (event) => {
                event.preventDefault();
                dragRef.current = { y: event.clientY, height };
                document.body.classList.add('qd-resizing');
              },
            }),
            terminalBody,
          ) : null,
        );
      }

      // ---------------------------------------------------------------- 控制台

      const WIN_MIN_W = 460;
      const WIN_MIN_H = 320;
      const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

      function consoleWindowKey(serviceId) {
        return `qd.consoleWin.${serviceId}`;
      }

      function defaultConsoleRect() {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const width = clamp(Math.round(vw * 0.86), 720, 1480);
        const height = clamp(Math.round(vh * 0.84), 520, 980);
        return {
          x: Math.max(8, Math.round((vw - width) / 2)),
          y: Math.max(8, Math.round((vh - height) / 2)),
          w: Math.min(width, vw - 16),
          h: Math.min(height, vh - 16),
        };
      }

      function clampConsoleRect(rect) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const w = clamp(rect.w, WIN_MIN_W, Math.max(WIN_MIN_W, vw - 8));
        const h = clamp(rect.h, WIN_MIN_H, Math.max(WIN_MIN_H, vh - 8));
        return {
          x: clamp(rect.x, -w + 160, vw - 140),
          y: clamp(rect.y, 0, vh - 60),
          w,
          h,
        };
      }

      function loadConsoleRect(serviceId) {
        try {
          const raw = localStorage.getItem(consoleWindowKey(serviceId));
          if (!raw) return null;
          const saved = JSON.parse(raw);
          if (!saved || !Number.isFinite(saved.w) || !Number.isFinite(saved.h)) return null;
          if (saved.w < WIN_MIN_W || saved.h < WIN_MIN_H) return null;
          return clampConsoleRect({
            x: Number(saved.x) || 0,
            y: Number(saved.y) || 0,
            w: Number(saved.w),
            h: Number(saved.h),
          });
        } catch {
          return null;
        }
      }

      function ConsolePane({ service, portalUrl, theme, onAction, busy }) {
        const meta = SERVICE_META[service.id];
        const [scale, setScale] = useState(() => Number(localStorage.getItem(`qd.scale.${service.id}`)) || 1);
        const [nonce, setNonce] = useState(0);
        const [loaded, setLoaded] = useState(false);
        const [expanded, setExpanded] = useState(false);
        const [maximized, setMaximized] = useState(false);
        const [rect, setRect] = useState(null);
        const rectRef = useRef(null);
        const dragRef = useRef(null);
        const frameRef = useRef(null);

        useEffect(() => {
          localStorage.setItem(`qd.scale.${service.id}`, String(scale));
        }, [scale, service.id]);

        const updateRect = useCallback((next) => {
          rectRef.current = next;
          setRect(next);
        }, []);

        const persistRect = useCallback(() => {
          if (!rectRef.current) return;
          try {
            localStorage.setItem(consoleWindowKey(service.id), JSON.stringify(rectRef.current));
          } catch {
            /* localStorage 可能被禁用，窗口仍可在本次会话内使用 */
          }
        }, [service.id]);

        const openWindow = useCallback(() => {
          const saved = loadConsoleRect(service.id);
          const next = clampConsoleRect(saved || defaultConsoleRect());
          updateRect(next);
          setMaximized(false);
          setExpanded(true);
        }, [service.id, updateRect]);

        const closeWindow = useCallback(() => {
          persistRect();
          setExpanded(false);
          setMaximized(false);
        }, [persistRect]);

        const toggleMaximized = useCallback(() => {
          if (!expanded) return;
          if (!maximized) {
            setMaximized(true);
            updateRect({ x: 8, y: 8, w: Math.max(WIN_MIN_W, window.innerWidth - 16), h: Math.max(WIN_MIN_H, window.innerHeight - 16) });
          } else {
            setMaximized(false);
            const saved = loadConsoleRect(service.id);
            updateRect(clampConsoleRect(saved || defaultConsoleRect()));
          }
        }, [expanded, maximized, service.id, updateRect]);

        // 拖动 / 缩放窗口：只在展开时挂 window 监听，关闭即卸载。
        useEffect(() => {
          if (!expanded) return undefined;
          const onMove = (event) => {
            const drag = dragRef.current;
            if (!drag) return;
            const dx = event.clientX - drag.sx;
            const dy = event.clientY - drag.sy;
            if (drag.mode === 'move') {
              updateRect({
                x: clamp(drag.rect.x + dx, -drag.rect.w + 160, window.innerWidth - 140),
                y: clamp(drag.rect.y + dy, 0, window.innerHeight - 60),
                w: drag.rect.w,
                h: drag.rect.h,
              });
              return;
            }
            let { x, y, w, h } = drag.rect;
            if (drag.mode.includes('e')) w += dx;
            if (drag.mode.includes('s')) h += dy;
            if (drag.mode.includes('w')) {
              w -= dx;
              x += dx;
            }
            if (drag.mode.includes('n')) {
              h -= dy;
              y += dy;
            }
            if (w < WIN_MIN_W) {
              if (drag.mode.includes('w')) x -= WIN_MIN_W - w;
              w = WIN_MIN_W;
            }
            if (h < WIN_MIN_H) {
              if (drag.mode.includes('n')) y -= WIN_MIN_H - h;
              h = WIN_MIN_H;
            }
            updateRect({
              x: clamp(x, -w + 160, window.innerWidth - 140),
              y: clamp(y, 0, window.innerHeight - 60),
              w,
              h,
            });
          };
          const onUp = () => {
            if (!dragRef.current) return;
            dragRef.current = null;
            document.body.classList.remove('qd-win-dragging');
            persistRect();
          };
          window.addEventListener('pointermove', onMove);
          window.addEventListener('pointerup', onUp);
          window.addEventListener('pointercancel', onUp);
          return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            document.body.classList.remove('qd-win-dragging');
          };
        }, [expanded, persistRect, updateRect]);

        // 视口变化时把窗口收回到可见范围内
        useEffect(() => {
          if (!expanded || !rectRef.current) return undefined;
          const onResize = () => {
            const next = clampConsoleRect(rectRef.current);
            updateRect(next);
          };
          window.addEventListener('resize', onResize);
          return () => window.removeEventListener('resize', onResize);
        }, [expanded, updateRect]);

        useEffect(() => {
          if (!expanded) return undefined;
          const onKey = (event) => {
            if (event.key === 'Escape') closeWindow();
          };
          window.addEventListener('keydown', onKey);
          return () => window.removeEventListener('keydown', onKey);
        }, [expanded, closeWindow]);

        const startDrag = useCallback((event) => {
          if (event.button !== 0 && event.pointerType === 'mouse') return;
          if (event.target.closest('button, select, input, textarea, a')) return;
          if (!rectRef.current) return;
          event.preventDefault();
          dragRef.current = { mode: 'move', sx: event.clientX, sy: event.clientY, rect: { ...rectRef.current } };
          document.body.classList.add('qd-win-dragging');
        }, []);

        const startResize = useCallback((mode) => (event) => {
          if (event.button !== 0 && event.pointerType === 'mouse') return;
          if (!rectRef.current) return;
          event.preventDefault();
          event.stopPropagation();
          dragRef.current = { mode, sx: event.clientX, sy: event.clientY, rect: { ...rectRef.current } };
          document.body.classList.add('qd-win-dragging');
        }, []);

        const src = useMemo(() => {
          if (!portalUrl) return null;
          const url = new URL(portalUrl);
          url.searchParams.set('theme', theme);
          url.searchParams.set('_v', String(nonce));
          return url.toString();
        }, [portalUrl, theme, nonce]);

        useEffect(() => {
          setLoaded(false);
          const timer = setTimeout(() => setLoaded(true), 12000);
          return () => clearTimeout(timer);
        }, [src]);

        // 只有控制台真就绪的状态才挂 iframe：启动中挂载会在上游端口还没监听时把 502 页面缓存下来。
        const showFrame = Boolean(src) && ['running', 'external', 'degraded', 'waiting-login'].includes(service.state);
        const frame = showFrame
          ? h('iframe', {
              ref: frameRef,
              className: 'qd-frame',
              src,
              title: `${meta.name} 控制台`,
              sandbox: 'allow-same-origin allow-scripts allow-forms allow-modals allow-popups allow-downloads',
              onLoad: () => setLoaded(true),
            })
          : h(
              'div',
              { className: 'qd-frame-placeholder' },
              h('div', { className: 'qd-frame-placeholder-title' }, `${meta.consoleLabel}暂不可用`),
              h('p', null, service.state === 'stopped'
                ? '服务尚未启动。点击上方「启动」后，控制台会在服务就绪时自动加载。'
                : service.state === 'starting'
                  ? '服务正在启动，控制台就绪后会自动加载。'
                  : service.state === 'stopping'
                    ? '服务正在停止，控制台已暂时卸载。'
                    : service.error || '门户尚未就绪，请稍候或重启服务。'),
              service.nextStep ? h('p', { className: 'qd-muted' }, service.nextStep) : null,
            );

        const head = h(
          'div',
          {
            className: 'qd-console-head',
            onPointerDown: expanded ? startDrag : undefined,
            onDoubleClick: expanded
              ? (event) => {
                  if (event.target.closest('button, select, input, textarea, a')) return;
                  toggleMaximized();
                }
              : undefined,
            title: expanded ? '拖动标题栏移动窗口，双击切换最大化' : undefined,
          },
          h('span', { className: 'qd-console-title' }, expanded ? `${meta.consoleLabel} · 独立窗口` : meta.consoleLabel),
          h('span', { className: 'qd-console-url' }, portalUrl ? '本机受限门户' : '未就绪'),
          expanded ? h('span', { className: 'qd-console-hint' }, '拖动移动 · 拖拽边缘/角调整大小') : null,
          h('span', { className: 'qd-spacer' }),
          h(
            'select',
            {
              className: 'qd-select',
              value: scale,
              onChange: (event) => setScale(Number(event.target.value)),
              title: '控制台缩放',
              'aria-label': '控制台缩放',
            },
            [0.8, 0.9, 1, 1.1, 1.25].map((value) => h('option', { key: value, value }, `${Math.round(value * 100)}%`)),
          ),
          h(Button, { onClick: () => setNonce((v) => v + 1), title: '重新加载控制台' }, '刷新'),
          expanded
            ? h(Button, { onClick: toggleMaximized, title: '最大化 / 还原窗口' }, maximized ? '还原大小' : '最大化')
            : null,
          expanded
            ? h(Button, { onClick: closeWindow, title: '关闭独立窗口（Esc）' }, '关闭')
            : h(Button, { onClick: openWindow, title: '在独立大窗口中打开控制台（可拖动、可缩放）' }, '放大'),
        );

        const body = h(
          'div',
          { className: 'qd-frame-wrap' },
          h('div', { className: 'qd-frame-scale', style: { zoom: String(scale) } }, frame),
          showFrame && !loaded ? h('div', { className: 'qd-frame-loading' }, h('span', { className: 'qd-spinner' }), `正在加载 ${meta.name} 控制台…`) : null,
        );

        if (!expanded) {
          return h('section', { className: 'qd-console' }, head, body);
        }

        const handle = (mode) => h('div', {
          key: mode,
          className: `qd-win-resize qd-win-resize-${mode}`,
          onPointerDown: startResize(mode),
          'aria-hidden': true,
        });

        return h(
          'section',
          {
            className: `qd-console qd-console-expanded ${maximized ? 'qd-console-maximized' : ''}`,
            style: rect ? { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` } : undefined,
            role: 'dialog',
            'aria-label': `${meta.consoleLabel}独立窗口`,
          },
          head,
          body,
          ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(handle),
        );
      }

      // ---------------------------------------------------------------- 设置

      function SettingsPanel({ state, onClose, onSaved }) {
        const [form, setForm] = useState(() => ({ ...state.settings, timeouts: { ...state.settings.timeouts }, consolePorts: { ...state.settings.consolePorts } }));
        const [password, setPassword] = useState('');
        const [busy, setBusy] = useState(false);
        const [message, setMessage] = useState(null);
        const credentials = state.auth?.snowluma || {};

        const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));
        const setTimeoutValue = (key, value) => setForm((prev) => ({ ...prev, timeouts: { ...prev.timeouts, [key]: Number(value) } }));

        const save = async () => {
          setBusy(true);
          setMessage(null);
          try {
            const data = await post('/api/settings', { settings: form });
            onSaved(data.settings);
            setMessage({ tone: 'ok', text: '设置已保存' });
          } catch (error) {
            setMessage({ tone: 'error', text: error.message });
          } finally {
            setBusy(false);
          }
        };

        const savePassword = async () => {
          if (!password) return;
          setBusy(true);
          setMessage(null);
          try {
            const data = await post('/api/credentials', { snowlumaPassword: password });
            setPassword('');
            setMessage({ tone: data.result?.login?.ok ? 'ok' : 'warn', text: data.result?.login?.ok ? '密码已安全保存，并已自动登录成功' : `密码已保存；自动登录结果：${data.result?.login?.error || '等待下一次启动'}` });
            onSaved(null, true);
          } catch (error) {
            setMessage({ tone: 'error', text: error.message });
          } finally {
            setBusy(false);
          }
        };

        const clearPassword = async () => {
          setBusy(true);
          try {
            await post('/api/credentials', { action: 'clear' });
            setMessage({ tone: 'warn', text: '已清除保存的 SnowLuma 密码（服务端会话令牌保留到过期）' });
            onSaved(null, true);
          } catch (error) {
            setMessage({ tone: 'error', text: error.message });
          } finally {
            setBusy(false);
          }
        };

        const relogin = async () => {
          setBusy(true);
          try {
            const data = await post('/api/action', { action: 'login-snowluma' });
            setMessage({ tone: data.result?.ok ? 'ok' : 'warn', text: data.result?.ok ? '已用保存的密码登录 SnowLuma' : `自动登录失败：${data.result?.error || '未知原因'}` });
          } catch (error) {
            setMessage({ tone: 'error', text: error.message });
          } finally {
            setBusy(false);
          }
        };

        const resetAll = async () => {
          setBusy(true);
          try {
            const data = await post('/api/settings', { action: 'reset' });
            setForm({ ...data.settings, timeouts: { ...data.settings.timeouts }, consolePorts: { ...data.settings.consolePorts } });
            onSaved(data.settings);
            setMessage({ tone: 'ok', text: '已恢复默认设置' });
          } catch (error) {
            setMessage({ tone: 'error', text: error.message });
          } finally {
            setBusy(false);
          }
        };

        const field = (label, key, hint, type = 'text') => h(
          'label',
          { className: 'qd-field' },
          h('span', { className: 'qd-field-label' }, label),
          h('input', {
            className: 'qd-input',
            type,
            value: form[key] ?? '',
            onChange: (event) => set(key, event.target.value),
          }),
          hint ? h('span', { className: 'qd-field-hint' }, hint) : null,
        );

        return h(
          'div',
          { className: 'qd-settings-backdrop', role: 'dialog', 'aria-modal': 'true', 'aria-label': '工具台设置' },
          h(
            'div',
            { className: 'qd-settings' },
            h(
              'header',
              { className: 'qd-settings-head' },
              h('h2', null, '工具台设置'),
              h(Button, { onClick: onClose, 'aria-label': '关闭设置' }, '关闭'),
            ),
            message ? h('div', { className: `qd-callout qd-callout-${message.tone}` }, message.text) : null,
            h(
              'section',
              { className: 'qd-settings-section' },
              h('h3', null, '当前客户端环境'),
              h(
                'div',
                { className: 'qd-kv' },
                h('span', null, 'DSH_HOME'), h('code', null, state.env.dshHome),
                h('span', null, 'DSH_PROFILE'), h('code', null, state.env.dshProfile || '（未设置）'),
                h('span', null, '宿主地址'), h('code', null, state.env.dshOrigin),
                h('span', null, '桥接目标'), h('code', null, state.diagnostics?.bridgeBaseUrl || '（读取不到 config.json）'),
                h('span', null, '认证环境'), h('code', null, state.diagnostics?.bridgeBaseMatchesHost ? '与当前宿主一致' : '与当前宿主不一致，请检查 qqbridge/config.json'),
                h('span', null, '旧自动启动'), h('code', null, state.diagnostics?.autoStartBridge ? '已开启（建议关闭，由工具台统一管理）' : '已关闭（符合预期）'),
              ),
            ),
            h(
              'section',
              { className: 'qd-settings-section' },
              h('h3', null, '服务路径与地址'),
              field('SnowLuma 目录', 'snowLumaDir', '包含 index.mjs 的目录'),
              field('qqbridge 目录', 'qqBridgeDir', '包含 src/bridge.js 与 config.json 的目录'),
              field('Node 可执行文件', 'nodePath', '留空或找不到时会自动回退 SnowLuma 自带 node.exe / Electron 的 Node 模式'),
              h('div', { className: 'qd-field-row' }, field('SnowLuma 控制台地址', 'snowLumaUrl', '端口被占用时会自动探测后续端口'), field('qqbridge 控制台地址', 'qqBridgeConsoleUrl', '默认 http://127.0.0.1:3100')),
              h('div', { className: 'qd-field-row' }, field('OneBot HTTP', 'oneBotHttpUrl', '用于检测 QQ 登录状态'), field('OneBot WebSocket', 'oneBotWsUrl', '仅供确认，桥接使用自身配置')),
            ),
            h(
              'section',
              { className: 'qd-settings-section' },
              h('h3', null, 'SnowLuma 自动认证'),
              h(
                'p',
                { className: 'qd-muted' },
                credentials.configured
                  ? '已保存密码（不会显示原文）。登录成功后会话令牌会安全保存并优先复用；密码错误不会自动重试，避免触发控制台 15 分钟锁定。'
                  : 'SnowLuma 只保存密码哈希，无法从哈希还原。录入一次密码后即可自动登录；也可以直接在控制台里手动登录，工具台会复用捕获到的会话。',
              ),
              h(
                'div',
                { className: 'qd-field-row' },
                h(
                  'label',
                  { className: 'qd-field qd-field-grow' },
                  h('span', { className: 'qd-field-label' }, credentials.configured ? '更新 SnowLuma 密码' : '录入 SnowLuma 密码'),
                  h('input', {
                    className: 'qd-input',
                    type: 'password',
                    value: password,
                    placeholder: '只写入系统凭据存储，不进入源码与日志',
                    onChange: (event) => setPassword(event.target.value),
                    autoComplete: 'new-password',
                  }),
                ),
                h('div', { className: 'qd-inline-actions' },
                  h(Button, { variant: 'primary', disabled: !password, busy, onClick: savePassword }, '保存并登录'),
                  h(Button, { disabled: !credentials.configured, busy, onClick: relogin }, '立即重试登录'),
                  h(Button, { variant: 'danger', disabled: !credentials.configured, busy, onClick: clearPassword }, '清除密码'),
                ),
              ),
            ),
            h(
              'section',
              { className: 'qd-settings-section' },
              h('h3', null, '启动与生命周期'),
              h(
                'div',
                { className: 'qd-settings-grid' },
                h(Switch, { checked: form.autoStart, onChange: (v) => set('autoStart', v), label: '随客户端自动启动 SnowLuma → qqbridge' }),
                h(Switch, { checked: form.stopOnExit, onChange: (v) => set('stopOnExit', v), label: '宿主真正退出时停止插件托管的进程' }),
                h(Switch, { checked: false, disabled: true, onChange: () => {}, label: '自动重启（默认关闭，不提供无限重启）' }),
              ),
              h('p', { className: 'qd-muted' }, '关闭工具台页面不会停止服务；宿主崩溃或强杀时可能留下孤儿进程，下次启动会以「外部实例」方式连接，不会重复启动。'),
            ),
            h(
              'section',
              { className: 'qd-settings-section' },
              h('h3', null, '控制台门户'),
              h(
                'div',
                { className: 'qd-field-row' },
                h(
                  'label',
                  { className: 'qd-field' },
                  h('span', { className: 'qd-field-label' }, 'SnowLuma 门户端口'),
                  h('input', { className: 'qd-input', type: 'number', value: form.consolePorts?.snowluma ?? 3310, onChange: (event) => set('consolePorts', { ...form.consolePorts, snowluma: Number(event.target.value) }) }),
                ),
                h(
                  'label',
                  { className: 'qd-field' },
                  h('span', { className: 'qd-field-label' }, 'qqbridge 门户端口'),
                  h('input', { className: 'qd-input', type: 'number', value: form.consolePorts?.qqbridge ?? 3311, onChange: (event) => set('consolePorts', { ...form.consolePorts, qqbridge: Number(event.target.value) }) }),
                ),
                h(
                  'label',
                  { className: 'qd-field' },
                  h('span', { className: 'qd-field-label' }, '日志缓存行数'),
                  h('input', { className: 'qd-input', type: 'number', value: form.logLines ?? 4000, onChange: (event) => set('logLines', Number(event.target.value)) }),
                ),
              ),
              h('p', { className: 'qd-muted' }, '门户只监听 127.0.0.1，并在边界剥离第三方 X-Frame-Options/CSP、注入各自认证；不修改第三方程序文件。'),
            ),
            h(
              'section',
              { className: 'qd-settings-section' },
              h('h3', null, '超时'),
              h(
                'div',
                { className: 'qd-settings-grid' },
                ['snowLumaReadyMs', 'oneBotReadyMs', 'qqLoginWaitMs', 'qqBridgeReadyMs', 'bridgeLinkMs', 'stopGraceMs'].map((key) => h(
                  'label',
                  { className: 'qd-field', key },
                  h('span', { className: 'qd-field-label' }, ({ snowLumaReadyMs: 'SnowLuma 就绪', oneBotReadyMs: 'OneBot 就绪', qqLoginWaitMs: '等待 QQ 登录', qqBridgeReadyMs: 'qqbridge 就绪', bridgeLinkMs: '桥接连接', stopGraceMs: '停止宽限' })[key]),
                  h('input', { className: 'qd-input', type: 'number', value: form.timeouts?.[key] ?? 0, onChange: (event) => setTimeoutValue(key, event.target.value) }),
                )),
              ),
            ),
            h(
              'footer',
              { className: 'qd-settings-foot' },
              h(Button, { variant: 'danger', busy, onClick: resetAll }, '恢复默认'),
              h('span', { className: 'qd-spacer' }),
              h(Button, { variant: 'primary', busy, onClick: save }, '保存设置'),
            ),
          ),
        );
      }

      // ---------------------------------------------------------------- 页面

      function ServiceCard({ service, state, logs, theme, onAction, busy }) {
        const meta = SERVICE_META[service.id];
        const [showTerminalHint, setShowTerminalHint] = useState(false);
        const tone = stateMeta(service.state).tone;
        const progress = service.progress || [];
        const failed = progress.find((item) => item.state === 'failed');
        return h(
          'article',
          { className: `qd-card qd-card-${tone}`, style: { '--qd-accent': meta.accent } },
          h(StatusLine, { service, onAction, busy }),
          h(
            'div',
            { className: 'qd-svc-status' },
            h('div', { className: 'qd-svc-line' },
              h('span', { className: `qd-dot qd-dot-${tone}`, 'aria-hidden': true }),
              h('span', { className: 'qd-svc-detail' }, service.detail || service.error || ''),
              service.uptimeMs ? h('span', { className: 'qd-muted' }, `运行 ${formatDuration(service.uptimeMs)}`) : null,
              service.state === 'external' ? h(Badge, { tone: 'info' }, '已连接外部实例') : null,
            ),
            service.onebot && service.id === 'snowluma'
              ? h('div', { className: 'qd-svc-line qd-svc-line-sub' },
                  h('span', { className: 'qd-mini' }, `QQ ${service.onebot.online ? '在线' : '未登录'}`),
                  service.onebot.nickname ? h('span', { className: 'qd-mini' }, service.onebot.nickname) : null,
                  h('span', { className: 'qd-mini' }, service.onebot.detail || ''),
                  service.onebot.httpUrl ? h('code', { className: 'qd-code' }, service.onebot.httpUrl) : null,
                )
              : null,
            service.id === 'qqbridge'
              ? h('div', { className: 'qd-svc-line qd-svc-line-sub' },
                  h('span', { className: 'qd-mini' }, `DSH ${service.link?.dshReady ? '已连接' : '未连接'}`),
                  service.link?.mode ? h('span', { className: 'qd-mini' }, `模式 ${service.link.mode}`) : null,
                  h('span', { className: 'qd-mini' }, `上游 ${service.upstream?.connected ? (service.upstream.degraded ? '异常' : '正常') : '未连接'}`),
                  service.link?.baseUrl ? h('code', { className: 'qd-code' }, service.link.baseUrl) : null,
                )
              : null,
            service.error || service.nextStep
              ? h('div', { className: `qd-callout qd-callout-${failed || service.error ? 'error' : 'warn'}` },
                  h('div', null, h('strong', null, failed ? `失败环节：${failed.label}` : '下一步'), h('span', null, service.error ? ` ${service.error}` : '')),
                  service.nextStep ? h('div', null, service.nextStep) : null,
                  h('button', { type: 'button', className: 'qd-link', onClick: () => setShowTerminalHint((v) => !v) }, showTerminalHint ? '收起终端提示' : '查看终端输出'),
                  showTerminalHint ? h('div', { className: 'qd-muted' }, '终端就在本卡片底部；若已折叠，点击「展开终端」。') : null,
                )
              : null,
            h('div', { className: 'qd-progress' },
              progress.map((item) => h('span', { key: item.id, className: `qd-progress-step qd-ps-${item.state}`, title: item.detail || item.label },
                h('span', { className: 'qd-progress-dot', 'aria-hidden': true }),
                h('span', null, item.label),
              )),
            ),
          ),
          h(ConsolePane, { service, portalUrl: state[service.id]?.portalUrl, theme, onAction, busy }),
          h(Terminal, { service, lines: logs[service.id] || [], onAction, busy }),
        );
      }

      function deskPage() {
        return function Page() {
          const theme = useThemeMode();
          const { state, connected, error, logs, logVersion, refresh } = useDeskState(theme);
          const [busy, setBusy] = useState(null);
          const [toast, setToast] = useState(null);
          const [settingsOpen, setSettingsOpen] = useState(false);
          const [layoutMode, setLayoutMode] = useState(() => localStorage.getItem('qd.layout') || 'auto');
          const [tab, setTab] = useState('snowluma');
          const [width, setWidth] = useState(() => window.innerWidth);

          useEffect(() => {
            const onResize = () => setWidth(window.innerWidth);
            window.addEventListener('resize', onResize);
            return () => window.removeEventListener('resize', onResize);
          }, []);

          useEffect(() => {
            localStorage.setItem('qd.layout', layoutMode);
          }, [layoutMode]);

          useEffect(() => {
            if (!toast) return;
            const timer = setTimeout(() => setToast(null), 4000);
            return () => clearTimeout(timer);
          }, [toast]);

          const runAction = useCallback(async (action, service) => {
            const key = service ? `${action}:${service}` : action;
            setBusy(key);
            try {
              const data = await post('/api/action', { action, service });
              if (!data.ok) setToast({ tone: 'warn', text: data.result?.error || data.result?.warning || '操作未完成，请查看服务状态' });
              else if (data.result?.warning) setToast({ tone: 'warn', text: data.result.warning });
              else if (data.result?.waiting) setToast({ tone: 'info', text: '已进入等待登录：完成登录后会自动继续' });
              else setToast({ tone: 'ok', text: action === 'stop-all' ? '已停止全部服务' : action === 'start-all' ? '启动序列已完成' : '操作已完成' });
            } catch (err) {
              if (!/取消|cancelled/i.test(err.message)) setToast({ tone: 'error', text: err.message });
            } finally {
              setBusy((current) => (current === key ? null : current));
              refresh();
            }
          }, [refresh]);

          const saveAutoStart = useCallback(async (value) => {
            try {
              await post('/api/settings', { settings: { autoStart: value } });
              setToast({ tone: 'ok', text: value ? '已开启：下次客户端启动时自动按顺序启动' : '已关闭随客户端自动启动' });
              refresh();
            } catch (err) {
              setToast({ tone: 'error', text: err.message });
            }
          }, [refresh]);

          const overall = state?.overall || { state: 'starting', text: '读取中', detail: '正在连接宿主状态…' };
          const overallMeta = stateMeta(overall.state === 'stopping' ? 'stopping' : overall.state);
          const twoColumn = layoutMode === 'columns' || (layoutMode === 'auto' && width >= 1180);
          const services = ['snowluma', 'qqbridge'];

          return h(
            'div',
            { className: 'qd-root', 'data-theme': theme, 'data-layout': twoColumn ? 'columns' : 'tabs' },
            h('style', null, STYLE_TEXT),
            h(
              'header',
              { className: 'qd-top' },
              h(
                'div',
                { className: 'qd-brand' },
                h('div', { className: 'qd-logo', 'aria-hidden': true }, h(Icon, { size: 22 })),
                h('div', null,
                  h('h1', null, PANEL_TITLE),
                  h('p', { className: 'qd-brand-sub' }, '客户端内托管 SnowLuma 与 qqbridge · 控制台 / 终端 / 自动认证'),
                ),
              ),
              h(
                'div',
                { className: 'qd-overall' },
                h(Badge, { tone: overallMeta.tone, dot: true }, overall.text),
                h('span', { className: 'qd-overall-detail' }, overall.detail || ''),
                h('span', { className: `qd-link-state ${connected ? 'qd-link-on' : 'qd-link-off'}`, title: connected ? '实时状态通道已连接' : '状态通道重连中' }, connected ? '实时' : '重连中'),
              ),
              h(
                'div',
                { className: 'qd-top-actions' },
                h(Switch, { checked: state?.autoStart ?? false, onChange: saveAutoStart, label: '随客户端自动启动', disabled: !state }),
                h(Button, { variant: 'primary', disabled: Boolean(busy), busy: busy === 'start-all', onClick: () => runAction('start-all') }, '全部启动'),
                h(Button, { variant: 'danger', disabled: busy === 'stop-all' || (!state?.snowluma?.managed && !state?.qqbridge?.managed && overall.state === 'stopped'), busy: busy === 'stop-all', onClick: () => runAction('stop-all') }, '全部停止'),
                h(Button, { onClick: () => setSettingsOpen(true), title: '路径、地址、自动认证与超时' }, '设置'),
              ),
            ),
            h(
              'div',
              { className: 'qd-seq', 'aria-label': '启动顺序' },
              (state?.sequence || []).map((step) => h(Seqi, { key: step.id, step })),
              h('span', { className: 'qd-spacer' }),
              h(
                'div',
                { className: 'qd-layout-toggle', role: 'group', 'aria-label': '布局' },
                ['auto', 'columns', 'tabs'].map((mode) => h('button', {
                  key: mode,
                  type: 'button',
                  className: `qd-seg ${layoutMode === mode ? 'qd-seg-on' : ''}`,
                  onClick: () => setLayoutMode(mode),
                }, ({ auto: '自动', columns: '并排', tabs: '标签' })[mode])),
              ),
            ),
            toast ? h('div', { className: `qd-toast qd-toast-${toast.tone}`, role: 'status' }, toast.text) : null,
            error ? h('div', { className: 'qd-callout qd-callout-error qd-callout-inline' }, `状态接口错误：${error}`) : null,
            state
              ? h(
                  'main',
                  { className: 'qd-main' },
                  !twoColumn
                    ? h('div', { className: 'qd-tabs', role: 'tablist' },
                        services.map((id) => h('button', {
                          key: id,
                          type: 'button',
                          role: 'tab',
                          'aria-selected': tab === id,
                          className: `qd-tab ${tab === id ? 'qd-tab-on' : ''}`,
                          onClick: () => setTab(id),
                        }, `${SERVICE_META[id].name}`, h('span', { className: `qd-tab-state qd-dot-${stateMeta(state[id].state).tone}` }))),
                      )
                    : null,
                  h(
                    'div',
                    { className: 'qd-grid' },
                    services.filter((id) => twoColumn || tab === id).map((id) => h(ServiceCard, {
                      key: id,
                      service: { ...state[id], id },
                      state,
                      logs,
                      theme,
                      onAction: runAction,
                      busy,
                    })),
                  ),
                )
              : h('main', { className: 'qd-main' }, h('div', { className: 'qd-loading' }, h('span', { className: 'qd-spinner' }), '正在读取工具台状态…')),
            settingsOpen && state
              ? h(SettingsPanel, {
                  state,
                  onClose: () => setSettingsOpen(false),
                  onSaved: () => refresh(),
                })
              : null,
            h('footer', { className: 'qd-foot' },
              h('span', null, '只管理本插件启动的进程；外部实例只连接不停止。'),
              h('span', { className: 'qd-spacer' }),
              h('span', null, `DSH_HOME ${state?.env?.dshHome || '—'}`),
            ),
          );
        };
      }

      function formatDuration(ms) {
        const total = Math.max(0, Math.round(Number(ms) || 0));
        if (total < 60000) return `${Math.round(total / 1000)} 秒`;
        const minutes = Math.floor(total / 60000);
        if (minutes < 60) return `${minutes} 分 ${Math.round((total % 60000) / 1000)} 秒`;
        return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
      }

      function Icon({ size = 18, active }) {
        return h(
          'svg',
          { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, style: { display: 'block', color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor' } },
          h('rect', { x: 2, y: 4, width: 20, height: 14, rx: 3, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
          h('path', { d: 'M7 10l3 2.6L7 15M12 15h5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }),
          h('path', { d: 'M8 21h8', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        );
      }

      const Page = deskPage();

      return {
        inject: ['slots', 'layout'],
        __components: { Page },
        apply(ctx) {
          ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_KEY }, Page));
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_KEY,
            order: 62,
            label: PANEL_TITLE,
          }, Icon));
        },
      };
    },
  });

  // ---------------------------------------------------------------- 样式

  const STYLE_TEXT = `
.qd-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;isolation:isolate;--qd-surface:#0d1422;--qd-surface-2:#121b2b}
.qd-root[data-theme="light"]{--qd-surface:#ffffff;--qd-surface-2:#eef3f9}
.qd-root *{box-sizing:border-box}
.qd-root button,.qd-root input,.qd-root select{font-family:inherit}
.qd-top{display:flex;align-items:center;gap:14px;padding:12px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap;background:color-mix(in srgb,var(--qd-surface) 90%,transparent);backdrop-filter:blur(8px)}
.qd-brand{display:flex;align-items:center;gap:10px;min-width:0}
.qd-logo{width:36px;height:36px;border-radius:11px;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent);color:var(--dsw-alias-brand-primary);flex:none}
.qd-brand h1{margin:0;font-size:16px;font-weight:700;letter-spacing:.01em}
.qd-brand-sub{margin:1px 0 0;font-size:11px;color:var(--dsw-alias-label-secondary)}
.qd-overall{display:flex;align-items:center;gap:10px;min-width:0;flex:1 1 260px}
.qd-overall-detail{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qd-link-state{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1)}
.qd-link-on{color:var(--dsw-alias-state-success-primary)}
.qd-link-off{color:var(--dsw-alias-state-warn-primary)}
.qd-top-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-left:auto}
.qd-seq{display:flex;align-items:center;gap:6px;padding:8px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap;background:color-mix(in srgb,var(--qd-surface) 90%,transparent);backdrop-filter:blur(8px)}
.qd-seq-step{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);padding:3px 8px;border-radius:999px;border:1px solid transparent}
.qd-seq-dot{width:16px;height:16px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:10px;border:1px solid var(--dsw-alias-border-l2)}
.qd-seq-done .qd-seq-dot{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent);color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.qd-seq-active{border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.qd-seq-active .qd-seq-dot{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);animation:qd-pulse 1.2s ease-in-out infinite}
.qd-seq-failed .qd-seq-dot{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 15%,transparent)}
.qd-seq-waiting .qd-seq-dot{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
@keyframes qd-pulse{0%,100%{opacity:.5}50%{opacity:1}}
.qd-layout-toggle{display:inline-flex;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden}
.qd-seg{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;padding:4px 9px;cursor:pointer}
.qd-seg-on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}
.qd-main{flex:1;min-height:0;display:flex;flex-direction:column;padding:12px 18px 0;overflow:auto}
.qd-grid{flex:1;min-height:0;display:grid;gap:12px;grid-template-columns:1fr;grid-auto-rows:minmax(480px,1fr)}
.qd-root[data-layout="columns"] .qd-grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
.qd-tabs{display:flex;gap:6px;margin-bottom:8px}
.qd-tab{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:9px;padding:6px 12px;font-size:12px;cursor:pointer}
.qd-tab-on{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);font-weight:600}
.qd-tab-state{width:7px;height:7px;border-radius:50%;display:inline-block;background:var(--dsw-alias-state-idle-primary)}
.qd-card{display:flex;flex-direction:column;min-height:0;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:color-mix(in srgb,var(--qd-surface) 97%,transparent);overflow:hidden;box-shadow:0 6px 24px rgba(0,0,0,.12)}
.qd-card-error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,var(--dsw-alias-border-l1))}
.qd-card-degraded{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 55%,var(--dsw-alias-border-l1))}
.qd-svc-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.qd-svc-title{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.qd-svc-title h2{margin:0;font-size:14px;font-weight:700}
.qd-svc-sub{font-size:11px;color:var(--dsw-alias-label-secondary)}
.qd-svc-pid,.qd-svc-ext{font-size:10px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 6px}
.qd-svc-actions{display:flex;gap:6px;flex-wrap:wrap}
.qd-svc-status{padding:8px 12px;display:flex;flex-direction:column;gap:5px;border-bottom:1px solid var(--dsw-alias-border-l1);min-height:44px}
.qd-svc-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;min-width:0}
.qd-svc-line-sub{font-size:11px;color:var(--dsw-alias-label-secondary)}
.qd-svc-detail{font-weight:600}
.qd-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}
.qd-dot-ok{background:var(--dsw-alias-state-success-primary)}
.qd-dot-warn{background:var(--dsw-alias-state-warn-primary)}
.qd-dot-error{background:var(--dsw-alias-state-error-primary)}
.qd-dot-busy{background:var(--dsw-alias-brand-primary);animation:qd-pulse 1.2s infinite}
.qd-dot-wait{background:var(--dsw-alias-state-warn-primary)}
.qd-dot-info{background:var(--dsw-alias-brand-primary)}
.qd-mini{white-space:nowrap}
.qd-code{font-family:ui-monospace,Consolas,monospace;font-size:10px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:0 5px;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.qd-progress{display:flex;gap:6px;flex-wrap:wrap;margin-top:2px}
.qd-progress-step{display:inline-flex;align-items:center;gap:5px;font-size:10px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 7px}
.qd-progress-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);display:inline-block}
.qd-ps-done .qd-progress-dot{background:var(--dsw-alias-state-success-primary)}
.qd-ps-active .qd-progress-dot{background:var(--dsw-alias-brand-primary);animation:qd-pulse 1.2s infinite}
.qd-ps-failed{border-color:var(--dsw-alias-state-error-primary)}
.qd-ps-failed .qd-progress-dot{background:var(--dsw-alias-state-error-primary)}
.qd-ps-waiting .qd-progress-dot{background:var(--dsw-alias-state-warn-primary)}
.qd-console{flex:1;min-height:220px;display:flex;flex-direction:column;min-width:0;border-top:1px solid var(--dsw-alias-border-l1)}
.qd-console-expanded{position:fixed;z-index:80;display:flex;flex-direction:column;min-width:460px;min-height:320px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--qd-surface);box-shadow:0 28px 90px rgba(0,0,0,.55);overflow:hidden}
.qd-console-expanded .qd-console-head{cursor:move;user-select:none;background:var(--qd-surface)}
.qd-console-expanded .qd-frame-wrap{flex:1;min-height:0}
.qd-console-maximized{border-radius:10px}
.qd-console-hint{font-size:10px;color:var(--dsw-alias-label-secondary);opacity:.8;white-space:nowrap}
.qd-win-resize{position:absolute;z-index:5;background:transparent;touch-action:none}
.qd-win-resize-e{right:0;top:12px;bottom:12px;width:8px;cursor:ew-resize}
.qd-win-resize-w{left:0;top:12px;bottom:12px;width:8px;cursor:ew-resize}
.qd-win-resize-s{bottom:0;left:12px;right:12px;height:8px;cursor:ns-resize}
.qd-win-resize-n{top:0;left:12px;right:12px;height:8px;cursor:ns-resize}
.qd-win-resize-ne{top:0;right:0;width:16px;height:16px;cursor:nesw-resize}
.qd-win-resize-nw{top:0;left:0;width:16px;height:16px;cursor:nwse-resize}
.qd-win-resize-se{bottom:0;right:0;width:18px;height:18px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 0 45%,color-mix(in srgb,var(--dsw-alias-label-secondary) 55%,transparent) 45% 52%,transparent 52% 64%,color-mix(in srgb,var(--dsw-alias-label-secondary) 55%,transparent) 64% 71%,transparent 71%)}
.qd-win-resize-sw{bottom:0;left:0;width:16px;height:16px;cursor:nesw-resize}
body.qd-win-dragging{cursor:grabbing!important;user-select:none!important}
body.qd-win-dragging iframe{pointer-events:none}
.qd-console-head{display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap;background:var(--qd-surface-2)}
.qd-console-title{font-size:12px;font-weight:600}
.qd-console-url{font-size:10px;color:var(--dsw-alias-label-secondary)}
.qd-frame-wrap{position:relative;flex:1;min-height:0;overflow:hidden;background:var(--qd-surface-2)}
.qd-frame-scale{width:100%;height:100%}
.qd-frame{width:100%;height:100%;border:0;display:block;background:#fff;color-scheme:light dark}
.qd-frame-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:10px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 82%,transparent);color:var(--dsw-alias-label-secondary);font-size:12px;backdrop-filter:blur(2px)}
.qd-frame-placeholder{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);background:var(--qd-surface-2)}
.qd-frame-placeholder-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.qd-frame-placeholder p{margin:0;font-size:12px;max-width:60ch}
.qd-term{border-top:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;min-height:0;background:var(--qd-surface);flex:none}
.qd-term-closed{height:auto}
.qd-term-head{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap;row-gap:4px;background:var(--qd-surface)}
.qd-term-title{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600}
.qd-term-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary);display:inline-block}
.qd-term-hint{font-size:10px;color:var(--dsw-alias-label-secondary)}
.qd-term-tools{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:1 1 100%;min-width:0}
.qd-term-search{width:150px;min-height:24px;padding:2px 7px;font-size:11px}
.qd-term-count{font-size:10px;color:var(--dsw-alias-label-secondary);min-width:56px;text-align:right}
.qd-term-resize{height:5px;cursor:ns-resize;background:linear-gradient(to bottom,transparent,color-mix(in srgb,var(--dsw-alias-border-l2) 70%,transparent));flex:none}
body.qd-resizing{cursor:ns-resize!important;user-select:none!important}
.qd-term-body{flex:1;min-height:0;overflow:auto;padding:6px 10px 10px;font-family:ui-monospace,SFMono-Regular,Consolas,"Microsoft YaHei UI",monospace;font-size:11.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word;background:var(--qd-surface-2);color:var(--dsw-alias-label-primary)}
.qd-term-expanded{position:fixed;inset:24px;z-index:70;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;box-shadow:0 24px 80px rgba(0,0,0,.5);height:auto!important;background:var(--qd-surface);padding-bottom:10px}
.qd-term-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35)}
.qd-term-overlay-inner{position:absolute;inset:24px;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,.5)}
.qd-term-overlay-inner .qd-term-body{flex:1;min-height:0}
.qd-term-tools-floating{padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.qd-term-empty{padding:16px;color:var(--dsw-alias-label-secondary);font-family:inherit}
.qd-log-line{display:flex;gap:8px;border-radius:4px;padding:0 2px}
.qd-log-line:hover{background:var(--dsw-alias-bg-layer-1)}
.qd-log-time{color:var(--dsw-alias-label-secondary);opacity:.75;flex:none;font-size:10.5px;padding-top:1px}
.qd-log-text{white-space:pre-wrap;word-break:break-word;min-width:0}
.qd-log-error .qd-log-text{color:var(--dsw-alias-state-error-primary)}
.qd-log-warn .qd-log-text{color:var(--dsw-alias-state-warn-primary)}
.qd-log-info .qd-log-text{color:var(--dsw-alias-label-primary)}
.qd-log-dim .qd-log-text{color:var(--dsw-alias-label-secondary)}
.qd-log-err .qd-log-text{color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 80%,var(--dsw-alias-label-primary))}
.qd-log-text mark{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent);color:inherit;border-radius:2px}
.qd-badge{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.qd-badge[data-dot="1"]::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block}
.qd-badge-ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 60%,transparent)}
.qd-badge-warn{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 60%,transparent)}
.qd-badge-error{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 60%,transparent)}
.qd-badge-busy{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 60%,transparent)}
.qd-badge-wait{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 60%,transparent)}
.qd-badge-info{color:var(--dsw-alias-brand-primary)}
.qd-badge-idle{color:var(--dsw-alias-label-secondary)}
.qd-btn{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 10px;font-size:12px;cursor:pointer;white-space:nowrap;min-height:26px}
.qd-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.qd-btn:disabled{opacity:.45;cursor:not-allowed}
.qd-btn-primary{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-weight:600}
.qd-btn-primary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,transparent)}
.qd-btn-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,var(--dsw-alias-border-l2));color:var(--dsw-alias-state-error-primary)}
.qd-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
.qd-btn-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.qd-spinner{width:11px;height:11px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;display:inline-block;animation:qd-spin .7s linear infinite}
@keyframes qd-spin{to{transform:rotate(360deg)}}
.qd-switch{display:inline-flex;align-items:center;gap:7px;cursor:pointer;font-size:12px;user-select:none}
.qd-switch input{position:absolute;opacity:0;width:1px;height:1px}
.qd-switch-track{width:30px;height:17px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);position:relative;transition:background .15s;flex:none}
.qd-switch-thumb{position:absolute;top:1px;left:1px;width:13px;height:13px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform .15s,background .15s}
.qd-switch input:checked + .qd-switch-track{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);border-color:var(--dsw-alias-brand-primary)}
.qd-switch input:checked + .qd-switch-track .qd-switch-thumb{transform:translateX(13px);background:var(--dsw-alias-brand-primary)}
.qd-switch input:focus-visible + .qd-switch-track{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.qd-switch-label{white-space:nowrap}
.qd-disabled{opacity:.55;cursor:not-allowed}
.qd-input{width:100%;min-height:28px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:7px;padding:3px 8px;font-size:12px}
.qd-input:focus-visible,.qd-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.qd-select{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;font-size:11px;min-height:24px;padding:1px 4px}
.qd-spacer{flex:1}
.qd-muted{color:var(--dsw-alias-label-secondary);font-size:11.5px;margin:2px 0}
.qd-callout{border-radius:9px;padding:7px 10px;font-size:11.5px;border-left:3px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);line-height:1.55}
.qd-callout-error{border-left-color:var(--dsw-alias-state-error-primary)}
.qd-callout-warn{border-left-color:var(--dsw-alias-state-warn-primary)}
.qd-callout-ok{border-left-color:var(--dsw-alias-state-success-primary)}
.qd-callout-info{border-left-color:var(--dsw-alias-brand-primary)}
.qd-callout-inline{margin:8px 18px 0}
.qd-callout div + div{margin-top:3px}
.qd-link{background:transparent;border:0;padding:0;margin-left:6px;color:var(--dsw-alias-brand-primary);font-size:11px;cursor:pointer}
.qd-toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:90;padding:8px 16px;border-radius:10px;font-size:12px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 10px 30px rgba(0,0,0,.25);max-width:min(620px,90vw)}
.qd-toast-ok{border-color:var(--dsw-alias-state-success-primary)}
.qd-toast-warn{border-color:var(--dsw-alias-state-warn-primary)}
.qd-toast-error{border-color:var(--dsw-alias-state-error-primary)}
.qd-toast-info{border-color:var(--dsw-alias-brand-primary)}
.qd-loading{display:flex;align-items:center;justify-content:center;gap:10px;height:240px;color:var(--dsw-alias-label-secondary)}
.qd-foot{display:flex;align-items:center;gap:10px;padding:6px 18px;border-top:1px solid var(--dsw-alias-border-l1);font-size:10.5px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}
.qd-settings-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:80;display:flex;align-items:center;justify-content:center;padding:20px}
.qd-settings{width:min(880px,100%);max-height:min(86vh,860px);overflow:auto;background:var(--qd-surface);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;box-shadow:0 30px 80px rgba(0,0,0,.45);padding:16px 18px}
.qd-settings-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
.qd-settings-head h2{margin:0;font-size:15px}
.qd-settings-section{border-top:1px solid var(--dsw-alias-border-l1);padding:12px 0}
.qd-settings-section h3{margin:0 0 8px;font-size:12.5px}
.qd-field{display:flex;flex-direction:column;gap:3px;font-size:11px;min-width:180px;flex:1}
.qd-field-label{color:var(--dsw-alias-label-secondary)}
.qd-field-hint{color:var(--dsw-alias-label-secondary);opacity:.8;font-size:10.5px}
.qd-field-row{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px;align-items:flex-end}
.qd-field-grow{flex:2}
.qd-settings-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px 12px;align-items:center}
.qd-inline-actions{display:flex;gap:6px;flex-wrap:wrap;padding-bottom:2px}
.qd-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:11.5px}
.qd-kv span{color:var(--dsw-alias-label-secondary)}
.qd-kv code{font-family:ui-monospace,Consolas,monospace;font-size:10.5px;overflow-wrap:anywhere}
.qd-settings-foot{display:flex;align-items:center;gap:8px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:12px;margin-top:6px}
@media (max-width: 720px){
  .qd-top,.qd-seq,.qd-main,.qd-foot{padding-left:10px;padding-right:10px}
  .qd-term-search{width:110px}
  .qd-console-head,.qd-term-head{gap:5px}
}
@media (max-width: 1180px){
  .qd-top{gap:8px 10px}
  .qd-top-actions{margin-left:0;order:2}
  .qd-overall{order:3;flex:1 1 100%}
}
@media (prefers-reduced-motion: reduce){
  .qd-seq-active .qd-seq-dot,.qd-progress-dot,.qd-spinner{animation:none!important}
}
`;
})();
