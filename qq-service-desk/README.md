# QQ 服务工具台（@tqyb/qq-service-desk）

DeepSeek Harness 桌面客户端内部插件：在客户端里按顺序托管 **SnowLuma** 与 **qqbridge**，
把两个真实控制台、真实终端输出、启停和自动认证集中到同一面板。

完整使用说明、面向 DeepSeek Harness 的功能阅读指令与安全边界，见发布包根目录的
`README.md`、`DSH_AGENT_GUIDE.md`、`SECURITY_AND_PRIVACY.md`。

## 快速开始

1. 用解压后的 `qq-service-desk` 目录安装：通过 `plugin_manager` 的 `install_bundle` 指到该目录。
2. 打开侧边栏「QQ 服务工具台」→「设置」，确认：
   - SnowLuma 目录（含 `index.mjs`）
   - qqbridge 目录（含 `src/bridge.js` 与 `config.json`）
   - Node 可执行文件（可留空：自动回退 SnowLuma 自带 `node.exe` 或 Electron 的 Node 模式）
3. 保持「随客户端自动启动」开启。启动顺序：检查实例 → SnowLuma → OneBot/QQ 登录 → qqbridge → 校验桥接。
4. QQ 登录由 QQ 客户端 + SnowLuma 控制台「进程注入」完成；工具台显示等待登录并在就绪后自动继续。

## 说明

- 插件不修改 SnowLuma / qqbridge 的程序文件或业务配置。
- 不包含任何固定盘符、用户名或本机凭据；默认路径按环境变量与 DSH_HOME 自动探测，也可以在设置里手动指定。
- 控制台通过两个只监听 `127.0.0.1` 的受限门户嵌入（默认 3310 / 3311），不关闭全局安全策略、不改第三方页面。
- 默认路径探测顺序：`QQ_DESK_WORKSPACE` / `QQ_DESK_SNOWLUMA_DIR` / `QQ_DESK_QQBRIDGE_DIR` / `QQ_DESK_NODE`
  → `DSH_HOME` 的上一级与自身下的 `integrations/*`
  → `runtime/node-*` 或 SnowLuma 自带 `node.exe`。

## 许可

MIT，见包根目录 `LICENSE`。
