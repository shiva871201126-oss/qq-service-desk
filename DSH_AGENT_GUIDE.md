# 给 DeepSeek Harness 的功能阅读指令

> 这份文档是写给 **DeepSeek Harness（DSH）里的编码/运维 Agent** 的：拿到这个包后，
> 先按这里的顺序理解插件，再决定安装、配置、排障或二次开发。
> 面向人类的使用说明在 `README.md`；安全边界在 `SECURITY_AND_PRIVACY.md`。

---

## 0. 阅读顺序（强制）

1. `SECURITY_AND_PRIVACY.md` —— 先建立凭据与隐私边界，避免误读/误打印秘密；
2. `README.md` —— 了解插件做什么、怎么装、怎么用；
3. 本文件 —— 掌握运行时契约、状态机与验证方法；
4. 需要改代码时再读 `qq-service-desk/`：
   - `index.js`（Host：生命周期、进程托管、HTTP/SSE、状态机）
   - `client.js`（浏览器页面：面板、控制台、终端、设置）
   - `lib/proxy.js`（控制台门户：认证注入、frame 头剥离、访问闸门）
   - `lib/services.js`（两个真实服务的协议）
   - `lib/settings.js`（设置与可移植默认值）
   - `lib/supervisor.js`（进程与日志）

不要凭文件名猜测行为；以本文件的契约和源码为准。

---

## 1. 一句话定位

`@tqyb/qq-service-desk` 是一个 **DSH 双半边插件**：

- **Host 半边（`index.js`）** 随宿主启动，负责按顺序托管 SnowLuma 与 qqbridge、维护状态机、
  提供同源 HTTP/SSE 接口，并起两个只监听回环地址的控制台门户；
- **Client 半边（`client.js`）** 在 DSH Web UI 的 `main` 槽位渲染整页「QQ 服务工具台」，
  在 `sidebar.panellist` 注册入口，全部数据通过 `/qq-desk/api/*` 读取。

它**不包含** SnowLuma / qqbridge，也不修改它们的文件；它管理的是这两个外部程序。

---

## 2. 依赖的真实外部服务

| 服务 | 入口 | 插件如何判断就绪 |
|---|---|---|
| SnowLuma WebUI | 默认 `http://127.0.0.1:5099/`，标题必须含 `SnowLuma 控制台` | HTTP 200 + HTML + 标题标记；端口占用时向上探测最多 50 个 |
| SnowLuma OneBot HTTP | 默认 `http://127.0.0.1:3000` | `POST /get_status`（Bearer 令牌）返回 `online=true` |
| SnowLuma OneBot WS | 默认 `ws://127.0.0.1:3001` | 由 qqbridge 自身连接并在 `/api/status` 报告 |
| qqbridge 控制台 | 默认 `http://127.0.0.1:3100/`，标题必须含 `QQ 桥接控制台` | 带控制台令牌请求首页；令牌来自 `config.json#consoleToken` 或 `state/console-token` |
| qqbridge ↔ DSH | qqbridge 自身 `dsh.baseUrl` | `GET /api/status` 的 `dshReady=true` |

**关键约束**：qqbridge 用 `DSH_HOME/.credentials.yaml` 里的会话签名密钥自行铸造 DSH cookie。
插件 spawn qqbridge 时必须把 `DSH_HOME` 指向**当前 DSH 宿主**的数据目录；指到别的目录会永久
`dshReady=false` 且日志沉默。不要复制旧凭据、不要另起一套 DSH。

QQ 登录本身不在 SnowLuma 的登录页完成：需要 QQ 客户端登录 + SnowLuma 控制台「进程注入」
加载 QQ 进程；工具台只能等待并自动续启 qqbridge。

---

## 3. 运行时契约（Host HTTP API）

所有接口挂在 DSH 宿主的同源前缀 `/qq-desk` 下，只接受本机回环与同源写请求；
POST 必须是 `application/json`，且带 `Origin` 时必须是当前宿主回环端口。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/qq-desk/api/state` | 完整状态快照 `{ ok, state }` |
| GET | `/qq-desk/api/diagnostics` | 诊断（路径、地址、令牌是否存在、进程目录存在性等） |
| GET | `/qq-desk/api/logs?service=snowluma|qqbridge&since=&limit=&search=&tail=1` | 分页日志 |
| GET | `/qq-desk/api/export?service=...` | 导出脱敏后的 `.log` 文本 |
| GET | `/qq-desk/api/stream` | SSE：`hello` / `state` / `logs` / `clear` 事件 |
| POST | `/qq-desk/api/action` | 启停动作，body `{ action, service? }` |
| GET/POST | `/qq-desk/api/settings` | 读取 / 更新设置；POST 传 `{ settings }` 或 `{ action: "reset" }` |
| GET/POST | `/qq-desk/api/credentials` | 查询 SnowLuma 密码/会话是否已配置；POST 写入或 `{action:"clear"}` 清除 |

### 3.1 actions

| action | service | 说明 |
|---|---|---|
| `start-all` / `continue` | — | 按顺序启动 SnowLuma → OneBot/QQ → qqbridge |
| `stop-all` | — | 先停 qqbridge 再停 SnowLuma，取消等待，保持停止 |
| `start` | `snowluma`/`qqbridge` | 启动单个服务（qqbridge 允许在上游未就绪时启动，但会显示连接异常） |
| `stop` | 同上 | 停止单个托管进程；外部实例返回 `external:true` 且不杀 |
| `restart` | 同上 | 先停后启 |
| `clear-logs` | 同上 | 清空内存日志缓存（不影响业务数据） |
| `login-snowluma` | — | 用已保存密码立即尝试登录（有频率限制） |
| `update-ui` | — | 保存纯前端偏好（可选） |

Action 串行执行；新动作会取消旧动作仍在等待的启动/登录等待（不杀进程）。

### 3.2 state 关键字段

```text
state.overall            { state, text, detail }   # stopped|starting|waiting-login|running|partial|degraded|error|stopping
state.sequence[]         # 顶部启动顺序条（由真实阶段推导）
state.autoStart          # 随客户端自动启动
state.env                # dshHome / dshOrigin / hostBuild / dshProfile
state.snowluma           # state, managed, external, pid, url, portalUrl, detail, error, nextStep,
                         # auth, onebot{state,online,uin,nickname,good,detail,httpUrl}, progress[], logSeq
state.qqbridge           # state, managed, external, pid, url, portalUrl, detail, error, nextStep,
                         # link{dshReady,baseUrl,mode,note}, upstream{connected,degraded,good,accountOnline,lastPacketAgoMs,hint},
                         # progress[], logSeq
state.diagnostics        # 路径/地址/令牌存在性/旧 autoStartBridge 状态
state.busy               # 当前动作（null 表示空闲）
```

### 3.3 状态判定规则（不要自行发明）

- **运行中**：SnowLuma 运行 + OneBot `online=true` + qqbridge 进程/控制台在 + `link.dshReady=true`
  + `upstream.connected=true` + `upstream.degraded!==true` + `accountOnline!==false`；
- **等待登录**：SnowLuma 就绪但 OneBot 未监听 / QQ 未登录；
- **连接异常**：桥接在但 DSH 未连接；或上游未连接/降级；
- **部分运行**：只停掉其中一个服务；
- **已连接外部实例**：端口上已有非本插件 spawn 的实例。

> 不要用「进程存在」或「日志里有某行」单独判定运行正常；日志是 append + 轮转 + 会残留旧运行内容。

---

## 4. 安装与启用（Agent 操作）

1. 确认当前 profile 与 `DSH_HOME`（不要凭目录名推断）。
2. 用 `plugin_manager` 的 `install_bundle`，目标为解压后的 `qq-service-desk` 目录。
3. 读取返回的 `application` / `warnings` 判断是否真正生效。
4. 需要确认行状态时，用无审批的 `cordis_inspect_query`：
   `Config.listConfigs` → `name: "@tqyb/qq-service-desk"` → 取 entry id。
5. 打开客户端侧边栏「QQ 服务工具台」，或让用户打开；确认 `/qq-desk/api/state` 可达（同源页面）。
6. **替换已安装版本后，Host 代码需要重启客户端**；客户端页面代码刷新页面即可。
   不要自行重启用户的客户端（遵守用户的宿主生命周期规则）。

### 安装后验证清单

- [ ] 侧边栏入口存在，面板能打开；
- [ ] `/qq-desk/api/state` 返回 200 且 `state.env.dshHome` 正确；
- [ ] 设置页能看到并保存路径/地址；
- [ ] 自动启动开启时，客户端启动 1–2 秒后开始顺序启动；
- [ ] 两个终端有真实输出且中文字符正常；
- [ ] 手动「全部停止」后端口关闭且不再自动拉起；
- [ ] 外部实例存在时显示「已连接外部实例」且停止不会杀它；
- [ ] 未登录 QQ 时不会显示「运行中」。

---

## 5. 配置、可移植性与默认值

设置文件：`DSH_HOME/qq-service-desk/settings.json`（插件自有，不是 profile 的 patch 文件）。

默认路径探测顺序：

1. 环境变量：`QQ_DESK_WORKSPACE`、`QQ_DESK_SNOWLUMA_DIR`、`QQ_DESK_QQBRIDGE_DIR`、`QQ_DESK_NODE`；
2. `DSH_HOME` 的上一级与自身下的 `integrations/SnowLuma`、`integrations/qq-bridge`；
3. Node：设置值 → `runtime/node-*` → SnowLuma 自带 `node.exe` → Electron 的 Node 模式（`ELECTRON_RUN_AS_NODE=1`）。

因此包内**没有任何固定盘符/用户名**；换机器后先看设置页，必要时用环境变量或手动填写。

可配置项：服务目录、Node、SnowLuma/OneBot/qqbridge 地址、门户端口（默认 3310/3311）、
自动启动、退出时停止、各阶段超时、日志缓存行数、UI 偏好。

---

## 6. 凭据与安全边界（阅读时必须遵守）

- 四类凭据不混用：SnowLuma WebUI 密码/会话、SnowLuma OneBot 令牌、qqbridge 控制台令牌、DSH 宿主认证；
- 密码/会话只经宿主 **credentials 服务**保存；OneBot 令牌只从 SnowLuma 配置读取；qqbridge 令牌只从
  `config.json` 或 `state/console-token` 读取；DSH 宿主认证由 qqbridge 用 `DSH_HOME` 自行铸造；
- 不得把任何令牌/密码写进源码、配置样例、日志、截图、导出文件或对话；
- 日志与导出在服务端脱敏；
- 只停止本插件 spawn 的进程树；外部实例只连接；
- 门户只监听 `127.0.0.1`，有一次性访问闸门；不得用关闭全局安全策略的方式换嵌入。

---

## 7. 故障排查速查

| 现象 | 优先检查 |
|---|---|
| 面板空白/无入口 | `plugin_manager` 安装结果、客户端加载错误、刷新页面 |
| SnowLuma 启动超时 | 目录/`index.mjs`、Node 路径、5099 被谁占用、终端输出 |
| 一直等待登录 | QQ 客户端是否登录、SnowLuma「进程注入」是否加载、OneBot 3000/3001 |
| qqbridge 起不来 | 3100 被占用/旧实例、`state/console-token`、终端中的 exit code 2 |
| `dshReady=false` | qqbridge `config.dsh.baseUrl` 是否等于宿主地址、插件是否以当前 `DSH_HOME` 启动它 |
| 上游未就绪 | SnowLuma 的 `/get_status` 与桥接 `/api/status` 的 `snowluma.connected/degraded/good` |
| 控制台 iframe 打不开 | 门户端口、`?qd=` 闸门、第三方服务是否在跑；不要改用全局关闭 XFO |
| 放大窗口太小 | 应使用 1.1.0+：卡片上不得再有 `backdrop-filter`（会让 fixed 以卡片为包含块） |

---

## 8. 可直接复制给 Agent 的工作指令

```text
你拿到的是 DeepSeek Harness 插件「QQ 服务工具台」（@tqyb/qq-service-desk）发布包。
请按以下顺序执行：
1. 先读 SECURITY_AND_PRIVACY.md 与 DSH_AGENT_GUIDE.md，再读 README.md；
2. 用 plugin_manager 的 install_bundle 安装解压目录 qq-service-desk；
3. 读取返回的 application/warnings，确认 bundle 与 Host 行都已生效；
4. 不要修改 SnowLuma / qqbridge 的程序文件与业务配置，不要复制或打印任何凭据；
5. 打开侧边栏「QQ 服务工具台」，按当前 profile 配置 SnowLuma/qqbridge 路径（可留空自动探测）；
6. 验证：state 接口 200、两个终端有真实输出、全部停止后不自动拉起、外部实例不被杀；
7. 需要替换 Host 代码时，先告诉用户需要重启客户端，由用户自行重启；
8. 任何结论以真实接口/真实日志为依据，不要用模拟页面或猜测。
```

---

## 9. 版本

- 1.1.0：控制台独立大窗口（拖动/缩放/最大化/记忆）；可移植默认路径；Node 自动回退；
  凭据按需解析；单服务停止显示「部分运行」；桥接步骤在 qqbridge 停止时归零。
- 1.0.0：首个公开版本（顺序托管、双控制台门户、终端、自动认证、外部实例保护）。
