# 04 · 工具使用经验（踩过的坑）

> **写法约定**：每条都标了 **【实测】** 或 **【未验证】**。
> 【实测】= 本机（`D:\hive`、Node v24.14.1、Windows、`ELOHIA\elohi`）上跑过并贴了真实输出；
> 【未验证】= 从文档/惯例推断，没在本机复现 —— 用之前请自己验一遍，别当事实。

时间：2026-11-05 18:5x–19:2x（本地 +08:00；**程序内部 ISO 时间一律 UTC，两者差 8 小时，对日志时要用 8 小时换算**）。

---

## E1　`node:sqlite` 的实验性告警　【实测】

```
$ node -e "const{DatabaseSync}=require('node:sqlite');console.log('ok')"
ok
(node:24304) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
```

**结论**：功能可用（SQLite **3.51.2**），但每次启动污染 stderr。

**两种抑制**（都在用）：

```powershell
node --no-warnings scripts\healthcheck.mjs            # ① 命令行
```
```js
// ② 进程内：只吞这一条，别的警告照常
const orig = process.emitWarning;
process.emitWarning = (w, ...rest) => {
  const msg = typeof w === 'string' ? w : (w?.message || '');
  if (/SQLite is an experimental/i.test(msg)) return;
  return orig.call(process, w, ...rest);
};
```

**坑**：`--no-warnings` 会把**所有**警告都关掉（包括你自己写的 `emitWarning`）。
排查阶段请用 `--trace-warnings` 或临时去掉该参数。

---

## E2　`NODE_USE_ENV_PROXY=1` 让 `fetch` 走代理，`https.request({agent:false})` 却能绕过　【实测】

本机环境：`HTTP_PROXY=HTTPS_PROXY=ALL_PROXY=http://127.0.0.1:7890`、`NODE_USE_ENV_PROXY=1`、
`NO_PROXY=127.0.0.1,localhost,::1,api.deepseek.com,...`。

三组对照（把代理故意指向**关闭**的 `127.0.0.1:9`，目标 `https://example.com`，不在 NO_PROXY 里）：

| 条件 | 结果 |
|---|---|
| `NODE_USE_ENV_PROXY=1` + `fetch()` | **`ERR ECONNREFUSED`**（说明确实走了代理） |
| 去掉 `NODE_USE_ENV_PROXY` + `fetch()` | `OK 200`（代理环境变量被忽略） |
| 保留 `NODE_USE_ENV_PROXY=1` + `https.request({..., agent:false})` | **`OK 200`**（绕过代理，直连成功） |

**结论**：

- Node 24 里 `NODE_USE_ENV_PROXY=1` 会让**全局 `fetch`（undici）**读 `HTTP(S)_PROXY`；
  境外站点会走 7890 代理，境内直连站点要靠 `NO_PROXY`。
- `src/core/llm.mjs` 用 `https.request(..., agent: false)` **显式绕开环境代理** —— 这是**故意**的（DeepSeek 国内直连可达，走代理反而更慢/更易失败）。
- **改这段代码时不要「顺手」把 `agent:false` 去掉**，也不要把 `fetch` 换成 `https.request` 而不带 `agent`：两者行为相反。

**排查口诀**：连不上 → 先看 `NODE_USE_ENV_PROXY` / `NO_PROXY`，再看是不是 `agent` 设错。

---

## E3　`dsh --profile headless "<job>"` 冷启动　【实测】

```
$ dsh --profile headless "只回复 OK 两个字符，不要做任何其他事"
OK
ELAPSED_SEC=36.8    EXIT=0
```

**结论**：一条 job = 起 profile（插件层）→ 跑一轮 → 打印最终答案 → 退出。**实测 36.8 s**（简单 prompt、机器已热）。
任务书里记的 51–55 s 应该是首轮/更重的 profile 场景 —— 两者都当「冷启动分钟级」看待。

**用法要点**：

- 参数顺序是 `dsh --profile headless "<job>"`（job 是位置参数，别写成 `--job`）。
- 它会**自己**在终端/日志里输出，不需要再套 `sh -c`。
- 超时预算：`settings.defaultTimeoutSec=900` 够；但如果一个任务要跑多次 dsh，要按 40 s × N 算。
- 子进程**必须整树 kill**（见 E8），否则 dsh 的插件进程会残留。

---

## E4　`pi --version` 要 7.5 秒　【实测】

| 命令 | 耗时 |
|---|---|
| `dsh --version` | 1 253 ms |
| `pi --version` | **7 547 ms** |
| `codex --version` | 1 521 ms |
| `claude --version` | 1 206 ms |
| `pwsh --version` | 1 016 ms |
| `agently-cli auth status` | 1 353 ms |

**坑**：健康检查如果**串行**跑 5 个执行器 + 通道探测，光探测就 **20.8 s**（`healthcheck.mjs` 第一版实测值）。
**改法**（`healthcheck.mjs` 已这么干）：所有外部命令 `Promise.all` 并行 → 总耗时由最慢的 pi 决定。
实测（当前版本）：全量 **8.1 s**（执行器模块 `probe()` 还会额外起 node/pwsh 时 **11–13 s**）；
`--fast`（只 `where` 查存在性、不取版本，且跳过执行器模块的 `probe()`）→ **2.7 s**。

**别做**：在 daemon 主循环里每次都 `probe()` 全部执行器（会拖住 tick）。要缓存结果。

---

## E5　Windows 上 npm 全局命令是 `.ps1` 垫片 → `execFileSync` 直接 ENOENT　【实测】

`where` 的真实结果：

```
dsh     → C:\Users\elohi\AppData\Roaming\npm\dsh.ps1
pi      → C:\Users\elohi\AppData\Roaming\npm\pi.ps1
codex   → C:\Users\elohi\AppData\Roaming\npm\codex.ps1
claude  → C:\Users\elohi\AppData\Roaming\npm\claude.ps1
agently-cli → C:\Users\elohi\AppData\Roaming\npm\agently-cli.ps1
```

`node scripts/hive.mjs doctor` 的实测输出里就有一行 failed：

```
邮件通道     FAIL  spawnSync agently-cli ENOENT
```

**原因**：`execFileSync('agently-cli', ...)` 不去找 `.ps1`/`.cmd`（那是给 shell 用的），于是 ENOENT，
**明明 `agently-cli --version` 在终端里是好的**。

**正确写法**（`healthcheck.mjs` 采用）：

```js
spawn('cmd.exe', ['/d', '/c', 'agently-cli auth status'])   // Windows
spawn(cmd, args)                                            // 其它平台
```

**三句话记住**：`spawnSync(命令)` 在 Windows 上找的是 `.exe`；npm 全局命令要经 `cmd /c`；想拿退出码就用 `spawn`/`spawnSync` 而不是 `exec`。

**现状（同日复核）**：`scripts/hive.mjs doctor` 已经改成 `execFileSync('cmd.exe', ['/c','agently-cli','auth','status'])`，
现在实测是 `邮件通道 PASS agently-cli 已授权`（不再是 FAIL）。
`scripts/healthcheck.mjs` 从第一版起就走 `cmd.exe /d /c`，没有这个问题。
——保留本条是因为**同样的错法很容易再写一遍**（任何新 module 只要直接 `execFile('某npm命令')` 就会踩）。

---

## E6　agently-cli 两阶段确认：第一次调用**不发信**　【实测】

```
$ agently-cli message +send --to elohia@agent.qq.com --subject "[hive] 两阶段确认验证" --body "..."
{
  "ok": true,
  "data": {
    "confirmation_required": true,
    "confirmation_token": "ctk_d28814cf-b085-4f14-8170-335c54364357",
    "summary": { "action": "send", "from": "elohia@agent.qq.com", "to": ["elohia@agent.qq.com"], "subject": "...", "attachment_count": 0 }
  }
}
tip: review summary, then re-run with --confirmation-token ctk_...
```

**结论**：

- 第 1 次调用 = **只拿摘要和令牌**，真实邮件**没有发出**（本轮故意不 confirm，事后确认无异常发送）。
- 第 2 次带 `--confirmation-token <ctk>` 才发。
- `--dry-run` 只打印将要发的 API 调用，**不产生** ctk（实测输出 `{"description":..., "calls":[...]}`）。

**HIVE 怎么用**：`src/hitl/notify.mjs → mail()` 拿到 ctk 就**停下**，返回 `{pending:true, ctk}`；
也就是「自动流程永远不会自己确认发信」，必须人来敲第 2 段。符合铁律 4。

**坑**：`--attachment` 的路径必须是**相对当前目录**的（帮助原文：`Attachment paths must be relative to the current directory`）。

---

## E7　agently-cli 凭据：DPAPI + 1 小时过期　【实测】

```
$ agently-cli auth status
{ "ok": true, "data": {
    "logged_in": true, "status": "logged_in", "token_status": "valid",
    "granted_at": "2026-07-21T11:50:01Z",
    "refresh_at": "2026-11-05T10:54:13Z",
    "expires_at": "2026-11-05T11:54:13Z",
    "storage": "Windows DPAPI", "app_id": "cli_002e8cd175cf41d8"
} }
```

**结论**：

- `expires_at` 只有 **1 小时**（refresh_at 前 1 小时），所以「凭据失效」是**高频**故障，不是偶发。
- `storage: Windows DPAPI` → 密文绑当前 Windows 用户与机器，**换用户/换机器都读不出来**，必须重新 `auth login`。
- 健康检查要把「剩余分钟数」打出来（`healthcheck.mjs` 已实现；实测当时显示「剩 52 分钟」），快到期就 WARN。

---

## E8　Windows 进程树 kill：必须 `/T /F`　【实测】

```powershell
$p = Start-Process pwsh -ArgumentList '-NoProfile','-Command','Start-Sleep 300' -PassThru -WindowStyle Hidden
& taskkill /PID $p.Id /T /F
```
```
SUCCESS: The process with PID 42820 (child process of PID 21600) has been terminated.
SUCCESS: The process with PID 21600 (child process of PID 44516) has been terminated.
still_running=False
```

**结论**：`taskkill /PID <pid> /T /F` 一刀切掉父子树；`/T` 不能省（执行器都是「node → 插件子进程」两层）。
`src/task/watchdog.mjs`、`src/executors/proc.mjs`、`install-task.ps1` 都用这个姿势。

**判活**：`process.kill(pid, 0)` 不抛异常 = 活着；**但 pid 会被复用**，所以还要对 `runs.started_at`/锁文件交叉验证。

---

## E9　`& wscript.exe` 在 PowerShell 里「静默不干活」　【实测】

| 调用方式 | 结果 |
|---|---|
| `& wscript.exe //Nologo run_hidden.vbs stub.cmd` | 立即返回（约 140 ms）、`$LASTEXITCODE` 为空、**marker 文件没生成** |
| `Start-Process wscript.exe -ArgumentList ... -Wait` | `ExitCode 0`、**marker 生成** ✔ |
| `cscript.exe //Nologo run_hidden.vbs stub.cmd` | 正常、marker 生成 ✔（控制台版，能吐错误） |

**原因**：`wscript.exe` 是 GUI 子系统程序，PowerShell 的 `&` 不会等它、也不回填退出码。

**结论**：

- 人工验证隐藏启动链路 → 用 `Start-Process -Wait`，或先用 `cscript` 排错。
- **计划任务器自己调 wscript 是正常的**（它不等，任务实例会挂着直到子进程退出）。
- 计划任务「启动到真正跑起来」有 **3–15 s** 延迟（实测一次 15 s 才看到 marker）；
  **别用任务状态判断 daemon 是否起来，要看 `data\hive.lock`**。

---

## E10　PowerShell 只读自动变量：参数不能叫 `-Home`　【实测】

```
WriteError: 无法覆盖变量 Home ，因为它是只读变量或常量。
```

`$HOME` 是只读自动变量，且**大小写不敏感** → `param([string]$Home)` 直接失败。
**改法**：参数叫 `-Root`，用 `[Alias('Home')]` 兼容旧写法（`install-task.ps1` 就是这么处理的）。

**同类坑**：`$Host`、`$PID`、`$Input`、`$Error`、`$Args` 都不要当参数名。

---

## E11　PowerShell 里生成 JS/SQL 代码时的引号地狱　【实测】

下面这种「`node -e` 里塞单引号 SQL」在 PowerShell 里会被吃掉引号：

```powershell
node -e "const t=db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\")..."   # ✗ 报 Expected unicode escape / missing )
```

**结论**：只要内嵌字符串里同时有单/双引号 + 反引号，就别跟 PowerShell 搏斗 ——
**写到临时 `.mjs` 文件再 `node 文件`**（本项目的 `healthcheck/backup/restore` 都是正经文件，无此问题）。
临时文件放 `%TEMP%`，别落进仓库。

---

## E12　SQLite 快照用 `VACUUM INTO`，别 `cp`　【实测】

```
vacuum_ms: 53
src_bytes: 147456   out_bytes: 147456
out_integrity: ok
out_journal: {"journal_mode":"delete"}     ← 注意！
out_events: 17 (与源库一致)
```

**结论**：

- `VACUUM INTO '<path>'` 在**库正在被写（WAL 模式）**时依然给出**一致快照**，全库 53 ms。
- 输出文件自带 `journal_mode=delete`（不是 WAL）——**恢复回去之后**，`src/core/db.mjs` 打开时会重新 `PRAGMA journal_mode=WAL`，所以无需手工处理。
- **不要**用 `copy hive.db`：WAL 里还有没回主文件的事务，拷出来的 `.db` 可能是旧的甚至坏页。

配套：`PRAGMA wal_checkpoint(TRUNCATE)` 实测返回 `{"busy":0,"log":0,"checkpointed":0}`（没有待回写帧时全 0，属正常）。

---

## E13　端口占用：错误文案与退出码　【实测】

有两个服务（不同 teammate 的测试 + 我的）同时抢 8787 时：

```
ERROR CLI 失败: Error: 端口 8787 已被占用：listen EADDRINUSE: address already in use 127.0.0.1:8787（可用 --port 换一个）
exit code: 1
```

**排查**：

```powershell
Get-NetTCPConnection -LocalPort 8787 -State Listen | Select LocalAddress,OwningProcess
Get-CimInstance Win32_Process -Filter "ProcessId=<pid>" | Select CommandLine
```

**处置**：先判断那是谁（`serve` 只起看板 / `http.mjs` 直测 / 真 daemon），再决定「复用」还是「换端口」。

---

## E14　cmd 存根里的中文与编码　【实测】

- `cmd` 默认代码页是 GBK（936），日志里中文会乱码；存根开头加 `chcp 65001 >nul` 切 UTF-8。
- 用 PowerShell `Set-Content`/`[IO.File]::WriteAllText` 写 `.cmd`/`.vbs` 时统一 **UTF-8 无 BOM**
  （`install-task.ps1` 用 `New-Object System.Text.UTF8Encoding($false)`）。
- `.vbs` 第一行是注释，**别在注释里放特殊 Unicode 字符**（wscript 按 ANSI 读，容易踩）；
  `install-task.ps1` 生成的 vbs 只有 ASCII 注释。
- 实测 `echo %DATE%` 打到文件里会出现 `周四 2026/11/05` 这类本地化文本，**脚本里不要解析 `%DATE%`**。

---

## E15　其它零散实测

| 现象 | 结论 / 做法 |
|---|---|
| `Get-ScheduledTask` 总数 **242** 条（其中 `wscript //Nologo D:\pi-agent\scripts\run_hidden.vbs ...` 形态 5+ 条，`D:\pi-agent\scripts\hidden` 下有 **37** 个 `.cmd`） | HIVE 注册的任务名要带前缀（默认 `HIVE-daemon`），避免和 pi-agent 的自动化混在一起 |
| 注册计划任务**不需要管理员**（实测成功，`-Principal ... -RunLevel Limited`） | 但写某些任务目录/改别人任务会失败 → 失败要给出「手跑命令」兜底 |
| D 盘余量 `70.4 GiB / 总 268.6 GiB`；C 盘 `40.6 GiB` | 备份/产物都在 D 盘，`healthcheck` 会把余量分级（<1 GiB FAIL、<5 GiB WARN） |
| `tar -a -c -f x.zip <files>` 一次就出 zip（192 B 小样本验证过） | Windows 自带 bsdtar 认扩展名；**不要**装 7zip/Compress-Archive（后者慢且大） |
| `Invoke-WebRequest -UseBasicParsing` 在 pwsh 7 上仍可用 | 看板 API 用 `curl`/`Invoke-RestMethod` 都行；SSE 要用 `curl -N` |
| 数据库 `data/hive.db` 旁边必有 `-wal`/`-shm` | 备份/迁移**不要只拷 `.db`**；恢复后要删旧的 `-wal`/`-shm`（`restore.mjs` 已做） |

---

## E16　看板 API 实测片段　【实测】

```
GET /api/health  → 200
{"ok":true,"name":"hive","version":"0.1.0","home":"D:\\hive",
 "db":{"ok":true,"path":"D:\\hive\\data\\hive.db","stats":{"items":34,"tasks":0,...}},
 "budget":{"costCny":0,"budget":8,"ratio":0},
 "executors":{"ready":true,"path":"D:\\hive\\src\\executors\\index.mjs"},
 "sensors":{"ready":true},
 "server":{"host":"127.0.0.1","port":8787,"tokenRequired":false,"sseClients":1,"sseEnabled":true}}

GET /api/overview → 200（counts/topItems/budget/db 聚合）
GET /            → 200  text/html  10530 B
```

**要点**：`/api/health` 已经包含「执行器 ready / 传感器 ready / 预算 / SSE 客户端数」，运维优先看它。

---

## 五、还没验证的东西（别当事实用）　【未验证】

1. **daemon 长时间常驻**（>1 小时、跨脉冲、跨日预算重置）没跑过；本文只验证了它的组成部件与 `serve`。
2. **dsh 冷启动 36.8 s 的稳定性**未知（只测了 1 次，机器热态）。
3. **12 个脉冲同时触发**时的行为没测（`pulseGraceSec` 也没接线，见 docs/02）。
4. **DPAPI 跨用户/跨机**：只从文档推断「读不出来」，没实测第二台机。
5. **看板 SSE 在浏览器长时间挂着的内存增长**没测。
6. **`pi --version` 慢的根因**没深挖（只测到现象）。
7. **Windows 计划任务在「未登录」状态**下能否跑 daemon（本项目默认 `-AtLogOn` 就是为了绕开这个不确定性）。
