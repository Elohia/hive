# 安装 · 卸载 · 升级

> 结论先行：装它只需要**一条安装动作**（把包挂进 profile 的 bundles），剩下的开箱、建库、
> 种脉冲、起引擎、挂看板，全部由插件自己完成。你不需要预装 HIVE，也不需要 API key。

---

## 0. 前置条件

| 项 | 要求 | 怎么确认 |
|---|---|---|
| DSH | 任意提供 `webServer` + `llm` + `tools` 三个服务的 profile（`web` 是常规选择） | 能打开 Web GUI 即为 `web` profile 可用 |
| Node | ≥ 22.5（`node:sqlite` 自 22.5 起是内置模块） | `node -v` |
| 模型 | DSH 里已选好一个 provider/model（默认 `agentDefaultModel`，否则回退到第一个 provider 的 flash/chat/pro 模型） | 会话里能正常对话即已配置 |
| 磁盘 | 约 1 MB（包本体 ~520 KB + 首次开箱的 SQLite 库） | — |
| 权限 | 能写 `$DSH_HOME/profiles/<name>/`（安装）与 `$DSH_HOME/hive/`（运行） | — |

`$DSH_HOME` 默认是 `~/.dsh`；本机是 `F:\dsh-home`（由环境变量 `DSH_HOME` 指定）。
下文命令里的 `web` 指 profile 名，按你的实际 profile 替换。

---

## 1. 安装

插件的挂载条件是**两条同时满足**：

1. 包出现在 profile 的依赖里（`pnpm add`，记录在 `profiles/<name>/package.json` 的 `dependencies`）；
2. 包名出现在同一个 `package.json` 的 `dsh.profile.bundles` 列表里（否则依赖装了也不挂载）。

`plugin_manager` 的 `install_bundle` 会替你做完这两步。

### 路径 A：本机目录（推荐给你自己的机器）

```js
plugin_manager({
  action: "install_bundle",
  target: "link:D:\\hive\\dsh-plugin-hive",   // 指向插件目录（含 package.json 的那一层）
})
```

- `install_bundle` 在 profile 目录里执行 `pnpm add <spec>`，并把包加进 `dsh.profile.bundles`。
- 若返回体里带 `nextStep`（例如要求重启或刷新），按它做。
- 用 `link:` 的收益：改代码后不用重装，重启/刷新即生效；代价是它指向你本机的绝对路径，不能分享给别人。

**命令行等价**（不经过 Agent 时）：

```powershell
dsh plugin --profile web add link:D:/hive/dsh-plugin-hive
# 之后确认 bundles：
#   profiles/web/package.json → dsh.profile.bundles 里要有 "dsh-plugin-hive"
# 没有就补上：plugin_manager({ action: "set_bundle", target: "dsh-plugin-hive", enabled: true })
```

### 路径 B：GitHub / npm（发布之后）

```js
plugin_manager({ action: "install_bundle", target: "github:Elohia/dsh-plugin-hive" })
// 或：{ action: "install_bundle", target: "dsh-plugin-hive@0.1.0" }
```

```powershell
dsh plugin --profile web add github:Elohia/dsh-plugin-hive
```

> ⚠ **本机这份仓库还没有 git remote**，上面两个 spec 在你把仓库推到 GitHub / 发包到 npm 之前都不可用。
> 发布前的唯一路径是 A。

### 安装完会发生什么（顺序固定）

| 步骤 | 产物 | 失败时 |
|---|---|---|
| 1 | 建目录 `$DSH_HOME/hive/` 与 `config/`、`data/{runs,artifacts,logs,work,calendar}` | 目录不可写 → 报错并停在这一步 |
| 2 | 从 `runtime/config-defaults/` 拷 `hive.json`、`policies.json`；把 `home` 改成实际路径，凭据路径不存在的置空 | 配置解析失败 → 用原样文本写盘（不阻断） |
| 3 | 导入 `runtime/src/core/db.mjs` → 建表（items/tasks/runs/approvals/events/pulses/context_facts/artifacts/cursors/kv） | `node:sqlite` 不可用 → 自检里 sqlite=FAIL |
| 4 | 用 `ctx.llm` 注入模型传输层并探测一次（`回复 OK`，8 token） | 探测失败 → 自检 llm=FAIL，其余功能仍在 |
| 5 | 启动引擎：`seedPulses()` + `recover()` + 3s 循环 | 引擎异常 → 自检 engine=WARN，可点「启动」重试 |
| 6 | 注册 webServer 路由 `/hive`（prefix），同源可嵌入 | 路由失败 → 看板打不开，状态里 `routeReady=false` |
| 7 | 注册 4 个 Agent 工具 | 工具注册失败只 warn，不影响看板 |

---

## 2. 安装后 30 秒验证

1. **左侧栏**出现六边形 **HIVE** 图标 → 点开，主区应看到 48px 控制条 + 看板首屏（收件箱）。
2. 控制条最左边的圆点是状态（正常 / 降级 / 异常 / 未初始化），旁边的计数是「待办 · 待拍板 · 在跑」。
3. 直接打接口（把端口换成你 GUI 的端口）：

```powershell
curl http://127.0.0.1:<DSH Web 端口>/hive/api/plugin/status
```

本机真实安装后的响应（原样摘录，供对照）：

```json
{"ok":true,"mode":"plugin","phase":"ready","home":"F:\\dsh-home\\hive",
 "dbPath":"F:\\dsh-home\\hive\\data\\hive.db",
 "engine":{"running":true,"ticks":60,"tickSec":3,"pulseTimeoutSec":240,
           "db":{"items":28,"tasks":0}},
 "model":{"ready":true,"current":"deepseek-official/deepseek-flash","error":null},
 "created":["config/hive.json","config/policies.json"]}
```

4. 看板第 9 页签「自检」应给出总体结论 PASS/WARN/FAIL，以及逐项明细。
   本机首跑是 `WARN（13 PASS / 2 WARN / 0 FAIL，15 项 = 9 核心 + 6 依赖）`，两个 WARN 分别是
   `proc` 执行器（需显式配 command）与「守护进程未运行」（插件模式下引擎在 DSH 进程内，
   不写独立 daemon 的 `data/hive.lock` —— 见 §6 FAQ）。

> 注意：看板挂在宿主 webServer 上，端口就是 **GUI 那个端口**（不是独立版的 8787）。

**还没装就想先确认它健康？** 在插件目录里跑两侧自测（用临时目录，不碰你的 DSH 和数据）：

```powershell
node --no-warnings scripts/selftest-host.mjs     # Host 半，19 项
node --no-warnings scripts/check-client.mjs      # 浏览器半，70 项
```

---

## 3. 卸载

**A. 用工具（推荐）**

```js
plugin_manager({ action: "remove_bundle", target: "dsh-plugin-hive" })
// 用 link: 装的就先换成实际的依赖名再移除；移除后刷新页面，左侧栏图标消失
```

**B. 手工**

```powershell
dsh plugin --profile web remove dsh-plugin-hive
# 再从 profiles/web/package.json 的 dsh.profile.bundles 里删掉 "dsh-plugin-hive"
```

卸载做的事：引擎 `stop()`、路由与工具随 `ctx.effect` 归还、模型传输层置空、`globalThis.__HIVE_PLUGIN__` 清理
（自测里 `dispose.clean` 逐条验证过）。

**数据不会自动删**：`$DSH_HOME/hive/` 保留。要清空就删掉这个目录（库、runs、artifacts 全在里面）。

---

## 4. 升级与降级

**A. 面板里点（装好之后最省事）**

控制条 →「版本」抽屉：显示当前版本、检查更新（读 GitHub Releases `Elohia/dsh-plugin-hive`）、
更新 / 降级 / 卸载。原则是**只给按钮，永不自动改**；拿不到版本源时如实说「读不到」，不编版本号。

- 落地动作走宿主 `ctx.pluginManager`（与 `dsh plugin add` 同一条路径，不自造包管理）。
- 宿主没提供 `pluginManager` → 显示「宿主没有提供 pluginManager」，需要按下面的手工路径做。
- `link:` 本地目录安装 → 会提示「升级/降级需要改成从 GitHub 或 registry 装，或用自定义 spec 覆盖」。

**B. 手工**

| 安装方式 | 升级动作 |
|---|---|
| `link:` 本机目录 | `git pull`（或改完代码）→ 重启 DSH / 刷新页面。客户端 bundle 需要重载，必要时重启宿主 |
| `github:` | 重跑一次 `install_bundle`（同一 target），或 `dsh plugin --profile web update dsh-plugin-hive` |
| npm | `install_bundle` 传新版本号，如 `dsh-plugin-hive@0.2.0` |
| 降级 | `install_bundle` 传入精确版本 / `github:Elohia/dsh-plugin-hive#v0.0.9`（或在「版本」抽屉里点降级） |

升级不迁移数据：表结构变更加在 `runtime/src/core/db.mjs` 的 `CREATE TABLE IF NOT EXISTS` / 兼容分支里，
已有库照常打开。**降级前请先备份** `$DSH_HOME/hive/data/hive.db`。

维护者另有一条：改了独立版 `D:\hive` 的 `src/` / `web/` / `config/` 后，必须重跑
`node scripts/sync-runtime.mjs` 把改动同步进 `runtime/`，否则插件里跑的还是旧的运行时。

---

## 5. 换机器 / 迁移

1. 新机器上装 DSH 并配好模型。
2. 装插件（路径 A 或 B）。
3. 想要历史数据：停掉插件 → 拷 `$DSH_HOME/hive/`（至少 `data/hive.db`）过去 → 重启。
4. **必改**：`$DSH_HOME/hive/config/policies.json` 里的 `write_allowlist_dirs`、`never_touch`，
   以及 `hive.json` 里 `sources.*.repos` / `roots` / `icsPaths` —— 默认值是作者机器的 `D:\…` / `F:\…`。
   不改的后果：红线与白名单指向不存在的路径（白名单为空则「允许写任何地方」除外见下）。

> 安全提示：`policies.write_allowlist_dirs` 若被清空（`[]`），代码逻辑是「不做白名单限制」，
> 只保留 `never_touch` 拦截。换机器时建议显式写成你自己的可写目录。

---

## 6. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 左侧栏没有 HIVE 图标 | 包只在依赖里、没在 `dsh.profile.bundles`；或客户端 bundle 没重载 | 检查 profile `package.json` 的 bundles；重启 DSH |
| 自动任务页签说「守护进程未运行」，但控制条状态是正常 | 该 KPI 看的是独立版 daemon 的锁文件 `data/hive.lock`，插件把引擎跑在 DSH 进程内、不写这个锁 | **以控制条状态点为准**；自检里那条 `daemon=WARN` 也是这个原因，属预期 |
| 面板显示「HIVE 还没接上」 | Host 半没就绪（phase=error/uninit） | 展开引导卡；或看 `/hive/api/plugin/status` 的 `error` |
| 控制条状态 = 异常，自检 llm=FAIL | DSH 里没选模型 / 模型不可用 | 在 DSH 设置里选一个模型，然后点「刷新」 |
| 自检 sqlite=FAIL | Node < 22.5 或 Node 未带 `node:sqlite` | 升级 Node（插件不会替你装 Node） |
| 看板 404 | 路由未注册（启动失败在 6 步之前） | 看宿主日志里 `[hive]` 开头的行 |
| 「今日花费」永远是 ¥0.00 | **插件模式的设计**：模型走宿主，HIVE 不计费 | 真实花费看 DSH 侧用量；详见 README「已知限制」1 |
| 没有 Toast 弹窗 | 非 Windows，或系统 PowerShell 5.1 不可用 | 信息仍在看板事件与 Outbox；不影响流程 |
| 执行器页 `codex` 不可用（402）/ `claude` 不可用（401） | 上游余额 / 凭据失效（本机实测现象） | 不用管：L4/L5 默认走 `dsh`；或修好对应 CLI |
| 「Agent 依赖」「版本」抽屉显示「接口未就绪」/「宿主没有提供 pluginManager」 | 依赖列表走 `/hive/api/deps`（运行时需已同步），落地动作走宿主 `ctx.pluginManager` | 先 `node scripts/sync-runtime.mjs` 同步运行时；宿主版本不支持插件管理时只能手工 `dsh plugin add/remove` |
| 独立版 `hive` 命令和插件同时在跑 | 两个引擎写同一张库会互相抢派单 | 只留一个：插件模式下停掉独立 daemon |

---

## 7. 与独立版 HIVE 的关系

| | 独立版（`D:\hive`） | 插件版（本包） |
|---|---|---|
| 启动方式 | `node scripts/hive.mjs daemon` + CLI | 随 DSH 进程启动，插件内引擎 |
| 模型 | 自配 `config/credentials.file` 里的 key | 借宿主 `ctx.llm`，零 key |
| 看板 | `http://127.0.0.1:8787`（独立端口，`X-Frame-Options: DENY`） | 宿主端口下的 `/hive/`（同源，`SAMEORIGIN` 可嵌） |
| 数据 | `D:\hive\data\hive.db` | `$DSH_HOME/hive/data/hive.db` |
| 运行时 | `src/`（源码） | `runtime/src/`（同步副本） |

两者**代码同源、表结构同构、语义等价**，但数据目录互不相通，可以并存；唯一禁止的是同名 `HIVE_HOME` 下同时跑两个引擎。

---

## 8. 本文的验证边界

| 结论 | 来源 |
|---|---|
| 开箱 7 步、19 项自测、`/hive` 前缀注册、SAMEORIGIN、4 个工具、卸载干净 | **本机实测**（`scripts/selftest-host.mjs`，19/19） |
| 左侧栏槽位/图标/样式作用域/接口契约/依赖与版本 UI/不白屏、卸载后无遗留定时器 | **本机实测**（`scripts/check-client.mjs`，70/70） |
| 独立看板可单跑（`/api/health` 200、`/` 200） | **本机实测** |
| 路径 A 的 `link:` 安装真实生效 | **本机实测**：desktop profile 里就是 `"dsh-plugin-hive": "link:D:/hive/dsh-plugin-hive"` 且已在 bundles |
| 安装后的接口链路 | **本机实测（只读探针）**：`/plugin/status` 200（phase=ready、引擎 running、28 条事项、12 脉冲）、`/plugin/doctor` 5/5 PASS、`/hive/` 200（14522 B、9 页签、SAMEORIGIN）、`/api/setup/doctor` WARN(13/2/0)、`/api/deps` 200（6/6 就绪）、`/api/agents` 6/7 可用、`/api/plugin/version` 200、`/api/autopilots` 12 条、`/api/cost` 200 |
| 路径 B（`github:` / npm） | **未验证**：仓库尚未发布（本机无 remote），因此这两条 spec 当前不可用 |
| 版本抽屉的「点升级/降级」落地动作 | 代码 + 桩测试覆盖 UI 与降级文案；**真机未点过**（真机上 `latest=null`，因为仓库未发布） |
| GUI 逐屏外观（图标长什么样、抽屉动画） | **未记录**（无截图）；接口与自测层面已验证 |
| GitHub Actions 的 CI | **未在 GitHub 上跑过**（scaffold，首次推送后按实际调整） |
