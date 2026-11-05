# 06 · 迁移到新机器

> 目标：把 `D:\hive` 整体搬到另一台 Windows 机器，**保留全部历史**（DB + artifacts + runs），并且**知道该改哪几行配置**。
> 本文件基于一次真实盘点：`D:\hive` 目前 **没有 `.git`、没有 `package.json`、没有 `node_modules`**
> （实测 `Test-Path .git → False`、`Test-Path package.json → False`）——所以迁移是**整目录拷贝**，不是 `git clone`。

---

## 一、目标机前置条件

| 项 | 要求 | 实测（源机） |
|---|---|---|
| OS | Windows 10/11 x64 | Windows（build 26100 的 powershell.exe） |
| 用户 | **同一个 Windows 账号名**建议保持一致 | `ELOHIA\elohi` |
| Node | **≥ 24**（本项目按 24.14.1 验） | v24.14.1 |
| 磁盘 | 数据目录所在盘 ≥ 5 GiB 空闲（`healthcheck` <5 GiB 报 WARN、<1 GiB 报 FAIL） | D 盘余 70.4 GiB |
| 网络 | 能到 LLM API（DeepSeek 直连）、能到 7890 代理（如果需要） | `HTTP(S)_PROXY=127.0.0.1:7890`、`NO_PROXY` 含 `api.deepseek.com` |
| 权限 | 能注册当前用户的计划任务（**不需要管理员**，实测成功） | ✅ |

---

## 二、依赖安装（按需，不是全都要）

```powershell
# ① 必需：Node 24（自带 node:sqlite）
winget install OpenJS.NodeJS.LTS     # 或官网 msi；装完 node -v 应是 v24.x
node -v
node --no-warnings -e "const{DatabaseSync}=require('node:sqlite');console.log(new DatabaseSync(':memory:').prepare('select sqlite_version() v').get().v)"

# ② 执行器（按需；没有就降级，daemon 仍能起）
npm i -g @deepseek-ai/dsh                     # dsh   0.1.5-rc.2
npm i -g @earendil-works/pi-coding-agent      # pi    0.84.1
npm i -g @openai/codex                        # codex 0.153.4
npm i -g @anthropic-ai/claude-code            # claude 2.1.195

# ③ 邮件通道
npm i -g @tencent-qqmail/agently-cli          # 1.0.11（最新 1.0.18）
agently-cli auth login                        # 必须重新授权（见第四节）

# ④ 工具（多数 Windows 自带）
git --version     # 2.55.0.windows.3
tar --version     # bsdtar 3.8.9（C:\Windows\system32\tar.exe）
pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'   # 7.6.9
```

装完先跑一次体检（此时项目目录还没数据，DB 会被自动建空库）：
```powershell
node --no-warnings scripts\healthcheck.mjs
```

---

## 三、拷贝什么、不拷贝什么

| 路径 | 拷？ | 理由 |
|---|---|---|
| `src\` `web\` `scripts\` `docs\` `config\` `prompts\` `tests\` | ✅ 全拷 | 代码与配置 |
| `AGENTS.md` `README.md` `VERSION` | ✅ | 约定与版本 |
| `data\hive.db` + `-wal` + `-shm` | ⚠️ **不要直接拷** | 见下方「正确姿势」：用 `backup.mjs` 出一致快照再搬，或**停掉所有进程后**三件一起拷 |
| `data\artifacts\` `data\runs\` | ✅ | 交付物与执行原始产物（可在新机用备份包里的版本覆盖） |
| `data\logs\` | ❌ 不必 | 旧日志没价值，还容易混淆时间线 |
| `data\work\` | ❌ 不必 | 执行器临时工作区 |
| `data\hive.lock` | ❌ **一定不要** | 里面是旧机器的 pid，拷过去会让单实例锁误判 |
| `data\backups\` | ✅ 建议拷最近 1–2 份 | 新机第一次恢复/回滚的底牌 |
| `node_modules` `package.json` | — | 本项目不存在（零依赖） |
| `F:\dsh-home\.credentials.yaml` | ⚠️ 手动、单独 | 见第四节，**不要放进项目目录** |

**正确姿势（推荐）**：

```powershell
# 旧机
node --no-warnings scripts\backup.mjs --out D:\migrate\hive-migrate.zip
Copy-Item D:\migrate\hive-migrate.zip \\NEWPC\share\   # 或 U 盘
# 新机：先拷代码目录（不含 data），再 restore 数据
node --no-warnings scripts\restore.mjs --from D:\migrate\hive-migrate.zip --dry-run
node --no-warnings scripts\restore.mjs --from D:\migrate\hive-migrate.zip --with-config --yes
```

---

## 四、凭据（**最容易在迁移这一步翻车**）

| 凭据 | 能不能直接拷 | 正确做法 |
|---|---|---|
| LLM keys（`F:\dsh-home\.credentials.yaml` 的 `refs:`） | ✅ 能（明文 YAML） | 手工拷到新机同名路径；确保**不在项目目录内**；拷完 `icacls` 收紧到当前用户 |
| `agently-cli` 邮件授权 | ❌ **不能** | `storage: Windows DPAPI` 绑用户+机器（实测），必须在新机 `agently-cli auth login` 重新授权；随后 `agently-cli auth status` 确认 `logged_in:true` |
| HIVE 自己的 `server.token` | ✅（在 `config/hive.json`） | 若新机要对外，重新生成一个强 token |

> 校验：`node --no-warnings scripts\healthcheck.mjs` 的 `channel.llm` / `channel.mail` 两行必须 PASS。

---

## 五、必须改的路径（改完逐项勾）

改 `config\hive.json`：

| 字段 | 改什么 | 不改的后果 |
|---|---|---|
| `home` | 新机项目根（如 `E:\hive`） | 只影响展示；但**同时确认没有残留 `HIVE_HOME` 环境变量指向旧路径**（它优先级最高） |
| `paths.db/runs/artifacts/logs/workspace/prompts` | 若目录结构不变可不改 | 相对路径会自动拼到新 home 下 |
| `credentials.file` | 新机上 `.credentials.yaml` 的**绝对路径** | LLM 直接报「缺少凭据」 |
| `sources.git.repos[]` | 新机存在的仓库路径 | git 传感器会一直报错/空转 |
| `sources.docs.roots[]` | 新机存在的报告目录 | 同上 |
| `sources.calendar.icsPaths[]` | 相对项目目录的 `.ics` 位置 | 空转（无害） |
| `notify.mail.to` | 收件人（**换机后建议先留空**，验证通了再开） | 误发邮件 |
| `notify.mail.enabled` | 先保持 `false` | — |
| `server.port` | 新机若 8787 被占则改 | `EADDRINUSE` |
| `server.host` | 保持 `127.0.0.1` | 改成 `0.0.0.0` 等于对外暴露 |

改 `config\policies.json`：

| 字段 | 改什么 |
|---|---|
| `write_allowlist_dirs` | 改成新机上允许写的目录（⚠️ 当前**未代码强制**，语义见 docs/02 §3.5） |
| `never_touch` | 把新机上的隐私目录加进去（同样未强制，属**声明**） |
| `priority.domainWeight` | 一般不用改；若新机业务域不同，可增键（未知域回退 `_default 0.4`） |

环境变量（任选其一）：

```powershell
# 推荐：显式指定项目根，避免「源码位置推导」在符号链接/快捷方式下猜错
[Environment]::SetEnvironmentVariable('HIVE_HOME','E:\hive','User')
```

---

## 六、计划任务重建

```powershell
cd E:\hive
pwsh -NoProfile -File scripts\install-task.ps1 -DryRun     # 先看它要注册什么
pwsh -NoProfile -File scripts\install-task.ps1              # 真注册
pwsh -NoProfile -File scripts\install-task.ps1 -Start       # 立刻起一次
```

它会做三件事：写 `data\work\hidden\{run_hidden.vbs,hive-daemon.cmd}`（内容含新机的 node 绝对路径与项目根）→
注册计划任务（登录时启动、隐藏窗口、失败每 1 分钟重启、无执行时限）→ 可选立即启动。

**注意**：

- 启动器里的路径是**注册时**写死的；换了目录/换了 node 位置 → **重跑一次 `install-task.ps1`**（幂等，内容变才重写）。
- 旧机的任务要先卸载：`scripts\uninstall-task.ps1`（幂等，本来没装也不报错）。
- 判断真起来看 `data\hive.lock`，别信任务状态（启动有 3–15 s 延迟，见 docs/05 §2.2）。
- **不要**把 pi-agent 的 `run_hidden.vbs` 当成依赖：HIVE 自带一份同款（内容见 `install-task.ps1`）。

---

## 七、迁移验证清单（逐项打勾）

### 7.1 自动（一条命令）

```powershell
node --no-warnings scripts\healthcheck.mjs --strict     # 目标：0 FAIL；已知 WARN 见下表
node --no-warnings scripts\hive.mjs doctor
```
`healthcheck` 里这些行**必须 PASS**：

| 行 | 判据 |
|---|---|
| `runtime.node` | `v24.x` |
| `runtime.sqlite` | 能打印 `SQLite 3.xx` |
| `config.files` | hive.json + policies.json 都能解析 |
| `config.paths` | 4 个数据目录存在且可写 |
| `db.open` / `db.tables` / `db.integrity` | `journal=wal`、10/10 表、`integrity_check=ok` |
| `db.counts` | **与旧机备份包 manifest 的行数一致**（迁移成功的硬指标） |
| `channel.llm` | 每个 key 有长度、无「缺:」 |
| `disk.free` | 不是 FAIL |
| `budget.today` | 不是 FAIL |

**允许的已知 WARN**（不影响可用）：`executors.index`（模块未就绪时）、`channel.dashboard`（看板未起）、
`daemon.lock`（未常驻）、`backup.age`（还没做首次备份）。

### 7.2 人工（5 分钟）

1. **看板**：`node --no-warnings scripts\hive.mjs serve` → 浏览器开 `http://127.0.0.1:8787/` → `/api/health` 返回 `executors.ready/sensors.ready`。
2. **历史数据**：`node --no-warnings scripts\hive.mjs inbox --limit 5`、`outbox`、`tasks`、`events --limit 10` 都有旧数据。
3. **恢复演练**：`restore.mjs --from <备份> --target-db data\work\drill.db --yes` 应 PASS（证明解包+校验链路在新机能跑）。
4. **备份**：`backup.mjs` 应成功产出 zip（证明 bsdtar 在新机可用）。
5. **计划任务**：`install-task.ps1 -Start` 后 30 s 内出现 `data\hive.lock`。
6. **邮件通道**：`agently-cli auth status` → `logged_in:true`；**先别开 `notify.mail.enabled`**，等一切稳定再说。
7. **时间/时区**：`Get-Date` 与 `events` 表里的 `Z` 时间差 8 小时属正常；确认新机时区正确（否则「今日预算」切日会错）。

### 7.3 迁移后 24 小时观察

- `data\logs\hive-<日期>.log` 有没有反复 `pulse.error`。
- `hive.mjs stats` 的 `failed24h` 是否异常增长。
- `hive.mjs events --level error` 是否只有已知降级告警。

---

## 八、回滚（迁移不满意怎么办）

```powershell
# 新机上：用迁移前的备份回到起点
node --no-warnings scripts\restore.mjs --from data\backups\pre-restore-*.db  # 不行，.db 不是备份包
node --no-warnings scripts\restore.mjs --from data\backups\<迁移前出的>.zip --yes
# 完全放弃：停任务 → 删目录（旧机数据还在，不受影响）
pwsh -NoProfile -File scripts\uninstall-task.ps1
```

> 最稳的回滚永远是：**迁移前先 `backup.mjs` 出一份 zip 并留在旧机**，新机只当副本。

---

## 九、已知迁移风险（诚实标注）

| 风险 | 说明 | 缓解 |
|---|---|---|
| **DPAPI 不跨机** | `agently-cli` 授权必须重做（实测 storage=Windows DPAPI） | 迁移清单第 4 步 |
| **计划任务的身份** | 任务绑定 `ELOHIA\elohi`；新机用户名不同 → 要用新用户名重注册 | 重跑 `install-task.ps1`（它按当前用户注册） |
| **脚本里没有其它硬编码路径** | 代码侧只认 `config/hive.json` + `HIVE_HOME`；但 `install-task.ps1` 生成的启动器会写死绝对路径 | 换目录后**必须重跑安装脚本** |
| **WAL 三件套** | 直接拷 `.db` 会丢未合并事务 | 用 `backup.mjs`/`restore.mjs`，或停进程后三件一起拷 |
| **Node 大版本差异** | `node:sqlite` 存储格式随 SQLite 版本演进 | 新机尽量同版本；先 `--dry-run` 校验 |
| **本文件未在真实第二台机器上验证过** | 它是按本机盘点写的流程 | 第一次真迁移时把实际踩到的差异回写本文件 |
