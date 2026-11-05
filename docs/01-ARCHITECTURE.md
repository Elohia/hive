# 01 · 架构与契约

> **改代码前必读。** 本文件定义不变量、状态机与模块契约。任何违反「不变量」的改动都是 bug。

---

## 一、总览

```
                  ┌────────────────────────── hive daemon ──────────────────────────┐
                  │                                                                 │
  Windows 计划任务 │  PulseScheduler ──► Sensor ──► Normalizer ──► Inbox(items)       │
  DSH schedule ───┼──► (cron/interval)   (source adapter)     (dedupe/upsert)        │
                  │                                                   │             │
                  │                                        Triage (L1..L5)           │
                  │                                                   │             │
                  │                                        Router ────┼── inline LLM ──► 结论回写 item
                  │                                                   │             │
                  │                                                   ├── dispatch ──► Task(queue)
                  │                                                   │                  │
                  │                                                   └── escalate ──► Approval(Outbox)
                  │                                                                      │
                  │   Watchdog ◄── lease/timeout/budget ◄── Worker(executor) ◄──────────┘
                  │      │                                      │
                  │      └── retry/backoff/kill ───────────────┘
                  │                                                   │
                  │   Runs/Events/Artifacts ◄──────────────────────────┘
                  │            │
                  └────────────┼─────────────────────────────────────────────────────┘
                               ▼
              HTTP API + SSE ──► web 看板（Inbox / Outbox / Tasks / Runs / Logs / Context）
              CLI `hive`     ──► scan / list / run / approve / retry / doctor
              Notify         ──► Windows Toast / QQ 邮件 / 看板
```

## 二、不变量（Invariants）

1. **I1 单库**：状态只在 `data/hive.db`。任何模块不得另建状态文件（`data/runs/` 只存原始字节，不存状态判断）。
2. **I2 单写者**：只有 `hive daemon` 进程写库。CLI 通过 HTTP API 或短暂独占（`--direct`）访问，避免并发写。
3. **I3 事件溯源**：状态变更必须同时写一行 `events`。`items`/`tasks` 是可重建的投影。
4. **I4 副作用闸门**：写外部系统（邮件发送、X 发布、文件删除到仓库外、付费 API 大额调用）**必须**先有
   `approvals.status='approved'` 且 `approval.task_id` 匹配。执行器进程本身拿不到写权限令牌。
5. **I5 幂等**：`items.dedupe_key` 唯一；重复感知返回既有 item 并 bump `last_seen_at`。
6. **I6 可重放**：每个 Run 的完整输入输出落在 `data/runs/<run_id>/`，`runs.meta` 记录 executor/命令/耗时/成本。
7. **I7 预算**：每个 Task 有 `budget_tokens` 与 `timeout_sec`；Watchdog 超限 kill 并标 `failed (budget)`。
8. **I8 守中**：`priority < settings.quietThreshold` 的事项只入 Inbox，不通知、不自动执行。

## 三、状态机

### 3.1 Item（事项）

```
        ┌─────────┐  triage   ┌──────────┐  dispatch  ┌─────────┐
  new ─►│  inbox  │──────────►│ planned  │───────────►│ running │
        └─────────┘           └──────────┘            └────┬────┘
             │                      │                     │
             │ escalate             │ need human          ├─ ok ──► done
             ▼                      ▼                     │
        ┌──────────────┐     ┌──────────────┐             ├─ retry(≤max) ─► running
        │awaiting_human│◄────│   blocked    │             └─ fail ──► failed
        └──────┬───────┘     └──────────────┘
               │ approved
               └──────────────► planned
        inbox ──(低价值/过期)──► dropped / archived
```

`bucket` 字段是「在哪个栏看」：`inbox | outbox | active | archive`。与 `status` 正交。

### 3.2 Task

```
queued ─► running ─► succeeded
   ▲          │
   │          ├─► failed ──(retry, attempt<max)──► queued
   │          ├─► timeout ──(retry)──► queued
   │          └─► cancelled
   └──(依赖未满足) blocked
```

### 3.3 Approval

`pending ─┬─► approved ─► (执行) ─► done`
          `├─► rejected ─► (item 归档)`
          `└─► expired（超时未处理 → 提醒一次 → 自动 rejected 或按策略 auto）`

## 四、L1–L5 自主等级（核心）

| 等级 | 定义（用户原话） | 机器判定：允许的动作 | 是否需审批 | 默认执行器 |
|---|---|---|---|---|
| **L1** | 理解和整理信息，提取待办、总结背景 | 只读 + 写 Inbox 备注 | 否 | 内联 LLM |
| **L2** | 分析问题，提供建议和执行方案 | 只读 + 产出建议文档（`data/artifacts/`） | 否 | 内联 LLM |
| **L3** | 完成部分工作，生成可交付的中间成果 | 工作区内写文件（沙箱目录）+ 产出中间件 | 否（限白名单目录） | LLM / dsh |
| **L4** | 自主完成大部分，**关键环节人工确认** | 生成完整方案 + 在 Outbox 请示；批准后落地产出 | **是** | dsh / pi / codex |
| **L5** | 端到端完成，自主验证并交付 | 全流程自主 + 自验证；仅「不可逆对外动作」仍需审批 | 仅敏感动作 | dsh / Heavy 多 Worker 互审 |

**判定算法（`src/task/triage.mjs`）——确定性优先：**

```
输入：item { kind, domain, source, text, requested_action }
步骤 1  抽取「动作意图」：read / summarize / analyze / draft / write_local /
        send_external / publish / delete / spend / deploy / code_change
步骤 2  查 policies.json 的 action → base_level 映射
步骤 3  按三个修正项下调：
        · 不可逆性 irreversible=true        → level = min(level, 4)
        · 对外可见 external_visible=true    → level = min(level, 4) 且必须 approval
        · 涉及金额 > spendThreshold         → level = min(level, 3)
        按两个修正项上调：
        · 历史同类任务成功率 ≥ 0.85 且 n ≥ 5 → level = min(5, level+1)
        · 该 item 已有 approved 的同型审批    → level = min(5, level+1)
步骤 4  clamp(1,5)，conf = 规则命中率（无 LLM）
步骤 5  仅当 conf < 0.6 时调用便宜模型做 tie-break（返回 level + 理由），并把理由写 events
```

**「做不做得动」的第二道闸（capability gate）**：
即使判定 L5，若 `required_tools` 全都不在本机可用清单（`doctor` 的探测结果）里 → 降级到 L2 并说明缺什么。

## 五、数据契约（SQLite）

数据库：`data/hive.db`，`PRAGMA journal_mode=WAL; synchronous=NORMAL; foreign_keys=ON;`

```sql
-- 传感器水位（增量拉取定位）
cursors(source TEXT, key TEXT, value TEXT, updated_at TEXT, PRIMARY KEY(source,key));

-- 事项
items(
  id TEXT PRIMARY KEY,                 -- itm_<ts><rnd>
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_seen_at TEXT,
  source TEXT NOT NULL,                -- mail|git|doc|calendar|x|wechat|dsh|pi|web|manual|agent|self
  source_ref TEXT,                     -- 外部唯一键
  dedupe_key TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL, body TEXT,
  kind TEXT NOT NULL,                  -- todo|issue|opportunity|decision|risk|fyi
  domain TEXT,                         -- work|trade|startup|ai|content|life|family
  urgency INTEGER DEFAULT 3,           -- 1..5
  impact  INTEGER DEFAULT 3,           -- 1..5
  priority REAL,                       -- 计算值
  autonomy_level INTEGER,              -- 1..5
  autonomy_ceiling INTEGER,            -- 策略上限
  confidence REAL,
  level_reason TEXT,
  status TEXT NOT NULL DEFAULT 'inbox',-- inbox|planned|running|blocked|awaiting_human|done|failed|dropped|archived
  bucket TEXT NOT NULL DEFAULT 'inbox',-- inbox|outbox|active|archive
  due_at TEXT, meta TEXT               -- meta = JSON
);

-- 任务
tasks(
  id TEXT PRIMARY KEY, item_id TEXT, parent_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  title TEXT NOT NULL, goal TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  executor TEXT, model TEXT,
  autonomy_level INTEGER,
  attempt INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 3,
  lease_until TEXT, heartbeat_at TEXT,
  timeout_sec INTEGER, budget_tokens INTEGER,
  tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, cost_cny REAL DEFAULT 0,
  priority REAL, depends_on TEXT,      -- JSON array
  plan TEXT, result TEXT, last_error TEXT,
  output_dir TEXT, started_at TEXT, finished_at TEXT
);

-- 执行记录
runs(
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt INTEGER NOT NULL,
  executor TEXT, command TEXT, cmdline TEXT,
  pid INTEGER, started_at TEXT, finished_at TEXT, duration_ms INTEGER,
  exit_code INTEGER, status TEXT,      -- running|ok|failed|timeout|killed
  tokens_in INTEGER, tokens_out INTEGER, cost_cny REAL,
  dir TEXT, error TEXT
);

-- 产物
artifacts(id TEXT PRIMARY KEY, task_id TEXT, item_id TEXT, kind TEXT,
  title TEXT, path TEXT NOT NULL, bytes INTEGER, sha256 TEXT, created_at TEXT);

-- HITL 审批
approvals(
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  item_id TEXT, task_id TEXT,
  kind TEXT NOT NULL,                  -- decision|send_message|publish|delete|spend|deploy|external
  title TEXT NOT NULL, summary TEXT,
  context TEXT, options TEXT, recommendation TEXT, risk TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected|expired|auto
  decided_at TEXT, decided_by TEXT, decision TEXT, note TEXT,
  expires_at TEXT, notified_count INTEGER DEFAULT 0, last_notified_at TEXT
);

-- 事件（可溯源 + 看板时间线）
events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
  actor TEXT NOT NULL,                 -- sensor|triage|router|worker|watchdog|human|system|notify
  type TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'info',
  item_id TEXT, task_id TEXT, run_id TEXT, approval_id TEXT,
  message TEXT, data TEXT
);
CREATE INDEX idx_events_ts ON events(ts DESC);
CREATE INDEX idx_events_task ON events(task_id);

-- 脉冲（定时巡检）
pulses(id TEXT PRIMARY KEY, name TEXT, spec TEXT NOT NULL, enabled INTEGER DEFAULT 1,
  last_run_at TEXT, next_run_at TEXT, last_status TEXT, config TEXT);

-- 个人上下文
context_facts(id TEXT PRIMARY KEY, category TEXT, key TEXT, value TEXT,
  evidence TEXT, confidence REAL, updated_at TEXT, UNIQUE(category,key));

-- 键值（版本、上次巡检、预算使用等）
kv(k TEXT PRIMARY KEY, v TEXT, updated_at TEXT);
```

## 六、模块契约

### 6.1 Sensor（传感器）

```js
// src/sensors/<name>.mjs
export default {
  name: 'mail',
  enabledFromConfig: true,
  async *scan(ctx) {          // AsyncIterable<RawItem>
    // yield { source, source_ref, title, body, ts, kind_hint, domain_hint, urgency_hint, meta }
  }
}
```
- **只读**，不得写库；由 daemon 统一 upsert。
- 必须支持增量：用 `ctx.cursor.get(source,key)` / `ctx.cursor.set`。
- 单个 sensor 失败不得影响其他 sensor（daemon 捕获并记 `sensor.error`）。

### 6.2 Executor（执行器）

```js
// src/executors/<name>.mjs
export default {
  name: 'dsh',
  async available(ctx) -> {ok:boolean, reason?:string}
  async run({ task, prompt, workdir, timeoutSec, budgetTokens, onSpawn, onLog }) -> {
    ok, exitCode, stdout, stderr, tokens:{in,out}, costCny, artifacts:[], result?:object
  }
}
```

### 6.3 Router 决策

```js
{ route: 'inline'|'dispatch'|'escalate'|'ignore',
  executor, prompt, reason, needApproval, approvalSpec }
```

### 6.4 Watchdog

- 每 `tickSec`（默认 20s）扫 `tasks.status='running'`：
  - `now > lease_until` 且进程已死 → `failed(timeout)` → 按退避重排
  - `tokens_used > budget_tokens` 或 `duration > timeout_sec` → kill（`taskkill /T /F`）→ `failed(budget)`
  - `attempt >= max_attempts` → `failed(final)` + 进 Outbox 请示是否人工接管
- 启动时 `recover()`：把所有 `running` 且 pid 不存在/租约过期 的任务重置为 `queued`。

## 七、HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 版本、库连通、执行器探测、预算余量 |
| GET | `/api/overview` | 看板首页聚合（计数、今日事件、预算、脉冲状态） |
| GET | `/api/items?bucket=&status=&q=&limit=` | 事项列表 |
| GET | `/api/items/:id` | 详情（含事件、runs、artifacts、approvals） |
| POST | `/api/items/:id/action` | `{action:'dispatch'|'drop'|'archive'|'relevel', payload}` |
| GET | `/api/tasks?status=` | 任务列表 |
| POST | `/api/tasks/:id/retry` | 重试 |
| POST | `/api/tasks/:id/cancel` | 取消 |
| GET | `/api/approvals?status=` | 审批列表 |
| POST | `/api/approvals/:id/decide` | `{decision:'approved'|'rejected', option, note}` |
| GET | `/api/events?since=&task_id=&limit=` | 事件流（历史） |
| GET | `/api/stream` | **SSE** 实时事件 |
| POST | `/api/scan` | 立即触发一轮巡检 `{source?}` |
| GET | `/api/context` | 个人上下文 |
| POST | `/api/context` | 更新上下文事实 |
| GET | `/api/doctor` | 环境自检（执行器/通道/依赖） |

**鉴权**：仅监听 `127.0.0.1`；可选 `X-Hive-Token`（配置后所有 `/api/*` 需要）。默认本地免密。

## 八、CLI

```
hive daemon [--port 8787]            常驻主进程
hive scan [--source mail]            跑一轮感知（可 daemon 未起时 --direct）
hive inbox [--limit 20]              看待办
hive outbox                          待我拍板
hive approve <id> --option approve [--note "..."]
hive reject <id> --note "..."
hive tasks [--status running]
hive retry <task-id>
hive run "<一句话任务>"               手工投递一个 item 并立即 triage
hive doctor                          环境自检
hive serve                           只起看板
hive backup <path>                   导出 db + artifacts
hive restore <path>
```

## 九、可移植性

- 全部路径来自 `config/hive.json`（唯一硬编码落点），支持 `HIVE_HOME` 覆盖。
- 运行时零 npm 依赖 → `git clone` + `node scripts/hive.mjs` 即可跑。
- 迁移：`hive backup` 出一个 tar/zip；新机解压 + 改 `config/hive.json` 路径 + `hive restore`。
- Windows 服务化：`scripts/install-task.ps1` 注册计划任务（开机启动 + 失败重启）。

## 十、成本与资源

- 分级用模：triage/摘要用 `deepseek-flash` 级别；L4/L5 交付用强模型。
- 每日预算 `settings.dailyBudgetCny`（默认 8 元）；超 80% 告警，超 100% 停止派单（保留 L1）。
- 并发上限 `settings.maxConcurrentWorkers`（默认 2，因 16GB RAM）。
- 单任务默认 `timeoutSec=900`、`budgetTokens=120000`。
