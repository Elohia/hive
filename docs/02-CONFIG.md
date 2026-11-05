# 02 · 配置

> **本文核对于 2026-11-05 19:15（本地 +08:00）**：`config/hive.json` 4669 B / `config/policies.json` 3854 B。
> 配置会随实现演进（例如 `policies.json` 在 19:06 新增了 `kind_alias` / `noise_patterns` / `domainWeight.ops|code|comms|_default`）。
> **配置文件的当前内容永远是唯一真相**；本文负责解释「每个字段想干什么、默认值多少、改大改小会怎样、哪些字段眼下还没接线」。

---

## 一、装载机制（先懂这三件事）

1. **唯一硬编码落点**：除 `config/hive.json` 里的路径，代码不做任何路径硬编码；改路径只改这里。
2. **项目根解析顺序**（`src/core/config.mjs`）：
   `HIVE_HOME` 环境变量（存在即用，须是真实目录） → 否则由源码位置推导 `<root>/src/core/` 上两级。
3. **装载即建目录**：`loadConfig()` 会 `mkdir -p` 补齐 `runs / artifacts / logs / workspace / prompts` 五个目录，
   并把相对路径解析成绝对路径塞进 `cfg.resolved.*`（见下）。模块内一律用 `cfg.resolved.db` 这类字段，不要自己拼路径。
   `loadConfig({ reload: true })` 可强制重读（守护进程长跑期间改配置后重启才生效，热更新未做）。

```js
// 实测：解析结果
home = D:\hive
resolved.db = D:\hive\data\hive.db
resolved.logs = D:\hive\data\logs
```

---

## 二、`config/hive.json` 逐字段

### 2.1 顶层

| 字段 | 当前值 | 说明 | 调参建议 |
|---|---|---|---|
| `$schema` | `hive-config-v1` | 配置契约标签，代码不校验，给人/工具看 | 改结构时同步升版本 |
| `version` | `0.1.0` | 应用版本（与 `VERSION` 文件一致） | 发版时两处一起改 |
| `home` | `D:\hive` | **仅作展示与日志**；真正项目根以 `resolveHome()` 为准 | 迁移后改这里，同时确认 `HIVE_HOME` 未指向旧路径 |

### 2.2 `server`（看板 / API）

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | 只监听回环。**改成 0.0.0.0 等于把看板暴露到局域网**，必须先设 `token` |
| `port` | `8787` | 被占会直接失败退出（`EADDRINUSE`，实测退出码 1，错误文案会提示 `--port` 换一个）；也可用环境变量 `HIVE_PORT` 覆盖 |
| `token` | `""` | 空 = 本地免密。填了之后所有 `/api/*` 要带 `X-Hive-Token: <token>`，或 `?token=<token>`（实测 401 文案：`未授权：需要正确的 X-Hive-Token`） |
| `sse` | `true` | 是否开 SSE（`/api/stream`）实时推送；关掉则看板只能轮询 |

实测：`hive serve --port 8787` 起服务后 `GET /api/health` → `200`，返回体含 `server:{host,port,tokenRequired:false,sseClients,sseEnabled:true}`。

### 2.3 `paths`（相对 `home` 或绝对路径皆可）

| 字段 | 默认 | 内容 | 备注 |
|---|---|---|---|
| `db` | `data/hive.db` | 单库（SQLite WAL） | 同目录会出现 `-wal` / `-shm`，**备份/迁移时要么一起拷、要么用 `VACUUM INTO`**（见 docs/05） |
| `runs` | `data/runs` | 每次 Run 的原始产物 `<run_id>/` | 会长期增长，按周清理 |
| `artifacts` | `data/artifacts` | 交付物 | 备份默认打包这里 |
| `logs` | `data/logs` | 进程日志 `hive-YYYY-MM-DD.log` | `pruneLogs(14)` 会删 14 天前的 |
| `workspace` | `data/work` | 执行器工作区（沙箱目录） | 白名单写入目录之一 |
| `prompts` | `prompts` | 提示词模板 | 缺失会自动建空目录 |

### 2.4 `credentials`（敏感）

| 字段 | 当前值 | 说明 |
|---|---|---|
| `file` | `F:\dsh-home\.credentials.yaml` | DSH 的凭据文件；**本文件不在 HIVE 仓库内，也绝不能被复制进仓库** |
| `keys.<别名>` | `deepseek/glm/qwen/agnes/xiaomi` → 各自的 `refs.<NAME>` | `llm.providers.*.keyRef` 指向这里的**别名**，不是真实环境变量名 |

解析逻辑（`src/core/credentials.mjs`）：只读 `refs:` 段的 `KEY: value`，**不落盘、不打印**；
`keyStatus()` 只回 `{present, length}`。实测输出：

```
deepseek(len=35) glm(len=67) qwen(len=113) agnes(len=51) xiaomi(len=51)
```

**规则**：文档、日志、看板一律只能出现「有没有 / 多长」，不能出现密钥本身。要换 key：改 `F:\dsh-home\.credentials.yaml` 的 `refs:`，重启 daemon。

### 2.5 `llm`（内联执行器用的模型）

| 字段 | 说明 |
|---|---|
| `default` | 默认 provider 别名，当前 `deepseek` |
| `providers.<name>.baseURL` | OpenAI 兼容 base，代码拼 `/chat/completions` |
| `providers.<name>.keyRef` | 上面 `credentials.keys` 的别名 |
| `providers.<name>.models.cheap/strong` | 两档模型；`tier:'cheap'` 用于 triage/摘要，`strong` 用于 L4/L5 交付 |
| `providers.<name>.pricing.cheap/strong.{in,out}` | **元 / 百万 token**，用于 `costCny` 记账（`costOf()`） |
| `providers.<name>.headers` | 额外请求头（如 glm 走 opencode 需要 `x-opencode-session`） |

当前三档：`deepseek`（`deepseek-chat` 2/8 元、`deepseek-reasoner` 4/16 元）、`glm`（`glm-5.3-flash` 0.5/2 元）、
`xiaomi`（`mimo-v2.6-flash` 1/4 元、`mimo-v2.6-pro` 4/16 元）。
**省钱改法**：把 `default` 改成 `glm`，或给 `pricing` 填真实价格（填 0 会让预算护栏失效）。

> ⚠️ 网络注意：本机有 `HTTP(S)_PROXY=127.0.0.1:7890` 且 `NODE_USE_ENV_PROXY=1`，
> 但 `llm.mjs` 用 `agent:false` 直连（实测可绕过代理）。`NO_PROXY` 里已含 `api.deepseek.com`。详见 docs/04。

### 2.6 `executors`（执行器，可换；契约不变）

| 名字 | 字段 | 当前值 | 说明 |
|---|---|---|---|
| `llm` | `kind` | `inline` | 进程内调 API，不起子进程；最简单、最便宜 |
| `dsh` | `command/args` | `dsh` / `--profile headless` | 实测 `dsh --profile headless "job"` 打印答案后退出；`coldStartSec:55` 是**预算提示值**，本轮实测冷启动 **36.8s**（见 docs/04） |
| `pi` | `command/args` | `pi` / `-p --mode json` | 实测 `pi --version` 要 **7.5s**，探测时别串行 |
| `codex` | `command/args` | `codex` / `exec --skip-git-repo-check` | 实测 `codex-cli 0.153.4` |
| `claude` | `command/args` | `claude` / `-p` | 实测 `2.1.195 (Claude Code)` |
| `shell` | `command/args` | `pwsh` / `-NoProfile -Command` | 实测 `PowerShell 7.6.9` |

- `enabled: false` = 禁用该执行器（路由会跳过；`hive doctor` / `healthcheck` 会显示 SKIP）。
- `cwdMode: task` = 工作目录切到该任务的工作区。
- 通用兜底执行器 `proc` 不在配置里也能用（跑任意命令），见 `src/executors/index.mjs`。

### 2.7 `settings`（运行参数 + 护栏）

| 字段 | 默认 | 真实语义 | 接线状态（实测 grep 代码） |
|---|---|---|---|
| `tickSec` | `20` | 主循环节拍 / watchdog 间隔 | ✅ `hive.mjs` 使用（`Math.max(1000, tickSec*1000)`） |
| `pulseGraceSec` | `90` | 脉冲「错过多久内仍补跑」的宽限 | ⚠️ **当前 0 处引用（未接线）** |
| `maxConcurrentWorkers` | `2` | 同时 running 的任务上限 | ✅ `worker.mjs` / `api.mjs` |
| `defaultTimeoutSec` | `900` | 单任务超时，watchdog 到点 kill | ✅ 9 处（router/worker/watchdog/executors） |
| `defaultBudgetTokens` | `120000` | 单任务 token 预算，超了 kill | ✅ `taskcenter.mjs` / `worker.mjs` |
| `maxAttempts` | `3` | 单任务最大尝试次数，超了标 failed | ✅ `taskcenter.mjs` / `worker.mjs` |
| `retryBackoffSec` | `[60,300,900]` | 重试退避序列 | ⚠️ **当前 0 处引用（未接线，重试是立即重排）** |
| `dailyBudgetCny` | `8` | 每日花费上限（元） | ✅ `taskcenter.todayCost` / `self.mjs` / `api.mjs` / healthcheck |
| `budgetWarnRatio` | `0.8` | 预算告警比例（≥80% 告警，≥100% 停派单） | ✅ `self.mjs` / `api.mjs`（停派单在 `hive.mjs` 主循环判断 `ratio<1`） |
| `quietThreshold` | `6.0` | 优先级低于此值只入 Inbox，不通知不自动执行（「守中」） | ✅ `api.mjs` |
| `maxNotifyPerDay` | `12` | 每日推送上限（防打扰），超了记 `notify.suppressed` | ✅ `notify.mjs` |
| `approvalTtlHours` | `72` | 审批单过期时间 | ✅ `taskcenter.createApproval` / `api.mjs` |
| `itemRetentionDays` | `90` | 事项保留天数 | ✅ `self.mjs`（自检时清理） |
| `lanes` | `{L1:0,L2:0,L3:1,L4:1,L5:1}` | 各等级并发车道 | ⚠️ **当前 0 处引用（未接线）** |

**调参建议（按目标）**

| 目标 | 改什么 | 代价 |
|---|---|---|
| 省钱 | `dailyBudgetCny`↓（如 3）、`llm.default`→`glm`、`defaultBudgetTokens`↓ | 交付质量下降、任务更易被判超预算 |
| 更快见效 | `tickSec`↓（10）、`maxConcurrentWorkers`↑（3） | 16 GB 内存机器上 3 并发有 OOM 风险 |
| 更保守（少打扰） | `quietThreshold`↑（8）、`maxNotifyPerDay`↓（5）、`maxConcurrentWorkers`↓（1） | 很多事项只进 Inbox，不自动推进 |
| 更自主 | `quietThreshold`↓（4）、`lanes.L3/L4`↑ | 花钱更快、出错面更大；**副作用闸门不受此影响**（仍必须审批） |

### 2.8 `notify`（推送）

| 字段 | 默认 | 说明 |
|---|---|---|
| `toast.enabled` | `true` | Windows Toast（走 `powershell.exe` + WinRT，失败 fail-soft 不抛错） |
| `mail.enabled` | `false` | 邮件通知；**默认关闭**。开启前必须填 `to` |
| `mail.command` | `agently-cli` | 底层命令 |
| `mail.to` | `""` | 收件人；空则 `mail()` 直接返回 `未启用或未配置 to` |
| `dashboard.enabled` | `true` | 看板内提示 |
| 推送总量 | 由 `settings.maxNotifyPerDay` 控制 | 超限写 `events.type='notify.suppressed'` |

⚠️ **agently-cli 是两阶段确认**：第一次调用只返回 `confirmation_token`（实测拿到 `ctk_d28814cf-…`），
**不会发信**；要真发必须再带 `--confirmation-token`。`notify.mail()` 故意停在第一阶段并把 `ctk` 返回给调用方，
即「自动流程绝不自行确认发信」——这与铁律 4（副作用必须过闸）一致。详见 docs/04。

### 2.9 `sources`（传感器）

| 源 | enabled | intervalSec | 关键参数 | 说明 |
|---|---|---|---|---|
| `mail` | `true` | 900 | `command=agently-cli`、`limit=12`、`dir=inbox`、`unreadOnly`、`maxBodyChars=2500` | 只读收件；退信/订阅类会被 `noise_patterns` 降级为 fyi |
| `git` | `true` | 1800 | `repos[]` 6 个、`lookbackHours=48` | 支持 `discover`（见传感器注释） |
| `docs` | `true` | 3600 | `roots[]` 4 个、`lookbackHours=72`、`exts` | 扫新报告 |
| `calendar` | `true` | 3600 | `icsPaths=["data\\calendar\\*.ics"]`、`lookaheadHours=72` | 无 ics 文件则空转 |
| `x` | `false` | 3600 | — | 依赖 DSH `x_*` 工具，**当前未接入** |
| `wechat` | `false` | 1800 | — | 依赖 `D:\elohia` 的 wcdb 桥；**默认关（隐私）** |
| `pulses_local` | `true` | 1800 | 可覆盖 `automationsDir/reportsDir/dutyDirs` | 读本机既有自动化产物当进展信号 |
| `self` | `true` | 3600 | — | 自检：失败堆积/预算/库健康 |

改 `repos` / `roots` 时注意：这些是**排他路径**，不要把它们指到 `policies.never_touch` 里的目录。

---

## 三、`config/policies.json` 逐字段

### 3.1 `actions`（动作 → 基础等级）

| action | base | approval | irreversible | external | 含义 |
|---|---|---|---|---|---|
| `read` | 1 | | | | 读取信息 |
| `summarize` | 1 | | | | 总结/提取待办 |
| `classify` | 1 | | | | 分类打标 |
| `analyze` | 2 | | | | 分析给建议 |
| `plan` | 2 | | | | 出方案 |
| `draft` | 3 | | | | 草稿/中间成果 |
| `write_local` | 3 | | | | 工作区写文件 |
| `research` | 3 | | | | 多源调研出报告 |
| `code_change` | 4 | | | | 改代码并验证 |
| `send_external` | 4 | ✅ | ✅ | ✅ | 对外发消息/邮件 |
| `publish` | 4 | ✅ | ✅ | ✅ | 公开发布 |
| `delete` | 4 | ✅ | ✅ | | 删数据/仓库外文件 |
| `spend` | 3 | ✅ | ✅ | | 产生费用 |
| `deploy` | 4 | ✅ | ✅ | ✅ | 部署上线 |

> 表的顺序 = 代码 `Object.keys(P.actions)` 的顺序 = triage 里「由轻到重」的次序：
> 一个请求命中多个动作时，**取最重的那个**定级（风险由最危险的一步决定）。

### 3.2 `modifiers`（上下调）

| 键 | 参数 | 效果 |
|---|---|---|
| `irreversible` | `cap:4` | 不可逆动作封顶 L4 |
| `external_visible` | `cap:4` | 对外可见封顶 L4，且强制审批 |
| `spend_over_cny` | `threshold:5, cap:3` | 金额 > 5 元封顶 L3，且强制审批 |
| `low_confidence` | `below:0.6, cap:2` | 置信度低时保守到 L2 —— ⚠️ **当前 0 处引用**：实现里是「conf<0.6 时调便宜模型做 tie-break」，不是直接 cap |

### 3.3 `promotions`（上调）

| 键 | 参数 | 效果 |
|---|---|---|
| `proven_success_rate` | `rate:0.85, minSamples:5, bump:1` | 近 60 天同类任务成功率 ≥85% 且样本 ≥5 → +1 级 |
| `approved_pattern` | `bump:1` | 已有同型审批通过记录 → +1 级 |

### 3.4 类型相关

- `kind_defaults`：6 个规范类型（`todo/issue/opportunity/decision/risk/fyi`）的 `urgency/impact` 默认值。
- `kind_alias`：**把各 sensor 自造的类型收敛到 6 类**（如 `email→todo`、`doc_change→fyi`、`git_unpushed→issue`、`pulse_failed→risk`）。
- `noise_patterns`：命中即降为 `fyi` 且 `urgency=1/impact=1`（实测样例：`退信`、`PostMaster`、`unsubscribe`…）。
  实现见 `taskcenter.refineKind()`，命中时 item 的 `meta.noisy=true`。

### 3.5 白名单 / 红线

| 键 | 内容 | 接线状态 |
|---|---|---|
| `side_effect_actions` | `send_external,publish,delete,spend,deploy` | ✅ triage 用来强制 `needApproval` |
| `write_allowlist_dirs` | `D:\hive\data\work`、`D:\hive\data\artifacts`、`D:\elohia\reports`、`D:\elohia\output` | ⚠️ **当前 0 处引用（尚未强制）** |
| `never_touch` | `D:\elohia\data\raw`、`D:\elohia\data\normalized`、`F:\dsh-home\.credentials.yaml`、`D:\01-docment\WeChat Files` | ⚠️ **当前 0 处引用（尚未强制）** |

> **诚实提示**：这两项是**声明式红线**，目前只是数据，没有代码在写盘前检查。
> 也就是说「越界写」现在靠执行器自律 + 人工 review，而不是机器拦截。接上它属于安全加固待办（docs/05 的已知缺口）。

### 3.6 `priority`（排序公式，实测可复算）

```
priority = impact*2.0 + urgency*1.5 + domainWeight + recencyBoost - effortPenalty
```

- `domainWeight`：`work 0.6 / trade 0.4 / startup 0.8 / ai 0.9 / content 0.5 / life 0.3 / family 0.5 / ops 0.7 / code 0.8 / comms 0.5`，未知域回退 `_default 0.4`。
- `recencyBoost`：创建 ≤24h → 0.8；≤72h → 0.4；≤168h → 0；更老 0。
- `effortPenalty`：L1 0.0 / L2 0.2 / L3 0.5 / L4 0.8 / L5 1.0（**等级越高越扣**，因为重活更贵）。`autonomy_level` 为空时按 L2 计。

**实测复算**（脚本直接调 `computePriority()` 与库里 `priority` 对比，10 条样本 diff 全为 0）：

```
盘中（risk, ops, u=4, i=4, L=null）→ 4*2 + 4*1.5 + 0.7 + 0.8 - 0.2 = 15.3  ✔ 与库里 15.3 一致
pi-agent 报告（fyi, ops, u=1, i=1） → 1*2 + 1*1.5 + 0.7 + 0.8 - 0.2 =  4.8  ✔ 一致
elohia 早评（todo, comms, u=3, i=3）→ 3*2 + 3*1.5 + 0.5 + 0.8 - 0.2 = 11.6  ✔ 一致
```

改 `domainWeight` 会直接改看板排序：例如把 `ai` 从 0.9 调到 1.5，AI 类事项会整体上浮；把 `life` 调低则生活类沉底。

---

## 四、敏感项总表

| 敏感物 | 在哪 | 谁能读 | 注意 |
|---|---|---|---|
| LLM API keys | `F:\dsh-home\.credentials.yaml` 的 `refs:` | DSH / HIVE 进程 | **不进 git、不进备份、不打印**；备份脚本只打 db/artifacts，不打凭据 |
| 邮箱授权 | `agently-cli` 自管（实测 `storage: Windows DPAPI`） | 当前 Windows 用户 | DPAPI 绑定用户+机器，**换机必须重新 `agently-cli auth login`** |
| `server.token` | `config/hive.json` | 本机 | 一旦非空，所有 API 都要带 `X-Hive-Token`；不要写进看板页面 |
| 微信语料 | `D:\elohia\data\{raw,normalized}` | 本机 | `never_touch` 红线（尚未代码强制）；`sources.wechat` 默认关 |
| 运行产物 | `data/runs/`、`data/artifacts/` | 本机 | 可能含邮件正文/报告原文，备份包要当敏感物保管 |

---

## 五、改配置的安全流程

```powershell
# 1) 改完先做语法与结构体检（不会跑任务）
node --no-warnings scripts/healthcheck.mjs --fast
node --no-warnings scripts/hive.mjs doctor

# 2) 再确认路由/判定没变味（只看判定，不执行）
node --no-warnings scripts/hive.mjs stats

# 3) 若改了 server/port、executors、settings，重启 daemon 才生效
node --no-warnings scripts/hive.mjs daemon        # 前台看日志；Ctrl+C 停
```

**不要**在 daemon 跑着的时候改 `data/hive.db` 或删 `-wal`/`-shm`；改配置本身是安全的（下次装载生效）。

---

## 六、已知不一致 / 待接线清单（诚实版）

1. `settings.pulseGraceSec`、`settings.retryBackoffSec`、`settings.lanes` —— **配置里有、代码没读**（0 处引用）。
   含义：脉冲错过就错过（不补跑）、重试是立即重排（无退避）、等级车道未限流。
2. `policies.write_allowlist_dirs`、`policies.never_touch` —— **声明式红线，未做机器拦截**。
3. `policies.modifiers.low_confidence.cap` —— 未按 cap 实现，实际是「低置信 → 便宜模型 tie-break + 取更保守值」。
4. `sources.x`、`sources.wechat` —— 配置占位，`enabled:false`，代码未接。
5. `executors.dsh.coldStartSec: 55` 与实际不符（本轮实测 36.8s）；该值目前只作文档提示，未参与超时计算。
   —— 若将来用它在派单前排预算，请以实测 36.8s 为下限、留 2× 余量。
