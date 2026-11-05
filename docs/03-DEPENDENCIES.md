# 03 · 依赖

> **本文的版本号全部是本机实测**（2026-11-05 18:5x–19:1x，Windows / `ELOHIA\elohi`，Node v24.14.1）。
> 复测方法写在每行「怎么验证」里，一条命令就能对齐；`node --no-warnings scripts/healthcheck.mjs` 会把这些探测**全部跑一遍**并给出 PASS/WARN。

**本项目零 npm 依赖**：`D:\hive` 下**没有** `package.json`，也**没有** `node_modules`（实测 `Test-Path package.json → False`）。
运行时只用 Node 内置模块 + 本机已装的 CLI 命令。所以「装依赖」= 装 Node + 装几个全局 CLI，不涉及 `npm install`。

---

## 一、总表

| 依赖 | 实测版本 | 位置 / 安装方式 | 用来干什么 | 怎么验证 | 缺失时降级到什么 |
|---|---|---|---|---|---|
| **Node.js** | **v24.14.1** | `C:\Program Files\nodejs\node.exe` | 一切（daemon/CLI/脚本） | `node -v` | 没有替代品：**硬依赖**，daemon 与所有脚本都起不来 |
| **node:sqlite**（内置） | SQLite **3.51.2** | Node 内置 `require('node:sqlite')` | 唯一状态库 `data/hive.db`（WAL） | `node -e "const{DatabaseSync}=require('node:sqlite');console.log(new DatabaseSync(':memory:').prepare('select sqlite_version() v').get().v)"` | 无。要求 Node ≥ 22.5（本项目按 24 验证） |
| **dsh** | **0.1.5-rc.2** | 全局 npm `@deepseek-ai/dsh`（`C:\Users\elohi\AppData\Roaming\npm\dsh.ps1`） | L4/L5 主力执行器（`dsh --profile headless "<job>"`） | `dsh --version` | 路由降级：L4/L5 任务被判「缺执行器」→ 收到 L2，只出建议不执行 |
| **pi** | **0.84.1** | 全局 npm `@earendil-works/pi-coding-agent` | 另一个进程执行器（`pi -p --mode json`） | `pi --version`（**慢，7.5s**） | 该执行器不可用，任务改投 dsh/llm |
| **codex** | **codex-cli 0.153.4** | 全局 npm `@openai/codex` | 代码类执行器（`codex exec --skip-git-repo-check`） | `codex --version` | 该执行器不可用 |
| **claude** | **2.1.195 (Claude Code)** | 全局 npm `@anthropic-ai/claude-code` | 长文/代码执行器（`claude -p`） | `claude --version` | 该执行器不可用 |
| **agently-cli** | **1.0.11**（最新 1.0.18） | 全局 npm `@tencent-qqmail/agently-cli` | 邮件传感器 + 邮件通知（QQ 邮箱 `elohia@agent.qq.com`） | `agently-cli auth status` | `channel.mail` WARN；`sources.mail` 空转，通知只走 Toast |
| **PowerShell 7（pwsh）** | **7.6.9** | `pwsh` 在 PATH | `shell` 执行器 + 脚本宿主 | `pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'` | `shell` 执行器不可用（不影响其它执行器） |
| **Windows PowerShell 5.1** | **5.1.26100.9711** | `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` | Toast 通知（WinRT 只在这代好使） | `powershell.exe -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'` | 通知静默失败（`notify` fail-soft），其余功能正常 |
| **tar（bsdtar）** | **bsdtar 3.8.9 / libarchive 3.8.9** | `C:\Windows\system32\tar.exe`（Win10+ 自带） | `scripts/backup.mjs` 打 zip、`restore.mjs` 解包 | `tar --version` | 备份自动可改走 `--format dbgz`（纯 `node:zlib`），但**恢复 zip 仍需 tar** |
| **git** | **2.55.0.windows.3** | `D:\Program Files\Git\bin\git.exe` | `sources.git` 传感器（读仓库状态/未推送） | `git --version` | git 传感器空转，其余不受影响 |
| **Docker** | **无**（`docker` 命令不存在） | — | 不需要 | `docker --version` → 报「未识别」 | 本项目**刻意不依赖 Docker**（见 AGENTS.md 已否定项） |
| **WSL** | Ubuntu，**Stopped** | `wsl --list --verbose` | 不需要 | — | 与 HIVE 无关，仅记录本机事实 |

---

## 二、Node 版本门槛（为什么是 24）

| 能力 | 首次出现 | 用在哪 |
|---|---|---|
| `require('node:sqlite')` / `DatabaseSync` | Node 22.5（实验性） | `src/core/db.mjs` 全部持久化 |
| `fs.cpSync` | 16.7 | `backup.mjs` 打包 runs |
| `fs.statfsSync` | 18.15 | `healthcheck.mjs` 查磁盘余量 |
| `Crypto.hash` / `fetch` 等 | — | 未强依赖 |

**实测告警**：`node:sqlite` 每次启动会打一行

```
(node:37268) ExperimentalWarning: SQLite is an experimental feature and might change at any time
```

两种抑制法（都在本仓库用过）：

1. 命令行 `--no-warnings`（推荐，计划任务里也这么写）；
2. 进程内覆写 `process.emitWarning`，只吞掉这一条（见 `scripts/hive.mjs` 顶部、`scripts/healthcheck.mjs` 顶部）。
   —— 这样即使别人忘了加 `--no-warnings`，输出也不会被警告污染。

**性能提醒**：`node:sqlite` 是**同步 API**，会阻塞事件循环。本项目单库、写入量小（实测 `VACUUM INTO` 全库快照 53 ms），可以接受；
但**不要在 HTTP 请求处理里做全表扫描**。

---

## 三、各依赖的「怎么验证」清单（可直接粘）

```powershell
node -v                                  # v24.14.1
node -e "const{DatabaseSync}=require('node:sqlite');console.log('sqlite', new DatabaseSync(':memory:').prepare('select sqlite_version() v').get().v)" --no-warnings
dsh --version                            # 0.1.5-rc.2
pi --version                             # 0.84.1（7.5s，别串行跑）
codex --version                          # codex-cli 0.153.4
claude --version                         # 2.1.195 (Claude Code)
agently-cli auth status                  # {"logged_in":true,...}
pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'
powershell.exe -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'   # 5.1.26100.9711
tar --version                            # bsdtar 3.8.9
git --version                            # git version 2.55.0.windows.3
```

**一次跑完（推荐）**：

```powershell
node --no-warnings scripts/healthcheck.mjs            # 全探测，实测 8.1s（探测项多时会 11–13s；pi 的 --version 独占 7.5s）
node --no-warnings scripts/healthcheck.mjs --fast     # 只查命令在不在，实测 2.7s
node --no-warnings scripts/hive.mjs doctor            # 项目自检（DB/凭据/执行器/通道/预算/守护进程）
```

执行器层自己也有契约探测：`src/executors/index.mjs → probe()`（返回 `{name:{ok,version|reason}}`，并附带 node/pwsh 运行时版本），
`healthcheck.mjs` 会优先用它；模块缺失时自动降级为「独立命令探测」，**不会崩**。

---

## 四、agently-cli 的关键约束（实测）

```json
{
  "aliases": [{ "email": "elohia@agent.qq.com", "is_primary": true }],
  "scopes": ["alias:read", "mail:delete", "mail:read", "mail:send"],
  "rate_limits": { "daily_send_quota": 50, "requests_per_hour": 200, "requests_per_minute": 10 },
  "constraints": { "max_attachment_count": 50, "max_attachment_size_bytes": "20971520" }
}
```

- **两阶段确认**：`message +send` 首次调用只返回 `confirmation_required:true` + `confirmation_token`（实测 `ctk_...`），
  **不发信**；必须再带 `--confirmation-token` 才真发。HIVE 的 `notify.mail()` 故意停在第 1 阶段并回传 `ctk`。
- **凭据**：`storage: Windows DPAPI`，`expires_at` 实测只有 **1 小时**有效期（`refresh_at` 前一小时），
  过期后 `auth status` 会显示 `token_status` 非 valid → 需要 `agently-cli auth refresh`。
  **DPAPI 绑定用户与机器，迁移到新机必须重新 `agently-cli auth login`。**
- 版本落后（1.0.11 vs 1.0.18）：升级是 `npm i -g @tencent-qqmail/agently-cli`。**升级前先确认两阶段确认的 JSON 结构没变**。

---

## 五、缺失时的整体降级矩阵

| 缺什么 | daemon 能起吗 | 感知 | 判定 | 执行 | 通知 | 看板 |
|---|---|---|---|---|---|---|
| Node | ✗ 完全不能 | — | — | — | — | — |
| node:sqlite（Node 太老） | ✗ 启动即失败 | — | — | — | — | — |
| dsh | ✓ | ✓ | ✓（L4/L5 降到 L2） | 只能用 pi/codex/claude/llm/shell | ✓ | ✓ |
| pi / codex / claude | ✓ | ✓ | ✓（该执行器不参与路由） | 其余执行器照常 | ✓ | ✓ |
| agently-cli | ✓ | mail 源空转 | ✓ | ✓ | 只 Toast | ✓ |
| git | ✓ | git 源空转 | ✓ | ✓ | ✓ | ✓ |
| tar | ✓ | ✓ | ✓ | ✓ | ✓ | ✓（备份需 `--format dbgz`，恢复 zip 不可用） |
| powershell.exe(5.1) | ✓ | ✓ | ✓ | ✓ | Toast 静默失败 | ✓ |
| pwsh 7 | ✓ | ✓ | ✓ | `shell` 执行器不可用 | ✓ | ✓ |

**结论**：只有 Node（含 node:sqlite）是硬依赖；其余全是「少一个能力」，系统会降级而不是停摆。
这正是 AGENTS.md 铁律 2「零外部依赖」想买到的性质。

---

## 六、升级与回滚

```powershell
# 升级某个 CLI（以 agently-cli 为例）
npm i -g @tencent-qqmail/agently-cli
agently-cli auth status                      # 确认仍 logged_in
node --no-warnings scripts/healthcheck.mjs   # 确认 channel.mail 仍 PASS

# 升级 Node（大版本）
#  · 先备份（node scripts\backup.mjs），因为 node:sqlite 的存储格式随 SQLite 版本演进
#  · 再升级，然后 node --no-warnings scripts/healthcheck.mjs --strict 全绿才算过
```

**回滚**：CLI 回滚用 `npm i -g <pkg>@<旧版本>`；数据回滚用 `node scripts\restore.mjs --from <备份> --yes`（详见 docs/05）。

---

## 七、本文「没验证」的部分（诚实标注）

- **未在其它 Windows 版本/其它机器上验证**：本表只反映这一台（`ELOHIA\elohi`，Windows 11 build 26100 的 `powershell.exe`）。
- **未验证 Node 22.x / 23.x 是否真的能跑**：代码按 24 写，低版本可能因 `node:sqlite` 行为差异（如 `DatabaseSync` 选项）失败。
- **未验证 agently-cli 1.0.18**：本机是 1.0.11；两阶段确认的字段名可能已变。
- **未加压测试**：并发 2 个 worker 的稳定性只做了功能验证，没做长时间压测。
