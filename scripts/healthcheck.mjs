#!/usr/bin/env node
// scripts/healthcheck.mjs — HIVE 体检：一次跑完「运行环境 / 配置 / DB / 执行器 / 通道 / 磁盘 / 预算 / 守护进程」
//
// 设计原则（与本项目铁律一致）：
//  1) 零 npm 依赖，只用 node: 内置模块；
//  2) 对「模块还没写出来」优雅降级：src/executors/index.mjs、src/server/http.mjs、hive.mjs 缺失时只报 WARN，绝不崩；
//  3) 只读为主：除「可写性探测」写入一个临时文件外，不改动 db 状态；
//  4) 有契约输出：人看表，机器吃 --json；
//  5) 有退出码：0 = 无 FAIL（允许 WARN）；1 = 有 FAIL；2 = 参数错误。
//
// 用法：
//   node --no-warnings scripts/healthcheck.mjs
//   node --no-warnings scripts/healthcheck.mjs --json
//   node --no-warnings scripts/healthcheck.mjs --strict      # WARN 也算失败（CI / 计划任务用）
//   node --no-warnings scripts/healthcheck.mjs --fast        # 只查命令存在，不取版本（约 0.5s）
//   node --no-warnings scripts/healthcheck.mjs --llm-ping    # 真调一次便宜模型验证通道（有极小费用）

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 抑制 node:sqlite 的 ExperimentalWarning（不影响功能，只是噪音）
const origEmitWarning = process.emitWarning;
process.emitWarning = (w, ...rest) => {
  const msg = typeof w === 'string' ? w : (w?.message || '');
  if (/SQLite is an experimental/i.test(msg)) return;
  return origEmitWarning.call(process, w, ...rest);
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ARGV = process.argv.slice(2);

const OPT = {
  json: ARGV.includes('--json'),
  strict: ARGV.includes('--strict'),
  quiet: ARGV.includes('--quiet'),
  fast: ARGV.includes('--fast'),
  llmPing: ARGV.includes('--llm-ping'),
  noColor: ARGV.includes('--no-color') || !!process.env.NO_COLOR,
  help: ARGV.includes('--help') || ARGV.includes('-h'),
};

if (OPT.help) {
  console.log(`HIVE 体检 healthcheck v1

用法: node --no-warnings scripts/healthcheck.mjs [选项]

选项:
  --json        机器可读输出（stdout 只有一份 JSON）
  --strict      WARN 也视为失败（退出码 1），给 CI / 计划任务用
  --quiet       只打印 FAIL 行与汇总
  --fast        执行器只查命令是否在 PATH，不跑 --version（少了 pi 的 7.5s 等开销）
  --llm-ping    真调一次便宜模型，验证 LLM 通道（有极小费用，默认跳过）
  --no-color    关闭 ANSI 颜色
  -h, --help    显示本帮助

探测项（每项给 PASS / WARN / FAIL / SKIP）:
  runtime.node / runtime.sqlite      Node 版本与 node:sqlite 可用
  config.files / config.paths        两份配置可解析、4 个数据目录存在且可写
  db.open / db.tables / db.integrity DB 可打开、10 张核心表齐全、完整性检查
  db.backlog / db.counts             队列积压、24h 失败数、僵尸 running、各表行数
  executors.index / executors.<name> 执行器层契约（probe()）+ 各命令真实版本
  channel.mail / channel.llm / channel.llm.ping / channel.toast / channel.dashboard
  disk.free / budget.today           磁盘余量与今日预算
  daemon.lock / logs.today / backup.age / artifacts

退出码: 0 = 通过（含 WARN）; 1 = 有 FAIL（或 --strict 下有 WARN）; 2 = 参数/环境致命错误
`);
  process.exit(0);
}

const KNOWN_FLAGS = new Set(['--json', '--strict', '--quiet', '--fast', '--llm-ping', '--no-color', '--help', '-h']);
const unknown = ARGV.filter((a) => a.startsWith('-') && !KNOWN_FLAGS.has(a));
if (unknown.length) {
  console.error(`✗ 未知参数: ${unknown.join(' ')}\n用 --help 看用法。`);
  process.exit(2);
}

// ---------------------------------------------------------------- 工具
const rows = [];
const C = { PASS: '\x1b[32m', WARN: '\x1b[33m', FAIL: '\x1b[31m', SKIP: '\x1b[90m', OFF: '\x1b[0m' };
const colorize = (s, t) => (OPT.noColor ? t : (C[s] || '') + t + C.OFF);
const ITEM_W = 30;
function renderLine(r) {
  const pad = r.item.length >= ITEM_W ? r.item + '  ' : r.item.padEnd(ITEM_W);
  process.stdout.write(pad + colorize(r.status, r.status.padEnd(4)) + '  ' + r.detail + '\n');
}
function add(item, status, detail) {
  rows.push({ item, status, detail: String(detail ?? '') });
  if (!OPT.json && !OPT.quiet) renderLine(rows[rows.length - 1]);
  return status;
}

const ms0 = Date.now();
const rel = (...p) => path.join(ROOT, ...p);
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const bytesFmt = (n) => n >= 1 << 30 ? (n / (1 << 30)).toFixed(1) + ' GiB'
  : n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MiB'
    : n >= 1 << 10 ? (n / (1 << 10)).toFixed(1) + ' KiB' : n + ' B';
const firstLine = (s) => String(s || '').split(/\r?\n/)[0].trim();

async function tryImport(relPath) {
  const abs = rel(relPath);
  if (!exists(abs)) return { mod: null, reason: `${relPath} 不存在` };
  try { return { mod: await import(pathToFileURL(abs).href), reason: '' }; }
  catch (e) { return { mod: null, reason: `${relPath} 装载失败: ${String(e.message).slice(0, 160)}` }; }
}

/** 异步执行外部命令（Windows 上 npm 全局命令是 .ps1/.cmd 垫片，必须经 cmd /d /c）
 *  实测：dsh --version 1.25s / pi --version 7.5s / codex 1.5s / claude 1.2s —— 所以必须并行。 */
function spawnCapture(cmdline, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const [cmd, ...args] = cmdline.split(' ');
    const child = isWin
      ? spawn('cmd.exe', ['/d', '/c', cmdline], { windowsHide: true })
      : spawn(cmd, args, { windowsHide: true });
    let out = '', err = '', settled = false;
    const timer = setTimeout(() => { if (!settled) { try { child.kill('SIGKILL'); } catch {} } }, timeoutMs);
    const fin = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    child.on('error', (e) => fin({ ok: false, code: null, stdout: out.trim(), stderr: String(e.message), timedOut: false }));
    child.on('close', (code) => fin({ ok: code === 0, code, stdout: out.trim(), stderr: err.trim(), timedOut: false }));
  });
}

async function probeCommand(cmdline) {
  if (OPT.fast) {
    const isWin = process.platform === 'win32';
    const r = await spawnCapture(`${isWin ? 'where' : 'which'} ${cmdline.split(' ')[0]}`, 5000);
    return { found: r.ok, version: null, path: firstLine(r.stdout) || null, err: firstLine(r.stderr) };
  }
  const t0 = Date.now();
  const r = await spawnCapture(`${cmdline} --version`, 20000);
  const version = firstLine(r.stdout) || firstLine(r.stderr) || null;
  const looksMissing = !r.ok && /不是内部或外部命令|not recognized|ENOENT/i.test(r.stderr || '');
  return { found: r.ok && !!version && !looksMissing, version, path: null, ms: Date.now() - t0, err: firstLine(r.stderr) };
}

function portListening(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch {} resolve(v); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    s.connect(port, host);
  });
}

// ---------------------------------------------------------------- 先把慢的外部探测并发打出去
const PROBE = {
  mail: spawnCapture('agently-cli auth status', 25000),
  // Toast 走 Windows PowerShell 5.1 + WinRT；这里只确认命令在不在，绝不弹窗。
  toast: process.platform === 'win32' ? spawnCapture('where powershell.exe', 8000) : Promise.resolve({ ok: false, stdout: '', stderr: '' }),
};

// ---------------------------------------------------------------- 0) 载入配置
let cfg = null, cfgErr = null;
{
  const cm = await tryImport('src/core/config.mjs');
  try {
    if (cm.mod?.loadConfig) cfg = cm.mod.loadConfig();
    else {
      const raw = JSON.parse(fs.readFileSync(rel('config', 'hive.json'), 'utf8'));
      cfg = {
        ...raw, home: ROOT,
        policies: JSON.parse(fs.readFileSync(rel('config', 'policies.json'), 'utf8')),
        resolved: {
          db: path.join(ROOT, raw.paths.db), runs: path.join(ROOT, raw.paths.runs),
          artifacts: path.join(ROOT, raw.paths.artifacts), logs: path.join(ROOT, raw.paths.logs),
          workspace: path.join(ROOT, raw.paths.workspace), prompts: path.join(ROOT, raw.paths.prompts),
          credentials: raw.credentials?.file || null, configFile: rel('config', 'hive.json'),
        },
      };
      cfgErr = `${cm.reason}（已回退到裸 JSON 解析）`;
    }
  } catch (e) { cfgErr = String(e.message); }
}

if (!OPT.json && !OPT.quiet) {
  console.log(`HIVE 体检 — home=${ROOT}  node=${process.version}  ${new Date().toISOString()}`);
  console.log('-'.repeat(100));
}

// ---------------------------------------------------------------- 1) 运行时
{
  const major = Number(process.versions.node.split('.')[0]);
  add('runtime.node', major >= 22 ? 'PASS' : 'FAIL',
    `v${process.versions.node} (${process.platform}/${process.arch})` + (major >= 24 ? '' : '  ← 低于 v24，node:sqlite 行为未在本机验证'));
}
{
  let ver = null, err = null;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const t = new DatabaseSync(':memory:');
    ver = t.prepare('SELECT sqlite_version() AS v').get().v;
    t.close();
  } catch (e) { err = String(e.message); }
  add('runtime.sqlite', ver ? 'PASS' : 'FAIL',
    ver ? `node:sqlite 可用，SQLite ${ver}（有 ExperimentalWarning，用 --no-warnings 抑制）` : `不可用: ${err}`);
}

// ---------------------------------------------------------------- 2) 配置
if (!cfg) add('config.files', 'FAIL', `配置装载失败: ${cfgErr}`);
else {
  const problems = [];
  if (!cfg.policies) problems.push('policies.json 未装载');
  if (!cfg.resolved?.db) problems.push('resolved.db 缺失');
  add('config.files', problems.length ? 'FAIL' : (cfgErr ? 'WARN' : 'PASS'),
    problems.length ? problems.join('; ')
      : `hive.json + policies.json OK（version=${cfg.version ?? '?'}, schema=${cfg.$schema ?? '-'}）${cfgErr ? '；' + cfgErr : ''}`);
}
{
  if (!cfg) add('config.paths', 'SKIP', '配置不可用');
  else {
    const missing = [], notWritable = [];
    for (const k of ['runs', 'artifacts', 'logs', 'workspace']) {
      const d = cfg.resolved[k];
      if (!d || !exists(d)) { missing.push(k); continue; }
      const probe = path.join(d, `.hc-${process.pid}.tmp`);
      try { fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe); } catch { notWritable.push(k); }
    }
    add('config.paths', missing.length || notWritable.length ? 'FAIL' : 'PASS',
      missing.length || notWritable.length
        ? `缺失/不可写: 缺[${missing.join(',')}] 不可写[${notWritable.join(',')}]`
        : `4 个数据目录存在且可写（db=${path.relative(ROOT, cfg.resolved.db)}）`);
  }
}

// ---------------------------------------------------------------- 3) DB
const REQUIRED_TABLES = ['items', 'tasks', 'runs', 'artifacts', 'approvals', 'events', 'pulses', 'context_facts', 'kv', 'cursors'];
let db = null, dbStatsObj = null;
if (!cfg) add('db.open', 'SKIP', '配置不可用');
else {
  const dbm = await tryImport('src/core/db.mjs');
  try {
    if (dbm.mod?.getDb) {
      db = dbm.mod.getDb();                 // 项目自己的入口（会建表，属预期行为）
      dbStatsObj = dbm.mod.dbStats?.() ?? null;
    } else {
      const { DatabaseSync } = await import('node:sqlite');
      db = new DatabaseSync(cfg.resolved.db); // 降级：直接开库，不建表
    }
    const mode = db.prepare('PRAGMA journal_mode').get();
    const pg = db.prepare('PRAGMA page_count').get()?.page_count ?? 0;
    const sz = db.prepare('PRAGMA page_size').get()?.page_size ?? 0;
    const wal = exists(cfg.resolved.db + '-wal') ? fs.statSync(cfg.resolved.db + '-wal').size : 0;
    add('db.open', 'PASS',
      `${path.relative(ROOT, cfg.resolved.db)} journal=${mode.journal_mode} 页=${pg}×${sz}B ≈ ${bytesFmt(pg * sz)} WAL=${bytesFmt(wal)}` +
      (dbm.mod?.getDb ? '' : `（降级直连：${dbm.reason}）`));
  } catch (e) { add('db.open', 'FAIL', String(e.message).slice(0, 200)); }
}
if (db) {
  try {
    const have = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    const missing = REQUIRED_TABLES.filter((t) => !have.includes(t));
    add('db.tables', missing.length ? 'FAIL' : 'PASS',
      missing.length ? `缺表: ${missing.join(', ')}（现有 ${have.length} 张）` : `${REQUIRED_TABLES.length}/10 张核心表齐全（共 ${have.length} 张）`);
  } catch (e) { add('db.tables', 'FAIL', String(e.message).slice(0, 160)); }

  try {
    const v = db.prepare('PRAGMA integrity_check').get()?.integrity_check;
    add('db.integrity', v === 'ok' ? 'PASS' : 'FAIL', `integrity_check=${v}`);
  } catch (e) { add('db.integrity', 'FAIL', String(e.message).slice(0, 160)); }

  try {
    const one = (sql, ...a) => db.prepare(sql).get(...a)?.n ?? 0;
    const queued = one("SELECT COUNT(*) n FROM tasks WHERE status='queued'");
    const running = one("SELECT COUNT(*) n FROM tasks WHERE status='running'");
    const failed24 = one("SELECT COUNT(*) n FROM tasks WHERE status='failed' AND updated_at > ?", new Date(Date.now() - 86400e3).toISOString());
    const stalled = one("SELECT COUNT(*) n FROM tasks WHERE status='running' AND COALESCE(heartbeat_at,updated_at) < ?", new Date(Date.now() - 600e3).toISOString());
    const pendAp = one("SELECT COUNT(*) n FROM approvals WHERE status='pending'");
    let status = 'PASS';
    if (failed24 > 5 || stalled > 0) status = 'WARN';
    if (queued > 200 || failed24 > 20) status = 'FAIL';
    add('db.backlog', status, `queued=${queued} running=${running} stalled=${stalled} failed24h=${failed24} pendingApprovals=${pendAp}`);
    if (dbStatsObj) add('db.counts', 'PASS', Object.entries(dbStatsObj).map(([k, v]) => `${k}=${v}`).join(' '));
  } catch (e) { add('db.backlog', 'FAIL', String(e.message).slice(0, 160)); }
}

// ---------------------------------------------------------------- 4) 执行器（并行探测）
{
  const exMod = await tryImport('src/executors/index.mjs');
  // --fast 不做版本探测：执行器模块的 probe() 会真跑 --version（pi 就 7.5s），直接走便宜的 where 分支
  if (exMod.mod?.probe && !OPT.fast) {
    try {
      const p = await exMod.mod.probe();
      const names = Object.keys(p);
      for (const [n, v] of Object.entries(p)) {
        if (v && v.disabled) { add(`executors.${n}`, 'SKIP', `已在 config 中关闭${v.reason ? '：' + v.reason : ''}`); continue; }
        add(`executors.${n}`, v.ok ? 'PASS' : 'WARN', v.ok ? (v.version || 'ok') : (v.reason || '不可用'));
      }
      const active = names.filter((n) => !p[n].disabled);
      if (!names.length) add('executors', 'WARN', 'probe() 返回空');
      else if (active.length && active.every((n) => !p[n].ok)) add('executors', 'FAIL', '所有启用的执行器都不可用');
    } catch (e) { add('executors', 'FAIL', `probe() 抛错: ${String(e.message).slice(0, 160)}`); }
  } else {
    add('executors.index', 'WARN', `${exMod.reason || 'probe() 未导出'} → 改用独立命令探测（降级）`);
    const ex = cfg?.executors || {};
    const todo = [];
    for (const [name, spec] of Object.entries(ex)) {
      if (!spec || spec.enabled === false) { add(`executors.${name}`, 'SKIP', '配置里未启用'); continue; }
      if (spec.kind !== 'process') { add(`executors.${name}`, 'SKIP', `kind=${spec.kind}（内联，无需探测命令）`); continue; }
      const cmdline = String(spec.command || '').split(/\s+/).filter(Boolean)[0];
      if (!cmdline) { add(`executors.${name}`, 'WARN', '未配置 command'); continue; }
      todo.push([name, cmdline]);
    }
    const probes = await Promise.all(todo.map(async ([name, cmdline]) => ({ name, cmdline, r: await probeCommand(cmdline) })));
    for (const { name, cmdline, r } of probes) {
      add(`executors.${name}`, r.found ? 'PASS' : 'WARN',
        r.found ? `${cmdline} → ${r.version || '(仅存在性检查)'}${r.ms ? ` ${r.ms}ms` : ''}` : `命令 ${cmdline} 不可用（${r.err || '不在 PATH'}）→ 路由会降级`);
    }
  }
}

// ---------------------------------------------------------------- 5) 通道
{
  const r = await PROBE.mail;
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch {}
  const d = parsed?.data;
  if (d?.logged_in) {
    const exp = d.expires_at ? new Date(d.expires_at) : null;
    const mins = exp && !Number.isNaN(+exp) ? Math.round((exp - Date.now()) / 60000) : null;
    add('channel.mail', mins != null && mins < 0 ? 'WARN' : 'PASS',
      `agently-cli logged_in token=${d.token_status} 存储=${d.storage} 到期=${d.expires_at || '?'}` +
      (mins != null ? `（剩 ${mins} 分钟）` : '') + (mins != null && mins < 0 ? ' ← 需 agently-cli auth refresh' : ''));
  } else {
    add('channel.mail', 'WARN', `agently-cli 未登录或探测失败: ${firstLine(r.stderr || r.stdout) || 'no output'}`);
  }

  const cm = await tryImport('src/core/credentials.mjs');
  if (cm.mod?.keyStatus) {
    try {
      const ks = cm.mod.keyStatus();
      const present = Object.entries(ks).filter(([, v]) => v.present);
      const absent = Object.entries(ks).filter(([, v]) => !v.present);
      add('channel.llm', present.length ? 'PASS' : 'FAIL',
        present.map(([k, v]) => `${k}(len=${v.length})`).join(' ') + (absent.length ? ` 缺:${absent.map(([k]) => k).join(',')}` : ''));
      const def = cfg?.llm?.default;
      const defAlias = cfg?.llm?.providers?.[def]?.keyRef;
      if (def && defAlias && !ks[defAlias]?.present) add('channel.llm.default', 'FAIL', `默认 provider ${def} 的 keyRef=${defAlias} 无密钥`);
    } catch (e) { add('channel.llm', 'FAIL', String(e.message).slice(0, 160)); }
  } else {
    add('channel.llm', 'WARN', `${cm.reason}（无法校验凭据，跳过）`);
  }

  if (OPT.llmPing) {
    const lm = await tryImport('src/core/llm.mjs');
    if (!lm.mod?.chat) add('channel.llm.ping', 'SKIP', lm.reason || 'llm.mjs 未就绪');
    else {
      try {
        const t0 = Date.now();
        const c = await lm.mod.chat({ messages: [{ role: 'user', content: '只回复 OK' }], maxTokens: 8, retries: 0, timeoutMs: 30000 });
        add('channel.llm.ping', c.ok ? 'PASS' : 'FAIL', c.ok ? `${c.provider}/${c.model} ${Date.now() - t0}ms ¥${c.costCny}` : c.error);
      } catch (e) { add('channel.llm.ping', 'FAIL', String(e.message).slice(0, 160)); }
    }
  } else add('channel.llm.ping', 'SKIP', '未传 --llm-ping（避免产生费用）');

  const ps = await PROBE.toast;
  add('channel.toast', ps.ok ? 'PASS' : 'WARN',
    ps.ok ? `powershell.exe 在 PATH（Toast 走 WinRT，失败 fail-soft 跳过）` : 'powershell.exe 不在 PATH → Toast 推送会被跳过');

  const port = Number(cfg?.server?.port || 8787);
  const up = await portListening(port);
  add('channel.dashboard', up ? 'PASS' : 'WARN', up ? `127.0.0.1:${port} 在监听` : `127.0.0.1:${port} 未监听（看板未起，CLI 仍可用）`);
}

// ---------------------------------------------------------------- 6) 磁盘
{
  const target = cfg?.resolved?.db ? path.dirname(cfg.resolved.db) : ROOT;
  try {
    const st = fs.statfsSync(target);
    const free = st.bavail * st.bsize, total = st.blocks * st.bsize;
    add('disk.free', free < 1 << 30 ? 'FAIL' : free < 5 << 30 ? 'WARN' : 'PASS',
      `${path.parse(path.resolve(target)).root} 余 ${bytesFmt(free)} / 总 ${bytesFmt(total)}`);
  } catch (e) { add('disk.free', 'WARN', String(e.message).slice(0, 120)); }
}

// ---------------------------------------------------------------- 7) 预算
{
  const budget = Number(cfg?.settings?.dailyBudgetCny ?? 0);
  let cost = 0, src = '';
  const tc = await tryImport('src/task/taskcenter.mjs');
  if (tc.mod?.todayCost) { try { cost = tc.mod.todayCost().costCny; src = 'taskcenter.todayCost'; } catch {} }
  if (!src && db) {
    try {
      const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
      cost = db.prepare('SELECT COALESCE(SUM(cost_cny),0) c FROM runs WHERE started_at >= ?').get(dayStart.toISOString()).c || 0;
      src = 'db.runs 汇总（降级）';
    } catch {}
  }
  if (!budget) add('budget.today', 'WARN', '未配置 dailyBudgetCny（护栏缺失）');
  else {
    const ratio = cost / budget;
    add('budget.today', ratio >= 1 ? 'FAIL' : ratio >= (cfg.settings.budgetWarnRatio ?? 0.8) ? 'WARN' : 'PASS',
      `¥${cost.toFixed(4)} / ¥${budget}（${(ratio * 100).toFixed(0)}%）via ${src || 'n/a'}${ratio >= 1 ? ' ← 已超限，派单会被暂停' : ''}`);
  }
}

// ---------------------------------------------------------------- 8) 守护进程
{
  const lockFile = cfg ? path.join(cfg.home, 'data', 'hive.lock') : rel('data', 'hive.lock');
  let lock = null;
  try { lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch {}
  const alive = lock ? (() => { try { process.kill(lock.pid, 0); return true; } catch { return false; } })() : false;
  const port = Number(cfg?.server?.port || 8787);
  const up = await portListening(port);
  if (alive && up) add('daemon.lock', 'PASS', `pid=${lock.pid} 活着，端口 ${port} 在听`);
  else if (alive && !up) add('daemon.lock', 'WARN', `pid=${lock.pid} 活着但端口 ${port} 未监听（server 未就绪？）`);
  else if (!alive && lock) add('daemon.lock', 'WARN', `锁文件残留 pid=${lock.pid} 已死 → 重启 daemon 会覆盖它`);
  else if (!alive && up) add('daemon.lock', 'WARN', `端口 ${port} 有服务但没有 data/hive.lock → 起的是 serve / http.mjs 单进程，不是常驻 daemon（无巡检/无派发）`);
  else add('daemon.lock', 'WARN', '守护进程未运行（单次命令仍可用：node scripts/hive.mjs ...）');
}

// ---------------------------------------------------------------- 9) 日志
{
  const dir = cfg?.resolved?.logs || rel('data', 'logs');
  try {
    const day = new Date().toISOString().slice(0, 10);
    const f = path.join(dir, `hive-${day}.log`);
    if (exists(f)) {
      const st = fs.statSync(f);
      add('logs.today', 'PASS', `${path.basename(f)} ${bytesFmt(st.size)} 更新于 ${new Date(st.mtimeMs).toISOString().slice(11, 19)}Z`);
    } else {
      const any = fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.log')) : [];
      add('logs.today', 'WARN', any.length ? `今日无日志，最近: ${any.slice(-3).join(', ')}` : `无日志文件（${path.relative(ROOT, dir)}）`);
    }
  } catch (e) { add('logs.today', 'WARN', String(e.message).slice(0, 120)); }
}

// ---------------------------------------------------------------- 10) 备份 / 产物
{
  // 默认落点 data/backups；也顺手看 data/ 根（很多人用 --out data\x.zip 手写路径）
  const dirs = [cfg ? path.join(cfg.home, 'data', 'backups') : rel('data', 'backups'), cfg ? path.join(cfg.home, 'data') : rel('data')];
  const found = [];
  try {
    for (const dir of dirs) {
      if (!exists(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!/^(hive-backup-|backup-|restore-).*\.(zip|db\.gz|tgz|tar\.gz)$/i.test(f)) continue;
        const abs = path.join(dir, f);
        try { const st = fs.statSync(abs); if (st.isFile()) found.push({ abs, f, m: st.mtimeMs }); } catch {}
      }
    }
    found.sort((a, b) => b.m - a.m);
    if (!found.length) add('backup.age', 'WARN', '没找到任何备份（data/backups 与 data/ 下均无 *.zip）→ 跑 node scripts/backup.mjs');
    else {
      const ageH = (Date.now() - found[0].m) / 3600e3;
      add('backup.age', ageH > 24 * 7 ? 'WARN' : 'PASS',
        `最新 ${path.relative(ROOT, found[0].abs)}（${ageH.toFixed(1)} 小时前，共 ${found.length} 份）`);
    }
  } catch (e) { add('backup.age', 'WARN', String(e.message).slice(0, 120)); }

  if (db) {
    try {
      const n = db.prepare('SELECT COUNT(*) n FROM artifacts').get()?.n ?? 0;
      const rowsArt = db.prepare('SELECT path FROM artifacts LIMIT 200').all();
      const missing = rowsArt.filter((r) => !exists(r.path)).length;
      add('artifacts', missing ? 'WARN' : 'PASS', `登记 ${n} 条${rowsArt.length ? `，抽查前 ${rowsArt.length} 条缺失 ${missing} 条` : ''}`);
    } catch (e) { add('artifacts', 'WARN', String(e.message).slice(0, 120)); }
  }
}

// ---------------------------------------------------------------- 收尾
if (db?.close) { try { db.close(); } catch {} }

const fail = rows.filter((r) => r.status === 'FAIL').length;
const warn = rows.filter((r) => r.status === 'WARN').length;
const pass = rows.filter((r) => r.status === 'PASS').length;
const skip = rows.filter((r) => r.status === 'SKIP').length;
const elapsed = Date.now() - ms0;
const exitCode = fail > 0 ? 1 : (OPT.strict && warn > 0 ? 1 : 0);

if (OPT.json) {
  console.log(JSON.stringify({
    ok: exitCode === 0, version: 'healthcheck-v1', home: ROOT, node: process.version,
    generatedAt: new Date().toISOString(), elapsedMs: elapsed,
    summary: { pass, warn, fail, skip, total: rows.length }, exitCode, rows,
  }, null, 2));
} else {
  console.log('-'.repeat(100));
  console.log(`合计: ${pass} PASS / ${warn} WARN / ${fail} FAIL / ${skip} SKIP  （${elapsed}ms，退出码 ${exitCode}）`);
  if (fail) console.log(colorize('FAIL', `\n有 ${fail} 项 FAIL：` + rows.filter((r) => r.status === 'FAIL').map((r) => r.item).join(', ')));
}
process.exit(exitCode);
