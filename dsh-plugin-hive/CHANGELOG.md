# Keep a Changelog 风格；版本号遵循 SemVer。

## [0.1.0] — 2026-11-05

第一个可安装的版本：HIVE 从「独立常驻程序」变成「DSH 插件」，装完即用。

### Added

- **插件两半**
  - Host 半 `index.js`：首次激活自动开箱（建 `$DSH_HOME/hive/`、写默认配置、建库、种 12 条脉冲）、
    用 `ctx.llm` 注入模型传输层（零 API key）、进程内启动调度引擎、把看板挂到 webServer 的 `/hive` 前缀、
    注册 4 个 Agent 工具。
  - 浏览器半 `client.js`：左侧栏 `sidebar.panellist` 六边形图标（id `hive`）+ `main` 主面板
    （48px 控制条 + 同源 iframe 看板 + 设置抽屉，含 doctor / 安装缺失依赖 / Agent 依赖 / 版本 四页）。
  - `version.mjs`：HIVE 插件自身的版本管理（当前版本 / 检查更新 / 安装 / 降级 / 卸载 / 仓库设置），
    落地动作统一走宿主 `ctx.pluginManager`（与 `dsh plugin add` 同一条路径），**只给按钮、永不自动改**；
    拿不到版本源时如实报错，不编版本号。
- **调度引擎 `engine.mjs`**：3s 一拍——到期脉冲 → 看门狗（20s）→ 队列非阻塞派发（带 `draining` 闸）→ 心跳（5min）；
  支持 `start / stop / restart / trigger / runPulseById / status`。
- **内置运行时 `runtime/`**：46 个文件 / 约 560 KB，零 npm 依赖（`node:sqlite` / `node:http` / `node:child_process`）；
  传感器 6 路、执行器 7 个（含 `proc` 兜底）、L1–L5 判定、Router / Worker / Watchdog、HTTP + SSE、静态看板。
- **看板 9 页签**：收件箱 / 待拍板 / 任务 / 日志 / 上下文 / 执行器 / 自动任务 / 成本 / 自检。
- **控制条 7 个动作**：启动 / 停止（二次确认，6s 窗口）/ 立即巡检 / 环境自检 / Agent 依赖 / 版本 / 刷新。
- **自检**：`/api/setup/doctor` 汇总 9 项核心检查 + 6 项依赖 CLI；缺失依赖可一键 `npm i -g`
  （固定白名单、180s 超时、不执行需交互登录的命令；Node 只检测不安装）。
- **自测脚本**：`scripts/selftest-host.mjs`（假 ctx + 临时 `DSH_HOME`，19 项断言）；
  `scripts/check-client.mjs`（`node:vm` 桩浏览器环境跑 `client.js`，68 项断言：槽位/图标/样式作用域/
  接口契约/归一化/依赖与版本 UI/不白屏/定时器回收）；`scripts/sync-runtime.mjs`（从独立版源码同步 `runtime/`）。
- **对外材料**：README（中/英）、LICENSE（MIT）、CHANGELOG、`.gitignore`、GitHub Actions CI、
  `docs/INSTALL.md`、`docs/FEATURES.md`、`docs/ARCHITECTURE.md`。

### Verified (本机实测，2026-11-05 · Windows 11 · Node v24.14.1)

- `node --no-warnings scripts/selftest-host.mjs` → **19/19 PASS**
  - 开箱：config/ 与 data/ 建好、库建好、`seedPulses: 新增 12 条脉冲`
  - 模型：借用宿主当前选择 → `deepseek/deepseek-chat`
  - 路由：`/hive` 以 `prefix` 注册；`X-Frame-Options=SAMEORIGIN`、`CSP frame-ancestors 'self'`
  - 真实巡检：扫到 29 条 / 新增 28 条（本机邮箱 + git + 文档 + 本机自动化 + 自检）
  - 工具：`hive_status, hive_capture, hive_run, hive_decide`
  - 卸载：引擎停、路由下线、global 清理
- 独立看板 `node runtime/src/server/http.mjs --port 8899` → `/api/health` 200、`/` 200。
- `node --no-warnings scripts/check-client.mjs` → **68/68 PASS**（834ms）。

### Known issues

- 插件模式下成本恒记 0（模型走宿主），因此日预算护栏不触发；见 README「已知限制」1。
- `runtime/` 是 `sync-runtime.mjs` 的拷贝：改了源码仓库不重跑同步，插件里仍是旧运行时（看板页签/自检/依赖接口都会落后）。
- 「Agent 依赖」「版本」的落地动作依赖宿主 `ctx.pluginManager`；宿主没提供时如实报「宿主没有提供 pluginManager」，
  用 `link:` 安装时「版本」会提示需改成 GitHub / registry 安装。仅影响这两个抽屉页。
- `codex`（402 上游余额）、`claude`（401 凭据失效）为作者机器实测现象，换机器不一定复现。
- 默认 `policies.json` / `hive.json` 内是作者本机绝对路径，换机器需手工改。
- 同一 `HIVE_HOME` 不可同时跑插件引擎与独立版 daemon。
- 真实 profile 的 GUI 安装未做端到端记录（已验的是两侧自测与独立看板）。

### Notes

- 独立版 HIVE（`D:\hive`，CLI + daemon + 5 套测试）与插件共用同一套运行时与表结构，语义等价、驱动方式不同；
  `runtime/` 由 `scripts/sync-runtime.mjs` 拷贝而来。
