// dsh-plugin-hive/scripts/selftest-host.mjs — 用假的 DSH ctx 跑一遍 Host 半
//
// 目的：在没有真正安装插件之前，验证
//   ① 开箱（数据目录/默认配置/建库） ② 模型传输层接线 ③ 引擎启停 ④ 看板路由注册 ⑤ 工具注册
//
// 用法：node --no-warnings dsh-plugin-hive/scripts/selftest-host.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

// —— 隔离一次运行：临时 DSH_HOME ——
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-selftest-'));
process.env.DSH_HOME = tmpHome;

// —— 假 ctx ——
const effects = [];
const registeredRoutes = [];
const registeredTools = [];
const fakeStream = async function* (opts) {
  yield { type: 'text-delta', index: 0, text: 'OK' };
  yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 2 } };
  yield { type: 'finish', reason: { kind: 'stop' } };
};
const ctx = {
  effect(fn) {
    const dispose = fn();
    effects.push(dispose);
    return () => { try { dispose?.(); } catch {} };
  },
  webServer: {
    register(route) {
      registeredRoutes.push(route);
      return () => {};
    },
    getOrigin: () => 'http://127.0.0.1:0',
  },
  llm: {
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
    listModels: async () => [{ id: 'deepseek-chat', name: 'deepseek-chat' }],
    stream: fakeStream,
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
  tools: {
    register(def) { registeredTools.push(def); return () => {}; },
  },
  logger: { info() {}, warn() {}, error() {} },
};

const mod = await import('../index.js');
ok('module.exports', typeof mod.apply === 'function' && Array.isArray(mod.inject), `inject=${JSON.stringify(mod.inject)}`);

mod.apply(ctx, {});

// 等 boot 完成（provision + import + 引擎 + 路由 + 工具）
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let state = null;
for (let i = 0; i < 60; i++) {
  await wait(250);
  state = globalThis.__HIVE_PLUGIN__;
  if (state?.routeReady) break;
}

ok('provision.home', state?.home?.startsWith(tmpHome), state?.home || '(无)');
ok('provision.config', fs.existsSync(path.join(tmpHome, 'hive', 'config', 'hive.json')));
ok('provision.db', fs.existsSync(path.join(tmpHome, 'hive', 'data', 'hive.db')));
ok('provision.dirs', fs.existsSync(path.join(tmpHome, 'hive', 'data', 'artifacts')));

ok('route.registered', registeredRoutes.length >= 1 && registeredRoutes[0].path === '/hive', JSON.stringify(registeredRoutes.map((r) => r.path + ':' + r.kind)));
ok('route.prefix', registeredRoutes[0]?.kind === 'prefix');
ok('engine.started', !!state?.engine?.isRunning, JSON.stringify(state?.engine?.status?.() ?? null));
ok('model.transport', state?.modelReady === true, state?.lastModel || state?.modelError || '');
ok('tools.registered', registeredTools.length >= 4, registeredTools.map((t) => t.name).join(','));

// —— 真打一次路由：把 handler 挂到真实 http server 上（mock req/res 无法验证静态文件流） ——
const handler = registeredRoutes[0]?.handler;
const srv = http.createServer((req, res) => {
  Promise.resolve(handler(req, res)).catch((e) => {
    try { res.writeHead(500); res.end(String(e?.message || e)); } catch {}
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const base = `http://127.0.0.1:${port}`;

async function call(urlPath, method = 'GET', body = null) {
  const res = await fetch(base + urlPath, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, headers: Object.fromEntries(res.headers), body: text };
}

const st = await call('/hive/api/plugin/status');
ok('api.plugin.status', st.status === 200 && /"mode":"plugin"/.test(st.body), `status=${st.status} ${String(st.body).slice(0, 120)}`);

const doc = await call('/hive/api/plugin/doctor');
ok('api.plugin.doctor', doc.status === 200 && /rows/.test(doc.body), String(doc.body).slice(0, 160));

const idx = await call('/hive/');
ok('web.index', idx.status === 200 && /<html/i.test(idx.body), `status=${idx.status} bytes=${idx.body?.length}`);
ok('web.frameable', /frame-ancestors 'self'/.test(idx.headers['content-security-policy'] || '') && (idx.headers['x-frame-options'] || '').toUpperCase() === 'SAMEORIGIN',
  `xfo=${idx.headers['x-frame-options']} csp=${String(idx.headers['content-security-policy']).slice(0, 60)}`);

const appjs = await call('/hive/app.js');
ok('web.appjs', appjs.status === 200 && appjs.body.length > 1000, `bytes=${appjs.body?.length}`);

const health = await call('/hive/api/health');
ok('api.health', health.status === 200 && /"ok":true/.test(health.body), String(health.body).slice(0, 120));

// 引擎控制
const started = await call('/hive/api/plugin/scan', 'POST', { what: 'scan' });
ok('api.plugin.scan', started.status === 200 || /error/.test(started.body), `${started.status} ${String(started.body).slice(0, 100)}`);

await new Promise((r) => srv.close(r));

// 停引擎 + 卸载
await state.engine.stop();
ok('engine.stopped', state.engine.isRunning === false);
for (const d of effects) { try { await d?.(); } catch {} }
await wait(200);
ok('dispose.clean', !globalThis.__HIVE_PLUGIN__, 'global 已清理');

const passed = results.filter((r) => r.pass).length;
console.log(`\n== selftest-host: ${passed}/${results.length} PASS ==`);
console.log('临时 HOME:', tmpHome);
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
process.exit(passed === results.length ? 0 : 1);
