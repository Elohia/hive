# HIVE · 蜂巢

**主动服务型超级智能体** —— 自己感知、自己发现任务、自己判断能不能干、自己干、需要你时只问关键决策。

> 你只需要关注**目标与关键决策**，剩下的事情尽可能交给它。

---

## 这是什么

HIVE 把本机已有的 Agent 生态组合成一个常驻系统：

- **手**：DSH / Pi / Codex / Claude Code（4 个 Agent CLI）+ 裸 LLM（DeepSeek / GLM / MiMo）
- **感官**：邮箱（QQ 邮箱 via agently-cli）、Git 仓库、文档变更、日历、本机既有自动化产物、自检
- **脑**：L1–L5 自主等级判定 + 规划器（拆 DAG）+ Router（内联 / 派活 / 请示）
- **闸门**：Outbox 人工审批（对不可逆/对外动作强制拦截）
- **看板**：Inbox / Outbox / 任务 / 运行日志 / 个人上下文，SSE 实时
- **骨架**：SQLite 单库持久化 + 租约看门狗 + 失败退避重试 + 预算护栏 + 崩溃恢复

设计血统：任务中心形态参考 **Multica**，运行时结构参考 **DeepSeek Super-agent**（Router / Worker / Watchdog），
审批流参考 **OpenDuet / open-super-agent**，自主动机参考本机 **EVO** 内核。详见 [docs/00-RESEARCH.md](docs/00-RESEARCH.md)。

---

## 当前状态

| 模块 | 状态 | 入口 |
|---|---|---|
| 核心（配置/DB/事件/LLM/凭据/红线守卫） | ✅ 已实测 | `src/core/` |
| 任务中心（items/tasks/runs/approvals/events） | ✅ 已实测 | `src/task/taskcenter.mjs` |
| L1–L5 判定 | ✅ 已实测（规则优先 + LLM 兜底 + 能力闸门） | `src/task/triage.mjs` |
| 规划器（拆 DAG + 前置产出注入） | ✅ 已实测 | `src/task/planner.mjs` |
| Router / Worker / Watchdog（含退避、车道、租约、崩溃恢复） | ✅ 已实测 | `src/task/{router,worker,watchdog}.mjs` |
| 脉冲调度（12 条随机启动） | ✅ 已实测 | `src/task/pulse.mjs` |
| 传感器 6 路（mail/git/docs/calendar/pulses_local/self） | ✅ 已实测（真实数据） | `src/sensors/` |
| 执行器 6 个（llm/dsh/pi/codex/claude/shell） | ✅ 已实测（dsh 真跑通） | `src/executors/` |
| HITL 通知（Windows Toast） | ✅ 已实测弹出 | `src/hitl/notify.mjs` |
| 个人上下文归纳 | ✅ 已实测（归纳出 11 项真实结论） | `src/context/builder.mjs` |
| 看板 + HTTP API + SSE | ✅ 已实测 | `src/server/`, `web/` |
| 运维（自检/备份恢复/开机自启） | ✅ 已实测（计划任务已注册） | `scripts/` |
| 测试 | ✅ 5 套全绿 | `tests/` |

**测试结果（2026-11-05 实测）**

| 套件 | 结果 | 耗时 |
|---|---|---|
| `tests/smoke-core.mjs` | **10/10 PASS** | 1.6s |
| `tests/sensors-smoke.mjs` | **29/29 PASS** | 19s |
| `tests/exec-smoke.mjs` | **50 PASS / 0 FAIL / 3 SKIP** | 172s |
| `tests/server-smoke.mjs` | **89/89 PASS** | 10.3s |
| `tests/e2e.mjs`（端到端闭环） | **40/40 PASS** | 18s |

详细交付状态见 `README` 末尾「实测记录」。

---

## 三十秒上手

```powershell
cd D:\hive

# 1) 环境自检
node --no-warnings scripts/hive.mjs doctor

# 2) 跑一轮感知（邮箱 / git / 文档 / 本机自动化 / 自检）
node --no-warnings scripts/hive.mjs scan

# 3) 看待办
node --no-warnings scripts/hive.mjs inbox

# 4) 投一个任务，让系统自己判定等级并执行
node --no-warnings scripts/hive.mjs run "总结 D:\hive\docs 下现在有什么，列 3 条待办" --drain

# 5) 起常驻守护 + 看板
node --no-warnings scripts/hive.mjs daemon
# 浏览器打开 http://127.0.0.1:8787
```

---

## 核心概念

### L1–L5 自主等级

| 等级 | 含义 | 系统会做什么 | 会不会打扰你 |
|---|---|---|---|
| **L1** | 理解、整理、提取待办 | 内联 LLM 出结论，不动任何外部状态 | 不会 |
| **L2** | 分析、给建议和方案 | 内联 LLM 出方案，存为产物 | 不会 |
| **L3** | 完成部分工作、出中间成果 | 派给进程执行器，在工作区产出文件 | 不会 |
| **L4** | 自主完成大部分、关键环节确认 | **先进 Outbox 请示**，批准后执行 | 会 |
| **L5** | 端到端自主、自验证、交付 | 直接执行；仅敏感动作（发信/发布/删除/花钱）请示 | 仅敏感动作 |

判定是**确定性规则优先**：动作意图 → 基准等级 → 不可逆/对外/金额下调 → 历史成功率上调 → 能力闸门 → clamp。
置信度低于 0.6 才让便宜模型兜底一次，且只取**更保守**的那个。

### Inbox / Outbox

- **Inbox**：系统感知到的一切，去重后按 `priority` 排序。低价值（噪声/退信/订阅）自动降权，不会打扰你。
- **Outbox**：需要你拍板的事。每张卡片带：背景、建议、2–4 个可执行选项、风险等级、有效期。批准后系统**自动继续推进**。

### 守中

`priority < settings.quietThreshold` 的事项只入 Inbox，不通知、不自动执行。
每日推送有上限（`maxNotifyPerDay`），预算有上限（`dailyBudgetCny`）。

---

## 命令

| 命令 | 作用 |
|---|---|
| `hive daemon [--port 8787]` | 常驻：巡检 + 判定 + 派发 + 看门狗 + 看板 |
| `hive serve` | 只起看板 |
| `hive scan [--source mail]` | 立即跑一轮感知 |
| `hive run "<任务>" [--drain] [--no-approval]` | 手工投递并立刻路由 |
| `hive inbox` / `hive outbox` / `hive tasks` / `hive events` | 看状态 |
| `hive approve <id> --option approve\|revise\|reject [--note]` | 拍板（批准后自动续跑） |
| `hive reject <id>` | 拒绝并归档 |
| `hive work` | 把队列跑空 |
| `hive retry <task-id> [--now]` | 重试 |
| `hive doctor` / `hive stats` / `hive seed` | 自检 / 汇总 / 重建脉冲 |

---

## 目录

```
config\     hive.json（唯一配置落点）· policies.json（L1-L5 规则）· sources.json
docs\       00 调研 · 01 架构 · 02 配置 · 03 依赖 · 04 工具经验 · 05 运维 · 06 迁移
src\core\   db / config / events / log / llm / credentials / ids
src\task\   taskcenter / triage / planner / router / worker / watchdog / pulse
src\sensors\ mail / git / docs / calendar / pulses_local / self
src\executors\ llm / dsh / pi / codex / claude / shell / proc
src\hitl\   notify（Toast / 邮件 / 看板）
src\context\ profile（个人上下文聚合）
src\server\ http / api / sse
web\        看板（零构建静态页，离线可用）
scripts\    hive.mjs（CLI+daemon）· healthcheck · backup · restore · install-task.ps1
data\       hive.db · runs\（每次执行原始产物）· artifacts\（交付物）· logs\
```

---

## 设计不变量

1. **单库**：所有状态只在 `data/hive.db`，不另立影子状态。
2. **零运行时依赖**：只用 Node 内置模块（`node:sqlite` / `node:http` / `node:child_process`）。
3. **执行器可换、契约不变**：换 Agent 不改上层。
4. **副作用必须过闸**：对外不可逆动作只能经 Outbox 批准。
5. **一切可重放**：每个 Run 的 prompt / stdout / stderr / result 落 `data/runs/<id>/`。
6. **幂等**：sensor 用 `(source, source_ref)` 去重，重复感知只 bump `last_seen_at`。
7. **失败不静默**：错误进 events + runs + 看板，重试有上限有退避。
8. **预算护栏**：单任务 token/时长预算，超限 kill；每日总预算超限暂停派单。

---

## 实测记录

> 逐条都是真跑出来的，不是设计稿。

- `tests/smoke-core.mjs` **10/10 PASS**：配置、凭据（5 个 key）、DB schema、ID、事件、LLM 真调（deepseek-chat 1.4s）。
- 首次真实扫描 `hive scan`：**33 条**真实事项（mail 12 / git 3 / docs 10 / pulses_local 8），耗时 16.6s。
  - 发现真问题：`xhs-duty` 已 5.9 天未运行、`bili-duty` 5.8 天未运行、`盘中` 自动化 37 天未跑且含失败。
  - 噪声治理：8 封退信自动识别为 `fyi` 并降权到 9.3→（噪声强制 1/1）。
- `hive run` 内联路径：L1 判定（conf 0.79）→ LLM 出结论 → 产物落 `data/artifacts/`；模型**拒绝编造**能力清单并指出缺证据。
- `hive run` 派发路径：识别「需要真工具」→ 不内联，规划成 3 步 DAG（list → read → summarize）并建任务链。
- 看板 HTTP：`/api/health`、`/api/overview` 真实返回；dashboard 静态页可离线打开。
- Windows Toast：实测弹出成功。

---

## 版本与迁移

- 版本见 `VERSION`；每次结构性变更在 `docs/` 留档。
- 迁移到新机器：`hive backup` → 拷 `config/` → 改 `config/hive.json` 里的路径 → `hive restore` → `scripts/install-task.ps1`。细则见 [docs/06-MIGRATION.md](docs/06-MIGRATION.md)。

## 边界（诚实声明）

- 微信 / X 的传感器默认关闭（隐私与稳定性），需要时在 `config/hive.json` 打开。
- 日历通道本机没有本地日历，目前只支持 ICS 文件，无配置时静默跳过。
- L4/L5 的「自主验证」目前是「执行器自述 + 产物落盘 + 人工可回溯」，**没有独立的自动化验收器**（诚实标注）。
- 成本估算基于配置里的单价表，可能与实际账单有偏差。

## 铁律

见 [AGENTS.md](AGENTS.md)。
