// dsh-plugin-hive/index.js — Host 半
//
// 职责：
//   1. 首次激活时自动开箱（建数据目录、写默认配置、建库、种脉冲）—— 新用户不用做任何准备
//   2. 把 HIVE 运行时在 DSH 进程内跑起来（借用宿主已配置的模型，无需自备 API key）
//   3. 把完整看板挂到宿主 webServer 的 /hive 前缀下（同源，可被插件面板 iframe 嵌入）
//   4. 向 Agent 注册 hive_* 工具，让会话里能直接用自然语言管任务
//
// 所有资源都经由 ctx.effect 注册，卸载时归还。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require0 = createRequire(import.meta.url);

const PKG_ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.join(PKG_ROOT, 'runtime');
const MOUNT = '/hive';

export const name = 'hive';
// 这三个服务是硬依赖：没有 webServer 就没看板，没有 llm 就没脑子
export const inject = ['webServer', 'llm', 'tools'];

const log = (level, ...args) => {
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn('[hive]', ...args);
};

/** DSH 家目录 */
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

/** 首次激活的开箱：目录 + 默认配置 + 版本戳 */
function provision(home) {
  const created = [];
  ensureDir(home);
  const cfgDir = path.join(home, 'config');
  ensureDir(cfgDir);
  for (const f of ['hive.json', 'policies.json']) {
    const dst = path.join(cfgDir, f);
    if (fs.existsSync(dst)) continue;
    const src = path.join(RUNTIME, 'config-defaults', f);
    if (!fs.existsSync(src)) continue;
    // 配置里的绝对路径指向 D:\hive 时要改成当前 runtime，否则新机器上找不到 web/
    let text = fs.readFileSync(src, 'utf8');
    try {
      const j = JSON.parse(text);
      j.home = home;
      // 凭据文件在插件模式用不到（借用宿主模型），留空避免指向别人机器的路径
      if (j.credentials) j.credentials.file = j.credentials.file && fs.existsSync(j.credentials.file) ? j.credentials.file : '';
      text = JSON.stringify(j, null, 2);
    } catch { /* 保持原文 */ }
    fs.writeFileSync(dst, text, 'utf8');
    created.push(`config/${f}`);
  }
  for (const d of ['data', 'data/runs', 'data/artifacts', 'data/logs', 'data/work', 'data/calendar']) {
    ensureDir(path.join(home, d));
  }
  return created;
}

/** 从 selection 对象里尽力抽出 provider/model（字段名在不同版本里不一致） */
function pickSelection(sel) {
  if (!sel || typeof sel !== 'object') return {};
  const provider = sel.provider || sel.providerId || sel.provider_id
    || (sel.route && (sel.route.provider || sel.route.id)) || sel.id;
  const model = sel.model || sel.modelId || sel.model_id
    || (sel.route && (sel.route.model || sel.route.modelId)) || sel.name;
  return {
    provider: typeof provider === 'string' && provider ? provider : undefined,
    model: typeof model === 'string' && model ? model : undefined,
  };
}

/** 用户手工钉住的模型（$DSH_HOME/hive/model-pin.json），优先于自动探测 */
function readPin(home) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, 'model-pin.json'), 'utf8'));
    if (j && typeof j.provider === 'string' && typeof j.model === 'string' && j.provider && j.model) return j;
  } catch { /* 没有就算了 */ }
  return null;
}

/** 常见 provider 的保底模型：只在该 provider 确实存在、且探测全失败时才用 */
const DEFAULT_MODEL_BY_PROVIDER = {
  'deepseek-official': 'deepseek-flash',
  'deepseek': 'deepseek-chat',
  'google': 'gemini-3.6-flash',
  'anthropic': 'claude-sonnet-4',
  'openai': 'gpt-5.1',
};

/**
 * 解析要用的 provider/model。
 * 顺序：手工钉住 → 宿主当前选择 → 该 provider 的模型目录 → 内置保底表。
 * 关键教训：插件在启动早期调用时，宿主的模型选择可能还没水合（model 为 undefined），
 * 所以每一层都必须校验「非空字符串」，不能把 undefined 传下去。
 */
async function resolveModel(ctx, home) {
  // 1) 手工钉住
  const pin = readPin(home);
  if (pin) return { provider: pin.provider, model: pin.model, from: 'pin' };

  // 2) 宿主当前选择（字段名有多个变体）
  let sel = {};
  try { sel = pickSelection(ctx.agentDefaultModel?.currentSelection?.()); } catch { /* 忽略 */ }
  if (sel.provider && sel.model) return { ...sel, from: 'selection' };

  // 3) provider 候选：选择里给的 > deepseek 系 > 第一个
  let providers = [];
  try { providers = ctx.llm.listProviders() || []; } catch { /* 忽略 */ }
  const providerIds = providers.map((p) => p && p.id).filter(Boolean);
  const provider = sel.provider
    || providerIds.find((id) => /deepseek/i.test(id))
    || providerIds[0];

  // 4) 该 provider 的模型目录
  if (provider) {
    try {
      const models = await ctx.llm.listModels(provider);
      const ids = (models || []).map((m) => (typeof m === 'string' ? m : m && (m.id || m.model))).filter(Boolean);
      if (ids.length) {
        const preferred = ids.find((id) => /flash|chat|pro/i.test(id)) || ids[0];
        return { provider, model: sel.model || preferred, from: 'catalog' };
      }
    } catch { /* 忽略 */ }
  }

  // 5) 内置保底
  const fallbackProvider = provider || Object.keys(DEFAULT_MODEL_BY_PROVIDER)[0];
  const fallbackModel = DEFAULT_MODEL_BY_PROVIDER[fallbackProvider];
  if (fallbackModel) return { provider: fallbackProvider, model: fallbackModel, from: 'fallback' };

  return null;
}

/** 诊断：把宿主这边能看到的 provider/model 全量吐出来（排障用） */
async function inspectModels(ctx, home) {
  const out = { at: new Date().toISOString(), pin: readPin(home), providers: [], selection: null, models: {}, resolved: null };
  try { out.selection = ctx.agentDefaultModel?.currentSelection?.() ?? null; } catch (e) { out.selectionError = String(e.message); }
  try { out.selectionPicked = pickSelection(out.selection); } catch { /* 忽略 */ }
  try { out.providers = (ctx.llm.listProviders() || []).map((p) => ({ id: p?.id, name: p?.name })); } catch (e) { out.providersError = String(e.message); }
  for (const p of out.providers) {
    try {
      const ms = await ctx.llm.listModels(p.id);
      out.models[p.id] = (ms || []).map((m) => (typeof m === 'string' ? m : { id: m?.id, name: m?.name }));
    } catch (e) { out.models[p.id] = { error: String(e.message) }; }
  }
  try { out.resolved = await resolveModel(ctx, home); } catch (e) { out.resolvedError = String(e.message); }
  return out;
}

/** 用宿主 ctx.llm 实现 HIVE 的 chat 传输层 */
function makeTransport(ctx, state, home) {
  return async function transport({ messages, maxTokens, temperature, timeoutMs }) {
    const sel = await resolveModel(ctx, home);
    if (!sel?.provider || !sel?.model) {
      state.modelReady = false;
      state.modelError = '解析不到可用的 模型（provider/model 都为空）';
      throw new Error('宿主没有可用的模型：请先在 DSH 设置里选一个模型，或在 $DSH_HOME/hive/model-pin.json 里钉住 {provider, model}');
    }
    const t0 = Date.now();
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const rest = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: 'user', content: [{ type: 'text', text: String(m.content) }] }));

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs || 120000);
    let text = '';
    let usage = { in: 0, out: 0 };
    let finish = null;
    try {
      const stream = ctx.llm.stream({
        provider: sel.provider,
        model: sel.model,
        system: system || undefined,
        messages: rest,
        temperature,
        maxTokens,
        signal: ac.signal,
      });
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta') text += chunk.text || '';
        else if (chunk?.type === 'usage') {
          usage = { in: chunk.usage?.inputTokens ?? 0, out: chunk.usage?.outputTokens ?? 0 };
        } else if (chunk?.type === 'finish') {
          finish = chunk.reason?.kind;
          if (chunk.reason?.kind === 'error') throw new Error(chunk.reason.failure?.message || '模型返回错误');
        }
      }
    } finally {
      clearTimeout(timer);
    }
    state.lastModel = `${sel.provider}/${sel.model}`;
    state.modelReady = true;
    state.modelError = null;
    state.modelFrom = sel.from || null;
    return {
      ok: true, text, provider: sel.provider, model: sel.model, tier: 'host',
      usage, costCny: 0, ms: Date.now() - t0, viaHost: true, finish,
    };
  };
}

/** 极简 JSON 响应工具（插件自有的 control/plugin 路由用） */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > limit) { req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

/** 自检：插件模式能答的那几项 */
function pluginDoctor(state) {
  const rows = [];
  const add = (id, name, status, detail, fix) => rows.push({ id, name, status, detail, fix });
  add('node', 'Node 运行时', 'PASS', `v${process.versions.node}`, '');
  let sqliteOk = false, sqliteVersion = '';
  try {
    const { DatabaseSync } = require0('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('create table t(a)'); db.close();
    sqliteOk = true;
    sqliteVersion = 'ok';
  } catch (e) { sqliteVersion = String(e.message).slice(0, 80); }
  add('sqlite', 'node:sqlite', sqliteOk ? 'PASS' : 'FAIL', sqliteOk ? '可用' : sqliteVersion, sqliteOk ? '' : '需要 Node ≥ 22.5');
  add('engine', '调度引擎', state.engine?.isRunning ? 'PASS' : 'WARN', state.engine?.isRunning ? '运行中' : '已停止', '点「启动」');
  add('llm', 'LLM 通道', state.modelReady ? 'PASS' : 'FAIL', state.lastModel || state.modelError || '未探测', state.modelReady ? '' : '在 DSH 设置里配置一个模型');
  add('web', '看板路由', state.routeReady ? 'PASS' : 'FAIL', state.routeReady ? `${MOUNT}/` : '未注册', '');
  add('db', '数据库', state.dbPath ? 'PASS' : 'FAIL', state.dbPath || '', '');
  return rows;
}

// require 在 ESM 里没有；用 createRequire 拿内置模块（require0 在文件顶部创建）

export function apply(ctx, config = {}) {
  // ── 事件环形缓冲（给插件控制台看；不持久化） ──
  const ring = [];
  const broadcast = (e) => {
    ring.push(e);
    if (ring.length > 200) ring.shift();
  };

  const home = path.join(dshHome(), 'hive');
  const state = {
    phase: 'starting', error: null, home,
    dbPath: path.join(home, 'data', 'hive.db'),
    engine: null, routeReady: false, modelReady: false, modelError: null, lastModel: null,
    created: [], startedAt: new Date().toISOString(),
  };

  // 让 /hive/api/control/* 这类路由能找到控制面
  globalThis.__HIVE_PLUGIN__ = state;
  globalThis.__HIVE_MODE__ = 'plugin';

  ctx.effect(() => {
    let disposed = false;
    boot().catch((e) => {
      state.phase = 'error';
      state.error = String(e?.stack || e);
      log('error', '启动失败:', e);
    });

    async function boot() {
      // 0) 开箱
      state.created = provision(home);
      process.env.HIVE_HOME = home;
      globalThis.__HIVE_HOME__ = home;

      // 1) 建库（导入即建表）
      const db = await import('./runtime/src/core/db.mjs');
      db.getDb();
      if (disposed) return;

      // 2) 注入模型传输层（关键：借宿主的模型，新用户零配置可用）
      const llmMod = await import('./runtime/src/core/llm.mjs');
      llmMod.setTransport(makeTransport(ctx, state, home));
      state.phase = 'ready';
      try {
        const probe = await llmMod.chat({ messages: [{ role: 'user', content: '回复 OK' }], maxTokens: 8, timeoutMs: 30000 });
        state.modelReady = !!probe.ok;
        if (!probe.ok) state.modelError = String(probe.error || '').slice(0, 200);
      } catch (e) { state.modelError = String(e.message).slice(0, 200); }
      if (disposed) return;

      // 3) 引擎
      const { createEngine } = await import('./engine.mjs');
      state.engine = createEngine({ log, onEvent: (e) => broadcast(e) });
      await state.engine.start();
      if (disposed) { await state.engine.stop(); return; }

      // 4) 看板路由
      const { createHandler } = await import('./runtime/src/server/http.mjs');
      const inner = createHandler({ mountPath: MOUNT, embeddable: true, logger: (l) => log('info', l) });

      const handler = async (req, res) => {
        // 插件自有：控制面
        const raw = req.url || '/';
        if (raw.startsWith(MOUNT + '/api/plugin/') || raw.startsWith(MOUNT + '/api/control/')) {
          return handlePluginApi(req, res, raw, state);
        }
        return inner.handler(req, res);
      };

      if (disposed) return;
      ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: MOUNT, handler }));
      state.routeReady = true;

      // 5) Agent 工具
      try { registerTools(ctx, state); } catch (e) { log('warn', '工具注册失败:', e.message); }

      // 6) 版本管理（装/升/降/卸都由用户点，永不自动改）
      try {
        const { createVersionManager } = await import('./version.mjs');
        state.version = createVersionManager({ ctx, pkgRoot: PKG_ROOT, home, log });
        state.version.scheduleAutoCheck();
      } catch (e) { log('warn', '版本管理器初始化失败:', e.message); }

      log('info', `就绪：数据目录 ${home}，看板 ${MOUNT}/，引擎 ${state.engine.isRunning ? '运行中' : '停止'}`);
    }

    return () => {
      // Cordis 的 effect disposer 按同步释放处理；异步停引擎单独发起，不阻塞卸载
      disposed = true;
      state.routeReady = false;
      Promise.resolve().then(async () => {
        try { await state.engine?.stop(); } catch { /* noop */ }
        try {
          const llmMod = await import('./runtime/src/core/llm.mjs');
          llmMod.setTransport(null);
        } catch { /* noop */ }
        if (globalThis.__HIVE_PLUGIN__ === state) {
          delete globalThis.__HIVE_PLUGIN__;
          delete globalThis.__HIVE_MODE__;
        }
        log('info', '已卸载');
      });
    };
  });

  state.events = () => ring.slice(-100);
}

/** 插件自有 API：控制引擎 + 插件自检 + 事件 */
async function handlePluginApi(req, res, raw, state) {
  const u = new URL(raw, 'http://127.0.0.1');
  const p = u.pathname.replace(MOUNT + '/api/plugin', '').replace(MOUNT + '/api/control', '');
  const method = req.method || 'GET';

  try {
    if (method === 'GET' && (p === '/status' || p === '/status/')) {
      return sendJson(res, 200, {
        ok: true, mode: 'plugin', phase: state.phase,
        home: state.home, dbPath: state.dbPath,
        engine: state.engine?.status?.() ?? null,
        model: { ready: state.modelReady, current: state.lastModel, from: state.modelFrom, error: state.modelError },
        created: state.created, startedAt: state.startedAt,
      });
    }
    if (method === 'GET' && p === '/doctor') {
      return sendJson(res, 200, { ok: true, mode: 'plugin', rows: pluginDoctor(state) });
    }
    if (method === 'GET' && p === '/events') {
      return sendJson(res, 200, { ok: true, events: state.events?.() ?? [] });
    }

    // ── 模型诊断：把宿主这边能看到的 provider/model 全量吐出来 ──
    if (method === 'GET' && p === '/models') {
      const info = await inspectModels(ctx, state.home);
      return sendJson(res, 200, {
        ok: true, ...info,
        live: { ready: state.modelReady, current: state.lastModel, from: state.modelFrom, error: state.modelError },
      });
    }
    // ── 手工钉住模型（写 $DSH_HOME/hive/model-pin.json，下一次调用即生效并当场验证）──
    if (method === 'POST' && p === '/model') {
      const body = await readBody(req);
      const provider = String(body.provider || '').trim();
      const model = String(body.model || '').trim();
      if (!provider || !model) return sendJson(res, 400, { error: '需要 {provider, model} 两个非空字符串' });
      try {
        fs.mkdirSync(state.home, { recursive: true });
        fs.writeFileSync(path.join(state.home, 'model-pin.json'),
          JSON.stringify({ provider, model, at: new Date().toISOString() }, null, 2), 'utf8');
        let probe = null;
        try {
          const { chat } = await import('./runtime/src/core/llm.mjs');
          const r = await chat({ messages: [{ role: 'user', content: '回复 OK' }], maxTokens: 8, timeoutMs: 30000 });
          probe = { ok: !!r.ok, error: r.ok ? null : String(r.error || '').slice(0, 200) };
        } catch (e) { probe = { ok: false, error: String(e.message).slice(0, 200) }; }
        return sendJson(res, 200, { ok: true, pinned: { provider, model }, probe });
      } catch (e) {
        return sendJson(res, 500, { error: String(e?.message || e) });
      }
    }
    if (method === 'DELETE' && p === '/model') {
      try { fs.unlinkSync(path.join(state.home, 'model-pin.json')); } catch { /* 没有就算了 */ }
      return sendJson(res, 200, { ok: true, cleared: true });
    }

    if (method === 'POST' && (p === '/start' || p === '/stop' || p === '/restart')) {
      if (p === '/start') await state.engine.start();
      else if (p === '/stop') await state.engine.stop();
      else await state.engine.restart();
      return sendJson(res, 200, { ok: true, engine: state.engine.status() });
    }
    if (method === 'POST' && (p === '/scan' || p === '/trigger')) {
      const body = await readBody(req);
      const r = await state.engine.trigger(body.what || 'scan');
      return sendJson(res, 200, { ok: true, result: r });
    }

    // ── 版本管理：让用户自己决定装 / 升 / 降 / 卸 ──
    if (method === 'GET' && p === '/version') {
      if (!state.version) return sendJson(res, 503, { error: '版本管理器未就绪' });
      const force = u.searchParams.get('force') === '1';
      const o = await state.version.overview({ force });
      return sendJson(res, 200, { ok: true, ...o });
    }
    if (method === 'POST' && p === '/version/check') {
      if (!state.version) return sendJson(res, 503, { error: '版本管理器未就绪' });
      const o = await state.version.overview({ force: true });
      return sendJson(res, 200, { ok: true, ...o });
    }
    if (method === 'POST' && p === '/version/apply') {
      if (!state.version) return sendJson(res, 503, { error: '版本管理器未就绪' });
      const body = await readBody(req);
      if (!body.action) return sendJson(res, 400, { error: '缺少 action（install/update/downgrade/uninstall/enable/disable）' });
      const r = await state.version.apply(body);
      return sendJson(res, r.ok ? 200 : 500, r);
    }
    if (method === 'POST' && p === '/version/settings') {
      if (!state.version) return sendJson(res, 503, { error: '版本管理器未就绪' });
      const body = await readBody(req);
      const s = state.version.saveSettings({
        ...(typeof body.autoCheck === 'boolean' ? { autoCheck: body.autoCheck } : {}),
        ...(body.repo ? { repo: String(body.repo) } : {}),
        ...(body.autoCheckHours ? { autoCheckHours: Number(body.autoCheckHours) } : {}),
      });
      return sendJson(res, 200, { ok: true, settings: s });
    }

    return sendJson(res, 404, { error: '未知的插件接口: ' + p });
  } catch (e) {
    return sendJson(res, 500, { error: String(e?.message || e) });
  }
}

/** 给 Agent 的工具：让会话里能直接管 HIVE */
function registerTools(ctx, state) {
  // 工具输出统一渲染成 JSON 文本，模型与人都能读
  const out = {
    schema: { type: 'object' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2).slice(0, 8000) }],
  };
  const tools = [
    {
      name: 'hive_status',
      description: '查看 HIVE 主动服务状态：待办、待拍板、运行中任务、今日花费、引擎与模型状态。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: out,
      timeoutMs: 20000,
      async execute() {
        const { pendingWork, todayCost } = await import('./runtime/src/task/taskcenter.mjs');
        return { mode: 'plugin', pending: pendingWork(), cost: todayCost(), engine: state.engine?.status(), model: state.modelReady, home: state.home };
      },
    },
    {
      name: 'hive_capture',
      description: '把一件事丢进 HIVE 的 Inbox（待办/机会/风险/决策），自动去重与分级。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '一句话事项' },
          body: { type: 'string', description: '背景、原始信息（可选）' },
          kind: { type: 'string', enum: ['todo', 'issue', 'opportunity', 'decision', 'risk', 'fyi'] },
          domain: { type: 'string', description: 'work/trade/startup/ai/content/life/family/ops/code/comms' },
        },
        required: ['title'],
        additionalProperties: false,
      },
      output: out,
      timeoutMs: 20000,
      async execute(args) {
        const { upsertItem } = await import('./runtime/src/task/taskcenter.mjs');
        const { item, created } = upsertItem({
          source: 'agent', source_ref: crypto.randomUUID(),
          title: String(args.title || '').slice(0, 300), body: args.body || null,
          kind: args.kind || 'todo', domain: args.domain || null,
        });
        return { id: item.id, created, priority: item.priority };
      },
    },
    {
      name: 'hive_run',
      description: '对一条 Inbox 事项立刻做路由：L1/L2 内联出结论，L3+ 派给执行器，需要人拍板的进 Outbox。',
      parameters: { type: 'object', properties: { id: { type: 'string', description: '事项 id（itm_…）' } }, required: ['id'], additionalProperties: false },
      output: out,
      timeoutMs: 120000,
      async execute(args) {
        const { processItem } = await import('./runtime/src/task/router.mjs');
        const r = await processItem(String(args.id), { force: true });
        return { route: r.route, ok: r.ok, level: r.triage?.level ?? null, reason: r.triage?.reason ?? null, text: r.text ? String(r.text).slice(0, 2000) : undefined, approval: r.approval?.id, tasks: r.tasks };
      },
    },
    {
      name: 'hive_decide',
      description: '处理一条 Outbox 审批：批准（会立刻续跑）/拒绝。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '审批 id（apr_…）' },
          decision: { type: 'string', enum: ['approve', 'reject'] },
          note: { type: 'string' },
        },
        required: ['id', 'decision'],
        additionalProperties: false,
      },
      output: out,
      timeoutMs: 120000,
      async execute(args) {
        const { decideApproval, getApproval, getItem } = await import('./runtime/src/task/taskcenter.mjs');
        const decision = args.decision === 'reject' ? 'rejected' : 'approved';
        decideApproval(String(args.id), { decision, note: args.note, by: 'agent' });
        if (decision === 'approved') {
          const ap = getApproval(String(args.id));
          if (ap?.item_id && getItem(ap.item_id)) {
            const { processItem } = await import('./runtime/src/task/router.mjs');
            const r = await processItem(ap.item_id, { force: true, skipApproval: true });
            return { decision, continued: r.route };
          }
        }
        return { decision };
      },
    },
  ];
  for (const t of tools) {
    ctx.effect(() => ctx.tools.register(t));
  }
}

