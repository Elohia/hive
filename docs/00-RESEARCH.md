# 00 · 调研：把「主动服务型超级智能」拼出来

- 日期：2026-11-05
- 目的：在动手前把「别人已经做到哪、本机已经有什么、哪些能直接复用、哪些必须自建」钉死。
- 结论先行：**不需要从零造轮子，也不需要硬上重型平台。** 本机缺的是「任务中心 + 自主分级 + HITL 闸门 + 看板」
  这四块**胶合层**，其余能力（执行器、传感器、通知、知识）本机已有成熟件。

---

## 一、外部方案调研

### 1.1 Multica（`multica-ai/multica`，≈55k★）—— 任务中心的形态参考

> "Agents that show up on the board." 把 Claude Code / Codex / Cursor / Kimi / DSH / Pi 等 26 种 Agent CLI
> 当成「同事」，在同一个看板上派活、看进度、交回评审。

关键概念与对我们的映射：

| Multica 概念 | 它做什么 | 我们的落法 |
|---|---|---|
| Issue | 一张工单 = 意图 + 运行 + 决策 + diff 绑一起 | `items` 表（事项） |
| Assignee（Agent） | 把 issue 派给某个 Agent | `tasks.assigned_executor` |
| Runtime / Daemon | 在你的机器上跑 Agent 的守护进程 | 本仓 `hive daemon` |
| Autopilot | cron 跑 standup / 审计 / 报告 | `pulses` 表 + 调度器 |
| Run | 一次执行的全部工具调用与命令，可回放 | `runs` 表 + `data/runs/<id>/` |
| Review gate | 成果落 review 不落 main，人决定是否发布 | `approvals` 表（Outbox） |
| Inbox | 只在「Agent 需要你拍板」时打扰你 | `approvals` + 通知 |
| Retry / timeout | 失败自动重试或停下说明原因 | `watchdog` |
| Skill | 把解决过的问题沉淀成可复用 playbook | `prompts/` + `skills/` |
| Squad | Agent + 人的小队，leader 分派 | Router + 依赖图 |

**自托管成本评估（决定不采用其代码）**：`SELF_HOSTING.md` 要求 Docker Compose / Helm + Postgres；
本机 **无 Docker**（`docker` 不在 PATH），WSL Ubuntu 处于 Stopped，16GB RAM 已被 DSH/WeChat/WPS/X 等占用。
再叠一个 Postgres + Redis + Next.js 前端，长期常驻的稳定性与资源都不划算。
→ **决策：借鉴它的数据模型与交互，用 Node 内置能力实现轻量版。**

### 1.2 DeepSeek Super-agent 架构 —— 运行时的形态参考

2026-10/11 DeepSeek 提出的持续运行多 Agent 系统设计，核心是 **Router / Worker / Watchdog** 三层，
配 **事件驱动、任务路由、Thread Subscription、异步执行与持久化**。
（二次资料：[阿里云架构解析](https://developer.aliyun.com/article/1779111)、[DoNews](https://www.donews.com/news/detail/1/6760986.html)、[chinaz](https://www.chinaz.com/ainews/32037.shtml)）

对我们的直接映射：

| Super-agent 概念 | 我们的落法 |
|---|---|
| Router（前门，判断内联回答还是派活） | `src/task/router.mjs`：内联 LLM / 派 Worker / 升级人工 |
| Worker（隔离的后台执行体） | `src/executors/*`（dsh-headless / pi / codex / claude / llm / shell） |
| Watchdog（超时、死循环、超预算就杀） | `src/task/watchdog.mjs`：租约 lease + 超时 + 预算 |
| Inline & Spill | 小任务内联直答；大任务「spill」成持久 Task |
| Thread Subscription | 一个 Task 一条事件流，看板 SSE 订阅 |
| 持久化 | SQLite WAL 单库，进程重启不丢 |

### 1.3 其他参考

- **open-super-agent**（`kadaliao/open-super-agent`，≈2.8k★）：可自部署常驻 AI 队友，架构明说借鉴 DeepSeek
  Super-agent 的 Router/Worker/Watchdog；有确认卡片、技能、定时任务、费用看板、Watchdog 杀卡死任务。
  → 借鉴：**确认卡片（允许一次/拒绝/总是允许）**、**按角色/任务/天统计 token 与金额**、**每日预算**。
  不采用：需要 Docker 跑「电脑」容器、Python+uv 全栈、无鉴权页面。
- **open-super-agent 的「Heavy 模式」**（多 Worker 各做一遍再互审汇总）→ 作为 L5 的复核策略借鉴。
- **CopilotKit OpenDuet**：开源「主动型 AI 同事 + 人类审批流」模板，印证产品形态（proactive + approval inbox）。
- **EVO（本机 `D:\evo`）**：用户自己的主动式 AI 内核雏形，已实现 感知→思辨→决断→行动→反思→进化 心跳、
  三层记忆（程序性/语义/情景）、议程（goals/todos）、**守中（无高价值事则不动）**、v7 outbox/inbox 协议、
  v8 驻留心跳、v14 坏响应重试+重复动作检测、token 预算。
  → **这是本系统「意志层」的最佳参考**，其「守中」思想直接进入我们的 triage 策略：**低价值不打扰**。
- **hangul**（`aasimmalikin/hangul`）：安全个人 Agent，「读你的文档与收件箱，经你批准后行动」——与我们的 HITL 一致。

---

## 二、本机存量能力盘点（复用优先）

### 2.1 CLI 与运行时

| 能力 | 实体 | 用途 |
|---|---|---|
| Node 24.14 | `C:\Program Files\nodejs\node.exe` | 运行时（自带 `node:sqlite`、`fetch`） |
| Python 3.13 / uv | 系统 + `uv` | 传感器脚本、分析 |
| DSH | `dsh`（`@deepseek-ai/dsh@0.1.5-rc.2`） | **主力执行器**：`dsh --profile headless "<job>"` 一次性跑完并打印结果（实测 51s 冷启动） |
| Pi | `pi`（`@earendil-works/pi-coding-agent@0.84.1`） | 编码 Agent，`pi -p --mode json` 非交互 |
| Codex | `codex`（`@openai/codex@0.153.4`） | `codex exec` 非交互 |
| Claude Code | `claude`（`@anthropic-ai/claude-code@2.1.195`） | `claude -p` 打印模式 |
| bun / rustc / ffmpeg / rg / git / gh | 本机 | 工具链 |
| agently-cli | `@tencent-qqmail/agently-cli@1.0.11` | **QQ 邮箱全能力**：list/read/search/watch/send/reply/forward/download + 两阶段确认（`ctk_`）—— 已授权（`logged_in: true`，DPAPI 存储） |
| guanlan (uv) | `guanlan` / `guanlan-mcp` | A 股数据/情绪 |
| rea | `rea-agents@6.4.0` | 逆向分析 MCP |

### 2.2 DSH 侧能力（本会话可直接调）

- **子 Agent / 工作流 / Team**：`subagent`、`workflow`、`spawn_teammate` —— 并行编排原语。
- **定时提醒**：`schedule_*`（投递到会话），已有任务如「08:10 持仓早报」在跑。
- **浏览器自动化**：`browser_open` / `browser_interact`（持久会话）+ `D:\dsh\video\remotion` 等。
- **MCP**：`rea`（逆向）、`mx-ds-mcp`（东财行情）。
- **Skills**：`bailian-*`（百炼全栈：生图/生视频/TTS/精调/托管 Agent/联网搜索）、`elohia-double`（数字分身）、
  `life-simulator`、`office-*`（docx/xlsx/pptx/pdf）、`reverse-engineer-anything`、`agent-experience`、
  `cordis-plugin-development`。
- **LLM Provider**：deepseek（默认）、glm-5.3-flash、qwen3.8-flash、gpt-6-astra、claude-fable-5、
  gemini 全系、MiMo v2.6、agnes 全系 —— 分级用模的池子已经很大。
- **DSH 底层模块**（`node_modules/@deepseek-ai/`）：`dsh-schedule`、`dsh-webhook-github`、`dsh-agent-loop`、
  `dsh-session-persistence`、`dsh-subagent-*`、`dsh-tool-workflow`、`dsh-persona`、`dsh-goal` —— 说明
  「持久会话 / 子 Agent / 工作流 / 目标」在 DSH 内已有原语，本项目**不重复实现**，只做编排与状态。

### 2.3 已有「自动化存量」（不能重复造、要接入）

- **Windows 计划任务 20+ 条**（`D:\pi-agent\scripts\hidden\*.cmd`）：盘前/盘中/午盘/晚间、数据湖更新、
  持仓早报、竞价信号、题材资金、复盘 flywheel、iwencai 采集…… → 本系统把它们视为**信息源与既有 Worker**，
  通过读取其产物（`D:\pi-agent\reports\`、`automations\memory\`）感知进展，不重写。
- **pi-agent automations**：`盘前/盘中/午盘/晚间/题材资金/数据湖更新/valen` + `memory` 摘要 → 天然的「个人工作节奏」样本。
- **x-duty / bili-duty / xhs-duty**（`F:\dsh-home\`）：已有的「值守 -> 日报 -> 投递」范式，含
  `state.json`/`seen.md`/`write-ledger.jsonl`/配额闸门 —— **本系统的 pulse 设计直接向它对齐**。
- **elohia**：微信语料 143 万条 + 人格画像 + 人生时间线 + 决策库 + 模拟器 → **个人上下文**的硬底座。
- **EVO**：主动式心跳内核雏形（见 1.3）。

### 2.4 通道现状

| 通道 | 状态 | 用法 |
|---|---|---|
| 邮件 | ✅ agently-cli 已授权（QQ 邮箱） | 感知收件箱 + Outbox 邮件通知 + 回复 |
| X / Twitter | ✅ `x_*` 工具 + 本地 `twitter` CLI | 感知关注流/搜索 + 发布（配额+台账） |
| 微信 | ✅ `elohia` wcdb 桥 + WeFlow API | 感知重要会话（只读） |
| 企业微信 | ✅ 客户端在跑（端口 9882 等） | 通知（可选） |
| 日历 | ❌ 无本地日历 | 先支持 ICS 文件/CalDAV URL 适配器；无配置则跳过 |
| 文档 | ✅ 本地多目录 + WPS 云 | 扫近期变更 |
| 代码仓库 | ✅ 12+ 本地 git 仓库 | git log/status/diff 感知 |
| 财务/行情 | ✅ mx-ds-mcp + guanlan + pi-agent 产物 | 组合成「持仓/盘面」上下文 |

---

## 三、结论：自建 vs 复用

| 模块 | 决策 | 理由 |
|---|---|---|
| 任务中心 / Inbox / Outbox | **自建**（SQLite，~800 行） | 没有哪个开源件能同时满足：无 Docker、无外部 DB、可被 Agent CLI 驱动、L1–L5 分级 |
| L1–L5 判定 | **自建**（确定性规则 + LLM 兜底） | 判定必须**可解释、可审计、稳定**，纯 LLM 会漂 |
| Router / Worker / Watchdog | **自建编排层**，Worker 复用现有 CLI | Super-agent 架构是「设计」不是「库」 |
| 执行器 | **复用** dsh / pi / codex / claude / 裸 LLM | 本机全都有且已登录 |
| 传感器 | **复用** agently-cli / git / x_* / elohia / 文件扫描 | 只写薄适配器 |
| 通知 | **复用** Windows Toast + agently-cli 邮件 | 断网可用 |
| 看板 | **自建**（零构建静态页 + SSE） | 需要贴合我们的数据模型；引 React 会引入构建链 |
| 持久化 / 重试 | **自建**（SQLite WAL + lease + 退避） | Temporal 要额外服务；DBOS/Restate 要额外运行时 |
| 个人上下文 | **复用 + 聚合** elohia 画像 / pi-agent 节奏 / DSH 会话 | 已经存在，缺的是「统一读接口」 |

**一句话**：外部方案给了我们**形态**（Multica 的任务中心、Super-agent 的运行时、OpenDuet 的审批流、
EVO 的守中心跳），本机给了我们**肌肉**（6 个 Agent CLI、6 个通道、143 万字个人语境）。
我们要造的是**神经与骨架**。

---

## 四、风险与对策（预判）

| 风险 | 对策 |
|---|---|
| 冷启动慢（`dsh headless` 51s） | 分级用执行器：内联 LLM 秒级；L3+ 才起 dsh；批量任务合并到一次会话 |
| LLM 成本失控 | 每任务 budget + 每日预算 + 分级用模（便宜模型做 triage，贵模型做交付） |
| Agent 幻觉/误报 | 所有 item 必须带 `source_ref`（可回溯原始证据）；L1 只整理不改状态 |
| 打扰过载 | 「守中」：urgency×impact 低于阈值只入 Inbox 不通知；每日推送上限 |
| 副作用误触发 | 硬闸门在 `hitl.request()`，worker 无写权限；token/路径白名单 |
| 进程崩溃丢任务 | 全部状态在 SQLite；daemon 重启后扫 `running` + 过期 lease 自动回收重排 |
| 依赖腐烂 | 运行时零 npm 依赖；只用 Node 内置 + 本地 CLI |
| 隐私外泄 | 敏感源（微信/邮件正文）默认只在本机处理；送 LLM 前做字段裁剪 |

---

## 五、下一步（进入实现）

见 `docs/01-ARCHITECTURE.md`。
