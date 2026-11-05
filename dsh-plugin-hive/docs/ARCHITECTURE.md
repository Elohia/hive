# 架构（简版）

> 三个部件、一条数据流、一条边界。看完你应该能回答：它是怎么起来的、为什么不用 API key、
> 数据在哪、和独立版 HIVE 是什么关系。

---

## 1. 三个部件

```
┌──────────────────────────── DSH 宿主（已存在）────────────────────────────┐
│  webServer（回环 HTTP）        llm（已配 provider/model）      tools（Agent 工具表）│
└───────▲────────────────────────────▲──────────────────────────────▲───────┘
        │ register({prefix:'/hive'}) │ stream(...)                  │ register(def)
┌───────┴────────────────────────────┴──────────────────────────────┴───────┐
│ Host 半  index.js                                                         │
│   开箱 provision → 建库 → setTransport(ctx.llm) → 引擎 start → 路由 → 工具  │
│   engine.mjs：3s 一拍（脉冲 / 看门狗 / 派单 / 心跳）                        │
│   version.mjs：版本查/装/升/降/卸（走宿主 ctx.pluginManager，只给按钮）      │
├───────────────────────────────────────────────────────────────────────────┤
│ 内置运行时 runtime/（46 文件 / 约 560 KB / 零 npm 依赖）                     │
│   sensors 6 → items → triage(L1–L5) → router(内联/派单/请示) → worker → runs │
│   server(http/api/sse) · web(9 页签看板) · hitl(notify) · context(profile)   │
└───────────────────────────────────────────────────────────────────────────┘
        ▲ iframe（同源 /hive/）                ▲ fetch /hive/api/*
┌───────┴────────────────────────────────────┴──────────────────────────────┐
│ 浏览器半  client.js                                                        │
│   sidebar.panellist(id=hive) → 左侧栏图标                                   │
│   main(key=hive) → 48px 控制条 + iframe 看板 + 设置抽屉                      │
└───────────────────────────────────────────────────────────────────────────┘
```

三者的耦合点只有三个，且全部由 Cordis 的 `ctx.effect` 注册，随插件卸载归还：
**webServer 路由**、**llm 传输层**、**tools 注册**。

---

## 2. 启动时序（首次激活）

```
apply(ctx)                                    ← DSH 装载插件
 └ ctx.effect(...)
    ├ 1 provision($DSH_HOME/hive)             建 config/ + data/{runs,artifacts,logs,work,calendar}
    │      拷 runtime/config-defaults/*.json → 改写 home、清空不存在的凭据路径
    ├ 2 import runtime/src/core/db.mjs → getDb()   建 10 张表（WAL + foreign_keys）
    ├ 3 import runtime/src/core/llm.mjs → setTransport(makeTransport(ctx))
    │      探测一次「回复 OK」→ modelReady / lastModel
    ├ 4 createEngine({log,onEvent}) → engine.start()
    │      seedPulses()（12 条）+ watchdog.recover() + 3s setInterval
    ├ 5 import runtime/src/server/http.mjs → createHandler({mountPath:'/hive', embeddable:true})
    │      ctx.webServer.register({kind:'prefix', path:'/hive', handler})
    │      handler 先拦截 /hive/api/plugin/* 与 /hive/api/control/*，其余交给 inner
    ├ 6 registerTools(ctx)：hive_status / hive_capture / hive_run / hive_decide
    ├ 7 version.mjs → createVersionManager({ctx, pkgRoot, home}) + scheduleAutoCheck()
    │      只读宿主 pluginManager.listBundles 与 GitHub Releases；装/升/降/卸等用户点
    └ 8 state.phase='ready'
```

任一步失败都不静默：写 `state.error`、进控制台，`/hive/api/plugin/status` 与自检页能看到。
**注意顺序**：模型传输层必须在引擎启动前注入，否则晨报/判定会去走「自配 key」的 HTTP 分支而失败。

---

## 3. 引擎循环（`engine.mjs`）

```js
setInterval(tick, 3000)          // 已 unref()，不阻塞进程退出
tick():
  ① 到期脉冲：pulse.duePulses(now) 逐条跑 handler（scan/triage/watchdog/digest/context/selfcheck）
     · 每条有超时（pulseTimeoutSec，默认 240s）
     · 结果写 pulses.last_status = ok/fail，失败进事件流，不中断其它脉冲
  ② 看门狗：每 20s 一次 watchdog.tick() —— 回收过期租约 / 孤儿任务 / 需要终止的运行
  ③ 派单：queued > 0 且今日花费 ratio < 1 且未在 draining → worker.drainQueue()
     · fire-and-forget（**不 await**）：长任务不会挡住脉冲与看门狗
     · draining 闸保证同一时刻只有一轮 drain
  ④ 心跳：每 5min 发一条 heartbeat 事件（看板能看出「它还活着」）
```

`start()` 里还有一个细节：启动 800ms 后立刻跑第一拍，这样新装完 30 秒内就能看到内容。

---

## 4. 模型传输层：为什么不需要 API key

`runtime/src/core/llm.mjs` 里留了一个可注入的传输层：

```js
let _transport = null
export function setTransport(fn) { _transport = fn }
export async function chat(o) {
  if (_transport) return _transport({ ... })      // ← 插件模式走这里
  ...                                             // ← 独立模式：HTTP 直连 + credentials
}
```

Host 半用 `ctx.llm.stream` 实现它（`index.js` 的 `makeTransport`）：
把 messages 拆成 system + user，转成宿主的内容块格式，逐 chunk 累加 `text-delta`，
读 `usage`，拿到 `finish.reason`，带 AbortController 超时。

**模型怎么挑**：先取 `ctx.agentDefaultModel.currentSelection()`（你在会话里选的那个）；
拿不到就 `ctx.llm.listProviders()` 里优先 `deepseek`，再 `listModels()` 里优先 `flash|chat|pro`。
本机实测解析到 `deepseek/deepseek-chat`。

**代价（诚实说）**：走宿主就看不到计费，`costCny` 记 0、usage 记 0（标记 `viaHost`）。
所以「成本」页在插件模式下恒为 ¥0.00，日预算护栏也不会触发 —— 真实花费在 DSH 侧。

---

## 5. `runtime/` 与独立版 daemon 的关系

| | 独立版（源码仓库根目录） | 插件（本包） |
|---|---|---|
| 代码 | `src/` `web/` `prompts/` `config/` | `runtime/` = 上述目录的**拷贝** |
| 同步方式 | 权威源 | `node scripts/sync-runtime.mjs`（清空 `runtime/` 后整目录拷贝） |
| 驱动 | `scripts/hive.mjs daemon`：自己的 while 循环 + CLI 命令 + 端口 8787 | `engine.mjs`：进程内 setInterval + 宿主 `webServer` 前缀路由 |
| 版本管理 | 手动 `git pull` / 重装 | `version.mjs`：读 GitHub Releases + 走宿主 `ctx.pluginManager` 落地（只给按钮） |
| 模型 | `config/llm.json` 里的 provider + `credentials.file` | 宿主 `ctx.llm`（零 key） |
| 数据 | `<repo>/data/hive.db` | `$DSH_HOME/hive/data/hive.db` |
| 看板安全头 | `X-Frame-Options: DENY`（默认 `embeddable=false`） | `SAMEORIGIN` + `CSP frame-ancestors 'self'`（`embeddable=true`） |

**为什么两套驱动**：独立 daemon 的循环和命令行参数解析绑在一起，插件要的是「进程内、可 start/stop、
可观测、能被宿主卸载」。所以两边共用同一个 runtime 与同一套表，只换驱动方式 —— 语义等价，不是两套实现。

**为什么不共享数据**：两个引擎指向同一个 `HIVE_HOME` 时没有跨进程协调（租约、watchdog、drain 都会互抢），
所以设计上各用各的数据目录；想沿用历史数据就把库拷过去（见 docs/INSTALL.md §5）。

---

## 6. 生命周期与卸载

- 所有资源注册都包在 `ctx.effect()` 里，返回值是 disposer。
- 卸载时的顺序：`state.routeReady=false` → 异步 `engine.stop()` → `setTransport(null)` →
  清 `globalThis.__HIVE_PLUGIN__` / `__HIVE_MODE__` → 打印「已卸载」。
- Cordis 的 disposer 按同步释放处理，所以停引擎是 `Promise.resolve().then(...)` 里发起的，
  不阻塞卸载（自测的 `dispose.clean` 断言 global 已被清理）。

---

## 7. 安全边界（四层，都不是提示词）

1. **网络**：只绑回环（`server.host=127.0.0.1`）；看板挂在宿主同源前缀下，`X-Frame-Options` + CSP 只允许宿主嵌；
   `server.token` 非空时校验 `X-Hive-Token`。
2. **写盘**：`policies.write_allowlist_dirs` 白名单 + `never_touch` 红线（`core/guard.mjs`，写入前抛错）；
   派发前还会用 `checkGoalAgainstRedlines` 拦一次。
3. **动作**：L1–L5 判定 + `side_effect_actions`（发信/发布/删除/花钱/部署）强制进 Outbox；
   执行器白名单（`shell` 不能接自然语言）。
4. **成本与频率**：单任务 token/时长预算、每日预算、每日推送上限、事项保留天数。

---

## 8. 失败与降级策略

| 场景 | 行为 |
|---|---|
| 某个传感器抛错 | 只隔离它自己（`scanAll` 逐个 try），其余照跑 |
| 脉冲失败 | `last_status=fail` + 事件 + 下个周期再试，不炸主循环 |
| 执行器不可用 | `probe()` 标红，Router 降级到别的执行器或内联 |
| 模型不可用 | 自检 llm=FAIL；L1/L2 内联失败会带错误返回，不伪造结论 |
| 看板接口挂了 | iframe 仍在，客户端叠引导卡；插件自有的 `/plugin/*` 作为更可靠的第三级 |
| 宿主没给 webServer/llm/tools | `inject` 里声明为硬依赖，依赖缺失时插件不会被装载（不会半死不活） |

---

## 9. 扩展点

| 想加什么 | 怎么做 | 契约 |
|---|---|---|
| 新传感器 | `runtime/src/sensors/` 加模块并在 `index.mjs` 的 `SENSORS` 注册 | `export default { name, title, enabled(cfg), async *scan(ctx) }`，yield `{source, source_ref, title, body, ts, kind_hint, domain_hint, urgency_hint, meta}` |
| 新执行器 | `runtime/src/executors/` 加模块并在 `index.mjs` 的 `EXECUTORS` 注册 | `{ name, kind, available(ctx), run(ctx) }`，`run` 绝不抛，异常折成 `{ok:false,error}` |
| 改判级规则 | 改 `$DSH_HOME/hive/config/policies.json`（`actions` / `modifiers` / `promotions` / `kind_defaults`） | 不改代码 |
| 改巡检节奏 | 改 `hive.json` 的 `sources.<name>.intervalSec`，重启后 `seedPulses()` 会更新脉冲 | 不改代码 |
| 改红线 | 改 `policies.json` 的 `never_touch` / `write_allowlist_dirs` | 注意：白名单为空 = 不做该项限制 |

---

## 10. 已知技术债

1. 插件模式不记录 token/成本，预算护栏形同虚设（见 §4）。
2. 插件引擎不写独立版 daemon 的锁文件（`data/hive.lock`），所以看板「自动任务」页签的「守护进程」KPI
   与自检的 `daemon` 项会显示未运行 —— 状态源不统一（一处看锁文件，一处看 `/plugin/status`）。
3. 同一 `HIVE_HOME` 无双引擎互斥保护（靠文档约束）。
4. Windows Toast 依赖系统 PowerShell 5.1；其它平台只有看板通道。
5. `runtime/` 是拷贝，源码改动需要人工 `sync-runtime.mjs`；没有 CI 校验「runtime 与源码一致」——
   不同步时看板页签、`/api/deps`、`/api/setup/*` 都会落后一个版本（客户端已做「接口未就绪」降级）。
6. 版本/依赖的落地动作依赖宿主服务 `ctx.pluginManager`。它在 `inject` 之外（可选），
   宿主不提供时只能看版本、不能在本进程内装/升/卸。
7. 版本检查访问 `api.github.com`（公开仓库无需 token，但有速率上限）；离线时如实报错。
8. `inject` 只有 `webServer / llm / tools`；`ctx.agentDefaultModel`、`ctx.pluginManager` 都是可选读取，
   缺了有兜底或降级 —— 代价是「同版本插件在不同宿主上能力不同」。
