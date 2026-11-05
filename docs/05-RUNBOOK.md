# 05 · 运维手册（Runbook）

> 面向：**半夜出问题时**要看的那一页。
> 所有命令都在 `D:\hive` 下执行；`$HIVE` 指 `D:\hive`。
> 时间对照：程序内部写库/写日志用 **UTC（ISO 8601，结尾 `Z`）**，本地是 **+08:00**；看日志要把本地时间减 8 小时。

> ⚠ **PowerShell 版本要求（实测 2026-11-05）**：`scripts/install-task.ps1` / `uninstall-task.ps1` 必须用 **PowerShell 7（`pwsh`）** 跑。
> 用 Windows 自带的 `powershell.exe`（5.1）会因编码/语法差异报 `ParserError`（实测 `Unexpected token`）。
> ```powershell
> pwsh -NoProfile -File scripts\install-task.ps1      # ✅ 正确姿势
> ```
> `healthcheck.mjs` / `backup.mjs` / `restore.mjs` 是 Node 脚本，与 PowerShell 版本无关。

---

## 一、三分钟定位（先做这四步，90% 问题能定性）

```powershell
cd D:\hive
node --no-warnings scripts\healthcheck.mjs        # ① 全身体检（PASS/WARN/FAIL + 退出码）
node --no-warnings scripts\hive.mjs doctor        # ② 项目自检（DB/凭据/执行器/通道/预算/守护进程）
Get-NetTCPConnection -LocalPort 8787 -State Listen | Select LocalAddress,OwningProcess,State   # ③ 看板端口
Get-Content (Get-ChildItem data\logs\hive-*.log | Sort LastWriteTime -Desc | Select -First 1).FullName -Tail 30  # ④ 今日日志尾
```

- `healthcheck` 退出码：**0 = 无 FAIL**（允许 WARN）；**1 = 有 FAIL**；**2 = 参数错**。
- 要机器读：`node --no-warnings scripts\healthcheck.mjs --json`（stdout 只有一份 JSON）。

---

## 二、启动 / 停止 / 重启

### 2.1 前台跑（排障首选，能立刻看到错误）

```powershell
node --no-warnings scripts\hive.mjs daemon            # 默认端口 8787
node --no-warnings scripts\hive.mjs daemon --port 8899 # 换端口
```
- 已有实例在跑时第二次启动会**拒绝并退出码 3**：`✗ 已有守护进程在跑 (pid=…, since …)`（单实例锁 `data\hive.lock`）。
- 停止：`Ctrl+C`（收到 SIGINT 会先 `releaseLock()` 再退）。
- 只起看板（**不跑巡检/不派发**，适合排障与演示）：`node --no-warnings scripts\hive.mjs serve --port 8787`。
  ⚠️ 实测：此时**没有** `data\hive.lock`，所以它是「看板」不是「daemon」——别指望它推进任务。

### 2.2 隐藏常驻（生产姿势，计划任务）

```powershell
pwsh -NoProfile -File scripts\install-task.ps1            # 注册：登录时启动、隐藏窗口、失败每 1 分钟重启
pwsh -NoProfile -File scripts\install-task.ps1 -Start      # 注册后立刻起一次并回显
pwsh -NoProfile -File scripts\install-task.ps1 -Uninstall  # 停 + 删任务 + 杀进程 + 删启动器
pwsh -NoProfile -File scripts\uninstall-task.ps1           # 同上（薄壳，行为一致）
```

- 任务名默认 `HIVE-daemon`；启动器在 `data\work\hidden\{run_hidden.vbs,hive-daemon.cmd}`。
- **判断是否真起来看 `data\hive.lock`，不要看任务状态**：实测 `Start-ScheduledTask` 到真正开跑有 **3–15 s** 延迟，期间任务状态可能还是 `Running`/上次结果 `267009`。
- 装载日志：`data\logs\daemon.stdout.log`（cmd 重定向的 stdout/stderr）。

### 2.3 重启（对齐顺序，不要乱）

```powershell
# ① 先停
pwsh -NoProfile -File scripts\uninstall-task.ps1     # 或前台 Ctrl+C
# ② 确认没有残留
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where CommandLine -like '*hive*' | Select ProcessId,CommandLine
# ③ 再起
node --no-warnings scripts\hive.mjs daemon           # 先前台看 30 秒，确认无报错
pwsh -NoProfile -File scripts\install-task.ps1 -Start # 确认没问题再交给计划任务
```

---

## 三、看板与接口

| 地址 | 说明 | 实测 |
|---|---|---|
| `http://127.0.0.1:8787/` | 看板首页（静态页，无构建步骤） | `200` `text/html` 10530 B |
| `http://127.0.0.1:8787/api/health` | 体检：db/预算/执行器/传感器/SSE 客户端数 | `200`，返回 `executors.ready=true`、`sensors.ready=true` |
| `http://127.0.0.1:8787/api/overview` | 聚合：counts/topItems/budget | `200` |
| `http://127.0.0.1:8787/api/stream` | SSE 实时事件流 | `server.sse=true` 时可用（`curl -N` 观察） |
| 其它 | `/api/items`、`/api/tasks`、`/api/approvals`、`/api/events`、`/api/doctor` | 见 docs/01 §七 |

**鉴权**：`config.server.token` 为空 = 本地免密；非空则所有 `/api/*` 需 `X-Hive-Token: <token>`（或 `?token=`），否则 `401 未授权`。

---

## 四、日志在哪

| 日志 | 路径 | 内容 | 什么时候看 |
|---|---|---|---|
| 应用日志 | `data\logs\hive-YYYY-MM-DD.log` | 主循环、脉冲、传感器、错误 | 首选。**文件名日期按 UTC**，所以本地 00:00–08:00 之间写的是「昨天」那个文件 |
| 守护进程 stdout | `data\logs\daemon.stdout.log` | 计划任务启动时的控制台输出（崩溃栈在这里） | 「任务在跑但没反应」时看这个 |
| 事件表（最权威） | `data\hive.db` 的 `events` 表 | 每次状态变更，含 `level=error` | `node --no-warnings scripts\hive.mjs events --limit 40` |
| Run 原始产物 | `data\runs\<run_id>\` | prompt/stdout/stderr/result.json/meta.json | 追某次执行到底输出了什么 |
| 备份 | `data\backups\` | `hive-backup-*.zip`、`pre-restore-*.db` | 回滚 |

```powershell
node --no-warnings scripts\hive.mjs events --limit 60          # 时间线
node --no-warnings scripts\hive.mjs events --level error       # 只看错误
```
日志保留：`pruneLogs(14)` 删 14 天前文件；`events` 表在 daemon 里按 30 天清理。

---

## 五、常见故障与处置

### F1　daemon 起不来

| 现象 | 排查 | 处置 |
|---|---|---|
| 退出码 3：`已有守护进程在跑` | `Get-Content data\hive.lock` | 真有进程就复用它；锁文件里的 pid 已死 → 删锁重起（`healthcheck` 会报「锁文件残留」） |
| `EADDRINUSE`（退出码 1） | 见 F2 | 换端口或停占用者 |
| 报 `Cannot find module ../src/sensors/index.mjs` 之类 | `Test-Path src\sensors\index.mjs` | 模块缺失时 daemon 会**降级**（HTTP 照起、sensor 不跑）；补齐代码后重启 |
| 一启动就 exit，日志无内容 | 看 `data\logs\daemon.stdout.log` | 多半是 Node 版本/语法错误：`node -v`、`node --check scripts\hive.mjs` |
| 计划任务 `Ready` 但一直没 `hive.lock` | `Get-ScheduledTaskInfo -TaskName HIVE-daemon` 看 `LastTaskResult` | `267009`=还在跑；`0x1`=失败。用 `Start-Process wscript … -Wait` 手工复现（见 docs/04 E9） |

### F2　端口被占（8787）

```powershell
Get-NetTCPConnection -LocalPort 8787 -State Listen | Select LocalAddress,OwningProcess
Get-CimInstance Win32_Process -Filter "ProcessId=<pid>" | Select Name,CommandLine,CreationDate
```
- 如果是**另一个 HIVE**（`hive.mjs daemon` / `hive.mjs serve` / `src/server/http.mjs`）：**别双开**（违反 I2 单写者）→ 停掉其中一个。
- 如果是**别的软件**：`config.server.port` 改端口（或临时 `--port 8899` / 环境变量 `HIVE_PORT`），重启 daemon。

### F3　DB 锁 / SQLITE_BUSY

- 连接时设了 `busy_timeout=8000`（8 秒），偶发 BUSY 会自动重试。
- **持续 BUSY 只有两个原因**：① 两个进程同时写（daemon + CLI `--direct` / 手工脚本）；② 有长事务没提交。
- 排查：
  ```powershell
  node --no-warnings scripts\healthcheck.mjs            # db.integrity / db.open 会报
  node --no-warnings scripts\hive.mjs stats             # 能读说明库没锁死
  ```
- 处置：停掉多余写者 → 仍失败时**不要**直接删 `-wal`/`-shm`（会丢未提交数据），先备份：
  ```powershell
  node --no-warnings scripts\backup.mjs                 # VACUUM INTO 能读就说明库没坏
  ```
  真要抢救：`restore.mjs --from <最近备份> --yes`。

### F4　任务卡死（一直 running）

```powershell
node --no-warnings scripts\hive.mjs tasks --status running
node --no-warnings scripts\hive.mjs events --limit 20      # 看 task.killed / run.timeout
```
- Watchdog 每 `tickSec`（默认 20 s）扫：`超时 > timeout_sec+30` 或 `tokens > budget_tokens` → `taskkill /T /F` → 按 `attempt < max_attempts` 重排。
- 心跳超 10 分钟没更新 = 僵尸（`healthcheck` 的 `db.backlog` 会报 `stalled>0`）。
- 处置：
  ```powershell
  node --no-warnings scripts\hive.mjs retry <task-id>        # 重排（attempt 归零）
  node --no-warnings scripts\hive.mjs retry <task-id> --now  # 立即执行
  ```
- 如果**执行器进程还残留在系统里**：`taskkill /PID <pid> /T /F`（pid 在 `runs.pid`）。

### F5　预算超支

```powershell
node --no-warnings scripts\hive.mjs stats      # cost: {costCny, budget, ratio}
```
- `ratio ≥ 0.8` → 告警（`budgetWarnRatio`）；`ratio ≥ 1` → **停止派单**（`events.type='budget.blocked'`），L1 只读类仍可跑。
- 处置：① 等次日 00:00 本地自然重置（`todayCost` 按本地 0 点切日）；② 临时调高 `settings.dailyBudgetCny`（改完重启）；
  ③ 查是谁烧的：`SELECT run_id,executor,model,cost_cny FROM runs ORDER BY cost_cny DESC LIMIT 10`。
- **别**为了「继续跑」把 `dailyBudgetCny` 改成 0 —— 代码里 0 表示「没有上限」，护栏直接消失。

### F6　凭据失效

| 症状 | 命令 | 处置 |
|---|---|---|
| LLM 报 `缺少凭据 refs.XXX` | `node --no-warnings scripts\healthcheck.mjs`（看 `channel.llm`） | 改 `F:\dsh-home\.credentials.yaml` 的 `refs:` 段，重启 daemon |
| `channel.llm.default` FAIL | 同上 | 默认 provider 的 `keyRef` 别名对不上 `credentials.keys` |
| 邮件 `logged_in:false` / `token_status != valid` | `agently-cli auth status` | `agently-cli auth refresh`（凭证 1 小时过期，见 docs/04 E7）；仍失败 `agently-cli auth login` |
| 邮件发不出去但状态正常 | `agently-cli message +send --dry-run …` | 看是不是**停在两阶段确认**（需要人带 `--confirmation-token` 二次确认） |

### F7　传感器不干活

```powershell
node --no-warnings scripts\hive.mjs scan --source mail     # 单源试扫（不写死状态）
node --no-warnings scripts\hive.mjs events --limit 30      # 找 sensor.error
```
- 常见：`sources.x` / `sources.wechat` 本就 `enabled:false`（未接入）；`git` 仓库路径不存在；`calendar` 没有 `.ics`（空转属正常）。
- 邮件源依赖 `agently-cli`（Windows 上必须经 `cmd /c` 调，见 docs/04 E5）。

### F8　磁盘满 / 产物膨胀

```powershell
node --no-warnings scripts\healthcheck.mjs     # disk.free：<1 GiB FAIL，<5 GiB WARN
(Get-ChildItem data\runs -Recurse -File | Measure-Object Length -Sum).Sum/1MB
```
- `data\runs` 会随执行次数线性增长。清理顺序：先备份 → 再删**已成功且无引用**的 run 目录。
- **不要**删 `data\hive.db` 旁边的 `-wal`/`-shm`（那是正在用的一致性结构）。

### F9　数据坏了 / 误删

```powershell
node --no-warnings scripts\healthcheck.mjs                # db.integrity
node --no-warnings scripts\backup.mjs                     # 能备份 = 库还能读
node --no-warnings scripts\restore.mjs --from data\backups\<最新>.zip --dry-run   # 先只校验
node --no-warnings scripts\restore.mjs --from data\backups\<最新>.zip            # 交互确认后覆盖
```
详见第六节。

---

## 六、备份 / 恢复（运维最重要的一条命）

### 6.1 备份

```powershell
node --no-warnings scripts\backup.mjs                                   # → data\backups\hive-backup-<ts>.zip
node --no-warnings scripts\backup.mjs --out data\backup-test.zip        # 指定路径
node --no-warnings scripts\backup.mjs --format dbgz                     # 纯 node 兜底格式（无 tar 也能恢复）
node --no-warnings scripts\backup.mjs --keep 7                          # 只留最近 7 份
```
- 内容：`hive.db`（**`VACUUM INTO` 一致性快照**，不是 cp）、`manifest.json`（含 db sha256 + 逐表行数）、`config/*.json`、`VERSION`、`artifacts/`、`runs/index.json`。
- 同时写 `<out>.sha256` 旁文件，恢复时连归档一起校验。
- 实测（两次）：库 144 KiB（items=2）→ 包 162.5 KiB / **494 ms**；库 280 KiB（items=36、runs=5）→ 包 299.5 KiB / **857 ms**。

### 6.2 恢复（有安全网）

```powershell
# ① 只校验不动手
node --no-warnings scripts\restore.mjs --from data\backup-test.zip --dry-run
# ② 演练：恢复到备用路径（不碰生产库）
node --no-warnings scripts\restore.mjs --from data\backup-test.zip --target-db data\work\drill.db --yes
# ③ 真恢复（会问 yes；脚本里用 --yes）
node --no-warnings scripts\restore.mjs --from data\backup-test.zip
# ④ 连配置一起回填
node --no-warnings scripts\restore.mjs --from data\backup-test.zip --with-config --yes
```
- **自动安全网**：覆盖前会把现场另存为 `data\backups\pre-restore-<ts>.db`（含 `-wal`/`-shm`），所以「恢复错了」还能再回滚。
- **拒绝条件**：`data\hive.lock` 里的 pid 还活着 → 拒绝覆盖（`--force` 可强行，**不推荐**）；非交互且没 `--yes` → 拒绝。
- 校验链条：归档 sha256（若有旁文件）→ 解出的 `hive.db` sha256 == manifest → `integrity_check` → 逐表行数 == manifest → 覆盖后**再复核一次**。
- 实测闭环：恢复前 `items=3/kv=2/events=18`（含演练哨兵）→ 恢复后 `items=2/kv=1/events=17`，11 张表与 manifest 全一致，`integrity_check=ok`。

### 6.3 备份节奏建议

| 频率 | 动作 | 保留 |
|---|---|---|
| 每日（低峰） | `backup.mjs` 默认路径 | 7 份 |
| 每周 | 把最新 zip 拷到**另一块盘**（D→E/F） | 4 份 |
| 每次改配置/升级前 | `backup.mjs --out data\backups\pre-<变更名>.zip` | 手动留 |

> `healthcheck` 会检查 `backup.age`：超过 7 天没备份报 WARN。

---

## 七、日常巡检清单

**每天（1 分钟）**

```powershell
node --no-warnings scripts\healthcheck.mjs --fast   # 全绿/只剩已知 WARN
node --no-warnings scripts\hive.mjs outbox          # 有没有等你拍板的事
node --no-warnings scripts\hive.mjs stats           # 预算 & 积压
```

**每周**

```powershell
node --no-warnings scripts\backup.mjs
node --no-warnings scripts\hive.mjs tasks --status failed
node --no-warnings scripts\hive.mjs events --level error --limit 50
```

**变更前**（改配置/换执行器/升级 CLI）

1. `backup.mjs --out data\backups\pre-change.zip`
2. 改 → `healthcheck --strict`（WARN 也算失败，确认没有新 WARN）
3. 前台跑 `daemon` 观察 ≥5 分钟，再切计划任务

---

## 八、绝对不要做（会直接坏数据）

1. **别开两个 daemon**（单实例锁就是防这个；锁坏了要先确认旧进程死透）。
2. **别手工改 `data/hive.db`**（状态唯一事实源 + 事件溯源；改了就与 `events` 对不上）。
3. **别删 `-wal`/`-shm`** 来「解决锁」（先备份，再谈）。
4. **别在 daemon 跑着的时候 restore**（会撕裂内存状态与磁盘状态）。
5. **别把 `dailyBudgetCny` 设成 0**（0 = 无上限）。
6. **别把 `.credentials.yaml` 拷进仓库或备份包**。
7. **别直接 `cp hive.db` 当备份**（WAL 未合并，可能是旧/坏快照）——用 `backup.mjs`。

---

## 九、升级与回滚

```powershell
# 升级流程
node --no-warnings scripts\backup.mjs --out data\backups\pre-upgrade.zip
# …替换代码 / 升级全局 CLI…
node --no-warnings scripts\healthcheck.mjs --strict
node --no-warnings scripts\hive.mjs doctor
# 回滚
node --no-warnings scripts\restore.mjs --from data\backups\pre-upgrade.zip --yes
```

---

## 十、这份手册里「没跑过」的部分（诚实标注）

- **完整 daemon 长时间常驻**（跨脉冲/跨日/预算重置）本轮**没有**跑：只验证了 `serve`（看板 + `/api/health`）与各部件探测。
  出问题时请以 `data\logs\` 与 `events` 表为准，并在验证后回写本节。
- **计划任务在「未登录 / 锁屏 / 休眠唤醒」** 下的行为未验证（默认 `-AtLogOn` 就是为了绕开它）。
- **多 worker 并发（`maxConcurrentWorkers=2`）** 的稳定性未做压测。
- **邮件真发**未验证（只验证到两阶段确认的第 1 段，故意不发）。
