// tests/e2e.mjs — 端到端闭环自测：信息发现 → 任务识别 → 自动规划 → 自主执行 → 人工确认 → 成果交付
// 使用隔离的 HIVE_HOME（data/e2e-home），不污染正式库。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const E2E_HOME = path.join(root, 'data', 'e2e-home');

// —— 必须在任何 import 之前设定 home ——
fs.rmSync(E2E_HOME, { recursive: true, force: true });
fs.mkdirSync(path.join(E2E_HOME, 'config'), { recursive: true });
for (const f of ['hive.json', 'policies.json']) {
  fs.copyFileSync(path.join(root, 'config', f), path.join(E2E_HOME, 'config', f));
}
// 测试环境把预算调小、并发调小，避免真花钱
const cfgPath = path.join(E2E_HOME, 'config', 'hive.json');
const cfgJson = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
cfgJson.settings.dailyBudgetCny = 2;
cfgJson.settings.maxConcurrentWorkers = 2;
cfgJson.notify = { toast: { enabled: false }, mail: { enabled: false }, dashboard: { enabled: true } };
cfgJson.server.port = 8899;
fs.writeFileSync(cfgPath, JSON.stringify(cfgJson, null, 2), 'utf8');
process.env.HIVE_HOME = E2E_HOME;

const results = [];
function ok(name, cond, extra = '') {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
}
const section = (t) => console.log(`\n──── ${t} ────`);

const db = await import('../src/core/db.mjs');
db.getDb();
const tc = await import('../src/task/taskcenter.mjs');
const tri = await import('../src/task/triage.mjs');
const router = await import('../src/task/router.mjs');
const worker = await import('../src/task/worker.mjs');
const wd = await import('../src/task/watchdog.mjs');
const ev = await import('../src/core/events.mjs');

// ============================================================
section('1. 信息发现与去重（Sensor → Item）');
{
  const raw = {
    source: 'mail', source_ref: 'e2e-msg-1',
    title: '客户催：合同附件什么时候给？', body: '对方在问合同附件的交付时间，语气偏急。',
    kind: 'email', domain: 'work', urgency: 4,
  };
  const a = tc.upsertItem(raw);
  const b = tc.upsertItem(raw); // 同一 source_ref 再感知一次
  ok('item.created', a.created === true, a.item.id);
  ok('item.dedupe', b.created === false && b.item.id === a.item.id);
  ok('item.priority>quiet', a.item.priority >= 6, `priority=${a.item.priority}`);
}

// ============================================================
section('2. 任务识别：L1–L5 判定');
let itemL4 = null;
{
  // L1：纯整理
  const l1 = await tri.triage({ title: '把这封邮件整理成三条待办', body: '内容略', source: 'mail', kind: 'fyi' }, { availableExecutors: ['llm', 'dsh'] });
  ok('triage.L1', l1.level === 1, `L${l1.level} conf=${l1.confidence} ${l1.reason.slice(0, 60)}`);

  // L2：分析建议
  const l2 = await tri.triage({ title: '分析这个项目该不该继续投入', body: '已有三个月，产出一般', source: 'manual', kind: 'decision' }, { availableExecutors: ['llm', 'dsh'] });
  ok('triage.L2', l2.level >= 1 && l2.level <= 3, `L${l2.level} ${l2.reason.slice(0, 60)}`);

  // 对外发送 → 必须审批
  const l4 = await tri.triage({ title: '回复邮件并把合同附件发给对方', body: '发送给 alice@example.com', source: 'mail', kind: 'todo' }, { availableExecutors: ['llm', 'dsh'] });
  ok('triage.sideEffect.needsApproval', l4.needApproval === true, `L${l4.level} action=${l4.primaryAction}`);
  ok('triage.sideEffect.capL4', l4.level <= 4, `L${l4.level}`);

  // 不可逆/对外 → 不允许 L5
  const del = await tri.triage({ title: '删除旧备份目录并清空回收站', body: '删除 D:\\backup 下所有文件', source: 'manual', kind: 'risk' }, { availableExecutors: ['llm', 'dsh'] });
  ok('triage.delete.needsApproval', del.needApproval === true, `L${del.level} action=${del.primaryAction}`);

  // 需要真实工具 → needsTools
  const tool = await tri.triage({ title: '读一下 D:\\hive\\src 下有哪些模块文件', body: '只读调查', source: 'manual', kind: 'todo' }, { availableExecutors: ['llm', 'dsh'] });
  ok('triage.needsTools', tool.needsTools === true, `L${tool.level} needsTools=${tool.needsTools}`);

  // 能力闸门：高等级但缺执行器 → 降 L2
  const noExec = await tri.triage({ title: '实现一个新功能并跑测试', body: '改代码', source: 'manual', kind: 'todo' }, { availableExecutors: [] });
  ok('triage.capabilityGate', noExec.level <= 2, `L${noExec.level} missing=${noExec.capabilitiesMissing.join(',')}`);

  itemL4 = tc.upsertItem({
    source: 'mail', source_ref: 'e2e-msg-2', dedupe_key: 'e2e|l4',
    title: '回复邮件并把合同附件发给对方', body: '发送给 alice@example.com，附上合同.pdf',
    kind: 'todo', domain: 'work',
  }).item;
}

// ============================================================
section('3. 人工确认闸门（Outbox → HITL）');
let apId = null;
{
  const r = await router.processItem(itemL4.id, { force: true });
  ok('router.escalate', r.route === 'escalate', `route=${r.route} L${r.triage?.level}`);
  apId = r.approval?.id || null;
  ok('approval.created', !!apId, apId || '');
  const ap = tc.getApproval(apId);
  ok('approval.pending', ap?.status === 'pending');
  ok('approval.hasOptions', JSON.parse(ap.options || '[]').length >= 2, `${JSON.parse(ap.options || '[]').length} 个选项`);
  ok('approval.hasRecommendation', !!ap.recommendation, String(ap.recommendation).slice(0, 40));
  const it = tc.getItem(itemL4.id);
  ok('item.movedToOutbox', it.bucket === 'outbox' && it.status === 'awaiting_human', `${it.bucket}/${it.status}`);
}

// ============================================================
section('4. 授权后继续推进（HITL 闭环）');
{
  tc.decideApproval(apId, { decision: 'approved', option: 'approve', note: 'e2e 批准' });
  const ap = tc.getApproval(apId);
  ok('approval.approved', ap.status === 'approved');
  const it = tc.getItem(itemL4.id);
  ok('item.afterApprove', it.status === 'planned' || it.status === 'running' || it.status === 'done', `${it.bucket}/${it.status}`);

  const r = await router.processItem(itemL4.id, { force: true, skipApproval: true });
  ok('router.afterApprove.dispatch', r.route === 'dispatch' || r.route === 'inline', `route=${r.route}`);
  if (r.tasks) ok('task.created', r.tasks.length >= 1, `${r.tasks.length} 个任务`);
}

// ============================================================
section('5. 自主执行（Worker → Run → Artifact）');
{
  const t = tc.createTask({
    item_id: itemL4.id, title: 'e2e 内联执行验证', goal: '用一句话回答：1+1 等于几。',
    executor: 'llm', autonomy_level: 2, timeout_sec: 120, budget_tokens: 5000,
  });
  const r = await worker.dispatchTask(t.id);
  ok('worker.executed', r.ok === true, r.error ? String(r.error).slice(0, 120) : r.runId);
  const after = tc.getTask(t.id);
  ok('task.succeeded', after.status === 'succeeded', `${after.status} cost=¥${after.cost_cny}`);
  ok('run.persisted', fs.existsSync(path.join(after.output_dir || '', 'prompt.txt')), after.output_dir || '');
  ok('run.resultFile', fs.existsSync(path.join(after.output_dir || '', 'result.json')));
  const runRow = db.q.get('SELECT * FROM runs WHERE task_id=? ORDER BY started_at DESC LIMIT 1', t.id);
  ok('run.recorded', !!runRow && runRow.status === 'ok', `${runRow?.status} ${runRow?.duration_ms}ms`);
}

// ============================================================
section('6. 异常恢复（Watchdog）');
{
  // 造一个「运行中但租约过期、进程已死」的任务
  const t = tc.createTask({ title: 'e2e 卡死任务', goal: '模拟卡死', executor: 'llm', autonomy_level: 2 });
  db.q.run("UPDATE tasks SET status='running', attempt=1, lease_until=?, started_at=? WHERE id=?",
    new Date(Date.now() - 3600e3).toISOString(), new Date(Date.now() - 3600e3).toISOString(), t.id);
  db.q.run("INSERT INTO runs(id,task_id,attempt,executor,started_at,status,pid) VALUES(?,?,?,?,?,?,?)",
    'run_e2e_stuck', t.id, 1, 'llm', new Date(Date.now() - 3600e3).toISOString(), 'running', 999999);
  const rec = wd.recover();
  const after = tc.getTask(t.id);
  ok('watchdog.recovered', rec.some((x) => x.id === t.id), `${rec.length} 个被回收`);
  ok('watchdog.requeued', after.status === 'queued' || after.status === 'failed', after.status);
}

// ============================================================
section('7. 预算护栏');
{
  // 直接塞一条贵的 run 记录，验证 ratio 计算与拦截
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  db.q.run('INSERT INTO runs(id,task_id,attempt,executor,started_at,status,cost_cny) VALUES(?,?,?,?,?,?,?)',
    'run_e2e_cost', 'tsk_x', 1, 'llm', new Date().toISOString(), 'ok', 2.5);
  const c = tc.todayCost();
  ok('budget.tracked', c.costCny >= 2.5, `¥${c.costCny}/¥${c.budget} ratio=${c.ratio}`);
  ok('budget.over', c.ratio >= 1, `ratio=${c.ratio}`);
  const t = tc.createTask({ title: 'e2e 预算拦截', goal: 'x', executor: 'llm' });
  const r = await router.processItem(
    tc.upsertItem({ source: 'manual', source_ref: 'e2e-budget', dedupe_key: 'e2e|budget', title: '预算超限时不该再派单', body: 'z', kind: 'todo' }).item.id,
    { force: false }
  );
  ok('budget.blocks', r.route === 'skip' && /budget/.test(String(r.error || '')), `route=${r.route} err=${r.error}`);
}

// ============================================================
section('8. 事件流（看板 SSE 数据源）');
{
  let got = null;
  const un = ev.subscribe((e) => { if (e.type === 'e2e.ping') got = e; });
  ev.emit({ actor: 'system', type: 'e2e.ping', message: 'hello' });
  un();
  ok('events.subscribe', !!got, got ? `id=${got.id}` : '');
  const rows = ev.recent({ limit: 5 });
  ok('events.persisted', rows.length > 0, `${rows.length} 条`);
}

// ============================================================
section('9. HTTP API（看板后端）');
{
  const srv = await import('../src/server/http.mjs');
  const h = await srv.startServer({ port: 8899 });
  const base = 'http://127.0.0.1:8899';
  const j = async (p) => (await fetch(base + p)).json();
  const health = await j('/api/health');
  ok('api.health', health.ok === true, `v${health.version}`);
  const ov = await j('/api/overview');
  ok('api.overview', ov.ok === true, `inbox=${ov.counts?.inbox} outbox=${ov.counts?.outbox}`);
  const items = await j('/api/items?limit=5');
  ok('api.items', Array.isArray(items.items ?? items.data?.items ?? items) || items.ok === true, JSON.stringify(Object.keys(items || {})).slice(0, 80));
  const aps = await j('/api/approvals?status=all');
  ok('api.approvals', aps.ok === true || Array.isArray(aps));
  const html = await (await fetch(base + '/')).text();
  ok('web.index', /<html/i.test(html) && html.length > 500, `${html.length} bytes`);
  if (h?.close) await h.close();
}

// ============================================================
section('10. 交付物与可回溯');
{
  const arts = db.q.all('SELECT * FROM artifacts');
  ok('artifacts.or.runs', arts.length > 0 || db.q.get('SELECT COUNT(*) n FROM runs')?.n > 0, `artifacts=${arts.length}`);
  const res = tc.listTasks({ limit: 50 });
  const withResult = res.filter((t) => t.result);
  ok('task.results', withResult.length > 0, `${withResult.length}/${res.length} 有结果`);
  const evCount = db.q.get('SELECT COUNT(*) n FROM events')?.n ?? 0;
  ok('events.traceable', evCount >= 10, `${evCount} 条事件`);
}

// ============================================================
const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);
console.log(`\n========================================`);
console.log(`E2E: ${passed}/${results.length} PASS`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  - ${f.name}  ${f.extra}`);
}
console.log(`数据目录: ${E2E_HOME}`);
process.exit(failed.length ? 1 : 0);
