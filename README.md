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

> 逐条都是真跑出来的，不是设计稿。时间：2026-11-05。

**测试套件（全绿）**

```
smoke-core      10/10 PASS      1.6s
sensors-smoke   29/29 PASS     19.0s
exec-smoke      50 PASS / 0 FAIL / 3 SKIP   172s
server-smoke    89/89 PASS     10.3s
e2e             42/42 PASS     18s     ← 端到端闭环 + 回归断言
```

**真实数据（不是 fixture）**

- 首次 `hive scan`：33 条真实事项（mail 12 / git 3 / docs 10 / pulses_local 8），16.6s。
- 立刻发现真问题：`xhs-duty` 已 5.9 天未运行、`bili-duty` 5.8 天、`盘中` 自动化 37 天未跑且含失败、
  三个仓库有未提交变更（evo 9 处 / MiroFish 2 处 / tickflow 1 处）。
- 上下文归纳器（一次 ¥0.011）产出：
  - 当前焦点：舆情回测口径收敛 / 节前风控（缩量破位+591亿解禁）/ hive 结构梳理
  - 6 条未完成事项（每条带「卡在哪 + 下一步动作」）
  - 2 个机会：**把三个值守合并到带失败告警与自动重试的调度层**（一次改造覆盖全部）、
    把「热度无边、作者有边」固化为策略过滤条件
  - 5 条风险（分发链路实际已断、盘中链路可信度存疑、回测样本右删失…）
- 12 条脉冲全部 `ok`：巡检 → 判定 → 派发 → 看门狗 → 晨报/晚报（Windows Toast 真弹出）。
- `dsh` 执行器真跑通：一次只读调查产出带文件证据的结构化报告（`data/runs/<id>/stdout.txt`）。
- 看板 `http://127.0.0.1:8787` 实测渲染，SSE 实时刷新。

**修掉的真 bug（都被测试锁住了）**

| bug | 现象 | 修法 |
|---|---|---|
| `shell` 被选来跑自然语言 | 整段 prompt 被当 PowerShell 命令，ParserError | 执行器白名单，只有 llm/dsh/pi/codex/claude 能接 NL 任务 |
| `onSpawn` 误用 `finishRun` | run 一 spawn 就被标 `ok` → 看门狗判孤儿 → **无限重跑** | 新增 `attachRunPid()`；E2E 加回归断言 |
| 主循环 `await drainQueue` | 一个长任务让看门狗/脉冲/推送全部停摆 | 改 fire-and-forget + `draining` 闸 |
| `recover()` 只认租约过期 | 「领了但没产生 run」的孤儿永不被回收 | dead 判定加入 orphan；tick 对孤儿 30s 回收 |
| 脉冲突发全量派发 | 22 个任务排队，全是低价值情报 | fyi 守中 + L1/L2 不派进程执行器 |
| 退信刷屏 | 8 封相同退信各成一条，还判成 L4 发布 | 类型归一 + 噪声强制降权 + `\bpost\b` 词边界 |
| `upsertFact` id 碰撞 | `preference:communication` 与 `preference:decision_style` 同 id | 改 sha256 完整派生 |
| 静态根跟 `HIVE_HOME` 走 | 换数据目录后看板 404 | 拆 `codeRoot`(代码) 与 `home`(数据) |

---

## 已知限制（诚实清单）

1. **`codex` 不可用**：上游 `api.xiaomimimo.com` 余额不足 → 402。执行器如实报错，不静默。
2. **`claude` 不可用**：`~/.claude/settings.json` 的 `ANTHROPIC_AUTH_TOKEN` 失效 → 401；CLI 自身重试约 197s，90s 超时下只看到「超时」。
   → 不阻塞：L4/L5 默认走 `dsh`（已验证），`probe()` 只验二进制与版本，验不了余额/凭据。
3. **微信 / X 传感器默认关闭**：需要在 `config/hive.json` 打开并补适配器。
4. **日历只有 ICS**：本机没有本地日历源，静默 0 条。
5. **L4/L5 的「自主验证」是「执行器自述 + 产物落盘 + 可回溯」**，没有独立第二套验收器。
6. **关键词判定有误报**：「给出修复动作」会被 `修复` 抬到 L4；看板可手动「调级」纠正。
7. **安装脚本要 PowerShell 7**：`install-task.ps1` 必须用 `pwsh`，Windows 自带 5.1 会 ParserError（实测）。
8. **OS 级权限隔离有限**：本机 DSH 是 `danger-full-access`，隔离靠「红线守卫 + 执行器白名单 + 只读 prompt 约束 + 人工审批」，不是容器级沙箱。
9. **成本是估算**：按配置单价表算，可能偏离账单；`dsh headless` 的 stdout 不含 usage，tokens 记 0 并标 `usage_unknown`（不编造）。

---

## 版本与迁移

- 版本见 `VERSION`；每次结构性变更在 `docs/` 留档。
- 迁移到新机器：`hive backup` → 拷 `config/` → 改 `config/hive.json` 里的路径 → `hive restore` → `scripts/install-task.ps1`。细则见 [docs/06-MIGRATION.md](docs/06-MIGRATION.md)。

## 边界（诚实声明）

- 微信 / X 的传感器默认关闭（隐私与稳定性），需要时在 `config/hive.json` 打开。
- 日历通道本机没有本地日历，目前只支持 ICS 文件，无配置时静默跳过。
- L4/L5 的「自主验证」目前是「执行器自述 + 产物落盘 + 人工可回溯」，**没有独立的自动化验收器**。
- 成本估算基于配置里的单价表，可能与实际账单有偏差。
- 完整限制清单见上文「已知限制」。

## 开机自启

```powershell
pwsh -NoProfile -File scripts\install-task.ps1     # ⚠ 必须用 pwsh 7，5.1 会解析失败
pwsh -NoProfile -File scripts\uninstall-task.ps1   # 卸载
```

计划任务：登录时启动 → `wscript run_hidden.vbs` → `hive-daemon.cmd`（隐藏窗口，不弹黑框）
→ `node scripts/hive.mjs daemon`；失败每分钟重启，最多 999 次；无执行时限；多实例忽略新请求。

## 铁律

见 [AGENTS.md](AGENTS.md)。
