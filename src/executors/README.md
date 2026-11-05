# src/executors — HIVE 执行器层

上层（router / worker / server）**只认** `index.mjs` 的三个函数，换执行器不改上层。

```js
import { list, get, probe, run } from './src/executors/index.mjs';

await probe();                                   // {name:{ok,reason,version}}，含 node/pwsh 运行时
run('dsh', { prompt, workdir, timeoutSec, budgetTokens, onSpawn, onLog })  // → Result
```

## 契约（docs/01-ARCHITECTURE.md §6.2）

```js
export default {
  name: 'dsh',
  kind: 'process' | 'inline',
  async available(cfg) -> { ok, reason?, version? },
  async run({ task, prompt, workdir, timeoutSec, budgetTokens, onSpawn, onLog }) -> {
    ok, exitCode, stdout, stderr, tokens: {in, out}, costCny, artifacts: [], result
  }
}
```

`run()` **不抛异常**：未知执行器 / 参数缺失 / 内部 bug 一律折成 `{ok:false, error}` 返回。
附加字段（不破坏契约，便于落 `runs` 表）：`text, error, ms, pid, cmdline, timedOut, killed, truncated, treeKill, degraded, attempts, via`。

## 文件

| 文件 | 作用 |
|---|---|
| `index.mjs` | 注册表 `list/get/names/probe/run`；`proc` 是通用兜底（未配 `executors.proc.command` 时 `enabled:false`，避免 router 乱选） |
| `proc.mjs` | 子进程基座：命令解析、spawn、超时 **kill 整棵进程树**、行级 `onLog`、输出上限、`probeVersion` |
| `agent.mjs` | CLI Agent 公共基座（`createCliExecutor`）+ JSONL/usage 嗅探工具 |
| `llm.mjs` | 纯 LLM（走 `src/core/llm.mjs` 的 `chat`），支持 `json:true` 结构化输出 |
| `dsh.mjs` / `pi.mjs` / `codex.mjs` / `claude.mjs` | 四个 CLI Agent 执行器 |
| `shell.mjs` | `pwsh -NoProfile -Command`，自动注入 UTF-8 输出编码前缀 |

## 本机实测（2026-11-05）

| 执行器 | 命令 | 版本 | 真跑结果 |
|---|---|---|---|
| node | `node -v` | v24.14.1 | ok |
| pwsh | `$PSVersionTable.PSVersion` | 7.6.9 | ok |
| dsh | `dsh --profile headless "<p>"` | 0.1.5-rc.2 | ok，冷启动 21.7–53s（首次 53s，之后 22–37s），stdout 只输出最终答案 |
| pi | `pi -p --mode json "<p>"` | 0.84.1 | ok，**需降级**（见坑 2），12s |
| codex | `codex exec --skip-git-repo-check "<p>"` | codex-cli 0.153.4 | **阻塞**：上游 402 余额不足（见坑 3） |
| claude | `claude -p "<p>"` | 2.1.195 | **阻塞**：401 认证失败（见坑 4） |
| shell | `pwsh -NoProfile -Command` | 7.6.9 | ok，3s |
| llm | DeepSeek `deepseek-chat` | — | ok，~1s，¥0.0002/次 |

## 本机坑（踩过，别再踩）

1. **npm 全局 CLI 只有 `.cmd` 壳，Node `spawn` 直接 EINVAL。**
   `proc.mjs` 读 `.cmd` 里的 `%dp0%\...` 目标：`.js` → `node <js>`，`.exe` → 直接跑。不经 shell，引号/换行安全。
2. **`pi` 在本机会被扩展 `F:\pi-agent\extensions\pi-wechat-workbuddy` 打挂**（缺 `qrcode-terminal`，exit 1）。
   `pi.mjs` 内置降级：检测到 `Failed to load extension` 自动加 `--no-extensions` 重试，结果里带 `degraded` 标记。
3. **`codex` 的 provider 指向 `api.xiaomimimo.com`，账户余额不足 → 402**，会重试 5 次后才报错。
   执行器如实返回 `ok:false`，`error` 里带 `codex 上游账户问题：…`。
4. **`claude` 的 `~/.claude/settings.json` 里 `ANTHROPIC_AUTH_TOKEN` 已失效 → 401**，且 Claude Code 自己重试
   约 197s 才吐错。默认超时下表现为"超时"。想看到真实错误：`HIVE_CLAUDE_TIMEOUT=240 npm test`。
5. **pwsh 输出中文会按控制台代码页 936 编码 → UTF-8 解码乱码。** `shell.mjs` 在脚本前注入
   `[Console]::OutputEncoding=[Text.Encoding]::UTF8` 修正（`ctx.utf8=false` 可关）。
6. **`WindowsApps\...\pwsh.exe` 是 App Execution Alias，`fs.statSync` 抛 EACCES。**
   `which()` 必须退回 `lstatSync` 才能认出它。
7. **probe 首次全量约 10–17s**（每个 CLI 要起一次 node），已加 10 分钟缓存；health 接口别每 tick 全量探。
8. **杀进程树只能靠 `taskkill /PID <pid> /T /F`**（agent CLI 都会再起子进程）；POSIX 走 `detached` + `kill(-pgid)`。

## 成本口径

- `llm`：`core/llm.mjs` 按配置里的 `pricing`（元/百万 token）算，可靠。
- `pi`：上报 USD，按 `config.llm.costUsdToCny`（默认 7.1）折算，**估算**，记在 `result.meta.cost_note`。
- `dsh` / `codex` / `claude`：CLI 不吐 usage → `tokens` 记 0，`meta.usage_unknown=true`。**不编造数字**。

## 测试

```bash
node --no-warnings tests/exec-smoke.mjs          # 默认：注册表/probe/proc/shell/llm/pi/claude/codex 全部真跑
node --no-warnings tests/exec-smoke.mjs --slow   # 额外真跑 dsh --profile headless（冷启动 ~55s）
```

- `PASS` = 断言成立；`FAIL` = 真失败；`SKIP` = 外部阻塞（上游 402 / CLI 无响应），此时断言的是"执行器如实上报失败"，不算通过。
- 实测（2026-11-05 最终版）：
  - `node --no-warnings tests/exec-smoke.mjs` → **50 PASS / 0 FAIL / 3 SKIP**（208.4s）
  - `node --no-warnings tests/exec-smoke.mjs --slow` → **53 PASS / 0 FAIL / 2 SKIP**（207.1s，dsh 真跑 21.7s 回 `HIVE_DSH_OK`）
