// tests/dashboard-smoke.mjs — 仪表盘（执行器 / 自动任务 / 成本 / 自检安装）冒烟
//
// 默认在【隔离的临时 HIVE_HOME】里跑：复制 config/{hive.json,policies.json} 与 VERSION，
// 所有写入都落在系统临时目录，跑完删除 —— 不污染 D:\hive\data\hive.db。
//   node --no-warnings tests/dashboard-smoke.mjs             # 隔离库（默认）
//   node --no-warnings tests/dashboard-smoke.mjs --real      # 直接跑真实 data/hive.db
//   node --no-warnings tests/dashboard-smoke.mjs --keep      # 保留临时目录便于排查
//   node --no-warnings tests/dashboard-smoke.mjs --verbose   # 打印服务端请求日志
//
// 覆盖：
//   · 前端：index.html 里 4 个新标签 / style.css 里仪表盘样式
//   · 路由表：8 条新路由已注册
//   · GET /api/agents        形状 + 6 个执行器齐全
//   · GET /api/autopilots    脉冲列表（seedPulses 后）
//   · POST /api/autopilots/:id/toggle  暂停 → GET 验证 → 恢复
//   · POST /api/autopilots/:id/run     可代跑（triage）/ 不可代跑（digest，如实说明）
//   · GET /api/cost?days=N   7 天 / 1 天 / 越界夹取
//   · GET /api/setup/doctor  9 项核心自检 + 6 个依赖 + PASS/WARN/FAIL
//   · POST /api/setup/install  nodejs 只检测不安装 / 非法 id 400
//   · POST /api/control/{start,stop,scan}  诚实降级
//   · 404 / 405 / 旧 /api/doctor 回归
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function parseArgs(argv) {
  const out = { real: false, keep: false, verbose: false, port: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--real') out.real = true;
    else if (a === '--keep') out.keep = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--port') out.port = Number(argv[++i]) || 0;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));
if (ARGS.help) {
  console.log(`用法: node --no-warnings tests/dashboard-smoke.mjs [--real] [--keep] [--verbose] [--port N]
  --real     使用真实 D:\\hive\\data\\hive.db（默认用临时隔离库）
  --keep     保留临时 HIVE_HOME
  --verbose  打印服务端请求日志
  --port N   指定端口（默认 0 = 系统分配）`);
  process.exit(0);
}

// ───────────────────────────── 断言工具 ─────────────────────────────
const results = [];
function ok(name, cond, extra = '') {
  const pass = !!cond;
  results.push({ name, pass, extra });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  return pass;
}
function fail(name, e) {
  const msg = e && e.message ? e.message : String(e);
  return ok(name, false, '异常: ' + msg.split('\n')[0]);
}
async function T(name, fn) {
  try { return await fn(); } catch (e) { fail(name, e); return null; }
}

// ───────────────────────────── 隔离环境 ─────────────────────────────
let tmpHome = null;
if (!ARGS.real) {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-dash-'));
  fs.mkdirSync(path.join(tmpHome, 'config'), { recursive: true });
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'hive.json'), 'utf8'));
  fs.writeFileSync(path.join(tmpHome, 'config', 'hive.json'), JSON.stringify(cfg, null, 2), 'utf8');
  fs.copyFileSync(path.join(ROOT, 'config', 'policies.json'), path.join(tmpHome, 'config', 'policies.json'));
  // 故意写假 VERSION：若代码错从 HOME 读版本，断言会立刻抓到
  fs.writeFileSync(path.join(tmpHome, 'VERSION'), '9.9.9-should-not-be-used\n', 'utf8');
  fs.mkdirSync(path.join(tmpHome, 'prompts'), { recursive: true });
  process.env.HIVE_HOME = tmpHome;
}

const HOME = process.env.HIVE_HOME || ROOT;
// 测试时把 registry 固定到本机镜像：避免每次跑测试都等 npmjs 直连的 12s 超时。
// 生产默认仍是 https://registry.npmjs.org/（HIVE_NPM_REGISTRY 可覆盖）。
if (!process.env.HIVE_NPM_REGISTRY) process.env.HIVE_NPM_REGISTRY = 'https://registry.npmmirror.com/';
console.log(`\n== dashboard-smoke ==`);
console.log(`   HOME = ${HOME}${ARGS.real ? '  (真实库)' : '  (临时隔离库)'}`);

const mod = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { startServer } = await mod('src/server/http.mjs');
const { loadConfig } = await mod('src/core/config.mjs');
const { closeDb, q } = await mod('src/core/db.mjs');
const { seedPulses } = await mod('src/task/pulse.mjs');
const { routeTable } = await mod('src/server/api.mjs');

const cfg = loadConfig();
const logger = ARGS.verbose ? (l) => console.log('   [server] ' + l) : () => {};

let srv = null;

async function req(method, p, body, opts = {}) {
  const url = srv.url.replace(/\/$/, '') + p;
  const headers = { ...(opts.headers || {}) };
  if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method, headers,
    body: body !== undefined && body !== null ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { __raw: text }; }
  return { status: res.status, data, text, headers: res.headers };
}

let exitCode = 0;
try {
  // ── 0. 启动 ─────────────────────────────────────────────────────
  srv = await startServer({ port: ARGS.port, logger });
  ok('server.start', srv.port > 0, `url=${srv.url}`);
  ok('server.isolated-db', ARGS.real || String(cfg.resolved.db).startsWith(tmpHome), cfg.resolved.db);

  // ── 1. 前端：新标签页与样式 ──────────────────────────────────────
  await T('static.tabs', async () => {
    const r = await req('GET', '/');
    const html = r.text;
    const tabs = ['执行器', '自动任务', '成本', '自检'];
    ok('static.index.tabs', r.status === 200 && tabs.every((t) => html.includes(t)),
      `missing=${tabs.filter((t) => !html.includes(t)).join(',') || '(none)'}`);
    ok('static.index.panels',
      ['data-tab="agents"', 'data-tab="autopilots"', 'data-tab="cost"', 'data-tab="setup"',
        'data-panel="agents"', 'data-panel="autopilots"', 'data-panel="cost"', 'data-panel="setup"',
        'id="deps-block"']
        .every((needle) => html.includes(needle)));
    const css = await req('GET', '/style.css');
    ok('static.css.dash', css.status === 200 && ['.kpi-value', '.setup-row', '.hbar', '.toggle']
      .every((c) => css.text.includes(c)));
    const js = await req('GET', '/app.js');
    ok('static.js.dash', js.status === 200 && ['/api/agents', '/api/autopilots', '/api/cost', '/api/setup/doctor']
      .every((c) => js.text.includes(c)));
    ok('static.js.deps',
      ['/api/deps', '/api/deps/check', 'data-deps-act', 'deps-block']
        .every((c) => js.text.includes(c)),
      '依赖管理前端已接线');
  });

  // ── 2. 路由表 ───────────────────────────────────────────────────
  await T('routes', async () => {
    const names = routeTable.map((r) => r.name);
    const want = ['agents', 'autopilots', 'autopilots.toggle', 'autopilots.run', 'cost',
      'setup.doctor', 'setup.install',
      'deps', 'deps.check', 'deps.install', 'deps.update', 'deps.uninstall',
      'control.start', 'control.stop', 'control.scan'];
    const missing = want.filter((n) => !names.includes(n));
    ok('routes.registered', missing.length === 0, `missing=${missing.join(',') || '(none)'}`);
  });

  // ── 3. GET /api/agents ─────────────────────────────────────────
  await T('api.agents', async () => {
    const r = await req('GET', '/api/agents');
    ok('api.agents.status', r.status === 200 && r.data && r.data.ok === true, `status=${r.status}`);
    const execs = r.data.executors || [];
    const names = execs.map((e) => e.name);
    ok('api.agents.executors', execs.length >= 6, `n=${execs.length} names=${names.join(',')}`);
    ok('api.agents.six',
      ['llm', 'dsh', 'pi', 'codex', 'claude', 'shell'].every((n) => names.includes(n)),
      `names=${names.join(',')}`);
    const e0 = execs[0] || {};
    ok('api.agents.shape',
      execs.every((e) => typeof e.ok === 'boolean' && e.runs24h && typeof e.runs24h.total === 'number'
        && 'version' in e && 'reason' in e && e.lifetime && typeof e.lifetime.runs === 'number'),
      `sample=${JSON.stringify({ name: e0.name, ok: e0.ok, v: e0.version }).slice(0, 120)}`);
    ok('api.agents.summary',
      r.data.summary && typeof r.data.summary.executors === 'number' && typeof r.data.summary.available === 'number'
        && typeof r.data.summary.runs24h === 'number' && typeof r.data.summary.costCnyAll === 'number');
    ok('api.agents.daemon', r.data.daemon && typeof r.data.daemon.running === 'boolean');
  });

  // ── 4. GET /api/autopilots（先 seed 脉冲）───────────────────────
  const seeded = seedPulses();
  ok('pulses.seed', seeded >= 1 || q.get('SELECT COUNT(*) AS n FROM pulses').n >= 5,
    `新增=${seeded} 总数=${q.get('SELECT COUNT(*) AS n FROM pulses').n}`);

  let pulses = [];
  await T('api.autopilots', async () => {
    const r = await req('GET', '/api/autopilots');
    ok('api.autopilots.status', r.status === 200 && r.data.ok === true, `status=${r.status}`);
    pulses = r.data.pulses || [];
    ok('api.autopilots.list', pulses.length >= 5, `n=${pulses.length}`);
    ok('api.autopilots.shape',
      pulses.every((p) => p.id && p.name && p.spec && p.schedule && typeof p.enabled === 'boolean'
        && 'handler' in p && 'nextRunAt' in p && 'due' in p));
    ok('api.autopilots.summary',
      r.data.summary && r.data.summary.total === pulses.length
        && typeof r.data.summary.enabled === 'number' && typeof r.data.summary.due === 'number');
    ok('api.autopilots.daemon', r.data.daemon && typeof r.data.daemon.running === 'boolean');
    ok('api.autopilots.notes', Array.isArray(r.data.notes) && r.data.notes.length >= 1);
  });

  // ── 5. POST toggle：暂停 → GET 验证 → 恢复 ─────────────────────
  const target = pulses.find((p) => p.id === 'pulse-triage') || pulses[0];
  await T('api.autopilots.toggle', async () => {
    const off = await req('POST', `/api/autopilots/${encodeURIComponent(target.id)}/toggle`, { enabled: false });
    ok('api.autopilots.toggle.off', off.status === 200 && off.data.ok === true && off.data.enabled === false,
      `status=${off.status} enabled=${off.data?.enabled}`);
    const after = await req('GET', '/api/autopilots');
    const p1 = (after.data.pulses || []).find((p) => p.id === target.id);
    ok('api.autopilots.toggle.persisted', p1 && p1.enabled === false, `enabled=${p1 && p1.enabled}`);

    const on = await req('POST', `/api/autopilots/${encodeURIComponent(target.id)}/toggle`, { enabled: true });
    ok('api.autopilots.toggle.on', on.status === 200 && on.data.enabled === true, `enabled=${on.data?.enabled}`);
    const after2 = await req('GET', '/api/autopilots');
    const p2 = (after2.data.pulses || []).find((p) => p.id === target.id);
    ok('api.autopilots.toggle.restored', p2 && p2.enabled === true, `enabled=${p2 && p2.enabled}`);

    const nf = await req('POST', '/api/autopilots/does-not-exist/toggle', { enabled: true });
    ok('api.autopilots.toggle.404', nf.status === 404 && typeof nf.data.error === 'string', `status=${nf.status}`);
  });

  // ── 6. POST run：可代跑 vs 不可代跑 ────────────────────────────
  await T('api.autopilots.run', async () => {
    const runnable = pulses.find((p) => p.id === 'pulse-triage');
    if (runnable) {
      const r = await req('POST', '/api/autopilots/pulse-triage/run', {});
      ok('api.autopilots.run.triage',
        r.status === 200 && r.data.ran === true && typeof r.data.ms === 'number',
        `ok=${r.data?.ok} ran=${r.data?.ran} ms=${r.data?.ms} summary=${r.data?.result?.summary || ''}`);
      const after = await req('GET', '/api/autopilots');
      const p = (after.data.pulses || []).find((x) => x.id === 'pulse-triage');
      ok('api.autopilots.run.marked', p && p.lastRunAt && p.lastStatus === 'ok',
        `last=${p && p.lastStatus}`);
    } else {
      ok('api.autopilots.run.triage', false, 'pulse-triage 缺失');
    }

    const digest = pulses.find((p) => p.handler === 'digest');
    if (digest) {
      const r = await req('POST', `/api/autopilots/${encodeURIComponent(digest.id)}/run`, {});
      ok('api.autopilots.run.skipped',
        r.status === 200 && r.data.skipped === true && r.data.ran === false && typeof r.data.reason === 'string' && r.data.reason.length > 0,
        `reason=${String(r.data?.reason).slice(0, 40)}`);
      ok('api.autopilots.run.hint', typeof r.data.hint === 'string' && r.data.hint.length > 0);
    } else {
      ok('api.autopilots.run.skipped', false, '没有 digest 脉冲');
    }

    const nf = await req('POST', '/api/autopilots/nope/run', {});
    ok('api.autopilots.run.404', nf.status === 404, `status=${nf.status}`);
  });

  // ── 7. GET /api/cost ───────────────────────────────────────────
  await T('api.cost', async () => {
    const r = await req('GET', '/api/cost?days=7');
    ok('api.cost.status', r.status === 200 && r.data.ok === true, `status=${r.status}`);
    ok('api.cost.byDay', Array.isArray(r.data.byDay) && r.data.byDay.length === 7, `n=${r.data.byDay?.length}`);
    ok('api.cost.byDay.shape',
      r.data.byDay.every((d) => d.date && typeof d.costCny === 'number' && typeof d.runs === 'number'
        && typeof d.tokensIn === 'number' && typeof d.tokensOut === 'number'));
    ok('api.cost.byExecutor', Array.isArray(r.data.byExecutor));
    ok('api.cost.topTasks', Array.isArray(r.data.topTasks) && r.data.topTasks.length <= 10);
    ok('api.cost.totals',
      r.data.totals && typeof r.data.totals.costCny === 'number'
        && typeof r.data.totals.runs === 'number' && typeof r.data.totals.tokens === 'number');
    ok('api.cost.budget', r.data.budget && typeof r.data.budget === 'object'
      && r.data.budgetProgress && typeof r.data.budgetProgress.ratio === 'number');

    const d1 = await req('GET', '/api/cost?days=1');
    ok('api.cost.days1', d1.status === 200 && d1.data.byDay.length === 1, `n=${d1.data?.byDay?.length}`);
    const d99 = await req('GET', '/api/cost?days=999');
    ok('api.cost.clamp', d99.status === 200 && d99.data.days === 90, `days=${d99.data?.days}`);
  });

  // ── 8. GET /api/setup/doctor ───────────────────────────────────
  await T('api.setup.doctor', async () => {
    const r = await req('GET', '/api/setup/doctor');
    ok('api.setup.doctor.status', r.status === 200 && r.data.ok !== undefined, `status=${r.status}`);
    const items = r.data.items || [];
    const ids = items.map((i) => i.id);
    const need = ['node', 'sqlite', 'db-writable', 'tables', 'executors', 'channels', 'disk', 'budget', 'daemon'];
    const missing = need.filter((n) => !ids.includes(n));
    ok('api.setup.doctor.cores', missing.length === 0, `missing=${missing.join(',') || '(none)'}`);
    ok('api.setup.doctor.status-values',
      items.every((i) => ['PASS', 'WARN', 'FAIL'].includes(i.status)),
      `statuses=${[...new Set(items.map((i) => i.status))].join('/')}`);
    ok('api.setup.doctor.fields',
      items.every((i) => typeof i.title === 'string' && typeof i.detail === 'string' && 'fix' in i));
    ok('api.setup.doctor.snapshot',
      ['PASS', 'WARN', 'FAIL'].includes(r.data.status)
        && r.data.summary && typeof r.data.summary.total === 'number'
        && r.data.env && typeof r.data.env.node === 'string');
    ok('api.setup.doctor.deps',
      Array.isArray(r.data.deps) && r.data.deps.length === 6
        && r.data.deps.every((x) => x.id && typeof x.ok === 'boolean' && 'pkg' in x),
      `deps=${(r.data.deps || []).map((x) => x.id).join(',')}`);
    ok('api.setup.doctor.installable',
      Array.isArray(r.data.installable) && r.data.installable.includes('dsh-cli')
        && !r.data.installable.includes('nodejs'),
      `installable=${(r.data.installable || []).join(',')}`);
    // 自检本身不应该产生 FAIL（进程能跑起来说明底座是好的）
    ok('api.setup.doctor.no-hard-fail',
      !(r.data.items || []).some((i) => i.id !== 'executors' && i.id !== 'tables' && i.status === 'FAIL'),
      `fail=${(r.data.items || []).filter((i) => i.status === 'FAIL').map((i) => i.id).join(',') || '(none)'}`);
  });

  // ── 9. POST /api/setup/install ─────────────────────────────────
  await T('api.setup.install', async () => {
    const node = await req('POST', '/api/setup/install', { id: 'nodejs' });
    ok('api.setup.install.nodejs', node.status === 200 && node.data.id === 'nodejs',
      `status=${node.status}`);
    ok('api.setup.install.nodejs-never-npm',
      node.data.cmd === null && (node.data.already === true || node.data.needManual === true),
      `already=${node.data?.already} needManual=${node.data?.needManual} cmd=${node.data?.cmd}`);
    if (node.data.needManual) ok('api.setup.install.nodejs-guide', Array.isArray(node.data.guide) && node.data.guide.length > 0);

    const bad = await req('POST', '/api/setup/install', { id: 'chrome' });
    ok('api.setup.install.bad-id', bad.status === 400 && typeof bad.data.error === 'string', `status=${bad.status}`);
    const empty = await req('POST', '/api/setup/install', {});
    ok('api.setup.install.empty-id', empty.status === 400, `status=${empty.status}`);
  });

  // ── 10. GET /api/deps + POST /api/deps/check ───────────────────
  let depsData = null;
  await T('api.deps', async () => {
    const r = await req('GET', '/api/deps');
    depsData = r.data;
    ok('api.deps.status', r.status === 200 && r.data.ok === true, `status=${r.status}`);
    const deps = r.data.deps || [];
    ok('api.deps.list', deps.length === 5, `n=${deps.length} ids=${deps.map((d) => d.id).join(',')}`);
    ok('api.deps.ids', ['dsh', 'pi', 'codex', 'claude', 'agently'].every((id) => deps.some((d) => d.id === id)));
    ok('api.deps.shape',
      deps.every((d) => d.pkg && d.purpose && d.fallback && d.docsUrl
        && typeof d.installed === 'boolean' && 'version' in d && 'latest' in d
        && Array.isArray(d.versions) && Array.isArray(d.versions)));
    ok('api.deps.versions-cap', deps.every((d) => d.versions.length <= 20),
      `max=${Math.max(0, ...deps.map((d) => d.versions.length))}`);
    ok('api.deps.registry',
      r.data.registry && typeof r.data.registry.requested === 'string'
        && r.data.registry.timeoutMs === 12000 && 'used' in r.data.registry);
    const metaFail = deps.filter((d) => d.metaError);
    ok('api.deps.meta-honest',
      metaFail.length === 0 || deps.every((d) => (d.metaError ? d.latest === null : true)),
      metaFail.length ? `${metaFail.length} 个包取不到元数据（latest=null，已如实标注）` : 'ok');
    ok('api.deps.summary',
      r.data.summary && r.data.summary.total === 5
        && typeof r.data.summary.installed === 'number' && typeof r.data.summary.updatable === 'number');

    const chk = await req('POST', '/api/deps/check', {});
    ok('api.deps.check', chk.status === 200 && (chk.data.deps || []).length === 5,
      `status=${chk.status} n=${(chk.data.deps || []).length} used=${chk.data.registry?.used}`);
  });

  // ── 11. 依赖动作：只用 dryRun / noop，绝不真的改本机全局包 ────────
  await T('api.deps.actions', async () => {
    const deps = (depsData && depsData.deps) || [];
    const target = deps.find((d) => d.installed) || deps[0] || { id: 'dsh' };

    const dry = await req('POST', `/api/deps/${target.id}/install`, { dryRun: true, version: '0.0.1-test' });
    ok('api.deps.install.dryrun',
      dry.status === 200 && dry.data.dryRun === true
        && typeof dry.data.cmd === 'string' && dry.data.cmd.startsWith('npm install -g ')
        && dry.data.before === dry.data.after,
      `cmd=${dry.data?.cmd}`);
    if (process.platform === 'win32') {
      ok('api.deps.install.win-cmd',
        Array.isArray(dry.data.argv) && /cmd\.exe$/i.test(dry.data.argv[0]),
        `argv0=${dry.data?.argv?.[0]}`);
    }

    if (target.installed && target.version) {
      const noop = await req('POST', `/api/deps/${target.id}/install`, { version: target.version });
      ok('api.deps.install.noop',
        noop.status === 200 && noop.data.noop === true && noop.data.cmd === null,
        `reason=${noop.data?.reason}`);
      ok('api.deps.install.noop-before-after',
        noop.data.before === noop.data.after && noop.data.before === target.version,
        `before=${noop.data?.before} after=${noop.data?.after}`);

      const unp = await req('POST', `/api/deps/${target.id}/uninstall`, {});
      if (target.required) {
        ok('api.deps.uninstall.required-guard',
          unp.status === 409 && typeof unp.data.error === 'string', `status=${unp.status}`);
        const unpDry = await req('POST', `/api/deps/${target.id}/uninstall`, { dryRun: true, confirm: true });
        ok('api.deps.uninstall.dryrun',
          unpDry.status === 200 && unpDry.data.dryRun === true
            && String(unpDry.data.cmd).startsWith('npm uninstall -g '),
          `cmd=${unpDry.data?.cmd}`);
      } else {
        ok('api.deps.uninstall.no-guard',
          unp.status === 200 && (unp.data.noop === true || unp.data.ok === true), `status=${unp.status}`);
      }
    }

    const upd = await req('POST', `/api/deps/${target.id}/update`, { dryRun: true });
    ok('api.deps.update.dryrun',
      upd.status === 200 && (upd.data.dryRun === true || upd.data.noop === true),
      `cmd=${upd.data?.cmd} noop=${upd.data?.noop}`);

    const nf = await req('POST', '/api/deps/nope/install', {});
    ok('api.deps.unknown-id', nf.status === 404 && typeof nf.data.error === 'string', `status=${nf.status}`);
    const badv = await req('POST', `/api/deps/${target.id}/install`, { version: '1.0.0; rm -rf /' });
    ok('api.deps.bad-version', badv.status === 400, `status=${badv.status}`);
    const badUn = await req('POST', `/api/deps/${target.id}/uninstall`, { confirm: true, version: '1.0.0' });
    ok('api.deps.uninstall-version-rejected', badUn.status === 400, `status=${badUn.status}`);

    const legacy = await req('POST', '/api/setup/install', { id: 'dsh-cli', dryRun: true });
    ok('api.setup.install.alias',
      legacy.status === 200 && legacy.data.aliasOf === '/api/deps/dsh/install',
      `aliasOf=${legacy.data?.aliasOf}`);

    // 审计：动作必须进 events 表
    const ev = await req('GET', '/api/events?limit=60');
    const types = (ev.data.events || []).map((e) => e.type);
    ok('api.deps.events',
      types.includes('dep.install') || types.includes('dep.uninstall'),
      `dep.*=${types.filter((t) => t.startsWith('dep.')).length}`);
  });

  // ── 12. POST /api/control/* ────────────────────────────────────
  await T('api.control', async () => {
    const start = await req('POST', '/api/control/start', { spawn: false });
    ok('api.control.start.honest',
      start.status === 200 && start.data.started === false
        && typeof start.data.cmd === 'string' && start.data.cmd.includes('hive.mjs')
        && typeof start.data.note === 'string',
      `started=${start.data?.started} note=${String(start.data?.note).slice(0, 40)}`);

    const stop = await req('POST', '/api/control/stop', {});
    ok('api.control.stop.idle',
      stop.status === 200 && stop.data.running === false && typeof stop.data.note === 'string',
      `note=${String(stop.data?.note).slice(0, 40)}`);

    // 伪造一个「死进程」锁文件：应当被判为 stale 并清理
    const lockPath = path.join(HOME, 'data', 'hive.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: new Date().toISOString(), argv: [] }), 'utf8');
    const stop2 = await req('POST', '/api/control/stop', {});
    ok('api.control.stop.stale',
      stop2.status === 200 && stop2.data.running === false && stop2.data.cleanedStaleLock === true
        && !fs.existsSync(lockPath),
      `cleaned=${stop2.data?.cleanedStaleLock}`);

    // 真有人想停：没有守护进程时不需要 confirm；有的话必须 409
    const scanList = await req('POST', '/api/control/scan', { list: true });
    ok('api.control.scan.list',
      scanList.status === 200 && scanList.data.mode === 'list' && Array.isArray(scanList.data.sensors),
      `sensors=${(scanList.data?.sensors || []).join(',')}`);

    const wrong = await req('GET', '/api/control/start');
    ok('api.control.405', wrong.status === 405, `status=${wrong.status}`);
  });

  // ── 13. 回归：旧接口仍在 ────────────────────────────────────────
  await T('api.regression', async () => {
    const d = await req('GET', '/api/doctor');
    ok('api.doctor.still-works', d.status === 200 && d.data.executors && d.data.db, `status=${d.status}`);
    const ov = await req('GET', '/api/overview');
    ok('api.overview.still-works', ov.status === 200 && ov.data.counts, `status=${ov.status}`);
    const nf = await req('GET', '/api/nope');
    ok('api.404', nf.status === 404 && typeof nf.data.error === 'string', `status=${nf.status}`);
  });
} catch (e) {
  fail('unexpected', e);
} finally {
  try { if (srv) await srv.close(); } catch { /* ignore */ }
  try { closeDb(); } catch { /* ignore */ }
  if (tmpHome && !ARGS.keep) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ } }
  if (tmpHome && ARGS.keep) console.log(`\n   临时 HOME 保留：${tmpHome}`);
}

const pass = results.filter((r) => r.pass).length;
const total = results.length;
const failed = results.filter((r) => !r.pass);
console.log(`\n合计: ${pass} PASS / ${failed.length} FAIL / ${total} 项`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  ✗ ${f.name}${f.extra ? '  ' + f.extra : ''}`);
  exitCode = 1;
}
process.exit(exitCode);
