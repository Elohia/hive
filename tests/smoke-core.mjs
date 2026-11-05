// tests/smoke-core.mjs — 核心件冒烟：配置/凭据/DB/事件/LLM
import { loadConfig } from '../src/core/config.mjs';
import { keyStatus } from '../src/core/credentials.mjs';
import { getDb, dbStats, kvSet, kvGet } from '../src/core/db.mjs';
import { emit, recent } from '../src/core/events.mjs';
import { chat, parseJson } from '../src/core/llm.mjs';
import { itemId, taskId } from '../src/core/ids.mjs';

const results = [];
function ok(name, cond, extra = '') {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
}

// 1 配置
const cfg = loadConfig();
ok('config.load', cfg.home && cfg.resolved.db, `home=${cfg.home}`);
ok('config.paths.created', !!getDb());

// 2 凭据
const ks = keyStatus();
ok('credentials.deepseek', ks.deepseek?.present, `len=${ks.deepseek?.length}`);
console.log('   keys:', Object.entries(ks).map(([k, v]) => `${k}:${v.present ? 'yes' : 'no'}`).join(' '));

// 3 DB + KV
kvSet('smoke.at', new Date().toISOString());
ok('db.kv', !!kvGet('smoke.at'));
const s1 = dbStats();
ok('db.schema', s1.items >= 0 && s1.events >= 0, JSON.stringify(s1));

// 4 ID 单调
const a = itemId(), b = taskId();
ok('ids.format', a.startsWith('itm_') && b.startsWith('tsk_'), `${a} ${b}`);

// 5 事件
const ev = emit({ actor: 'system', type: 'smoke.test', message: 'smoke' });
ok('events.emit', ev.id > 0, `id=${ev.id}`);
ok('events.recent', recent({ limit: 3 }).length > 0);

// 6 LLM
console.log('   llm: 调用中…');
const r = await chat({
  messages: [
    { role: 'system', content: '你是测试助手，只输出 JSON。' },
    { role: 'user', content: '返回 {"ok":true,"n":7} 这个 JSON，不要别的。' },
  ],
  json: true,
  maxTokens: 200,
});
ok('llm.chat', r.ok, r.ok ? `${r.model} ${r.ms}ms in=${r.usage.in} out=${r.usage.out} ¥${r.costCny}` : r.error);
if (r.ok) {
  const j = parseJson(r.text);
  ok('llm.json', j && j.ok === true, JSON.stringify(j));
}

const passed = results.filter((x) => x.pass).length;
console.log(`\n== smoke-core: ${passed}/${results.length} PASS ==`);
process.exit(passed === results.length ? 0 : 1);
