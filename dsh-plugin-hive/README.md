# HIVE · 蜂巢（DSH 插件）

**一句话**：HIVE 是常驻在 DSH 里的「主动服务型超级智能体」——它自己巡检（邮箱 / Git / 文档 / 日历 / 本机自动化 / 自检），自己把发现的事排进 Inbox，按 L1–L5 判断能不能自己干，只有真正需要你拍板的事才进 Outbox。作为 DSH 插件，它给你**左侧栏一个入口**，点开是一整套任务中心看板。

| | |
|---|---|
| 版本 | 0.1.0 |
| 许可 | MIT |
| 运行要求 | DSH（任意带 `webServer` + `llm` + `tools` 的 profile）· Node ≥ 22.5（`node:sqlite` 是内置模块） |
| npm 依赖 | **0 个**（只用 Node 内置；看板零 CDN、离线可用） |
| 数据位置 | `$DSH_HOME/hive/`（本地 SQLite 单库） |
| 本机实测 | Host 半自测 **19/19 PASS** · 浏览器半自测 **70/70 PASS** · 独立看板 `/api/health` 200 |

---

## 30 秒安装

插件走 DSH 自己的插件机制（profile 里 `pnpm add` + 出现在 `dsh.profile.bundles` 才会挂载）。
两种做法都行，**不要两条都做**。

### 路径 A：本机目录（开发者 / 自用，推荐）

在任意 DSH 会话里让 Agent 调：

```js
plugin_manager({
  action: "install_bundle",
  target: "link:D:\\hive\\dsh-plugin-hive",   // 指向插件目录本身
})
```

等它返回已应用（若返回 `nextStep`，按提示重启/刷新）。命令行等价：

```powershell
dsh plugin --profile web add link:D:/hive/dsh-plugin-hive
```

> 只 `add` 只装依赖；还要让 `dsh-plugin-hive` 出现在该 profile `package.json` 的
> `dsh.profile.bundles` 里（`plugin_manager` 的 `set_bundle` 或手工编辑），否则不会被挂载。
> 用 `link:` 的好处是改完代码重启即生效，不用重装。

### 路径 B：GitHub / npm（发布之后）

```js
plugin_manager({ action: "install_bundle", target: "github:Elohia/dsh-plugin-hive" })
// 或 npm 包名：target: "dsh-plugin-hive@0.1.0"
```

命令行等价：`dsh plugin --profile web add github:Elohia/dsh-plugin-hive`（同样要进 bundles）。

> **注意**：本机这份仓库还没有配 git remote，`github:Elohia/dsh-plugin-hive` 与 npm 包名
> **在你发布之前不可用**。发布前的唯一可用路径是上面的路径 A。

装完刷新页面（或重启 DSH），左侧栏出现 **HIVE 六边形图标**。更细的步骤、卸载、换机器见
[docs/INSTALL.md](docs/INSTALL.md)。

---

## 装完你会看到什么

1. **左侧栏**：一颗六边形蜂巢图标（`sidebar.panellist`，id `hive`）。
2. **主区面板**：48px 控制条 + 内嵌的完整看板（webServer 的 `/hive/` 前缀，同源 iframe）+ 可拉起的设置抽屉。
3. **控制条**：状态点与计数常驻，按钮从左到右 —— **启动 / 停止 / 立即巡检 / 环境自检 / Agent 依赖 / 版本 / 刷新**。
   - 「停止」是二次确认：第一次点变成「确认停止？」，6 秒内不点自动取消，避免手滑。
   - 「Agent 依赖」打开抽屉：5 个 Agent CLI（dsh / pi / codex / claude / agently）的安装、更新、降级、卸载
     （卸载要连点两次才真的发请求）。
   - 「版本」打开抽屉：HIVE 插件自身的当前版本、检查更新、降级、卸载 —— **只给按钮，永不自动改**。
     可用版本来自 GitHub Releases；拿不到就如实报错，不编版本号。
4. **看板 9 个页签**（见下表），首屏就是收件箱。

| # | 页签 | 里面是什么 |
|---|---|---|
| 1 | 收件箱 | 传感器扫来的全部事项；搜索、按栏位/来源/状态/L1–L5 过滤；可手工投递；事项可派单 / 归档 / 丢弃 / 恢复 / 调级 |
| 2 | 待拍板 | Outbox 审批卡：「背景 + 建议 + 2–4 个选项 + 风险 + 有效期」，批准后**自动续跑** |
| 3 | 任务 | 队列与运行记录：排队/运行/成功/失败/取消；可重试、取消；每个 Run 的产物可回溯 |
| 4 | 日志 | 事件流（SSE 实时），按 info/warn/error 过滤，可暂停、清屏 |
| 5 | 上下文 | 个人上下文事实卡（分类 / 键 / 值 / 证据 / 置信度），可增删；只在只读或建议类动作里使用 |
| 6 | 执行器 | 7 个执行器的探活结果（**实测**，不是配置声明）、版本、24h 运行与成功率、按执行器花费 |
| 7 | 自动任务 | 12 条脉冲的时间表（周期/上次/下次/已到期）、逐条启用开关、立即执行；守护进程启动/停止 |
| 8 | 成本 | 按天花费曲线、今日预算进度条、按执行器分组的条形图、最花钱的任务 |
| 9 | 自检 | 9 项核心检查（Node / node:sqlite / 库可写 / 表齐全 / 执行器 / 通道 / 磁盘 / 预算 / 守护）+ 6 项依赖 CLI；缺的依赖可点一下 npm 全局安装（Node 只检测不装） |

---

## 为什么它开箱就能用

这是本插件与「先配一堆东西才能跑」的差别，五条都能在代码里指到：

1. **内置全部运行时**：`runtime/` 是完整 HIVE（46 个文件 / 约 560 KB），`package.json` 里 `dependencies` 为空 —— 不靠用户机器上先装一套 HIVE，也不引第三方 npm 包。
2. **模型直接借用你在 DSH 里已配好的那个**：插件启动时用 `ctx.llm.stream` 实现 HIVE 的 chat 传输层（`runtime/src/core/llm.mjs` 的 `setTransport`），模型挑的是你当前会话选择的 provider/model（selftest 桩拿到 `deepseek/deepseek-chat`；真实运行拿到 `deepseek-official/deepseek-flash`）。**不需要另配 API key**；开箱时还会把默认配置里指向别人机器的凭据路径清空。
3. **首次激活自动开箱**：建 `$DSH_HOME/hive/`（`config/`、`data/`、`data/{runs,artifacts,logs,work,calendar}`）→ 写默认 `hive.json` / `policies.json` → 建库建表 → 启动引擎 → **种 12 条定时巡检** → 注册 `/hive` 路由。用户什么都不用做（自测里这四步逐项 PASS）。
4. **外部 CLI 全部可选**：`codex` / `pi` / `claude` / `agently-cli` 没装也不影响主链路 —— 没装就用内置 `llm` 执行器与 `dsh` 执行器，L1/L2 内联出结论、L3+ 派 `dsh`。少一个执行器只少一种「干活的手」，不是功能残缺。
5. **自检页告诉你缺什么**：自检页把每一项写成 PASS/WARN/FAIL，附「缺什么 + 怎么补」，能一键装的给按钮（`npm i -g`，固定白名单、180s 超时、不执行任何需要交互登录的动作）。

---

## 能力清单

| 能力 | 你现在能做什么 | 入口 |
|---|---|---|
| 左侧栏入口 | 点图标 → 主区打开完整看板，不离开当前会话 | 左侧栏 |
| 控制条 | 启停引擎、立即巡检、环境自检、依赖与版本、刷新 | 面板顶部 48px |
| L1–L5 自主分级 | 每条事项自动判级：**确定性规则优先**（动作意图→基准级→不可逆/对外/金额下调→历史成功率上调→能力闸门→clamp），置信度 < 0.6 才让便宜模型兜底且只取更保守的 | 自动 |
| Outbox 审批 | 发信 / 发布 / 删除 / 花钱 / 部署**必须**经你放行；批准后自动续跑 | 待拍板 / `hive_decide` |
| 脉冲定时巡检 | 12 条：6 路传感器各一条 + 事项判定 + 看门狗 + 晨报 08:40 + 晚报 21:30 + 上下文刷新 07:50 + 自检 6h | 自动任务 |
| 6 路传感器 | 邮箱摘要、Git（未提交/未推送）、文档变更、ICS 日历、本机既有自动化产物（pi-agent / dsh-home）、系统自检 | 自动 |
| 7 个执行器 | `llm` / `dsh` / `pi` / `codex` / `claude` / `shell` + `proc` 通用兜底（未显式配置不启用） | 执行器 |
| 成本与预算 | 按天、按执行器统计；超 `dailyBudgetCny` 的 80% 告警、100% 暂停派单（插件模式下见「已知限制」第 1 条） | 成本 |
| 红线守卫 | `never_touch` 目录禁止写入、写盘白名单、执行器白名单（只有 llm/dsh/pi/codex/claude 能接自然语言任务） | 自动 |
| 4 个 Agent 工具 | 在会话里用自然语言管任务 | 会话 |

### 4 个 Agent 工具

| 工具 | 干什么 | 参数 |
|---|---|---|
| `hive_status` | 待办 / 待拍板 / 在运行 / 今日花费 / 引擎与模型状态 | 无 |
| `hive_capture` | 把一件事丢进 Inbox，自动去重与算优先级 | `title`（必填）· `body` · `kind`（todo/issue/opportunity/decision/risk/fyi）· `domain` |
| `hive_run` | 立刻路由一条事项：L1/L2 内联出结论，L3+ 派执行器，需要拍板则进 Outbox | `id`（`itm_…`） |
| `hive_decide` | 批准（会立刻续跑）/ 拒绝一条审批 | `id`（`apr_…`）· `decision`（approve/reject）· `note` |

---

## 它是怎么工作的

```
DSH 宿主（已有）
  ├─ ctx.llm ─────────────► HIVE 的 chat 传输层（借你的模型，零 key）
  ├─ ctx.webServer.register('/hive', prefix) ─► 看板 + /hive/api/*
  └─ ctx.tools.register ──► hive_status / hive_capture / hive_run / hive_decide

插件 Host 半（index.js + engine.mjs + version.mjs）
  首次激活：开箱 → 建库 → 注入模型传输层 → 启引擎 → 挂路由 → 注册工具 → 接版本管理
  引擎每 3s 一拍：到期脉冲 → 看门狗(20s) → 队列非阻塞派发 → 心跳(5min)

内置运行时（runtime/，同步自独立版 HIVE）
  6 传感器 → 归一/去重 → items → L1–L5 判定 → Router（内联 / 派单 / 请示）→ Worker → runs/artifacts
                                                          └─ Outbox（人工闸门）
```

审批是唯一的副作用闸门：任何对外或不可逆动作都要在 Outbox 放行。细节见
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 与 [docs/FEATURES.md](docs/FEATURES.md)。

---

## 数据与隐私

- **全部本地**：状态只在一个 SQLite 文件 `$DSH_HOME/hive/data/hive.db`（WAL），没有影子状态、没有云同步。
- **默认不读微信、不读 X**：`sources.wechat` 与 `sources.x` 默认关闭（隐私），要接自己开并补适配器。
- **邮件默认只取列表摘要**：抓正文会**把邮件标记为已读**（实测），所以 `fetchBody=false`；要正文得显式打开，等于接受「这些邮件会变成已读」。
- **红线目录禁止写入**：`policies.never_touch`（默认含微信原始语料、`.credentials.yaml`、他人微信账号目录）由代码强制拦截，不是靠提示词。
- **只监听回环**：看板路由挂在宿主的 `127.0.0.1` 服务上，走 `/hive` 同源前缀；响应带 `X-Frame-Options: SAMEORIGIN` 与 `CSP frame-ancestors 'self'`，只允许宿主自己嵌。
- **模型调用只走你已经配好的通道**：插件不落任何 API key。

---

## 目录结构

```
dsh-plugin-hive/
├─ index.js            Host 半：开箱 / 模型传输层 / 引擎 / /hive 路由 / 4 个工具
├─ engine.mjs          插件内调度引擎（3s 一拍）
├─ version.mjs         版本管理（查/装/升/降/卸，走宿主 pluginManager，永不自动改）
├─ client.js           浏览器半：左侧栏图标 + 主面板（控制条 + iframe 看板 + 抽屉）
├─ cordis.patch.yml    bundle patch（insert 一个 id=hive 的插件条目）
├─ package.json        dsh.bundle / dsh.client 声明；dependencies 为空
├─ icon.svg · locale/  图标与中英文文案
├─ runtime/            内置运行时（46 文件 / 约 560 KB / 零 npm 依赖）
│  ├─ src/core/        config · db · events · llm · guard · ids · log · credentials
│  ├─ src/task/        taskcenter · triage · planner · router · worker · watchdog · pulse
│  ├─ src/sensors/     mail · git · docs · calendar · pulses_local · self
│  ├─ src/executors/   llm · dsh · pi · codex · claude · shell · proc
│  ├─ src/hitl/        notify（Toast / 邮件 / 看板，全部 fail-soft）
│  ├─ src/context/     profile · builder（个人上下文归纳）
│  ├─ src/server/      http · api · sse
│  ├─ web/             看板静态页（9 页签，零构建、离线可用）
│  └─ config-defaults/ hive.json · policies.json（首次激活拷进 $DSH_HOME/hive/config/）
└─ scripts/
   ├─ sync-runtime.mjs 从独立版源码仓库同步 runtime/（维护用）
   ├─ selftest-host.mjs 假 ctx 跑 Host 半（19 项）
   └─ check-client.mjs node:vm 桩环境跑 client.js（70 项）
```

---

## 自测（3 条命令）

不需要装 DSH，也不会碰你现有的数据（全部用临时目录 / 桩环境）：

```powershell
# 0) 进入插件目录
cd dsh-plugin-hive

# 1) 语法（入口 + 引擎 + 两侧脚本）
node --check index.js && node --check client.js && node --check engine.mjs && node --check version.mjs

# 2) Host 半自测：假 ctx + 临时 DSH_HOME，19 项逐条断言
node --no-warnings scripts/selftest-host.mjs

# 3) 浏览器半自测：node:vm 造一个最小浏览器环境跑 client.js，70 项断言
node --no-warnings scripts/check-client.mjs
```

想看界面（可选第 4 条，不装 DSH 也能起看板）：

```powershell
$h="$env:TEMP\hive-demo"; New-Item -ItemType Directory -Force "$h\config" | Out-Null;
Copy-Item runtime\config-defaults\*.json "$h\config\"; $env:HIVE_HOME=$h;
node --no-warnings runtime/src/server/http.mjs --port 8899   # 打开 http://127.0.0.1:8899/
```

### 本机实测（2026-11-05，Windows 11 / Node v24.14.1 自测 · v24.21.0 应用进程）

**装到真实 profile 之后（`link:` 安装，live 只读探针）**

| 验证项 | 结果 |
|---|---|
| 安装 | desktop profile 里 `"dsh-plugin-hive": "link:D:/hive/dsh-plugin-hive"`，并已在 `dsh.profile.bundles` 中 |
| 插件状态 | `GET /hive/api/plugin/status` 200：`phase=ready`、引擎 running、已扫入 28 条事项、12 条脉冲 |
| 借用宿主模型 | live 解析到 `deepseek-official/deepseek-flash`（跟着你在 DSH 里选的模型走） |
| 看板 | `GET /hive/` 200（14522 B，9 个页签）、`X-Frame-Options=SAMEORIGIN`、CSP 含 `frame-ancestors 'self'` |
| 插件级自检 | `GET /hive/api/plugin/doctor` 5 项全 PASS |
| 完整自检 | `GET /hive/api/setup/doctor` → **WARN（13 PASS / 2 WARN / 0 FAIL，共 15 项 = 9 核心 + 6 依赖）**；2 个 WARN 是 `proc` 执行器（需显式配 command）与「守护进程未运行」（见已知限制 2） |
| Agent 依赖 | `GET /hive/api/deps` 200；6 项依赖全部就绪（dsh 0.1.5-rc.2 / pi 0.84.1 / codex 0.153.4 / claude 2.1.195 / agently ✓） |
| 执行器 | `GET /hive/api/agents` → **6/7 可用**：llm / dsh / pi / codex / claude / shell；`proc` 不可用（预期） |
| 版本 | `GET /hive/api/plugin/version` 200：当前 0.1.0；仓库未发布时 `latest=null` 且如实报「读不到」 |
| 自动任务 | `GET /hive/api/autopilots` 200：12 条脉冲 |

**两侧自测（不装 DSH 也能跑，用临时目录）**

| 验证项 | 结果 | 怎么验的 |
|---|---|---|
| Host 半自测 | **19/19 PASS** | 命令 2 |
| 浏览器半自测 | **70/70 PASS**（槽位注册、图标、样式作用域、接口契约、依赖/版本 UI、不白屏） | 命令 3 |
| 开箱 | 建 config/ 与 data/、建库、**种 12 条脉冲** | 命令 2（`provision.*` / `seedPulses: 新增 12 条脉冲`） |
| 借用宿主模型 | `deepseek/deepseek-chat`（selftest 的桩默认；真实运行见上表） | 命令 2（`model.transport`） |
| 看板路由 | `/hive` 以 `prefix` 注册；`X-Frame-Options=SAMEORIGIN` + `frame-ancestors 'self'` | 命令 2（`route.*` / `web.frameable`） |
| 真实巡检 | 扫到 29 条 / 新增 28 条（本机邮箱 + git + 文档 + 本机自动化 + 自检） | 命令 2（`api.plugin.scan`） |
| 4 个工具 | `hive_status,hive_capture,hive_run,hive_decide` | 命令 2（`tools.registered`） |
| 卸载 | 引擎停、路由下线、global 清理 | 命令 2（`dispose.clean`） |
| 独立看板 | `/api/health` 200、`/` 200 | 可选第 4 条 |

> 断言条数会随脚本增长（2026-11-05 那一刻是 19 + 70），以你本地命令输出的数字为准。`runtime/` 是独立版 HIVE 的同步副本：独立版另有 5 套更细的测试套件（在源码仓库的
> `tests/`，不在本 npm 包内），覆盖传感器、执行器、HTTP 服务与端到端闭环。

---

## 已知限制（诚实清单）

1. **插件模式下「今日花费」恒为 ¥0.00**：模型调用走宿主的 `ctx.llm`，HIVE 不重复计费也不编造 token，所以成本记 0。副作用是日预算护栏**在插件模式里不会触发**（`ratio` 恒为 0）；真实花了多少请看你 DSH 侧的用量。改成自配 key 走 HTTP 直连才会记成本。
2. **自动任务页签的「守护进程」在插件模式下显示「未运行」**：它看的是独立版 daemon 的锁文件（`data/hive.lock`），而插件把引擎跑在 DSH 进程内，不写这个锁。**以控制条左侧的状态点为准**（那里是真实引擎状态）。所以自检里也会有 1 条 `daemon=WARN`，属预期。
3. **`proc` 执行器不可用是正常的**：它是通用兜底，没显式配置 `executors.proc.command` 就不启用。本机探活 6/7 可用（llm / dsh / pi / codex / claude / shell）。
4. **`codex` / `claude` 曾在本机跑任务时失败**：`codex` 上游余额 402、`claude` 凭据失效 401（二进制本身装着、探活 PASS）。`probe()` 只验二进制与版本，验不了余额与凭据；换机器不一定复现。不可用只是少一种执行器，L4/L5 默认走 `dsh`。
5. **L4/L5 的「自主验证」= 产物落盘 + 可回溯**，没有独立的第二套验收器；「完成」是执行器自述加证据，不是第三方判定。
6. **Toast 只在 Windows 10/11 生效**（用系统 PowerShell 5.1 的 WinRT，无需模块）。其它平台通知会失败但不影响主流程，信息仍落在看板事件与 Outbox 里。
7. **默认配置里的绝对路径是本机路径**：`policies.json` 的 `write_allowlist_dirs` / `never_touch`、`sources` 的扫描根目录写的是作者本机的 `D:\…` / `F:\…`。换机器请改 `$DSH_HOME/hive/config/policies.json` 与 `hive.json`（否则红线与白名单会指向不存在的目录）。
8. **同一个 `HIVE_HOME` 不要同时跑插件引擎和独立版 daemon**：两者语义等价但没有多进程协调，会共用一张库互相抢派单。二选一即可。
9. **微信 / X 传感器默认关闭**，需要自己接适配器；**日历只支持 ICS**；关键词判定有误报（看板可手动「调级」纠正）。
10. **成本是估算**：走自配 key 时按配置里的单价表算，可能与账单有偏差；`dsh` 执行器的 stdout 不含 usage，token 记 0 并标 `usage_unknown`。
11. **`runtime/` 是同步副本，不是源码**：插件里的运行时由 `node scripts/sync-runtime.mjs` 从源码仓库整目录拷入
    （看板 9 页签、自检、依赖接口都在里面）。改了源码却没重跑同步，插件里跑的还是旧的 —— 这是 0.1.0 最容易踩的坑。
12. **「Agent 依赖」与「版本」的落地动作依赖宿主能力**：依赖列表走 `/hive/api/deps`，安装/更新/降级/卸载走宿主
    `ctx.pluginManager`（宿主没提供则如实报「宿主没有提供 pluginManager」）。用 `link:` 本地目录安装时，
    「版本」会提示升级/降级需要改成从 GitHub 或 registry 装。仓库未发布时读不到可用版本（`latest=null`，不编版本号）。
13. **验证边界**：安装路径与各接口已在本机真实 profile 上只读探针验证（见上表）；**GUI 逐屏点击**（左侧栏图标长什么样、
    抽屉动画等）没有截图记录，属外观层面。

---

## 文档

| 文件 | 内容 |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | 两种安装路径、依赖、卸载、升级、换机器、常见问题 |
| [docs/FEATURES.md](docs/FEATURES.md) | 9 个页签、控制条、L1–L5、传感器/执行器清单、API 表、工具语义 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 插件两半、引擎循环、`runtime/` 与独立 daemon 的关系、数据模型、安全边界 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更 |
| [README.en.md](README.en.md) | English（略简） |

## 许可

MIT © 2026 Elohia。见 [LICENSE](LICENSE)。
