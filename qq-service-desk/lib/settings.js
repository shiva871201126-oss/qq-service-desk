/**
 * 设置存储：用户可在工具台里改路径 / 地址 / 端口 / 自启动开关。
 *
 * 可移植性：本文件不包含任何固定盘符或用户名。默认路径按以下顺序自动探测：
 *   1. 环境变量 QQ_DESK_WORKSPACE / QQ_DESK_SNOWLUMA_DIR / QQ_DESK_QQBRIDGE_DIR / QQ_DESK_NODE
 *   2. DSH_HOME 的上一级与 DSH_HOME 自身下的 integrations/{SnowLuma,qq-bridge}
 *   3. 从 runtime/node-* 或 SnowLuma 自带 node.exe 找 Node
 *   4. 都没找到时留空，由设置面板提示用户填写
 *
 * 说明（遵循宿主插件实践）：
 * - 不读写 profile 的 cordis.patch.yml（那是用户的文件，且可能被更高层覆盖）；
 * - 用户改动落在 DSH_HOME/qq-service-desk/settings.json；
 * - 密码 / 令牌不进这个文件，走宿主 credentials 服务。
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from './util.js';

function safeExists(target) {
  try {
    return Boolean(target) && fs.existsSync(target);
  } catch {
    return false;
  }
}

function findWithMarker(base, parts, marker) {
  if (!base) return '';
  const dir = path.join(base, ...parts);
  if (marker && !safeExists(path.join(dir, marker))) return '';
  return dir;
}

function findRuntimeNode(base) {
  if (!base) return '';
  const runtimeDir = path.join(base, 'runtime');
  let entries = [];
  try {
    entries = fs.readdirSync(runtimeDir, { withFileTypes: true });
  } catch {
    return '';
  }
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
    if (!entry.isDirectory() || !/^node-v/i.test(entry.name)) continue;
    const candidate = path.join(runtimeDir, entry.name, exe);
    if (safeExists(candidate)) return candidate;
  }
  return '';
}

export function defaultSettings(dshHome, env = process.env) {
  const bases = [...new Set([
    env.QQ_DESK_WORKSPACE,
    dshHome ? path.dirname(dshHome) : '',
    dshHome,
    process.cwd(),
  ].filter(Boolean))];

  let snowLumaDir = env.QQ_DESK_SNOWLUMA_DIR || '';
  let qqBridgeDir = env.QQ_DESK_QQBRIDGE_DIR || '';
  for (const base of bases) {
    if (!snowLumaDir) snowLumaDir = findWithMarker(base, ['integrations', 'SnowLuma'], 'index.mjs');
    if (!qqBridgeDir) qqBridgeDir = findWithMarker(base, ['integrations', 'qq-bridge'], path.join('src', 'bridge.js'));
  }

  const nodeCandidates = [
    env.QQ_DESK_NODE,
    ...bases.map((base) => findRuntimeNode(base)),
    snowLumaDir ? path.join(snowLumaDir, process.platform === 'win32' ? 'node.exe' : 'node') : '',
  ];
  const nodePath = nodeCandidates.find((candidate) => safeExists(candidate)) || '';

  return {
    version: 1,
    snowLumaDir,
    qqBridgeDir,
    nodePath,
    snowLumaUrl: 'http://127.0.0.1:5099',
    oneBotHttpUrl: 'http://127.0.0.1:3000',
    oneBotWsUrl: 'ws://127.0.0.1:3001',
    qqBridgeConsoleUrl: 'http://127.0.0.1:3100',
    consolePorts: { snowluma: 3310, qqbridge: 3311 },
    autoStart: true,
    stopOnExit: true,
    autoRestart: false,
    timeouts: {
      snowLumaReadyMs: 120000,
      oneBotReadyMs: 90000,
      qqLoginWaitMs: 300000,
      qqBridgeReadyMs: 90000,
      bridgeLinkMs: 90000,
      stopGraceMs: 12000,
    },
    logLines: 4000,
    ui: {
      consoleScale: 1,
      terminalHeight: 220,
      terminalOpen: true,
      layout: 'auto',
    },
  };
}

function merge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base?.[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = merge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const STRING_FIELDS = ['snowLumaDir', 'qqBridgeDir', 'nodePath', 'snowLumaUrl', 'oneBotHttpUrl', 'oneBotWsUrl', 'qqBridgeConsoleUrl'];
const BOOLEAN_FIELDS = ['autoStart', 'stopOnExit', 'autoRestart'];
const NUMBER_FIELDS = { logLines: [200, 20000] };

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export class SettingsStore {
  constructor(dshHome) {
    this.dshHome = dshHome;
    this.dir = path.join(dshHome, 'qq-service-desk');
    this.file = path.join(this.dir, 'settings.json');
    this.defaults = defaultSettings(dshHome);
    this.settings = this.#load();
  }

  #load() {
    const disk = readJsonFile(this.file, null);
    const merged = merge(this.defaults, disk && typeof disk === 'object' ? disk : {});
    return this.#sanitize(merged);
  }

  #sanitize(value) {
    const next = { ...value };
    for (const field of STRING_FIELDS) {
      if (typeof next[field] !== 'string') next[field] = this.defaults[field] || '';
      else next[field] = next[field].trim();
    }
    for (const field of BOOLEAN_FIELDS) {
      if (typeof next[field] !== 'boolean') next[field] = this.defaults[field];
    }
    next.logLines = clampInt(next.logLines, NUMBER_FIELDS.logLines[0], NUMBER_FIELDS.logLines[1], this.defaults.logLines);
    next.consolePorts = {
      snowluma: clampInt(next.consolePorts?.snowluma, 0, 65535, this.defaults.consolePorts.snowluma),
      qqbridge: clampInt(next.consolePorts?.qqbridge, 0, 65535, this.defaults.consolePorts.qqbridge),
    };
    next.timeouts = merge(this.defaults.timeouts, next.timeouts || {});
    for (const key of Object.keys(this.defaults.timeouts)) {
      next.timeouts[key] = clampInt(next.timeouts[key], 5000, 900000, this.defaults.timeouts[key]);
    }
    next.ui = merge(this.defaults.ui, next.ui || {});
    next.ui.consoleScale = Math.min(1.5, Math.max(0.6, Number(next.ui.consoleScale) || 1));
    next.ui.terminalHeight = clampInt(next.ui.terminalHeight, 90, 620, this.defaults.ui.terminalHeight);
    if (!['auto', 'columns', 'tabs'].includes(next.ui.layout)) next.ui.layout = 'auto';
    next.ui.terminalOpen = next.ui.terminalOpen !== false;
    return next;
  }

  get() {
    return this.settings;
  }

  /** 更新并返回最新设置；不允许通过 UI 改密码/token。 */
  update(patch) {
    const candidate = merge(this.settings, patch || {});
    const next = this.#sanitize(candidate);
    this.settings = next;
    writeJsonAtomic(this.file, next);
    return next;
  }

  reset() {
    this.settings = this.#sanitize(this.defaults);
    writeJsonAtomic(this.file, this.settings);
    return this.settings;
  }
}
