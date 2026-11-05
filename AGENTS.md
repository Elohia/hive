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

| 轮子 | 路径 | 一句话用途 | 调用姿势 |
|---|---|---|---|
| （启动阶段，随实现回写） | | | |

## 六、已否定/不采用（先例，别重犯）

- **不自建 Docker 化 Multica**：本机无 Docker，Multica 自托管需 Docker + Postgres；16GB RAM 跑不动。
  → 采用「借鉴其 Issue/Inbox/Autopilot/Run/Review-gate 概念 + 自建轻量 SQLite 实现」。
- **不用外部审批 SaaS**：Outbox 必须是本地 SQLite + 本地通知（Toast/邮件），断网可用。

## 七、当前状态

见 `README.md` 顶部状态表。
