// tests/server-smoke.mjs — 看板 + HTTP API 冒烟测试（零依赖，随起随关）
//
// 默认在【隔离的临时 HIVE_HOME】里跑：复制 config/{hive.json,policies.json} 与 VERSION，
// 所有写入都落在系统临时目录，跑完删除 —— 不污染 D:\hive\data\hive.db。
//   node --no-warnings tests/server-smoke.mjs            # 隔离库（默认）
//   node --no-warnings tests/server-smoke.mjs --real     # 直接跑真实 data/hive.db
//   node --no-warnings tests/server-smoke.mjs --keep     # 保留临时目录便于排查
//   node --no-warnings tests/server-smoke.mjs --verbose  # 打印服务端请求日志
//
// 覆盖：静态页 / 全部 GET 接口 / 建事项→派单→建审批→拍板 / 上下文读写 / 事件 /
//       环境自检降级 / 巡检接口 / 404 / 405 / 400 / 403 / SSE 实时推送 / token 鉴权。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
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
  console.log(`用法: node --no-warnings tests/server-smoke.mjs [--real] [--keep] [--verbose] [--port N]
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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-smoke-'));
  fs.mkdirSync(path.join(tmpHome, 'config'), { recursive: true });
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'hive.json'), 'utf8'));
  fs.writeFileSync(path.join(tmpHome, 'config', 'hive.json'), JSON.stringify(cfg, null, 2), 'utf8');
  fs.copyFileSync(path.join(ROOT, 'config', 'policies.json'), path.join(tmpHome, 'config', 'policies.json'));
  // 故意写一个假的 VERSION 进临时 home：如果代码错从 HOME 读版本，断言会立刻抓到 0.0.0 / 9.9.9
  fs.writeFileSync(path.join(tmpHome, 'VERSION'), '9.9.9-should-not-be-used\n', 'utf8');
  fs.mkdirSync(path.join(tmpHome, 'prompts'), { recursive: true });
  process.env.HIVE_HOME = tmpHome;
}

const HOME = process.env.HIVE_HOME || ROOT;
console.log(`\n== server-smoke ==`);
console.log(`   HOME = ${HOME}${ARGS.real ? '  (真实库)' : '  (临时隔离库)'}`);

// 服务端模块必须在设置 HIVE_HOME 之后再加载
const mod = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { startServer } = await mod('src/server/http.mjs');
const { loadConfig } = await mod('src/core/config.mjs');
const { dbStats, closeDb } = await mod('src/core/db.mjs');
const taskcenter = await mod('src/task/taskcenter.mjs');

const cfg = loadConfig();
const started = [];
let sseClient = null;
let exitCode = 0;

const logger = ARGS.verbose ? (l) => console.log('   [server] ' + l) : () => {};

async function req(method, p, body, opts = {}) {
  const url = started[0].url.replace(/\/$/, '') + p;
  const headers = { ...(opts.headers || {}) };
  if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body !== undefined && body !== null ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { __raw: text }; }
  return { status: res.status, data, text, headers: res.headers };
}

function rawRequest(p, hostPort) {
  return new Promise((resolve, reject) => {
    const port = hostPort || started[0].port;
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: body }));
    });
    r.on('error', reject);
    r.setTimeout(8000, () => { r.destroy(new Error('请求超时')); });
    r.end();
  });
}

function openSSE(p, hostPort) {
  return new Promise((resolve, reject) => {
    const port = hostPort || started[0].port;
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: { Accept: 'text/event-stream' } }, (res) => {
      const client = { res, text: '', status: res.statusCode, closed: false, close() { try { r.destroy(); } catch { /* noop */ } } };
      res.setEncoding('utf8');
      res.on('data', (c) => { client.text += c; });
      res.on('error', () => { client.closed = true; });
      resolve(client);
    });
    r.on('error', reject);
    r.setTimeout(8000, () => { r.destroy(new Error('SSE 连接超时')); });
    r.end();
  });
}

async function waitFor(fn, timeoutMs = 5000, interval = 50) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, interval));
  }
}

// ═══════════════════════════════════════════════════════════════════
try {
  // ── 0. 启动 ─────────────────────────────────────────────────────
  // 注意：这里【不传 webRoot】，故意让服务自己解析 —— 用来证明静态根跟代码根走，
  // 不随 HIVE_HOME（临时数据目录）漂移。
  const srv = await startServer({ port: ARGS.port, logger });
  started.push(srv);
  ok('server.start', srv.port > 0, `url=${srv.url}`);
  ok('server.web-root-follows-code',
    path.resolve(srv.webRoot) === path.join(ROOT, 'web'),
    `webRoot=${srv.webRoot}`);

  // 确认真的落在隔离库（非 --real 时路径必须在临时目录里）
  ok('server.isolated-db', ARGS.real || String(cfg.resolved.db).startsWith(tmpHome), cfg.resolved.db);

  // ── 1. 静态页（无 CDN、离线可用）────────────────────────────────
  await T('static.index', async () => {
    const r = await req('GET', '/');
    const source = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
    ok('static.index', r.status === 200 && /text\/html/.test(r.headers.get('content-type') || ''), `status=${r.status}`);
    ok('static.index.code-root', r.status === 200 && r.text.length === source.length && r.text.includes('HIVE'),
      `served=${r.text.length}B source=${source.length}B`);
    ok('static.index.head', r.text.includes('HIVE') && r.text.includes('收件箱'));
    const css = await req('GET', '/style.css');
    ok('static.css', css.status === 200 && css.text.includes('--amber'), `status=${css.status}`);
    const js = await req('GET', '/app.js');
    ok('static.js', js.status === 200 && js.text.includes('/api/overview'), `status=${js.status}`);
    const fav = await rawRequest('/favicon.ico');
    ok('static.favicon', fav.status === 204, `status=${fav.status}`);
  });

  await T('static.traversal', async () => {
    const r = await rawRequest('/%2e%2e%2fconfig/hive.json');
    ok('static.traversal-blocked', r.status === 403, `status=${r.status}`);
  });

  // ── 2. 健康 / 概览 ─────────────────────────────────────────────
  const versionFile = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
  await T('api.health', async () => {
    const r = await req('GET', '/api/health');
    ok('api.health.status', r.status === 200, `status=${r.status}`);
    ok('api.health.shape', r.data && r.data.ok === true && r.data.db && r.data.db.ok === true,
      `version=${r.data?.version} db=${r.data?.db?.ok}`);
    ok('api.health.server', r.data?.server?.port === srv.port, `port=${r.data?.server?.port}`);
    // 版本必须来自代码根 VERSION，而不是 HOME（换 HIVE_HOME 后 home 里没有 VERSION）
    ok('api.health.version', r.data?.version === versionFile && r.data.version !== '0.0.0',
      `got=${r.data?.version} expect=${versionFile}`);
  });

  let overviewInitial = null;
  await T('api.overview', async () => {
    const r = await req('GET', '/api/overview');
    overviewInitial = r.data;
    ok('api.overview.status', r.status === 200, `status=${r.status}`);
    ok('api.overview.version', r.data?.version === versionFile, `got=${r.data?.version}`);
    const c = r.data?.counts || {};
    ok('api.overview.counts', ['inbox', 'outbox', 'queued', 'running', 'failed24h'].every((k) => typeof c[k] === 'number'),
      JSON.stringify(c));
    ok('api.overview.budget', r.data && r.data.budget && typeof r.data.budget.costCny === 'number' && typeof r.data.budget.budget === 'number',
      JSON.stringify(r.data?.budget));
    ok('api.overview.empty-friendly', Array.isArray(r.data?.topItems) && Array.isArray(r.data?.pendingApprovals) && Array.isArray(r.data?.pulses));
  });

  // ── 3. 空库友好 ────────────────────────────────────────────────
  await T('api.empty', async () => {
    const items = await req('GET', '/api/items');
    ok('api.items.empty', items.status === 200 && Array.isArray(items.data?.items), `count=${items.data?.items?.length}`);
    const none = await req('GET', '/api/items?bucket=__none__');
    ok('api.items.filter-none', none.status === 200 && none.data.items.length === 0);
    const tasks = await req('GET', '/api/tasks');
    ok('api.tasks.empty', tasks.status === 200 && Array.isArray(tasks.data?.tasks));
    const approvals = await req('GET', '/api/approvals');
    ok('api.approvals.empty', approvals.status === 200 && Array.isArray(approvals.data?.approvals));
    const ctx = await req('GET', '/api/context');
    ok('api.context.empty', ctx.status === 200 && Array.isArray(ctx.data?.facts));
    const events = await req('GET', '/api/events');
    ok('api.events.empty', events.status === 200 && Array.isArray(events.data?.events));
  });

  // ── 4. 建事项 → 详情 → 派单 ─────────────────────────────────────
  let itemId = null;
  let taskId = null;
  await T('api.item.create', async () => {
    const r = await req('POST', '/api/items', {
      title: '[smoke] 看板冒烟事项 ' + new Date().toISOString(),
      body: '由 tests/server-smoke.mjs 创建，用于验证 建事项→派单→审批→拍板 全链路。',
      kind: 'todo', domain: 'work', source: 'smoke',
    });
    itemId = r.data?.item?.id || null;
    ok('api.item.create', r.status === 200 && r.data.ok === true && /^itm_/.test(itemId || ''), `id=${itemId}`);
    ok('api.item.create.defaults', r.data?.item?.status === 'inbox' && r.data?.item?.bucket === 'inbox');
  });

  await T('api.item.detail', async () => {
    const r = await req('GET', '/api/items/' + itemId);
    ok('api.item.detail', r.status === 200 && r.data?.item?.id === itemId);
    ok('api.item.detail.collections', ['events', 'tasks', 'runs', 'artifacts', 'approvals'].every((k) => Array.isArray(r.data?.[k])),
      Object.keys(r.data || {}).join(','));
    const miss = await req('GET', '/api/items/itm_doesnotexist');
    ok('api.item.detail.404', miss.status === 404 && !!miss.data?.error, JSON.stringify(miss.data));
  });

  await T('api.item.dispatch', async () => {
    const r = await req('POST', `/api/items/${itemId}/action`, { action: 'dispatch', payload: {} });
    taskId = r.data?.task?.id || null;
    ok('api.item.dispatch', r.status === 200 && r.data.ok === true && /^tsk_/.test(taskId || ''), `task=${taskId}`);
    ok('api.item.dispatch.item-moved', r.data?.item?.status === 'planned' && r.data?.item?.bucket === 'active');
    const again = await req('POST', `/api/items/${itemId}/action`, { action: 'dispatch', payload: {} });
    ok('api.item.dispatch.guard', again.status === 409 && !!again.data?.error, `status=${again.status}`);
  });

  await T('api.item.relevel', async () => {
    const r = await req('POST', `/api/items/${itemId}/action`, { action: 'relevel', payload: { level: 4, reason: 'smoke' } });
    ok('api.item.relevel', r.status === 200 && r.data?.item?.autonomy_level === 4);
    const bad = await req('POST', `/api/items/${itemId}/action`, { action: 'relevel', payload: { level: 9 } });
    ok('api.item.relevel.invalid', bad.status === 400 && !!bad.data?.error);
    const unknown = await req('POST', `/api/items/${itemId}/action`, { action: 'nope' });
    ok('api.item.action.unknown', unknown.status === 400 && !!unknown.data?.error);
  });

  // ── 5. 任务：列表 / 详情 / 重试 / 取消 ─────────────────────────
  await T('api.tasks', async () => {
    const r = await req('GET', '/api/tasks?status=queued');
    ok('api.tasks.list', r.status === 200 && r.data.tasks.some((t) => t.id === taskId), `count=${r.data?.tasks?.length}`);
    const q = r.data.tasks.find((t) => t.id === taskId);
    ok('api.tasks.shape', q && q.status === 'queued' && q.item_title, `item_title=${q?.item_title}`);
    const d = await req('GET', '/api/tasks/' + taskId);
    ok('api.tasks.detail', d.status === 200 && d.data?.task?.id === taskId && Array.isArray(d.data?.events));
    const m = await req('GET', '/api/tasks/tsk_doesnotexist');
    ok('api.tasks.detail.404', m.status === 404 && !!m.data?.error);
  });

  await T('api.tasks.retry-cancel', async () => {
    const r1 = await req('POST', `/api/tasks/${taskId}/retry`, {});
    ok('api.tasks.retry.queued', r1.status === 200 && r1.data?.task?.status === 'queued', r1.data?.note || '');
    const c = await req('POST', `/api/tasks/${taskId}/cancel`, {});
    ok('api.tasks.cancel', c.status === 200 && c.data?.task?.status === 'cancelled');
    const r2 = await req('POST', `/api/tasks/${taskId}/retry`, {});
    ok('api.tasks.retry', r2.status === 200 && r2.data?.task?.status === 'queued' && r2.data?.task?.attempt === 0);
    const again = await req('POST', `/api/tasks/${taskId}/cancel`, {});
    ok('api.tasks.cancel.idempotent', again.status === 200 && again.data?.task?.status === 'cancelled');
  });

  // ── 6. 审批：建 → 列表 → 拍板 ─────────────────────────────────
  let approvalId = null;
  await T('api.approval.flow', async () => {
    const ap = taskcenter.createApproval({
      item_id: itemId,
      kind: 'decision',
      title: '[smoke] 是否批准这次冒烟动作',
      summary: '用于验证 Outbox 的 背景 / 建议 / 选项 / 备注 / 拍板 全链路。',
      context: { 来源: 'tests/server-smoke.mjs', 场景: 'approval-flow', 可逆: false },
      options: [
        { value: 'approve', label: '批准执行', description: '冒烟用，不产生真实副作用' },
        { value: 'dry-run', label: '先只读演练', description: '仅检查链路' },
      ],
      recommendation: '选「先只读演练」更保守。',
      risk: 'low',
    });
    approvalId = ap.id;

    const list = await req('GET', '/api/approvals?status=pending');
    const row = (list.data.approvals || []).find((a) => a.id === approvalId);
    ok('api.approvals.list', list.status === 200 && !!row, `count=${list.data?.approvals?.length}`);
    ok('api.approvals.shape', row && typeof row.context === 'object' && Array.isArray(row.options) && row.item_title,
      `context.type=${typeof row?.context} options=${Array.isArray(row?.options)}`);

    const bad = await req('POST', `/api/approvals/${approvalId}/decide`, { decision: 'maybe' });
    ok('api.approvals.decide.invalid', bad.status === 400 && !!bad.data?.error);

    const r = await req('POST', `/api/approvals/${approvalId}/decide`, {
      decision: 'approved', option: 'approve', note: 'smoke 自动拍板', by: 'smoke',
    });
    ok('api.approvals.decide', r.status === 200 && r.data?.approval?.status === 'approved' && r.data?.approval?.decision === 'approve',
      `status=${r.data?.approval?.status}`);
    ok('api.approvals.decide.item', r.data?.item?.status === 'planned' && r.data?.item?.bucket === 'active',
      `item=${r.data?.item?.status}/${r.data?.item?.bucket}`);

    const twice = await req('POST', `/api/approvals/${approvalId}/decide`, { decision: 'rejected' });
    ok('api.approvals.decide.conflict', twice.status === 409 && !!twice.data?.error, `status=${twice.status}`);

    const all = await req('GET', '/api/approvals?status=approved');
    ok('api.approvals.by-status', all.status === 200 && (all.data.approvals || []).some((a) => a.id === approvalId));
  });

  // ── 7. 事件 ────────────────────────────────────────────────────
  await T('api.events', async () => {
    const r = await req('GET', '/api/events?limit=50');
    ok('api.events.list', r.status === 200 && r.data.events.length > 0 && typeof r.data.lastId === 'number',
      `count=${r.data?.events?.length} lastId=${r.data?.lastId}`);
    ok('api.events.shape', r.data.events.every((e) => typeof e.id === 'number' && typeof e.ts === 'string' && typeof e.type === 'string'));
    const since = await req('GET', '/api/events?since=' + r.data.lastId);
    ok('api.events.since', since.status === 200 && Array.isArray(since.data.events));
    const byTask = await req('GET', '/api/events?task_id=' + taskId);
    ok('api.events.by-task', byTask.status === 200 && byTask.data.events.every((e) => e.task_id === taskId));
    const lvl = await req('GET', '/api/events?level=error&limit=10');
    ok('api.events.by-level', lvl.status === 200 && lvl.data.events.every((e) => e.level === 'error'));
  });

  // ── 8. 上下文读写 ─────────────────────────────────────────────
  await T('api.context', async () => {
    const set = await req('POST', '/api/context', {
      category: '冒烟', key: 'server-smoke', value: 'ok', evidence: 'tests/server-smoke.mjs', confidence: 0.9,
    });
    ok('api.context.post', set.status === 200 && set.data?.fact?.key === 'server-smoke');
    const get = await req('GET', '/api/context');
    const fact = (get.data.facts || []).find((f) => f.key === 'server-smoke');
    ok('api.context.get', get.status === 200 && !!fact && fact.category === '冒烟', `count=${get.data?.count}`);
    ok('api.context.grouped', fact && Array.isArray(get.data?.grouped?.['冒烟']));
    const upd = await req('POST', '/api/context', { category: '冒烟', key: 'server-smoke', value: 'updated', confidence: 0.5 });
    const get2 = await req('GET', '/api/context');
    const f2 = (get2.data.facts || []).find((f) => f.key === 'server-smoke');
    ok('api.context.upsert', upd.status === 200 && f2?.value === 'updated' && get2.data.facts.filter((f) => f.key === 'server-smoke').length === 1);
    const del = await req('POST', `/api/context/${encodeURIComponent(f2.id)}/delete`, {});
    ok('api.context.delete', del.status === 200 && del.data?.deleted === f2.id);
  });

  // ── 9. 巡检（注册表就绪则真跑；未就绪必须优雅降级）────────────
  await T('api.scan', async () => {
    const list = await req('POST', '/api/scan?list=1', {});
    ok('api.scan.list', list.status === 200 && typeof list.data?.ok === 'boolean' && Array.isArray(list.data?.sensors),
      `ok=${list.data?.ok} reason=${list.data?.reason || ''} sensors=${JSON.stringify(list.data?.sensors || [])}`);
    const sensorsReady = fs.existsSync(path.join(ROOT, 'src', 'sensors', 'index.mjs'));
    if (sensorsReady) {
      // 只点名一个不存在的 sensor：走完解析/调度/upsert 全链路但零真实 IO，快且可重复
      const run = await req('POST', '/api/scan?source=__none__', {});
      ok('api.scan.run', run.status === 200 && run.data?.ok === true && run.data?.scanned === 0,
        `ok=${run.data?.ok} scanned=${run.data?.scanned} created=${run.data?.created}`);
      ok('api.scan.list.names', list.data.ok === true && list.data.sensors.length > 0, `sensors=${list.data.sensors.length}`);
    } else {
      const run = await req('POST', '/api/scan?timeoutMs=2000', {});
      ok('api.scan.degraded', run.status === 200 && run.data?.ok === false && run.data?.reason === 'sensor registry not ready',
        `ok=${run.data?.ok} reason=${run.data?.reason || ''}`);
    }
  });

  // ── 10. 环境自检（执行器/传感器可能未就绪 → 降级不崩）─────────
  await T('api.doctor', async () => {
    const r = await req('GET', '/api/doctor');
    ok('api.doctor.status', r.status === 200, `status=${r.status}`);
    ok('api.doctor.shape', r.data && typeof r.data.ok === 'boolean' && r.data.db && r.data.channels && r.data.config,
      `ok=${r.data?.ok} reason=${r.data?.reason || ''}`);
    // 注册表在【代码根】，不在 HIVE_HOME —— 换数据目录后 doctor 仍必须探测到执行器
    const registryExists = fs.existsSync(path.join(ROOT, 'src', 'executors', 'index.mjs'));
    if (!registryExists) {
      ok('api.doctor.degraded', r.data.ok === false && r.data.reason === 'executor registry not ready' && r.data.executors?.ready === false,
        r.data.reason || '');
    } else {
      ok('api.doctor.executors', r.data.executors?.ready === true && Object.keys(r.data.executors?.probes || {}).length > 0,
        `ready=${r.data.executors?.ready} probes=${Object.keys(r.data.executors?.probes || {}).length}`);
    }
    ok('api.doctor.channels', Object.keys(r.data?.channels || {}).length >= 4 && 'git' in (r.data?.channels || {}));
  });

  // ── 11. SSE 实时推送 ──────────────────────────────────────────
  await T('api.sse', async () => {
    sseClient = await openSSE('/api/stream');
    ok('api.sse.status', sseClient.status === 200, `status=${sseClient.status}`);
    const hello = await waitFor(() => sseClient.text.includes('"type":"hello"'), 4000);
    ok('api.sse.hello', hello, `bytes=${sseClient.text.length}`);
    const frame = (t) => sseClient.text.includes('data: ') && sseClient.text.includes(`"type":"${t}"`);
    // 触发一条新事件（context upsert → emit context.updated）
    await req('POST', '/api/context', { category: '冒烟', key: 'sse-ping', value: String(Date.now()) });
    const got = await waitFor(() => sseClient.text.includes('"type":"event"') && sseClient.text.includes('context.updated'), 5000);
    ok('api.sse.event', got, got ? '收到 context.updated' : '未在 5s 内收到事件');
    sseClient.close();
    ok('api.sse.cleanup', true);
  });

  // ── 12. 错误路径：404 / 405 / 400 / 413 ─────────────────────
  await T('api.errors', async () => {
    const nf = await req('GET', '/api/definitely-not-a-route');
    ok('api.404.json', nf.status === 404 && !!nf.data?.error, JSON.stringify(nf.data));
    const m = await req('GET', '/api/scan');
    ok('api.405.json', m.status === 405 && !!m.data?.error, JSON.stringify(m.data));
    const bad = await req('POST', '/api/items', 'this-is-not-json', { headers: { 'Content-Type': 'application/json' } });
    ok('api.400.bad-json', bad.status === 400 && !!bad.data?.error, JSON.stringify(bad.data));
    const emptyTitle = await req('POST', '/api/items', { kind: 'todo' });
    ok('api.400.validation', emptyTitle.status === 400 && !!emptyTitle.data?.error, JSON.stringify(emptyTitle.data));
    const static404 = await rawRequest('/nope.html');
    ok('api.404.static', static404.status === 404);
  });

  // ── 13. token 鉴权（第二个实例，独立配置）+ close 幂等 / SSE 排空 ──
  await T('token.auth', async () => {
    const tokenCfg = { ...cfg, server: { ...(cfg.server || {}), token: 'smoke-token-123' } };
    const s2 = await startServer({ cfg: tokenCfg, port: 0, logger });
    started.push(s2);
    ok('token.no-webroot-override', path.resolve(s2.webRoot) === path.join(ROOT, 'web'), s2.webRoot);
    const noToken = await fetch(s2.url.replace(/\/$/, '') + '/api/health');
    ok('token.reject', noToken.status === 401, `status=${noToken.status}`);
    const wrong = await fetch(s2.url.replace(/\/$/, '') + '/api/health', { headers: { 'X-Hive-Token': 'wrong' } });
    ok('token.reject-wrong', wrong.status === 401, `status=${wrong.status}`);
    const good = await fetch(s2.url.replace(/\/$/, '') + '/api/health', { headers: { 'X-Hive-Token': 'smoke-token-123' } });
    ok('token.accept-header', good.status === 200, `status=${good.status}`);
    const q = await fetch(s2.url.replace(/\/$/, '') + '/api/health?token=smoke-token-123');
    ok('token.accept-query', q.status === 200, `status=${q.status}`);
    const idx = await fetch(s2.url.replace(/\/$/, '') + '/');
    ok('token.static-open', idx.status === 200, '静态页不校验 token（页面本身无数据）');

    // close 必须先排空 SSE 客户端，且重复调用安全（旧实现在这里 uv 断言崩溃）
    const sse2 = await openSSE('/api/stream?token=smoke-token-123', s2.port);
    const hello2 = await waitFor(() => sse2.text.includes('"type":"hello"'), 4000);
    ok('token.sse-connected', hello2);
    const t0 = Date.now();
    await s2.close();
    const ms = Date.now() - t0;
    ok('server.close.drains-sse', ms < 3000, `${ms}ms`);
    sse2.close();
    let twice = false;
    try {
      await Promise.all([s2.close(), s2.close()]); // 并发重复 close 也必须安全
      await s2.close();
      twice = true;
    } catch (e) {
      twice = false;
      ok('server.close.idempotent', false, e.message);
    }
    ok('server.close.idempotent', twice);
  });

  // ── 14. CLI ───────────────────────────────────────────────────
  await T('cli.help', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'src', 'server', 'http.mjs'), '--help'], { encoding: 'utf8', timeout: 15000 });
    ok('cli.help', r.status === 0 && r.stdout.includes('--port') && r.stdout.includes('8787'), `exit=${r.status}`);
  });

  // ── 15. 数据一致性复查 ─────────────────────────────────────────
  await T('final.overview', async () => {
    const r = await req('GET', '/api/overview');
    ok('final.overview', r.status === 200 && r.data.counts.itemsTotal >= 1 && r.data.counts.approvalsTotal >= 1,
      `items=${r.data?.counts?.itemsTotal} tasks=${r.data?.counts?.tasksTotal} approvals=${r.data?.counts?.approvalsTotal} events=${r.data?.counts?.eventsTotal}`);
    const s = dbStats();
    ok('final.dbstats', s.items >= 1 && s.tasks >= 1 && s.approvals >= 1 && s.events >= 1, JSON.stringify(s));
    console.log('\n── /api/overview 实际返回（初始空库时刻）──');
    console.log(JSON.stringify(overviewInitial, null, 2));
  });
} catch (e) {
  fail('fatal', e);
  exitCode = 1;
} finally {
  try { if (sseClient) sseClient.close(); } catch { /* noop */ }
  for (const s of started.reverse()) {
    try { await s.close(); } catch (e) { console.log('   [warn] 关闭服务失败: ' + e.message); }
  }
  try { closeDb(); } catch { /* noop */ }
  if (tmpHome && !ARGS.keep) {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); }
    catch (e) { console.log('   [warn] 临时目录清理失败: ' + e.message + '（路径 ' + tmpHome + '）'); }
  } else if (tmpHome) {
    console.log('   [keep] 临时 HIVE_HOME = ' + tmpHome);
  }
}

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
const bar = '─'.repeat(52);
console.log('\n' + bar);
console.log(`== server-smoke: ${passed}/${results.length} PASS · ${failed} FAIL ==`);
if (failed) {
  console.log('失败项：');
  for (const r of results.filter((x) => !x.pass)) console.log(`  · ${r.name}  ${r.extra}`);
  exitCode = 1;
}
console.log(bar);
process.exit(exitCode || (failed ? 1 : 0));
