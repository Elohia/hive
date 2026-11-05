# AGENTS.md — HIVE（蜂巢）· 主动服务型超级智能体

> 本项目唯一项目级约定与轮子清单（L1 项目层）。全局纪律见 `$DSH_HOME/AGENTS.md`（L0）。
> **写入规则：每次新增/扩展轮子、改变数据契约、改变部署方式后必须回写本文件。未登记的轮子视为不存在。**

---

## 一、一句话目标

把本机已有的 Agent 生态（DSH / Pi / Codex / Claude Code / MCP / Skills / 浏览器 / 邮箱 / X / 交易自动化）
**组合成一个常驻、主动、可交付**的系统：自己感知信息 → 自己发现任务 → 自己判定 L1–L5 自主等级 →
自己规划执行 → 需要人时进 Outbox 请示 → 交付成果并持续跟进。

**北极星**：用户只关注**目标与关键决策**，其余由系统自主完成。

## 二、先读什么（新人/新会话必读顺序）

1. `README.md` —— 当前状态与三分钟上手
2. `docs/01-ARCHITECTURE.md` —— 架构与不变量（改代码前必读）
3. `docs/02-CONFIG.md` —— 配置项与唯一硬编码落点
4. `docs/04-TOOLING.md` —— 工具使用经验（踩过的坑）
5. `docs/05-RUNBOOK.md` —— 运维、排障、恢复

## 三、铁律（本项目特有，优先级高于一般习惯）

1. **单一事实源**：所有任务/审批/事件状态只存 `data/hive.db`（SQLite WAL）。**不允许**在文件系统另立影子状态。
2. **零外部依赖**：运行时只用 Node 内置模块（`node:sqlite` / `node:http` / `node:child_process`）。不装 npm 包进运行时。
   理由：可移植、可迁移、不会因依赖腐烂而停摆。开发期工具同样不得进入运行时依赖。
3. **执行器可换、契约不变**：所有 Agent 执行都走 `src/executors/*` 的统一接口（`run(ctx) -> Result`），
   换 DSH / Pi / Codex / 裸 LLM 不改上层。
4. **副作用必须过闸**：任何对外不可逆动作（发信/发布/删除/花钱/部署）**只能**通过 `hitl.request()` 产生
   Approval，人工批准后才允许执行。禁止在 worker 里直接调写操作。
5. **一切可重放**：每个 Run 落 `data/runs/<run_id>/`（prompt、stdout、stderr、result.json、meta.json）。
   任何结论都能回溯到某次 Run 的原始输出。
6. **幂等**：Sensor 用 `(source, source_ref)` 去重；Task 用 `dedupe_key`；重跑不得产生重复条目。
7. **失败不静默**：失败必须写 `events(level=error)` + `runs.error`，并在看板可见。重试有上限、有退避。
8. **预算护栏**：每任务有 token/时长预算，Watchdog 超限即杀；每日总预算超限暂停派单并上报。

## 四、目录结构

```
D:\hive\
  AGENTS.md            # 本文件
  README.md            # 状态 + 快速开始
  VERSION              # 语义化版本
  config\
    hive.json          # 唯一配置落点（路径/端口/预算/executor 命令）
    policies.json      # L1-L5 判定规则 + 副作用闸门规则
    sources.json       # 传感器启用与参数
  docs\                # 00 调研 / 01 架构 / 02 配置 / 03 依赖 / 04 经验 / 05 运维 / 06 迁移
  prompts\             # 给 LLM / Agent 的提示词模板（可版本化）
  src\
    core\              # db / config / events / log / ids / util
    task\              # taskcenter / triage(L1-L5) / router / planner / watchdog
    sensors\           # mail / git / docs / calendar / x / wechat / dsh / pi / web
    executors\         # dsh-headless / pi / codex / llm / shell / human
    hitl\              # approval / outbox / notify
    context\           # profile（个人上下文）/ projects / habits
    server\            # http + api + sse
  web\                 # 看板（无构建步骤的静态页）
  scripts\             # hive.mjs（CLI）/ install-task.ps1 / healthcheck
  data\
    hive.db            # SQLite（WAL）
    runs\              # 每次 Run 的原始产物
    artifacts\         # 交付物
    logs\              # 进程日志（滚动）
  tests\               # 冒烟 / 集成 / 端到端
```

## 五、轮子清单（禁止重复造轮子）

> **未登记 = 不存在。** 新增/改造任何可复用脚本后必须回来补一行。

### 5.1 CLI / 入口

| 轮子 | 路径 | 用途 | 调用姿势 |
|---|---|---|---|
| 主 CLI + 守护进程 | `scripts/hive.mjs` | 全部命令入口：daemon/serve/scan/run/inbox/outbox/approve/reject/tasks/work/retry/events/doctor/stats/seed/context | `node --no-warnings scripts/hive.mjs <命令>` |
| 环境体检 | `scripts/healthcheck.mjs` | 29 项探测 PASS/WARN/FAIL + 退出码；`--fast` 2.7s / `--json` / `--strict` | `node --no-warnings scripts/healthcheck.mjs` |
| 备份 | `scripts/backup.mjs` | `VACUUM INTO` 快照 + bsdtar 打包 + sha256 旁文件 | `node --no-warnings scripts/backup.mjs --out data\bak.zip` |
| 恢复 | `scripts/restore.mjs` | 三链校验 → 询问 → 安全网另存 → 覆盖 → 逐表复核 | `node --no-warnings scripts/restore.mjs --archive <zip> [--yes]` |
| 开机自启 | `scripts/install-task.ps1` | 注册 Windows 计划任务（隐藏启动 + 失败重启，幂等） | `powershell -File scripts\install-task.ps1` |

### 5.2 核心库（跨模块只经这些契约）

| 轮子 | 路径 | 用途 | 调用姿势 |
|---|---|---|---|
| 配置 | `src/core/config.mjs` | 唯一配置装载点；`home`(数据，可被 HIVE_HOME 改) 与 `codeRoot`(代码，永不变) 分离 | `loadConfig()` → `cfg.resolved.*` |
| 数据库 | `src/core/db.mjs` | SQLite WAL 单库；`q.all/get/run`（自动归一化参数类型）；`tx()` | `import { q, tx, kvGet, kvSet, cursorGet, cursorSet }` |
| 事件溯源 | `src/core/events.mjs` | `emit(subscribe)` 双写：表 + 内存广播（SSE 数据源） | `emit({actor,type,item_id,message,data})` |
| LLM | `src/core/llm.mjs` | OpenAI 兼容；`node:https` 直连（显式 `agent:false` 绕代理）；按 provider/tier 计费 | `chat({provider,tier,messages,json,schemaHint})` |
| 凭据 | `src/core/credentials.mjs` | 解析 `F:\dsh-home\.credentials.yaml` 的 `refs:` 段（不落盘不打印） | `getKey('DEEPSEEK_API_KEY')` |
| 红线守卫 | `src/core/guard.mjs` | `write_allowlist_dirs` / `never_touch` 的**机器强制**（不只是声明） | `assertWritable(p)` · `checkGoalAgainstRedlines(text)` |

### 5.3 任务层

| 轮子 | 路径 | 用途 | 调用姿势 |
|---|---|---|---|
| 任务中心 | `src/task/taskcenter.mjs` | **唯一状态写入 API**（items/tasks/runs/approvals/artifacts）；含二级去重、类型归一、优先级计算 | `upsertItem` `createTask` `claimNextTask` `createApproval` `decideApproval` `todayCost` |
| L1–L5 判定 | `src/task/triage.mjs` | 动作意图 → 基准等级 → 修正 → 能力闸门；LLM 仅低置信兜底且取保守值 | `triage(item,{availableExecutors})` |
| 规划器 | `src/task/planner.mjs` | 拆 DAG（keys + depends_on）；执行器白名单只允许 llm/dsh/pi/codex/claude | `plan({item,level,defaultExecutor})` |
| 路由 | `src/task/router.mjs` | 内联 / 派发 / 请示；fyi 守中不派活；红线拦截 | `processItem(id)` · `triageInbox()` |
| 执行 | `src/task/worker.mjs` | 派发单个 task：租约、run 落盘、DAG 前置产出注入、退避重试 | `dispatchTask(id)` · `drainQueue()` · `drainAll()` |
| 看门狗 | `src/task/watchdog.mjs` | 租约/超时/超预算 kill + 崩溃恢复 + 审批过期 | `recover()` · `tick()` · `health()` |
| 脉冲 | `src/task/pulse.mjs` | 定时巡检：`every/Nm` `daily/HH:MM` `weekly/1,2/HH:MM` | `seedPulses()` `duePulses()` `markPulseRun()` |

### 5.4 感知 / 执行 / 交付

| 轮子 | 路径 | 用途 | 调用姿势 |
|---|---|---|---|
| 传感器注册表 | `src/sensors/index.mjs` | `scanAll(ctx,{only})` 统一 AsyncIterable；单源失败隔离；domain 白名单收敛 | `for await (const raw of scanAll(ctx))` |
| 邮件感知 | `src/sensors/mail.mjs` | agently-cli 读 QQ 邮箱；同轮聚合、48h 年龄窗、**默认不抓正文（+read 会标已读）** | 由注册表驱动 |
| 仓库感知 | `src/sensors/git.mjs` | 提交/未提交/未推送三类信号；有界嵌套发现 | 同上 |
| 文档感知 | `src/sensors/docs.mjs` | 按 mtime 扫文档，黑名单降噪 | 同上 |
| 日历感知 | `src/sensors/calendar.mjs` | 零依赖 ICS 解析（折叠行/TZID），72h 窗口 | 同上 |
| 本机值守感知 | `src/sensors/pulses_local.mjs` | 读 pi-agent automations + 三个 duty 的 state/seen，识别停摆 | 同上 |
| 自检感知 | `src/sensors/self.mjs` | 只读快照：失败堆积/预算/DB/错误事件 | 同上 |
| 执行器注册表 | `src/executors/index.mjs` | `list/get/probe/run`；`probe()` 带版本；`run()` 绝不抛 | `probe()` · `run(name, ctx)` |
| 进程基座 | `src/executors/proc.mjs` | spawn + 超时 + 进程树 kill（`taskkill /T /F`）+ 行级 onLog | 被各执行器复用 |
| HITL 通知 | `src/hitl/notify.mjs` | Windows Toast（WinRT，无需模块）/ 邮件 / 看板；每日上限 | `notify({title,body})` · `approvalMessage(ap)` |
| 上下文 | `src/context/profile.mjs` | 聚合事实/活跃度/未竟/外部档案 → 注入 prompt 的文本 | `buildContextText()` · `upsertFact()` |
| 上下文归纳 | `src/context/builder.mjs` | 从真实信号归纳「我是谁/在做什么/欠着什么/机会/风险」并写回 | `refreshContext()` · `seedBaselineFacts()` |
| 看板服务 | `src/server/http.mjs` | 零依赖 HTTP + 静态 + SSE；端口冲突自动顺延；close 幂等 | `startServer({port})` |
| 看板前端 | `web/{index.html,app.js,style.css}` | 5 标签（Inbox/Outbox/任务/日志/上下文），离线可用 | 浏览器打开 `/` |

### 5.5 测试

| 轮子 | 用途 | 命令 |
|---|---|---|
| 核心冒烟 | 配置/凭据/DB/ID/事件/LLM | `node --no-warnings tests/smoke-core.mjs`（10/10） |
| 传感器冒烟 | 6 路真跑 | `node --no-warnings tests/sensors-smoke.mjs`（29/29） |
| 执行器冒烟 | probe + 真跑 llm/shell；`--slow` 才跑 dsh | `node --no-warnings tests/exec-smoke.mjs` |
| 看板/API 冒烟 | 89 项（隔离 HIVE_HOME） | `node --no-warnings tests/server-smoke.mjs`（89/89） |
| **端到端闭环** | 信息发现→识别→规划→执行→确认→交付 + 恢复/预算/SSE | `node --no-warnings tests/e2e.mjs`（40/40） |

## 六、已否定/不采用（先例，别重犯）

- **不自建 Docker 化 Multica**：本机无 Docker，Multica 自托管需 Docker + Postgres；16GB RAM 跑不动。
  → 采用「借鉴其 Issue/Inbox/Autopilot/Run/Review-gate 概念 + 自建轻量 SQLite 实现」。
- **不用外部审批 SaaS**：Outbox 必须是本地 SQLite + 本地通知（Toast/邮件），断网可用。

## 七、当前状态

见 `README.md` 顶部状态表与「实测记录」。

### 已知缺口（诚实清单，别假装已解决）

1. **微信 / X 传感器默认关闭**：需要在 `config/hive.json` 里打开并补适配器；当前只有 mail/git/docs/calendar/pulses_local/self 六路真实在跑。
2. **日历通道无本地数据源**：只支持 ICS 文件，本机没有 ICS → 静默 0 条。
3. **`pulseGraceSec` 未单独接线**：错过的脉冲由 `duePulses()` 在下一 tick 自然补跑，没有「超过宽限期则跳过」的策略。
4. **L4/L5 的「自主验证」目前是「执行器自述 + 产物落盘 + 可回溯」**，没有独立的自动化验收器（没有第二套测试去判定产出对不对）。
5. **`executors.proc` 未配 command**：通用执行器保持 WARN，避免 router 选到它。
6. **邮件正文默认不抓**：`agently-cli message +read` 会把邮件标记为已读且无回滚命令，所以默认只用 snippet。
7. **成本估算用配置里的单价表**，可能与实际账单有偏差。
8. **`codex` 不可用**：上游 `api.xiaomimimo.com` 账户余额不足 → 402（2026-11-05 实测）；执行器如实返回失败，不静默。
9. **`claude` 不可用**：`~/.claude/settings.json` 的 `ANTHROPIC_AUTH_TOKEN` 已失效 → 401（2026-11-05 实测）；CLI 自身重试约 197s，90s 超时下表现为「超时」。
   → 这两条不阻塞系统：L4/L5 默认走 `dsh`，`probe()` 只验二进制与版本，验不了余额/凭据有效性。
10. **L1/L2 不自动派进程执行器**（设计决定，非缺陷）：低等级是「理解与建议」，需要真工具时内联会写清「缺什么证据、该谁去做」，由人决定是否升级。只有 L3+ 才自动派活。想强制派发用看板的「派单执行」或 `hive run --no-approval`。
11. **关键词判定仍有误报**：`修复/发布` 等词会把「给出修复动作」这类纯分析抬到 L4。已加置信度兜底但不彻底，人工可在看板「调级」纠正。
