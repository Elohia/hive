# 功能说明

> 本文按「你在界面上看到什么 → 它背后做了什么 → 对应哪个接口/配置」组织。
> 版本 0.1.0；凡标注「实测」的是本机跑出来的，其余是按代码与配置的确定行为。

---

## 1. 面板（浏览器半 `client.js`）

| 部分 | 说明 |
|---|---|
| 左侧栏入口 | `sidebar.panellist`，id `hive`，order 30，六边形蜂巢图标（`icon.svg` 同款） |
| 主区 | `main` slot，key `hive`：固定 48px 控制条 + 同源 iframe（`/hive/`）+ 设置抽屉 |
| 跨域 | iframe 是**同源**的（宿主 webServer 的 `/hive` 前缀），响应带 `X-Frame-Options: SAMEORIGIN` 与 `CSP frame-ancestors 'self'`，**只允许宿主自己嵌** |
| 窄栏适配 | 面板可能只有 400px 宽：控制条按钮横排可横向滚动、不换行；抽屉在窄栏下变整宽 |
| 失败不白屏 | iframe 永远挂着；后端不可用（phase=error/uninit）时上面叠「HIVE 还没接上」引导卡（一键启动 / 重试 / 环境自检 / 仍然打开看板） |
| 轮询 | 状态每 20s 拉一次；按钮点击立刻变「处理中…」，结果落到控制条下方的提示条（失败保留更久，并原样显示 HTTP 状态与返回体） |

### 控制条（7 个动作）

| 按钮 | 做什么 | 打到哪个接口 | 备注 |
|---|---|---|---|
| 启动 | 启动引擎（幂等，已在跑则返回 already） | `POST /hive/api/control/start` | 引擎起来才有脉冲/派单 |
| 停止 | 停止引擎 | `POST /hive/api/control/stop` | **二次确认**：首次点变「确认停止？」，6s 内不点自动取消 |
| 立即巡检 | 立刻跑一轮传感器扫描并入库 | `POST /hive/api/control/scan` | 返回 `{seen, created}` |
| 环境自检 | 打开抽屉的 doctor 页 | `GET /hive/api/setup/doctor`（回退 `/hive/api/plugin/doctor`） | 服务端不可用时退到插件自体自检 |
| Agent 依赖 | 抽屉：5 个 Agent CLI 的安装/更新/降级/卸载 | `GET /hive/api/deps`、`POST /hive/api/deps/check`、`POST /hive/api/deps/:id/{install,update,uninstall}` | 落地动作走宿主 `ctx.pluginManager`；接口缺失显示「未就绪」；卸载要点两次 |
| 版本 | 抽屉：HIVE 插件自身的当前版本/检查更新/更新/降级/卸载/仓库设置 | `GET /hive/api/plugin/version`、`POST /hive/api/plugin/version/{check,apply,settings}` | 只给按钮、**永不自动改**；版本源是 GitHub Releases，读不到就如实报错 |
| 刷新 | 重拉状态并重建 iframe（刷新按钮语义） | `GET /hive/api/plugin/status` | — |

状态点四态：正常 / 降级 / 异常 / 未初始化；旁边的计数是「待办 · 待拍板 · 在跑」。

---

## 2. 看板 9 个页签

> 看板本身是 `runtime/web/`（无构建、零 CDN、离线可用），由 `runtime/src/server/http.mjs` 提供服务，
> 数据全部走 `/hive/api/*`。

### 2.1 收件箱 inbox
- **看到**：所有传感器与手工投递的事项，按 `priority` 降序；每行含类型、领域、L 级、来源、状态。
- **能做**：标题/正文搜索；按栏位（inbox/active/archive）、来源、状态、L1–L5 过滤；`+ 投递事项`（标题/类型/领域）；
  单条事项动作：**派单（dispatch）/ 归档（archive）/ 丢弃（drop）/ 恢复（restore）/ 调级（relevel 1–5）**。
- **接口**：`GET /api/items`、`POST /api/items`、`POST /api/items/:id/action`。

### 2.2 待拍板 outbox
- **看到**：审批卡——背景、建议、2–4 个选项、风险等级、有效期、状态（pending/approved/rejected/expired）。
- **能做**：批准（`approved`，批准后**立刻续跑**该事项）、拒绝（`rejected`），可选项与备注。
- **关键语义**：这是**唯一的副作用闸门**——发信 / 发布 / 删除 / 花钱 / 部署必须在这里放行。
- **接口**：`GET /api/approvals`、`POST /api/approvals/:id/decide`（body：`decision: approved|rejected` + `option?` + `note?`）。

### 2.3 任务 tasks
- **看到**：任务队列与运行记录，状态机 `queued → running → succeeded/failed/cancelled`；含执行器、尝试次数、token、耗时、错误。
- **能做**：按状态过滤、刷新、**重试**、**取消**；每个 Run 的 `stdout/stderr/result.json` 落在 `data/runs/<run-id>/` 可回溯。
- **接口**：`GET /api/tasks`、`GET /api/tasks/:id`、`POST /api/tasks/:id/retry`、`POST /api/tasks/:id/cancel`。

### 2.4 日志 logs
- **看到**：事件流（SSE 实时），含 actor（sensor/router/worker/notify/…）、type、level、message、关联 item/task。
- **能做**：按 info/warn/error 过滤、暂停实时、清屏、手动刷新。
- **接口**：`GET /api/events`、`GET /api/stream`（SSE）。

### 2.5 上下文 context
- **看到**：个人上下文事实卡（分类 / 键 / 值 / 证据 / 置信度 / 更新时间），例如「当前焦点」「作息」「偏好」。
- **能做**：新增事实（键必填、可填证据与置信度）、删除、刷新。
- **用途**：只喂给只读/建议类动作（L1/L2 与规划），**不进对外动作**。
- **接口**：`GET /api/context`、`POST /api/context`、`POST /api/context/:id/delete`。

### 2.6 执行器 agents
- **看到**：7 个执行器的**实测**探活结果（二进制在不在、版本号）、启用/禁用、24h 运行数与成功率、平均耗时、24h 与累计花费、最近一次运行；附运行时 chip（node / pwsh）。
- **能做**：刷新。
- **语义**：不可用 ≠ 系统坏了 —— `probe()` 只验二进制与版本，验不了余额/凭据（`codex` 402、`claude` 401 就是这种情况）。
- **接口**：`GET /api/agents`。

### 2.7 自动任务 autopilots
- **看到**：12 条脉冲的时间表（周期 / 上次运行 / 下次运行 / 是否已到期 / 上次状态），KPI：脉冲总数、到期未跑、上次失败数、守护进程状态。
- **能做**：逐条启用/暂停；**立即执行**（只代跑 scan / triage / watchdog —— 晨报、上下文刷新、定时自检依赖守护进程上下文与 LLM，Web 端不代跑，避免重复计费与重复推送）；启动/停止守护进程。
- **接口**：`GET /api/autopilots`、`POST /api/autopilots/:id/toggle`、`POST /api/autopilots/:id/run`。

### 2.8 成本 cost
- **看到**：窗口内花费、token、运行次数、失败数；每日花费曲线；今日预算进度条；按执行器分组的条形图；最花钱的任务。
- **护栏**：超 `settings.dailyBudgetCny` 的 80%（`budgetWarnRatio`）告警，超 100% 引擎暂停派单。
- **接口**：`GET /api/cost`。
- **注意**：插件模式下模型走宿主、成本记 0，所以这里通常全是 ¥0.00（README 已知限制 1）。

### 2.9 自检 setup
- **看到**：总体结论 PASS/WARN/FAIL + 「9 项核心检查」+「6 项依赖 CLI」，每项带 detail 与修复建议。
  - 核心 9 项：Node 版本 / `node:sqlite` / 库可写（会写一个探针 kv 键证明真的能写，不动业务表）/ 表齐全 / 执行器探活 / 外部通道 / 磁盘空间 / 今日预算 / 守护进程。
  - 依赖 6 项：`nodejs`（**只检测不安装**）、`dsh-cli`、`pi-cli`、`codex-cli`、`claude-cli`、`agently-cli`。
- **能做**：重新自检；对缺失依赖**一键 `npm i -g`**（固定白名单、180s 超时、不执行任何需要交互登录的动作，装完自动复探）。
- **接口**：`GET /api/setup/doctor`、`POST /api/setup/install`（body：`{id}`）。

---

## 3. Agent 依赖与版本管理（两个抽屉页）

### Agent 依赖（`/hive/api/deps`）

管的是「干活的手」，5 个 Agent CLI：

| id | 包 | 说明 |
|---|---|---|
| `dsh` | `@deepseek-ai/dsh` | L4/L5 默认执行器 |
| `pi` | `@earendil-works/pi-coding-agent` | 结构化输出 |
| `codex` | `@openai/codex` | 代码类任务 |
| `claude` | `@anthropic-ai/claude-code` | 长文/调查 |
| `agently` | `@tencent-qqmail/agently-cli` | 邮箱通道 |

每行能做的动作：**安装 / 更新 / 降级 / 卸载**（已装的行禁用「安装」；卸载需连点两次才真的发请求）。
可用版本来自 npm registry（`GET /deps` 同时返回已装版本与最新版本），版本比较做了 `1.10.0 > 1.9.9` 这类边界处理。

护栏：只做 `npm i -g` 全局安装；固定白名单；不执行任何需要交互登录的命令；装完自动复探执行器。
接口不可用时显示「该接口未就绪」并给出原因，**不崩、不假装成功**。

### 版本（`/hive/api/plugin/version`）

管的是 HIVE 插件自身，三条硬原则写在 `version.mjs` 头部：

1. **永不自动改** —— 只提供信息与按钮，落不落地由用户点。
2. **落地走宿主** —— 安装/卸载统一经 `ctx.pluginManager`（与 `dsh plugin add` 同一条路径），
   不自造包管理（否则会把 profile 的 `package.json` / patch 写坏）。
3. **拿不到就如实说** —— 本地目录安装、离线、仓库未发布，都直接报出来，不编版本号。

能看到：当前版本（来自 `pluginManager.listBundles` 与本地 `package.json`）、可用版本列表（GitHub Releases）、
最新稳定版、以及「为什么现在不能升」（例如 `link:` 安装会提示需改成 GitHub / registry 安装）。
设置项落在 `$DSH_HOME/hive/version-settings.json`（仓库、自动检查开关与周期）。

---

## 4. L1–L5 自主分级

| 等级 | 含义 | 系统会做什么 | 打扰你吗 |
|---|---|---|---|
| L1 | 理解、整理、提取待办 | 内联 LLM 出结论，不动外部状态 | 不 |
| L2 | 分析、给建议和方案 | 内联 LLM 出方案，存为产物 | 不 |
| L3 | 完成部分工作、出中间成果 | 派给进程执行器，在工作区产出文件 | 不 |
| L4 | 自主完成大部分、关键环节确认 | **先进 Outbox 请示**，批准后执行 | 会 |
| L5 | 端到端自主、自验证、交付 | 直接执行；仅敏感动作请示 | 仅敏感动作 |

**判定是确定性规则优先**（`runtime/src/task/triage.mjs` + `policies.json`）：

```
动作意图 → 基准等级（read/summarize/classify=1，analyze/plan=2，draft/write_local/research=3，
                       code_change=4，send_external/publish/delete/spend/deploy=4 且强制审批）
        → 修正项（不可逆封顶 L4、对外可见封顶 L4、金额>5 元封顶 L3、置信度<0.6 封顶 L2）
        → 提升项（同类历史成功率 ≥0.85 且样本 ≥5 → +1；已有同型审批通过记录 → +1）
        → 能力闸门（没有可用执行器就降级到内联）
        → clamp
```
置信度 < 0.6 时才让便宜模型兜底判一次，且只取**更保守**的那个结果。

**车道限流**（`settings.lanes`）：L1 3 并发 / L2 2 / L3 2 / L4 1 / L5 1。

---

## 5. Inbox 事项模型

| 字段 | 含义 |
|---|---|
| `id` / `created_at` / `updated_at` / `last_seen_at` | 主键与时间；重复感知只 bump `last_seen_at` |
| `source` / `source_ref` / `dedupe_key` | 来源（mail/git/docs/calendar/pulses_local/self/agent/manual）、来源内引用、去重键（UNIQUE） |
| `title` / `body` | 标题与正文（正文上限 20k 字符，标题 200） |
| `kind` | todo / issue / opportunity / decision / risk / fyi（`kind_alias` 会把 email→todo、git_wip→issue、pulse_failed→risk 等归一） |
| `domain` | work / trade / startup / ai / content / life / family / ops / code / comms |
| `urgency` / `impact` | 1–5，缺省按 `kind_defaults` |
| `priority` | `impact*2.0 + urgency*1.5 + domainWeight + recencyBoost - effortPenalty(L级)` |
| `autonomy_level` / `autonomy_ceiling` / `confidence` / `level_reason` | 判级结果与理由 |
| `status` / `bucket` | bucket：inbox / outbox / active / archive；status：inbox / planned / running / done / awaiting_human / archived / dropped |

**噪声压制**：`noise_patterns`（退信、mailer-daemon、unsubscribe…）与 `low_value_patterns`（各类 lock 文件、心跳 json）会强制降权。

---

## 6. Outbox 审批模型

| 字段 | 含义 |
|---|---|
| `kind` / `title` / `summary` / `context` | 类型、标题、摘要、背景 |
| `options` | 2–4 个可执行选项（JSON） |
| `recommendation` / `risk` | 建议与风险等级 |
| `status` | pending → approved / rejected / expired（`approvalTtlHours` 默认 72h） |
| `decided_at` / `decided_by` / `decision` / `note` | 谁在什么时候怎么拍的 |
| `expires_at` / `notified_count` / `last_notified_at` | 有效期与推送计数（`maxNotifyPerDay` 默认 12） |

批准后 Router 会以 `skipApproval` 再跑一次该事项，把工作真正推进下去；拒绝则把事项归档。

---

## 7. 12 条脉冲（调度节奏）

| id | 名称 | 周期 | handler |
|---|---|---|---|
| `pulse-scan-mail` | 巡检·mail | 每 15m | scan（mail） |
| `pulse-scan-git` | 巡检·git | 每 30m | scan（git） |
| `pulse-scan-docs` | 巡检·docs | 每 60m | scan（docs） |
| `pulse-scan-calendar` | 巡检·calendar | 每 60m | scan（calendar） |
| `pulse-scan-pulses_local` | 巡检·pulses_local | 每 30m | scan（pulses_local） |
| `pulse-scan-self` | 巡检·self | 每 60m | scan（self） |
| `pulse-triage` | 事项判定与路由 | 每 10m | triage |
| `pulse-watchdog` | 看门狗 | 每 1m | watchdog |
| `pulse-digest-morning` | 晨报 | 每天 08:40 | digest(morning) |
| `pulse-digest-evening` | 晚报 | 每天 21:30 | digest(evening) |
| `pulse-context` | 上下文刷新 | 每天 07:50 | context |
| `pulse-selfcheck` | 自检 | 每 6h | selfcheck |

**说明**：扫描类脉冲由 `sources.<name>.enabled !== false` 生成（每路一条），所以关掉某路传感器它就少一条；
`x` 与 `wechat` 默认关闭，因此默认正好 12 条。脉冲有超时保护（`settings.pulseTimeoutSec`，默认 240s），
失败写 `last_status=fail` 并进事件流，不影响其它脉冲。

---

## 8. 传感器 6 路

| 名称 | 默认 | 间隔 | 扫什么 | 备注 |
|---|---|---|---|---|
| `mail` | 开 | 15m | 邮箱未读列表（`agently-cli`），按线程/主题聚合 | **默认不抓正文**（`fetchBody=false`）：抓正文的命令会**把邮件标记为已读**，要正文需显式开 `sources.mail.fetchBody=true` 并接受这个副作用 |
| `git` | 开 | 30m | 配置里的仓库：未提交变更、未推送提交 | 仓库不存在则跳过（不报错中断） |
| `docs` | 开 | 60m | 配置里的文档根目录：72h 内变更的 md/txt/html/json | 低价值文件（lock、心跳）降权 |
| `calendar` | 开 | 60m | `data/calendar/*.ics` 的 72h 内事件 | 只支持 ICS，没有本地日历源时静默 0 条 |
| `pulses_local` | 开 | 30m | 本机既有自动化产物（pi-agent automations / dsh-home duties）作为进展/停滞信号 | 这是最容易「抓到真问题」的一路 |
| `self` | 开 | 60m | 失败任务堆积、预算、数据库健康 | 自检类风险项 |

另有两个**默认关闭**的源：`x`（依赖 DSH 的 x_* 工具）、`wechat`（依赖 `D:\elohia` 的 wcdb 桥，隐私原因默认关）。

---

## 9. 执行器 7 个

| 名称 | 类型 | 默认命令 | 用途 |
|---|---|---|---|
| `llm` | inline | — | 进程内 LLM 调用；L1/L2 与 cheap 任务的主力 |
| `dsh` | process | `dsh --profile headless` | L4/L5 默认落点；冷启动预算 `coldStartSec=55` |
| `pi` | process | `pi -p --mode json` | 结构化输出 |
| `codex` | process | `codex exec --skip-git-repo-check` | 代码类任务 |
| `claude` | process | `claude -p` | 长文/调查类任务 |
| `shell` | process | `pwsh -NoProfile -Command` | **只跑命令，不接自然语言任务** |
| `proc` | process | 需显式配置 `executors.proc.command` | 通用兜底，未配置等于未启用 |

**白名单**：只有 `llm / dsh / pi / codex / claude` 能接自然语言任务；`shell` 只能跑确定命令（否则整段 prompt 会被当 PowerShell 解析）。

---

## 10. 4 个 Agent 工具（会话内直接用）

| 工具 | 语义细节 | 超时 |
|---|---|---|
| `hive_status` | 返回 `pending`（收件箱各栏计数）、`cost`（今日）、`engine`（运行态/拍数/错误）、`model`、`home` | 20s |
| `hive_capture` | `upsertItem()` 入库，`source='agent'`，返回 `{id, created, priority}`；重复标题会走 `dedupe_key` 去重 | 20s |
| `hive_run` | `processItem(id, {force:true})`：返回 `route`（inline/dispatched/approval/skip）、`level`、`reason`、内联结论摘要、`approval` id | 120s |
| `hive_decide` | `decision: approve` → 先 `decideApproval` 再 `processItem(skipApproval)` 续跑；`reject` → 归档 | 120s |

工具输出统一是 JSON 文本（截断到 8000 字符），模型和人都能读。

---

## 11. HTTP API（`/hive/api/*`）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/health` | 健康（node/db/executors/sensors/budget） |
| GET | `/overview` | 看板汇总 KPI |
| GET/POST | `/items` | 列表 / 投递 |
| GET | `/items/:id` | 详情 |
| POST | `/items/:id/action` | dispatch / archive / drop / restore / relevel |
| GET | `/tasks` · `/tasks/:id` | 任务列表 / 详情 |
| POST | `/tasks/:id/retry` · `/cancel` | 重试 / 取消 |
| GET | `/approvals` · POST `/approvals/:id/decide` | 审批 |
| GET | `/events` · `/stream` | 事件 / SSE |
| POST | `/scan` | 立刻巡检 |
| GET/POST | `/context` · POST `/context/:id/delete` | 上下文事实 |
| GET | `/doctor` | 旧版自检（嵌套结构，作第三级兜底） |
| GET | `/agents` | 执行器探活与统计 |
| GET | `/autopilots` · POST `/autopilots/:id/toggle` · `/run` | 脉冲 |
| GET | `/cost` | 成本报表 |
| GET | `/deps` · POST `/deps/check` | Agent 依赖清单（已装版本 / 最新版本）/ 强制复检 |
| POST | `/deps/:id/install` · `/update` · `/uninstall` | 依赖落地动作（`uninstall` 需 `confirm:true`） |
| GET | `/setup/doctor` · POST `/setup/install` | 自检与一键安装（`/setup/install` 是 `/deps/:id/install` 的兼容别名） |
| POST | `/control/start` · `/stop` · `/scan` | 引擎控制 |
| GET | `/artifacts/:id` | 取产物文件 |

**插件自有**（Host 半 `index.js` 直接处理，比看板接口更可靠）：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/plugin/status` | phase / home / dbPath / engine / model / created |
| GET | `/plugin/doctor` | 5 项插件级自检（node / sqlite / engine / llm / route） |
| GET | `/plugin/events` | 最近 100 条插件事件（环形缓冲，不落库） |
| POST | `/plugin/start` · `/plugin/stop` · `/plugin/restart` | 引擎控制 |
| POST | `/plugin/scan` · `/plugin/trigger` | 触发一轮（`what`：scan/triage/watchdog/digest/selfcheck） |
| GET | `/plugin/version` | 当前版本 + 安装来源 + 只读原因（走 `ctx.pluginManager.listBundles`） |
| POST | `/plugin/version/check` | 读 GitHub Releases 列可用版本（读不到就返回 `error`，不编版本号） |
| POST | `/plugin/version/apply` | 装/升/降/卸载（走宿主 `pluginManager`）；`/version/settings` 存仓库与自动检查配置 |

> 路径前后缀都宽容（`/items` 与 `/items/` 等价）；所有错误统一返回 `{error}`；
> 仅监听回环地址，`server.token` 非空时校验 `X-Hive-Token`。

---

## 12. 通知与「守中」

- 通道：Windows Toast（WinRT via PowerShell 5.1）、邮件（默认关，需填 `notify.mail.to` 且**必须人工批准后才发**）、看板（事件流）。
- 全部 fail-soft：通道失败不影响任务。
- **守中**：`priority < settings.quietThreshold`（默认 6）的事项只入 Inbox，不通知、不自动执行。
- 每日推送上限 `maxNotifyPerDay`（默认 12），超了记 `notify.suppressed` 事件而不是硬发。

---

## 13. 红线与隐私

| 机制 | 位置 | 行为 |
|---|---|---|
| 红线目录 | `policies.never_touch` | 写入前拦截并抛错（默认含微信原始/归一语料、`.credentials.yaml`、他人微信账号目录） |
| 写盘白名单 | `policies.write_allowlist_dirs` | 不在白名单内一律拒绝；**白名单为空 = 不做该项限制**（换机器时注意） |
| 派发前拦截 | `checkGoalAgainstRedlines` | 目标文本里出现红线路径就不派发，不等执行器动手 |
| 执行器白名单 | `policy.side_effect_actions` + 执行器能力 | 副作用动作必须过审批 |
| 只监听回环 | `server.host=127.0.0.1` | 非回环会打印告警；独立版默认 `X-Frame-Options: DENY`，插件模式仅允许同源嵌入 |

---

## 14. 数据模型（一张库，10 张表）

| 表 | 用途 |
|---|---|
| `items` | 事项（收件箱/待拍板/进行中/归档） |
| `tasks` | 派出去的任务（含租约 `lease_until`、`heartbeat_at`、预算、重试） |
| `runs` | 每次执行的原始记录（命令、pid、耗时、退出码、token、花费、产物目录） |
| `artifacts` | 产物登记（路径、大小、sha256） |
| `approvals` | 审批卡 |
| `events` | 事件流（看板日志/SSE 的来源） |
| `pulses` | 定时巡检 |
| `context_facts` | 个人上下文事实 |
| `cursors` | 传感器游标（增量扫描） |
| `kv` | 杂项键值（如自检探针） |

库文件：`$DSH_HOME/hive/data/hive.db`（WAL 模式，开启 `foreign_keys`），是**唯一事实源**。
