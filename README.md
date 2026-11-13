# QQ 服务工具台

> 在 DeepSeek Harness 桌面客户端内部，按顺序托管 **SnowLuma** 与 **qqbridge**：
> 真实控制台、真实终端输出、启停、自动认证与生命周期管理都集中在一个面板里。

- 插件包名：`@tqyb/qq-service-desk`
- 当前版本：`1.1.0`
- 运行环境：DeepSeek Harness 桌面客户端（Electron），Windows
- 依赖：本机已存在的 SnowLuma 与 qqbridge（本包**不包含**它们）
- 许可：MIT

---

## 1. 它解决什么问题

SnowLuma 是 QQ 网关，qqbridge 把 QQ 消息接到 DeepSeek Harness。两者原本需要分别启动、
分别打开浏览器控制台、分别处理认证，而且控制台默认禁止被 iframe 嵌入。

本插件把这条链路收进客户端：

1. 客户端启动后，由插件按顺序检查 / 启动 SnowLuma → 检测 OneBot 与 QQ 登录 → 启动 / 连接 qqbridge → 校验桥接与当前客户端宿主的连接；
2. 两个控制台以**受限同源门户**嵌在客户端面板内，自动完成各自认证，不弹外部浏览器；
3. 两个服务的真实 stdout/stderr 以终端形式展示，支持中文、ANSI、搜索、暂停滚动、复制、清空、导出；
4. 启停按钮按状态机启用/禁用，手动停止后不会自动拉起；
5. 只管理本插件启动的进程树，发现外部实例时只连接、不误杀。

---

## 2. 功能清单

### 顶部
- 总体状态：已停止 / 启动中 / 等待登录 / 运行中 / 部分运行 / 连接异常 / 停止中 / 已连接外部实例
- 启动顺序条：检查实例 → SnowLuma → OneBot 接口 → QQ 登录 → qqbridge → 桥接连接
- 「随客户端自动启动」开关（默认开）
- 全部启动 / 全部停止 / 设置
- 布局：自动（宽屏并排、窄屏标签）/ 并排 / 标签

### SnowLuma 与 qqbridge 卡片
每张卡片包含：
- 状态徽章、pid / 外部实例标记、运行时长、启动进度、失败环节与「下一步」
- 独立 启动 / 停止 / 重启
- 真实控制台 iframe：刷新、缩放（80%–125%）、**独立大窗口**
- 真实终端：搜索、暂停自动滚动、复制、清空显示、导出日志、折叠、拖拽高度、单独放大

### 独立大窗口（1.1.0）
- 「放大」打开网页大小的内置窗口：默认约视口 **86% × 84%**（最小 460×320），内容 100% 显示
- 拖动标题栏移动；拖动八条边/四角缩放；双击标题栏或按钮最大化/还原
- Esc 或「关闭」退出；每个控制台分别记忆位置与尺寸（`localStorage`，键 `qd.consoleWin.<service>`）
- 窗口展开时 iframe 保持同一实例，拖动/缩放不重新加载页面

---

## 3. 目录结构

```
QQ服务工具台-v1.1.0/
├── README.md                     # 本文件
├── DSH_AGENT_GUIDE.md            # 给 DeepSeek Harness 的功能阅读指令
├── SECURITY_AND_PRIVACY.md       # 凭据、隐私与安全边界
├── CHANGELOG.md
├── LICENSE                       # MIT
└── qq-service-desk/              # 插件本体（安装这个目录）
    ├── package.json              # dsh.bundle + dsh.client 声明
    ├── cordis.patch.yml          # Host 行插入
    ├── index.js                  # Host：生命周期、进程托管、HTTP/SSE
    ├── client.js                 # 浏览器端页面（IIFE 隔离）
    ├── lib/
    │   ├── settings.js           # 设置存储与可移植默认值
    │   ├── supervisor.js         # 进程/日志/进程树停止
    │   ├── services.js           # SnowLuma / qqbridge 协议细节
    │   ├── probe.js              # 本机 HTTP 探测
    │   ├── proxy.js              # 受限同源门户（认证注入、frame 头剥离、访问闸门）
    │   └── util.js               # 脱敏、等待、原子写盘
    ├── locale/{zh,en}.json
    ├── icon.svg
    ├── README.md
    └── LICENSE
```

---

## 4. 环境要求

| 项目 | 要求 |
|---|---|
| DeepSeek Harness | 桌面客户端（Electron），支持 `plugin_manager` / `dsh.bundle` 与 `dsh.client` |
| Node | SnowLuma 发行版自带 `node.exe`，或本机 `runtime/node-*/node.exe`；找不到时回退 Electron 的 Node 模式 |
| SnowLuma | 已存在的发行版目录（含 `index.mjs`），默认控制台 `127.0.0.1:5099`，OneBot HTTP/WS `3000/3001` |
| qqbridge | 已存在（含 `src/bridge.js` 与 `config.json`），控制台默认 `127.0.0.1:3100` |
| 浏览器内核 | 客户端自带 Chromium（控制台门户在 iframe 内） |

> 本包**不包含** SnowLuma、qqbridge、它们的依赖或任何用户数据；它们需要由使用者自行准备。

---

## 5. 安装

### 5.1 通过插件管理器（推荐）

把 `qq-service-desk` 目录（或其绝对路径）交给 DeepSeek Harness 的 `plugin_manager`，
执行 `install_bundle`。安装后会：

1. 把包链接进当前 profile 的 `node_modules`；
2. 在 profile 的 bundle 列表里加入 `@tqyb/qq-service-desk`；
3. 插入 Host 行 `qq-service-desk`（见 `cordis.patch.yml`）；
4. Host 半边立即激活，客户端半边在 Web 页面加载时注册面板与侧边栏入口。

安装结果以 `plugin_manager` 返回的 `application` 与 `warnings` 为准；不要仅凭进程存在判断。
替换已安装版本后，新的 **Host** 代码需要重启客户端才会加载（客户端页面代码刷新页面即可）。

### 5.2 验证安装

- 侧边栏出现「QQ 服务工具台」，点击能打开面板；
- 面板能读到宿主环境（DSH_HOME、宿主地址）且「实时」指示亮起；
- 打开设置能看到路径与地址。

如果面板空白：先检查客户端控制台是否有插件加载错误，再确认 `plugin_manager` 的安装结果。

---

## 6. 首次配置

打开「设置」：

1. **服务路径**
   - SnowLuma 目录：包含 `index.mjs` 的目录；
   - qqbridge 目录：包含 `src/bridge.js` 与 `config.json` 的目录；
   - Node：可留空。探测顺序为 设置值 → SnowLuma 自带 `node.exe` → Electron 的 Node 模式。
2. **地址**
   - SnowLuma 控制台、OneBot HTTP/WS、qqbridge 控制台；
   - 默认值即常见端口；SnowLuma 端口被占用时插件会自动向上探测最多 50 个端口。
3. **SnowLuma 自动认证**
   - 可选：录入一次 WebUI 密码。密码写入宿主 credentials 存储，不进入源码、日志或导出；
   - 不录入也可以：在控制台 iframe 内手动登录一次，插件会捕获并复用会话；
   - 密码错误不会自动重试，避免触发控制台的登录锁定。
4. **启动与生命周期**
   - 随客户端自动启动（默认开）；
   - 宿主真正退出时停止插件托管的进程（默认开）；
   - 不提供无限自动重启。
5. **门户端口**（默认 3310 / 3311）与各阶段超时。

设置保存在 `DSH_HOME/qq-service-desk/settings.json`。这是插件自有数据，不改 profile 的 `cordis.patch.yml`。

### 自动探测的环境变量（可选）

| 变量 | 作用 |
|---|---|
| `QQ_DESK_WORKSPACE` | 工作区根目录，用于推导 `integrations/SnowLuma`、`integrations/qq-bridge` |
| `QQ_DESK_SNOWLUMA_DIR` | 直接指定 SnowLuma 目录 |
| `QQ_DESK_QQBRIDGE_DIR` | 直接指定 qqbridge 目录 |
| `QQ_DESK_NODE` | 直接指定 Node 可执行文件 |

未设置时按 `DSH_HOME` 的上一级与自身探测 `integrations/*`、`runtime/node-*`。

---

## 7. 日常使用

1. 打开侧边栏「QQ 服务工具台」。
2. 点「全部启动」或等待客户端启动时的自动启动。
3. 观察启动顺序条与每个服务的进度：
   - SnowLuma 启动后进入「等待登录」：需要在 QQ 客户端登录，并在 SnowLuma 控制台「进程注入」里加载已登录的 QQ 进程（SnowLuma 没有扫码登录页）；
   - 登录成功后工具台会自动继续启动 qqbridge；
   - qqbridge 只有同时满足「进程在」「控制台在」「DSH 已连接」「SnowLuma 上游健康」才会显示「运行中」，否则显示「连接异常」并给出下一步。
4. 需要查看完整控制台时点「放大」，拖动/缩放内置大窗口；关闭后卡片内仍保留控制台。
5. 需要停止时点「全部停止」（先停 qqbridge 再停 SnowLuma）；手动停止后保持停止。

---

## 8. 控制台为什么能嵌在客户端里

SnowLuma 与 qqbridge 都对响应发送 `X-Frame-Options: DENY`（SnowLuma 还有 `frame-ancestors 'none'`），
并且认证方式不同：

| 服务 | 认证 |
|---|---|
| SnowLuma WebUI | `Authorization: Bearer`，令牌存 `localStorage["snowluma_token"]` |
| qqbridge 控制台 | `x-console-token` 头 / `?token=`，页面存 `localStorage["consoleToken"]` |

插件为每个服务在 `127.0.0.1` 上起一个**独立端口的受限反向代理**（默认 3310 / 3311），挂在端口根路径，
因此第三方页面里的 `/assets/*`、`/api/*` 不需要改写。边界上只做四件事：

1. 剥离 `X-Frame-Options`、`Content-Security-Policy`、COOP/COEP（仅这两个门户端口）；
2. 注入各自认证；qqbridge 同时改写 `Origin` / `Host` 以满足其 CSRF 与 Host 校验；
3. 访问闸门：iframe 首次带一次性 `?qd=` 令牌，文档请求校验该令牌；门户内同源子资源用
   `Sec-Fetch-Site: same-origin` 放行，不依赖第三方 cookie；
4. 转发时清掉宿主的 `dsh-auth-*` cookie，不把客户端宿主凭据带给第三方本地服务。

未修改 SnowLuma / qqbridge 的任何程序文件或业务配置；未关闭全局安全策略。

---

## 9. 状态与失败语义

| 状态 | 含义 |
|---|---|
| 已停止 | 没有托管进程；手动停止后保持，不自动拉起 |
| 启动中 | 进程已启动，等待控制台/接口就绪 |
| 等待登录 | SnowLuma 已就绪，但 QQ 未登录 / OneBot 尚未监听 |
| 运行中 | 进程、控制台、DSH 连接与上游健康均满足 |
| 部分运行 | 只有一个服务在运行（例如只停掉 qqbridge） |
| 连接异常 | 桥接已启动但 DSH 未连接，或 SnowLuma 上游未就绪/静默 |
| 停止中 | 正在停止进程树 |
| 已连接外部实例 | 端口上已有非本插件启动的实例；只连接、不停止 |

「全部停止」严格先 qqbridge 后 SnowLuma；手动停止会取消等待与重试；没有无限自动重启。

---

## 10. 常见问题

**面板没有侧边栏入口？**
确认插件安装返回 `application: applied`，并刷新页面；客户端插件代码更新后需要重载页面。

**SnowLuma 一直「等待登录」？**
QQ 尚未登录或尚未注入：在 QQ 客户端登录，然后在 SnowLuma 控制台「进程注入」加载 QQ 进程。
工具台会在 OneBot 可用后自动继续。

**qqbridge 显示「连接异常」但进程在？**
工具台要求 `dshReady=true` 且 SnowLuma 上游 `connected=true`、`degraded=false`。
若 DSH 未连接，检查 qqbridge 配置里的 `dsh.baseUrl` 是否等于当前客户端宿主地址，
并确认插件以当前宿主的 `DSH_HOME` 启动 qqbridge（桥接需要用它铸造会话 cookie）。
若上游未连接，先在 SnowLuma 完成 QQ 登录/注入。

**端口被占用 / 启动失败？**
查看终端输出。若日志提示「控制台端口已被占用 / 已有实例在运行」，说明存在旧实例；
工具台会把它识别为外部实例，不会重复启动，也不会去杀它。

**如何换门户端口？**
设置 → 控制台门户 → 修改端口并保存；插件会重新监听。

**如何卸载？**
`plugin_manager` → `remove_bundle` → `@tqyb/qq-service-desk`。卸载会 dispose 插件：
关闭门户、按设置停止插件托管进程；外部实例不受影响。

---

## 11. 可移植性与隐私

- 源码中**没有**固定盘符、用户名、家庭目录、令牌、密码、日志或本机数据；
- 默认路径与 Node 全部在运行时探测，也可用设置面板/环境变量覆盖；
- 包内只包含插件自身源码、文档、图标与 locale，不包含 `node_modules`、截图、测试脚本、settings 或凭据；
- 发布前的隐私检查清单见 `SECURITY_AND_PRIVACY.md`。

---

## 12. 许可

MIT License，见 `LICENSE`。
SnowLuma、qqbridge 及 DeepSeek Harness 各自遵循其原项目许可；本包不再分发它们的代码。
