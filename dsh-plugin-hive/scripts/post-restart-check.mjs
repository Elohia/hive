// dsh-plugin-hive/scripts/post-restart-check.mjs — 重启 DSH 之后跑它
//
// 做四件事：
//   1. 自动找到当前 DSH Web 端口（端口每次重启会变）
//   2. 验证宿主模型已接上（model.ready / model.from）
//   3. 把临时关掉的 4 个 LLM 脉冲重新打开（triage / 早晚报 / 上下文）
//   4. 触发一次真实巡检，确认不再出现「脉冲超时」
//
// 用法：node --no-warnings dsh-plugin-hive/scripts/post-restart-check.mjs [--port 30494] [--keep-off]
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i === -1 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };

const PAUSED = ['pulse-triage', 'pulse-digest-morning', 'pulse-digest-evening', 'pulse-context'];
const results = [];
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond, extra }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

/** 找到当前 DSH Web 端口 */
function findPorts() {
  const explicit = flag('port');
  if (explicit) return [Number(explicit)];
  const ports = [];
  try {
    const ps = `Get-NetTCPConnection -State Listen | Select-Object -ExpandProperty LocalPort | Sort-Object -Unique`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 15000 });
    for (const line of out.split(/\r?\n/)) {
      const p = Number(line.trim());
      if (Number.isInteger(p) && p > 1024 && p < 65535) ports.push(p);
    }
  } catch { /* 忽略 */ }
  return ports;
}

async function probe(port) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1500);
    const r = await fetch(`http://127.0.0.1:${port}/hive/api/plugin/status`, { signal: ac.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.mode === 'plugin' ? { port, status: j } : null;
  } catch { return null; }
}

async function findServer() {
  const ports = findPorts();
  for (const p of ports) {
    const hit = await probe(p);
    if (hit) return hit;
  }
  return null;
}

const base = (port) => `http://127.0.0.1:${port}/hive/api`;

console.log('… 查找 DSH Web 端口');
const found = await findServer();
if (!found) {
  console.error('✗ 没找到任何在跑的 HIVE 插件实例（DSH 起了吗？插件启用了吗？）');
  process.exit(2);
}
const { port, status } = found;
console.log(`✓ 端口 ${port}  phase=${status.phase}`);
ok('plugin.alive', status.phase === 'ready' || status.phase === 'starting', status.phase);
ok('engine.running', !!(status.engine && status.engine.running), `ticks=${status.engine?.ticks}`);
ok('engine.no_stale_error', !status.engine?.lastError, String(status.engine?.lastError || ''));
ok('engine.has_tick_mutex', typeof status.engine?.ticking === 'boolean', '新引擎才有 ticking 字段');

ok('model.ready', status.model?.ready === true, `current=${status.model?.current || '-'} from=${status.model?.from || '-'} err=${String(status.model?.error || '').slice(0, 80)}`);

// 模型诊断（新接口；旧代码会 404，不作为失败项）
try {
  const m = await (await fetch(base(port) + '/plugin/models')).json();
  ok('model.diagnostic', m.ok === true, `resolved=${JSON.stringify(m.resolved || null)}`);
  if (m.ok) console.log('   selection:', JSON.stringify(m.selectionPicked || m.selection || null));
} catch (e) {
  ok('model.diagnostic', false, `接口不可用：${String(e.message).slice(0, 60)}`);
}

if (!status.model?.ready) {
  console.log('\n模型还没接上：先看上面的 error；可以手工钉住：');
  console.log(`  curl -X POST ${base(port)}/plugin/model -H "content-type: application/json" -d "{\\"provider\\":\\"deepseek-official\\",\\"model\\":\\"deepseek-flash\\"}"`);
}

// 重新打开临时关掉的脉冲
if (!flag('keep-off')) {
  console.log('\n… 重新打开 4 个 LLM 脉冲');
  for (const id of PAUSED) {
    try {
      const r = await fetch(`${base(port)}/autopilots/${id}/toggle`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }),
      });
      const j = await r.json();
      ok(`pulse.${id}.on`, r.ok && j.ok !== false, `enabled=${j.pulse?.enabled}`);
    } catch (e) { ok(`pulse.${id}.on`, false, String(e.message).slice(0, 60)); }
  }
}

// 触发一次巡检
console.log('\n… 触发一次真实巡检');
try {
  const r = await fetch(base(port) + '/plugin/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ what: 'scan' }) });
  const j = await r.json();
  ok('scan.runs', r.ok && j.ok !== false, JSON.stringify(j.result || j).slice(0, 120));
} catch (e) { ok('scan.runs', false, String(e.message).slice(0, 80)); }

// 等 30 秒看是否出现新的「脉冲超时」
console.log('\n… 观察 30 秒，确认没有脉冲超时/叠加');
const errBefore = await (await fetch(base(port) + '/plugin/events')).json().catch(() => ({ events: [] }));
const nBefore = (errBefore.events || []).filter((e) => /超时|timeout/i.test(String(e.message || ''))).length;
await new Promise((r) => setTimeout(r, 30000));
const after = await (await fetch(base(port) + '/plugin/events')).json().catch(() => ({ events: [] }));
const nAfter = (after.events || []).filter((e) => /超时|timeout/i.test(String(e.message || ''))).length;
ok('no.new_timeout', nAfter <= nBefore, `超时事件 ${nBefore} → ${nAfter}`);

const tri = (after.events || []).filter((e) => e.type === 'triage').length;
console.log(`   环形缓冲内 triage 事件数：${tri}（应随时间缓慢增长，不再一分钟十几条）`);

const s2 = await (await fetch(base(port) + '/plugin/status')).json();
console.log(`\n最终：ticks=${s2.engine?.ticks} lastError=${JSON.stringify(s2.engine?.lastError)} model=${s2.model?.ready} from=${s2.model?.from}`);

const passed = results.filter((r) => r.pass).length;
console.log(`\n== post-restart: ${passed}/${results.length} PASS ==`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
