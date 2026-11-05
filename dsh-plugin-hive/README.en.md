# HIVE · DSH plugin

**What it is.** HIVE is a resident "proactive service" agent that lives inside DeepSeek Harness (DSH).
It inspects your machine on its own (mail, git, docs, calendars, existing local automations, self-check),
turns what it finds into an Inbox, decides per item how far it may act on its own (autonomy levels L1–L5),
and pushes only genuine decisions to an Outbox. As a DSH plugin it adds a **left-sidebar entry** that opens
a full task-center dashboard.

| | |
|---|---|
| Version | 0.1.0 |
| License | MIT |
| Requires | DSH profile with `webServer` + `llm` + `tools` · Node ≥ 22.5 (`node:sqlite` is built in) |
| npm dependencies | **none** — Node built-ins only; dashboard has zero CDN |
| Data | `$DSH_HOME/hive/` (single local SQLite database) |
| Verified locally | host half **19/19 PASS** · client half **68/68 PASS** · standalone dashboard `/api/health` 200 |

---

## Install (two paths)

Plugins follow DSH's own mechanism: `pnpm add` inside the profile **and** the package listed in
`dsh.profile.bundles`. Use one path, not both.

**A. Local directory (developer / self-hosted; recommended today)**

```js
plugin_manager({ action: "install_bundle", target: "link:D:\\hive\\dsh-plugin-hive" })
// CLI equivalent: dsh plugin --profile web add link:D:/hive/dsh-plugin-hive
```

`add` alone only installs the dependency — also make sure `dsh-plugin-hive` is listed in that profile's
`dsh.profile.bundles` (via `plugin_manager` `set_bundle` or by editing `package.json`), or it will not mount.

**B. GitHub / npm (after publishing)**

```js
plugin_manager({ action: "install_bundle", target: "github:Elohia/dsh-plugin-hive" })
// or: target: "dsh-plugin-hive@0.1.0"
```

> This checkout has no git remote yet, so `github:Elohia/dsh-plugin-hive` and the npm name **do not
> resolve until you publish**. Path A is the only usable path before that.

Refresh the page (or restart DSH) and a **hexagonal HIVE icon** appears in the left sidebar.
Details, uninstall and migration: [docs/INSTALL.md](docs/INSTALL.md).

---

## What you get

1. **Sidebar entry** — `sidebar.panellist` id `hive`, hexagonal icon.
2. **Main panel** — a 48px control bar, an embedded dashboard served from the host web server under
   `/hive/` (same-origin iframe), and a settings drawer.
3. **Control bar** — status dot + counts, then: **Start / Stop / Scan now / Doctor / Agent deps / Version / Refresh**.
   - Stop is armed: the first click becomes "Confirm stop?" and expires after 6 seconds.
   - *Agent deps* opens a drawer for the five agent CLIs (dsh / pi / codex / claude / agently): install, update,
     downgrade, uninstall (uninstall needs a second click before it fires).
   - *Version* opens a drawer for this plugin: current version, check for updates, downgrade, uninstall —
     **buttons only, never automatic**. Available versions come from GitHub Releases; when they cannot be read
     it says so instead of inventing a version.
4. **Nine dashboard tabs**:

| # | Tab | Contents |
|---|---|---|
| 1 | Inbox | every sensed item; search, filter by bucket/source/status/L1–L5, manual capture; per item: dispatch / archive / drop / restore / re-level |
| 2 | Outbox | approval cards (context + recommendation + 2–4 options + risk + expiry); approving continues the work automatically |
| 3 | Tasks | queue and runs; retry, cancel; every run's artifacts are traceable |
| 4 | Logs | live event stream over SSE; filter by level; pause / clear |
| 5 | Context | personal-context facts (category/key/value/evidence/confidence), editable |
| 6 | Executors | live probe results for all 7 executors (measured, not declared), versions, 24h runs and success rate |
| 7 | Autopilots | the 12 scheduled pulses (interval / last / next / overdue), per-pulse enable, run now; engine start/stop |
| 8 | Cost | daily spend chart, today's budget progress, per-executor bars, most expensive tasks |
| 9 | Doctor | 9 core checks + 6 optional CLI dependencies; missing ones get a one-click `npm i -g` button |

---

## Why it works out of the box

1. **Runtime is bundled** — `runtime/` is the whole HIVE runtime (46 files, ~560 KB); `dependencies` is empty.
2. **It borrows the model you already configured** — on start the plugin implements HIVE's chat transport with
   `ctx.llm.stream` (`setTransport` in `runtime/src/core/llm.mjs`) and uses your current provider/model
   (`deepseek/deepseek-chat` in the local test). **No API key of its own.**
3. **First activation provisions everything** — creates `$DSH_HOME/hive/`, writes default `hive.json` /
   `policies.json`, builds the database, starts the engine, seeds **12 scheduled pulses**, registers `/hive`.
4. **External CLIs are optional** — without `codex` / `pi` / `claude` / `agently-cli` you still have the built-in
   `llm` and `dsh` executors; L1/L2 answer inline, L3+ dispatch to `dsh`.
5. **The doctor tab tells you what is missing** and can install it (`npm i -g` from a fixed allow-list, 180s timeout,
   no interactive-login commands; Node itself is detect-only).

---

## Four agent tools

| Tool | Purpose | Parameters |
|---|---|---|
| `hive_status` | pending / awaiting approval / running / today's cost / engine and model state | — |
| `hive_capture` | put an item into the Inbox (deduped, prioritized) | `title` (required) · `body` · `kind` · `domain` |
| `hive_run` | route one item now: L1/L2 inline, L3+ to an executor, L4/L5 to the Outbox | `id` |
| `hive_decide` | approve (continues automatically) / reject an approval | `id` · `decision` · `note` |

---

## Data and privacy

- Everything local: one SQLite file, `$DSH_HOME/hive/data/hive.db`. No cloud, no shadow state.
- WeChat and X sensors are **off by default**; mail body fetching is **off by default** because fetching a body
  **marks the mail as read**.
- `policies.never_touch` directories are enforced in code (not by prompt), writes go through an allow-list.
- The dashboard is mounted on the host's loopback server under `/hive`; responses carry
  `X-Frame-Options: SAMEORIGIN` and `CSP frame-ancestors 'self'`.

---

## Self-test (no DSH required, does not touch your data)

```powershell
cd dsh-plugin-hive
node --check index.js && node --check client.js && node --check engine.mjs && node --check version.mjs
node --no-warnings scripts/selftest-host.mjs          # 19 assertions, fake ctx, temporary DSH_HOME
node --no-warnings scripts/check-client.mjs           # 68 assertions, node:vm browser stub
# optional: standalone dashboard
$h="$env:TEMP\hive-demo"; New-Item -ItemType Directory -Force "$h\config" | Out-Null;
Copy-Item runtime\config-defaults\*.json "$h\config\"; $env:HIVE_HOME=$h;
node --no-warnings runtime/src/server/http.mjs --port 8899   # open http://127.0.0.1:8899/
```

Local run (2026-11-05, Windows 11, Node v24.14.1): host **19/19 PASS** — provisioning created config/data and
seeded 12 pulses, host model resolved to `deepseek/deepseek-chat`, `/hive` registered as a prefix route with
`SAMEORIGIN`, a real scan saw 29 items and created 28, four tools registered, unload was clean. Client
**68/68 PASS** — slot registration, icon, scoped styles, endpoint contract, deps/version UI, no-blank-screen
fallbacks. The standalone dashboard answered `/api/health` 200.

---

## Known limitations

1. **Cost reads ¥0.00 in plugin mode** — model calls go through the host, HIVE neither re-bills nor invents tokens.
   Consequence: the daily budget guard never trips in plugin mode. Check DSH's own usage for real spend.
2. `codex` (HTTP 402, upstream balance) and `claude` (HTTP 401, expired credentials) were unavailable on the author's
   machine; this may not reproduce elsewhere. `probe()` only checks binaries and versions.
3. L4/L5 "self-verification" means artifacts on disk plus auditability — there is no independent second verifier.
4. Toast notifications only work on Windows 10/11 (WinRT via PowerShell 5.1); elsewhere they fail soft and the
   information still lands in the dashboard events / Outbox.
5. Default `policies.json` / `hive.json` contain absolute paths from the author's machine (`D:\…`, `F:\…`);
   change `$DSH_HOME/hive/config/*.json` after moving machines.
6. Do not run the plugin engine and the standalone `hive daemon` against the same `HIVE_HOME` — no cross-process coordination.
7. **`runtime/` is a synced copy, not the source** — it is produced by `node scripts/sync-runtime.mjs`; edit the
   source repo without re-syncing and the plugin keeps running the old runtime.
8. **Agent deps / Version drawer actions depend on host capabilities** — the dependency list comes from
   `/hive/api/deps` (an unsynced runtime shows "endpoint not ready"), and install/update/downgrade/uninstall go
   through the host's `ctx.pluginManager`; when missing it says so instead of failing silently. With a `link:`
   install, the Version drawer tells you that upgrading requires a GitHub/registry install.
9. The steps in this README were validated for both halves with stubs (19 + 68 assertions) and for the standalone
   dashboard; the real profile install was not recorded end-to-end on the author's machine.

---

## Docs

[docs/INSTALL.md](docs/INSTALL.md) · [docs/FEATURES.md](docs/FEATURES.md) ·
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [CHANGELOG.md](CHANGELOG.md) · [README.md](README.md) (中文)

MIT © 2026 Elohia — see [LICENSE](LICENSE).
