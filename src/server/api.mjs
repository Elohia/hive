// src/server/api.mjs — HIVE HTTP API 路由表（全部函数式、零依赖）
//
// ── 数据访问边界（项目铁律）──────────────────────────────────────────────
// 1. items / tasks / approvals 的读写【只】经 src/task/taskcenter.mjs 的导出函数，
//    本文件不写任何针对这三张表的 SQL（列、读、聚合都不写）。
// 2. 事件只经 src/core/events.mjs 的 recent() / subscribe()；库统计只经 db.mjs 的 dbStats()。
// 3. taskcenter 没有提供 runs / artifacts / context_facts / pulses 的 getter，这几张表
//    用 core/db.mjs 的 q 做【只读 SELECT】（context_facts 的 upsert 是本模块职责）。
// 4. 所有动作都通过 createTask/updateTask/updateItem/decideApproval 等既有 API 落状态，
//    不绕过状态机。副作用动作（approvals）仍然必须人拍板。
//
// ── 降级约定 ───────────────────────────────────────────────────────────
// src/executors/** 与 src/sensors/** 由其他并行任务实现，HTTP 层不得因为它们缺失/写坏而崩：
// 一律 fs.existsSync + 动态 import + try/catch，缺失时返回 {ok:false, reason:'<x> registry not ready'}。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { q, dbStats, cursorGet, cursorSet } from '../core/db.mjs';
import { recent, emit } from '../core/events.mjs';
import { shortHash } from '../core/ids.mjs';
import {
  upsertItem, getItem, listItems, updateItem,
  createTask, getTask, listTasks, updateTask,
  getApproval, listApprovals, decideApproval,
  pendingWork, todayCost,
} from '../task/taskcenter.mjs';
import { HANDLED, openStream, clientCount, shapeEvent } from './sse.mjs';

// ───────────────────────────── 通用工具 ─────────────────────────────

export class HttpError extends Error {
  constructor(status, message, extra = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.extra = extra;
  }
}

const nowIso = () => new Date().toISOString();
const bad = (msg, status = 400) => { throw new HttpError(status, msg); };
const need = (cond, msg, status = 400) => { if (!cond) bad(msg, status); };

function parseJsonMaybe(v, fallback = null) {
  if (v == null || v === '') return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

function qsStr(query, name) {
  const v = query?.get?.(name);
  return v != null && String(v).trim() !== '' ? String(v).trim() : undefined;
}

function qsInt(query, name, def, min, max) {
  const raw = qsStr(query, name);
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function bodyObject(ctx) {
  const b = ctx.body;
  if (b == null) return {};
  if (typeof b !== 'object' || Array.isArray(b)) bad('请求体必须是 JSON 对象');
  return b;
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms`)), ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, guard]).finally(() => { if (timer) clearTimeout(timer); });
}

// 版本号：永远取配置模块给的「代码根 VERSION」（cfg.version），
// 不自己从 cfg.home 读 —— 换 HIVE_HOME 后 home 里没有 VERSION，会退化成 0.0.0。
function readVersion(cfg) {
  if (cfg && typeof cfg.version === 'string' && cfg.version) return cfg.version;
  const roots = [cfg?.codeRoot, cfg?.resolved?.codeRoot].filter(Boolean);
  for (const root of roots) {
    try { return fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim() || '0.0.0'; }
    catch { /* 继续找下一个 */ }
  }
  return '0.0.0';
}

// 探测子命令一律异步并行（Windows 上每次 spawn 约 100–600ms，串行会让 /api/doctor 变成 4s+）
function execAsync(cmd, args, timeout = 5000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
        resolve({ err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      });
    } catch (e) {
      resolve({ err: e, stdout: '', stderr: '' });
    }
  });
}

async function which(cmd) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const { err, stdout } = await execAsync(finder, [cmd]);
  const first = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null;
  return {
    ok: !err && !!first,
    path: first,
    error: err ? String(err.message).split('\n')[0] : null,
  };
}

async function commandVersion(cmd, args = ['--version']) {
  const { err, stdout, stderr } = await execAsync(cmd, args, 6000);
  const out = String(stdout || stderr || '').trim().split(/\r?\n/).filter(Boolean)[0] || null;
  return { ok: !err, version: out, error: err ? String(err.message).split('\n')[0] : null };
}

function inClause(arr) { return arr.map(() => '?').join(','); }

/** 动态加载「可能还不存在 / 正在被别处写」的模块（按 mtime 破缓存，写完可热生效） */
async function loadModule(cfg, relPath) {
  // 代码资产（src/**）永远跟代码根走；HIVE_HOME 只改数据/配置目录。
  const abs = path.join(cfg.codeRoot || cfg.home, relPath);
  let st = null;
  try { st = fs.statSync(abs); } catch { /* 缺失 */ }
  if (!st) return { ok: false, path: abs, reason: 'missing', mod: null };
  try {
    const url = pathToFileURL(abs).href + '?m=' + Math.round(st.mtimeMs);
    const mod = await import(url);
    return { ok: true, path: abs, reason: null, mod };
  } catch (e) {
    return { ok: false, path: abs, reason: `加载失败: ${e.message}`, mod: null };
  }
}

function pickFn(mod, names) {
  if (!mod) return null;
  for (const n of names) {
    if (typeof mod[n] === 'function') return mod[n];
    if (mod.default && typeof mod.default[n] === 'function') return mod.default[n];
  }
  return null;
}

// ───────────────────────────── 形状转换 ─────────────────────────────

function shapeItem(it) {
  if (!it) return null;
  return { ...it, meta: parseJsonMaybe(it.meta, null) };
}

function shapeTask(t) {
  if (!t) return null;
  return {
    ...t,
    plan: parseJsonMaybe(t.plan, null),
    result: parseJsonMaybe(t.result, null),
    depends_on: parseJsonMaybe(t.depends_on, []),
  };
}

function shapeApproval(a) {
  if (!a) return null;
  return {
    ...a,
    context: parseJsonMaybe(a.context, {}),
    options: parseJsonMaybe(a.options, []),
  };
}

function withItemTitle(approval) {
  if (!approval) return approval;
  let title = null;
  try { title = approval.item_id ? (getItem(approval.item_id)?.title ?? null) : null; } catch { title = null; }
  return { ...approval, item_title: title };
}

function safePulses(limit = 30) {
  try {
    return q.all(
      `SELECT id,name,spec,enabled,last_run_at,next_run_at,last_status,config
       FROM pulses ORDER BY next_run_at ASC LIMIT ?`, limit
    ).map((p) => ({ ...p, enabled: !!p.enabled, config: parseJsonMaybe(p.config, null) }));
  } catch { return []; }
}

function recentEvents(opts) {
  try { return recent(opts).map(shapeEvent); } catch { return []; }
}

// ───────────────────────────── 执行器 / 传感器探测 ─────────────────────────────

const PROBE_TTL_MS = 30000;
let _probeCache = { at: 0, value: null };

function normalizeProbes(raw) {
  if (!raw || typeof raw !== 'object') return {};
  // 容错：允许 probe() 直接返回 {ok, executors:{...}} 形式
  if (typeof raw.ok === 'boolean' && raw.executors && typeof raw.executors === 'object') raw = raw.executors;
  const out = {};
  for (const [name, v] of Object.entries(raw)) {
    if (v && typeof v === 'object') {
      out[name] = {
        ok: !!v.ok,
        reason: v.reason ?? null,
        version: v.version ?? null,
      };
    } else {
      out[name] = { ok: !!v, reason: null, version: null };
    }
  }
  return out;
}

/** 返回 {ready:boolean, reason?, probes?:{name:{ok,reason,version}}, path} —— 绝不抛 */
export async function probeExecutors(cfg, { force = false } = {}) {
  const cacheKey = path.join(cfg.codeRoot || cfg.home, 'src', 'executors', 'index.mjs');
  if (!force && _probeCache.value && Date.now() - _probeCache.at < PROBE_TTL_MS && _probeCache.value.path === cacheKey) {
    return _probeCache.value;
  }
  const load = await loadModule(cfg, 'src/executors/index.mjs');
  let value;
  if (!load.ok) {
    value = {
      ready: false,
      reason: 'executor registry not ready',
      detail: load.reason,
      path: load.path,
      probes: {},
    };
  } else {
    const probe = pickFn(load.mod, ['probe', 'probeAll']);
    if (typeof probe !== 'function') {
      value = {
        ready: false,
        reason: 'executor registry not ready',
        detail: 'src/executors/index.mjs 未导出 probe()',
        path: load.path,
        probes: {},
      };
    } else {
      try {
        const raw = await withTimeout(Promise.resolve(probe(cfg)), 20000, 'executor probe');
        value = { ready: true, reason: null, path: load.path, probes: normalizeProbes(raw) };
      } catch (e) {
        value = {
          ready: false,
          reason: 'executor registry not ready',
          detail: `probe() 失败: ${e.message}`,
          path: load.path,
          probes: {},
        };
      }
    }
  }
  _probeCache = { at: Date.now(), value };
  return value;
}

async function sensorInventory(cfg) {
  const load = await loadModule(cfg, 'src/sensors/index.mjs');
  if (!load.ok) return { ready: false, reason: 'sensor registry not ready', detail: load.reason, path: load.path, names: [] };
  const listFn = pickFn(load.mod, ['list', 'names']);
  let names = [];
  if (typeof listFn === 'function') {
    try {
      const r = await listFn(cfg);
      if (Array.isArray(r)) names = r.map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean);
      else if (r && typeof r === 'object') names = Object.keys(r);
    } catch { /* 注册表自检失败不算致命 */ }
  }
  return { ready: true, reason: null, path: load.path, names };
}

async function runScan(cfg, { only, timeoutMs, maxItems, logs }) {
  const load = await loadModule(cfg, 'src/sensors/index.mjs');
  if (!load.ok) {
    return { ok: false, reason: 'sensor registry not ready', detail: load.reason, created: 0, seen: 0, scanned: 0 };
  }
  const scanAll = pickFn(load.mod, ['scanAll', 'scan']);
  if (typeof scanAll !== 'function') {
    return { ok: false, reason: 'sensor registry not ready', detail: 'src/sensors/index.mjs 未导出 scanAll()', created: 0, seen: 0, scanned: 0 };
  }
  const notes = {};
  const scanCtx = {
    cfg,
    now: new Date(),
    only: only ?? null,
    cursor: { get: cursorGet, set: cursorSet },
    notes,              // 传感器把「这次为什么 0 条 / 降级在哪」写这里，随响应返回
    opts: {},
    log: (level, msg, data) => {
      const tail = data && typeof data === 'object' ? ' ' + JSON.stringify(data) : '';
      logs.push(`${level ?? 'info'} ${msg ?? ''}${tail}`.trim());
    },
    emit,
  };
  const raws = await withTimeout(
    (async () => {
      const acc = [];
      const r = scanAll(scanCtx, only ? { only } : {});
      const consume = async (v) => {
        if (!v) return;
        if (Array.isArray(v)) { acc.push(...v); return; }
        if (typeof v[Symbol.asyncIterator] === 'function') { for await (const x of v) acc.push(x); return; }
        if (typeof v === 'object') {
          for (const val of Object.values(v)) {
            if (Array.isArray(val)) acc.push(...val);
            else if (val && typeof val[Symbol.asyncIterator] === 'function') { for await (const x of val) acc.push(x); }
          }
        }
      };
      if (r && typeof r[Symbol.asyncIterator] === 'function') await consume(r);
      else await consume(await r);
      return acc;
    })(),
    timeoutMs,
    '巡检'
  );

  let created = 0, seen = 0, failed = 0;
  const bySource = {};
  const accepted = [];
  for (const raw of raws.slice(0, maxItems)) {
    if (!raw || typeof raw !== 'object') continue;
    const source = String(raw.source || only || 'unknown');
    bySource[source] = bySource[source] || { created: 0, seen: 0, failed: 0 };
    try {
      const r = upsertItem({
        source,
        source_ref: raw.source_ref ?? null,
        dedupe_key: raw.dedupe_key,
        title: raw.title || raw.subject || '(无标题)',
        body: raw.body ?? raw.summary ?? null,
        kind: raw.kind_hint || raw.kind || 'fyi',
        domain: raw.domain_hint || raw.domain || null,
        urgency: raw.urgency_hint ?? raw.urgency,
        impact: raw.impact,
        due_at: raw.due_at ?? null,
        meta: raw.meta ?? null,
      });
      if (r.created) { created++; bySource[source].created++; } else { seen++; bySource[source].seen++; }
      accepted.push(r.item.id);
    } catch (e) {
      failed++; bySource[source].failed++;
      logs.push(`upsert 失败: ${e.message}`);
    }
  }
  return {
    ok: true,
    scanned: raws.length,
    accepted: accepted.length,
    created, seen, failed,
    truncated: raws.length > maxItems,
    bySource,
    notes,
    itemIds: accepted.slice(0, 50),
  };
}

let _scanning = false;

// ───────────────────────────── 处理器 ─────────────────────────────

function health(ctx) {
  const cfg = ctx.cfg;
  const out = {
    ok: true,
    name: 'hive',
    version: readVersion(cfg),
    home: cfg.home,
    time: nowIso(),
    uptimeSec: Math.round(process.uptime()),
  };
  try {
    out.db = { ok: true, path: cfg.resolved.db, stats: dbStats() };
  } catch (e) {
    out.ok = false;
    out.db = { ok: false, path: cfg.resolved.db, stats: null, error: e.message };
  }
  try { out.budget = todayCost(); }
  catch (e) { out.budget = { error: e.message }; }
  const regPath = path.join(cfg.codeRoot || cfg.home, 'src', 'executors', 'index.mjs');
  out.executors = { ready: fs.existsSync(regPath), path: regPath };
  if (!out.executors.ready) out.executors.reason = 'executor registry not ready';
  out.sensors = { ready: fs.existsSync(path.join(cfg.codeRoot || cfg.home, 'src', 'sensors', 'index.mjs')) };
  if (!out.sensors.ready) out.sensors.reason = 'sensor registry not ready';
  out.server = {
    host: cfg.server?.host || '127.0.0.1',
    port: ctx.server?.port ?? cfg.server?.port ?? 8787,
    tokenRequired: !!cfg.server?.token,
    sseClients: clientCount(),
    sseEnabled: cfg.server?.sse !== false,
  };
  return out;
}

function overview(ctx) {
  const cfg = ctx.cfg;
  const p = pendingWork();
  const db = dbStats();
  const items = listItems({ limit: 12 }).map(shapeItem);
  const approvals = listApprovals({ status: 'pending', limit: 12 }).map(shapeApproval).map(withItemTitle);
  const running = listTasks({ status: 'running', limit: 20 }).map(shapeTask);
  const queued = listTasks({ status: 'queued', limit: 20 }).map(shapeTask);
  const recentTasks = listTasks({ limit: 10 }).map(shapeTask);
  return {
    ok: true,
    generatedAt: nowIso(),
    version: readVersion(cfg),
    home: cfg.home,
    counts: {
      inbox: p.inbox,
      outbox: p.outbox,
      queued: p.queued,
      running: p.running,
      failed24h: p.failed24h,
      itemsTotal: db.items,
      tasksTotal: db.tasks,
      approvalsTotal: db.approvals,
      eventsTotal: db.events,
    },
    budget: todayCost(),
    db,
    topItems: items,
    pendingApprovals: approvals,
    runningTasks: running,
    queuedTasks: queued,
    recentTasks,
    recentEvents: recentEvents({ limit: 15 }),
    pulses: safePulses(),
  };
}

function items(ctx) {
  const bucket = qsStr(ctx.query, 'bucket');
  const status = qsStr(ctx.query, 'status');
  const source = qsStr(ctx.query, 'source');
  const search = qsStr(ctx.query, 'q');
  const limit = qsInt(ctx.query, 'limit', 100, 1, 500);
  const offset = qsInt(ctx.query, 'offset', 0, 0, 100000);
  const rows = listItems({ bucket, status, source, q: search, limit, offset });
  const p = pendingWork();
  return {
    ok: true,
    items: rows.map(shapeItem),
    count: rows.length,
    filters: { bucket: bucket ?? null, status: status ?? null, source: source ?? null, q: search ?? null, limit, offset },
    counts: { inbox: p.inbox, outbox: p.outbox, queued: p.queued, running: p.running },
  };
}

function itemDetail(ctx) {
  const id = ctx.params[0];
  const item = getItem(id);
  if (!item) bad(`item 不存在: ${id}`, 404);
  const tasks = listTasks({ item_id: id, limit: 100 });
  const taskIds = tasks.map((t) => t.id);
  let runs = [], artifacts = [];
  try {
    // runs / artifacts：只读，taskcenter 未提供 getter → 只读 SELECT（不碰 items/tasks 表）
    runs = taskIds.length
      ? q.all(`SELECT * FROM runs WHERE task_id IN (${inClause(taskIds)}) ORDER BY started_at DESC LIMIT 100`, ...taskIds)
      : [];
    artifacts = taskIds.length
      ? q.all(
        `SELECT * FROM artifacts WHERE item_id = ? OR task_id IN (${inClause(taskIds)})
         ORDER BY created_at DESC LIMIT 100`, id, ...taskIds)
      : q.all('SELECT * FROM artifacts WHERE item_id = ? ORDER BY created_at DESC LIMIT 100', id);
  } catch { /* 表异常不影响详情主体 */ }
  const approvals = listApprovals({ limit: 300 }).filter((a) => a.item_id === id).map(shapeApproval);
  return {
    ok: true,
    item: shapeItem(item),
    tasks: tasks.map(shapeTask),
    runs,
    artifacts,
    approvals,
    events: recentEvents({ item_id: id, limit: 200 }),
  };
}

function itemAction(ctx) {
  const id = ctx.params[0];
  const item = getItem(id);
  if (!item) bad(`item 不存在: ${id}`, 404);
  const body = bodyObject(ctx);
  const action = String(body.action || '').trim();
  const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};

  switch (action) {
    case 'dispatch': {
      const live = listTasks({ item_id: id, limit: 50 }).filter((t) => t.status === 'queued' || t.status === 'running');
      if (live.length) {
        throw new HttpError(409, `该事项已有进行中的任务: ${live[0].id}`, { task_id: live[0].id });
      }
      const task = createTask({
        item_id: id,
        title: payload.title || item.title,
        goal: payload.goal || item.body || item.title,
        executor: payload.executor || null,
        model: payload.model || null,
        autonomy_level: payload.autonomy_level ?? item.autonomy_level ?? 3,
        priority: item.priority ?? 0,
        timeout_sec: payload.timeout_sec,
        budget_tokens: payload.budget_tokens,
      });
      updateItem(id, { bucket: 'active', status: 'planned' }, {
        event: { actor: 'human', type: 'item.dispatched', message: `派单 → ${task.id}` },
      });
      return { ok: true, action, item: shapeItem(getItem(id)), task: shapeTask(task) };
    }
    case 'drop':
    case 'archive': {
      const status = action === 'drop' ? 'dropped' : 'archived';
      const updated = updateItem(id, { bucket: 'archive', status }, {
        event: { actor: 'human', type: `item.${status}`, message: action === 'drop' ? '人工丢弃' : '人工归档' },
      });
      return { ok: true, action, item: shapeItem(updated) };
    }
    case 'restore': {
      const updated = updateItem(id, { bucket: 'inbox', status: 'inbox' }, {
        event: { actor: 'human', type: 'item.restored', message: '恢复回收件箱' },
      });
      return { ok: true, action, item: shapeItem(updated) };
    }
    case 'relevel': {
      const raw = payload.level ?? payload.autonomy_level ?? body.level;
      const level = Number(raw);
      need(Number.isInteger(level) && level >= 1 && level <= 5, 'level 必须是 1..5 的整数');
      const updated = updateItem(id, { autonomy_level: level }, {
        event: {
          actor: 'human', type: 'item.relevel',
          message: `人工调级 L${item.autonomy_level ?? '?'} → L${level}`,
          data: { from: item.autonomy_level ?? null, to: level, reason: payload.reason ?? null },
        },
      });
      return { ok: true, action, item: shapeItem(updated) };
    }
    default:
      bad(`未知 action: ${action || '(空)'}；可用: dispatch | drop | archive | restore | relevel`);
  }
}

function createItem(ctx) {
  const body = bodyObject(ctx);
  const title = String(body.title || '').trim();
  need(title, 'title 必填');
  const source = String(body.source || 'manual').trim() || 'manual';
  const dedupe = body.dedupe_key || shortHash([source, title, body.body || '', nowIso()].join('|'), 24);
  const r = upsertItem({
    source,
    source_ref: body.source_ref ?? null,
    dedupe_key: dedupe,
    title,
    body: body.body ?? null,
    kind: body.kind || 'todo',
    domain: body.domain ?? null,
    urgency: body.urgency,
    impact: body.impact,
    due_at: body.due_at ?? null,
    meta: body.meta ?? null,
  });
  return { ok: true, created: r.created, item: shapeItem(r.item) };
}

function tasks(ctx) {
  const status = qsStr(ctx.query, 'status');
  const itemId = qsStr(ctx.query, 'item_id');
  const limit = qsInt(ctx.query, 'limit', 100, 1, 500);
  const rows = listTasks({ status, item_id: itemId, limit });
  const titles = new Map();
  for (const t of rows) {
    if (!t.item_id || titles.has(t.item_id)) continue;
    try { titles.set(t.item_id, getItem(t.item_id)?.title ?? null); } catch { /* ignore */ }
  }
  return {
    ok: true,
    tasks: rows.map((t) => ({ ...shapeTask(t), item_title: t.item_id ? (titles.get(t.item_id) ?? null) : null })),
    count: rows.length,
    counts: (() => { const p = pendingWork(); return { queued: p.queued, running: p.running, failed24h: p.failed24h }; })(),
  };
}

function taskDetail(ctx) {
  const id = ctx.params[0];
  const t = getTask(id);
  if (!t) bad(`task 不存在: ${id}`, 404);
  let runs = [], artifacts = [];
  try {
    runs = q.all('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 100', id);
    artifacts = q.all('SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at DESC LIMIT 100', id);
  } catch { /* ignore */ }
  const item = t.item_id ? getItem(t.item_id) : null;
  return {
    ok: true,
    task: shapeTask(t),
    item: shapeItem(item),
    runs,
    artifacts,
    events: recentEvents({ task_id: id, limit: 200 }),
  };
}

function taskRetry(ctx) {
  const id = ctx.params[0];
  const t = getTask(id);
  if (!t) bad(`task 不存在: ${id}`, 404);
  if (t.status === 'running') bad('任务正在运行：请先取消，等 Watchdog 结束进程后再重试', 409);
  if (t.status === 'queued') return { ok: true, task: shapeTask(t), note: '任务已在队列中' };
  if (t.status === 'succeeded') bad('任务已成功，无需重试', 409);
  const updated = updateTask(id, {
    status: 'queued',
    attempt: 0,
    last_error: null,
    finished_at: null,
    started_at: null,
    lease_until: null,
    heartbeat_at: null,
  });
  emit({
    actor: 'human', type: 'task.retried', task_id: id, item_id: t.item_id, level: 'warn',
    message: `人工重试（原状态 ${t.status}，attempt 归零）`,
  });
  return { ok: true, task: shapeTask(updated), note: '已重新入队，attempt 归零' };
}

function taskCancel(ctx) {
  const id = ctx.params[0];
  const t = getTask(id);
  if (!t) bad(`task 不存在: ${id}`, 404);
  if (t.status === 'succeeded') bad('任务已成功，无法取消', 409);
  if (t.status === 'cancelled') return { ok: true, task: shapeTask(t), note: '任务已是取消状态' };
  const updated = updateTask(id, { status: 'cancelled', finished_at: nowIso() });
  emit({
    actor: 'human', type: 'task.cancelled', task_id: id, item_id: t.item_id, level: 'warn',
    message: `人工取消（原状态 ${t.status}）`,
  });
  return {
    ok: true,
    task: shapeTask(updated),
    note: t.status === 'running'
      ? '已标记 cancelled；若执行进程仍在运行，Watchdog/Worker 会在下一次 tick 结束它'
      : undefined,
  };
}

function approvals(ctx) {
  const status = qsStr(ctx.query, 'status');
  const limit = qsInt(ctx.query, 'limit', 100, 1, 300);
  const rows = listApprovals({ status, limit }).map(shapeApproval).map(withItemTitle);
  return {
    ok: true,
    approvals: rows,
    count: rows.length,
    counts: (() => { const p = pendingWork(); return { pending: p.outbox }; })(),
  };
}

function approvalDecide(ctx) {
  const id = ctx.params[0];
  const cur = getApproval(id);
  if (!cur) bad(`approval 不存在: ${id}`, 404);
  if (cur.status !== 'pending') bad(`审批已处理: ${cur.status}`, 409);
  const body = bodyObject(ctx);
  const decision = String(body.decision || '').trim();
  need(decision === 'approved' || decision === 'rejected', 'decision 必须是 approved 或 rejected');
  const option = body.option != null ? String(body.option) : null;
  const note = body.note != null ? String(body.note) : null;
  const by = body.by ? String(body.by) : 'dashboard';
  let updated;
  try {
    updated = decideApproval(id, { decision, option, note, by });
  } catch (e) {
    throw new HttpError(409, e.message);
  }
  return {
    ok: true,
    approval: shapeApproval(updated),
    item: cur.item_id ? shapeItem(getItem(cur.item_id)) : null,
  };
}

function events(ctx) {
  const limit = qsInt(ctx.query, 'limit', 100, 1, 500);
  const since = qsInt(ctx.query, 'since', 0, 0, Number.MAX_SAFE_INTEGER);
  const itemId = qsStr(ctx.query, 'item_id');
  const taskId = qsStr(ctx.query, 'task_id');
  const level = qsStr(ctx.query, 'level');
  let rows = [];
  try { rows = recent({ limit, since, item_id: itemId, task_id: taskId, level }).map(shapeEvent); }
  catch (e) { throw new HttpError(500, `事件读取失败: ${e.message}`); }
  const lastId = rows.length ? Math.max(...rows.map((r) => Number(r.id) || 0)) : since;
  return { ok: true, events: rows, count: rows.length, lastId, filters: { since, item_id: itemId ?? null, task_id: taskId ?? null, level: level ?? null } };
}

function stream(ctx) {
  return openStream(ctx);
}

async function scan(ctx) {
  const cfg = ctx.cfg;
  const body = bodyObject(ctx);
  const listOnly = ctx.query.get('list') === '1' || body.list === true;
  const only = qsStr(ctx.query, 'source') || (typeof body.source === 'string' ? body.source : undefined);
  const timeoutMs = qsInt(ctx.query, 'timeoutMs', Number(body.timeoutMs) || 30000, 1000, 120000);
  const maxItems = qsInt(ctx.query, 'max', Number(body.max) || 300, 1, 2000);
  const logs = [];

  if (listOnly) {
    const inv = await sensorInventory(cfg);
    if (!inv.ready) return { ok: false, reason: 'sensor registry not ready', detail: inv.detail, sensors: [] };
    return { ok: true, mode: 'list', sensors: inv.names, path: inv.path };
  }

  if (_scanning) {
    return { ok: true, running: true, note: '已有一轮巡检在进行中，本次跳过', created: 0, seen: 0, scanned: 0 };
  }
  _scanning = true;
  const t0 = Date.now();
  try {
    const r = await runScan(cfg, { only, timeoutMs, maxItems, logs });
    return { ...r, ms: Date.now() - t0, logs: logs.slice(-50) };
  } catch (e) {
    return { ok: false, reason: `巡检失败: ${e.message}`, ms: Date.now() - t0, logs: logs.slice(-50), created: 0, seen: 0, scanned: 0 };
  } finally {
    _scanning = false;
  }
}

function contextGet() {
  let facts = [];
  try {
    facts = q.all('SELECT id,category,key,value,evidence,confidence,updated_at FROM context_facts ORDER BY category, key');
  } catch (e) {
    throw new HttpError(500, `上下文读取失败: ${e.message}`);
  }
  const grouped = {};
  for (const f of facts) (grouped[f.category || '未分类'] ||= []).push(f);
  return { ok: true, facts, grouped, count: facts.length };
}

function contextPost(ctx) {
  const body = bodyObject(ctx);
  const category = String(body.category || '').trim() || '未分类';
  const key = String(body.key || '').trim();
  need(key, 'key 必填');
  need(body.value !== undefined && body.value !== null && String(body.value).trim() !== '', 'value 必填');
  const value = String(body.value);
  const evidence = body.evidence != null ? String(body.evidence) : null;
  const confidence = body.confidence != null ? Math.min(1, Math.max(0, Number(body.confidence) || 0)) : 0.8;
  const id = body.id || ('ctx_' + shortHash([category, key].join('|'), 16));
  const ts = nowIso();
  try {
    q.run(
      `INSERT INTO context_facts(id,category,key,value,evidence,confidence,updated_at)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(category,key) DO UPDATE SET
         value=excluded.value, evidence=excluded.evidence,
         confidence=excluded.confidence, updated_at=excluded.updated_at`,
      id, category, key, value, evidence, confidence, ts
    );
  } catch (e) {
    throw new HttpError(500, `上下文写入失败: ${e.message}`);
  }
  emit({ actor: 'human', type: 'context.updated', message: `${category}/${key}`, data: { confidence } });
  const fact = q.get('SELECT id,category,key,value,evidence,confidence,updated_at FROM context_facts WHERE category=? AND key=?', category, key);
  return { ok: true, fact };
}

function contextDelete(ctx) {
  const id = ctx.params[0];
  const cur = q.get('SELECT * FROM context_facts WHERE id=?', id);
  if (!cur) bad(`上下文事实不存在: ${id}`, 404);
  q.run('DELETE FROM context_facts WHERE id=?', id);
  emit({ actor: 'human', type: 'context.deleted', message: `${cur.category}/${cur.key}` });
  return { ok: true, deleted: id };
}

async function doctor(ctx) {
  const cfg = ctx.cfg;
  const out = {
    ok: true,
    time: nowIso(),
    node: {
      ok: true,
      version: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
    },
    db: { ok: false, path: cfg.resolved.db, sizeBytes: 0, walBytes: 0, stats: null, error: null },
    executors: { ready: false, reason: 'executor registry not ready', probes: {} },
    sensors: { ready: false, reason: 'sensor registry not ready', names: [] },
    channels: {},
    config: {},
    budget: {},
    warnings: [],
    notes: [],
  };

  try { out.db = { ...out.db, ok: true, stats: dbStats() }; }
  catch (e) { out.db = { ...out.db, ok: false, error: e.message }; }
  try { out.db.sizeBytes = fs.statSync(cfg.resolved.db).size; } catch { /* 未建库 */ }
  try { out.db.walBytes = fs.statSync(cfg.resolved.db + '-wal').size; } catch { /* 无 WAL */ }

  out.executors = await probeExecutors(cfg, { force: true });
  out.sensors = await sensorInventory(cfg);

  // 通道探测：全部并行（异步 spawn），避免串行 spawn 把 /api/doctor 拖到数秒
  const channelDefs = [
    ['agentlyCli', 'agently-cli', 'QQ 邮箱通道（mail sensor 依赖）'],
    ['git', 'git', 'git sensor 依赖'],
    ['pwsh', 'pwsh', 'shell 执行器依赖'],
    ['dsh', 'dsh', 'dsh 执行器依赖'],
    ['pi', 'pi', 'pi 执行器依赖'],
    ['codex', 'codex', 'codex 执行器依赖'],
    ['claude', 'claude', 'claude 执行器依赖'],
  ];
  const found = await Promise.all(channelDefs.map(async ([key, cmd, note]) => [key, { ...(await which(cmd)), note }]));
  const ch = Object.fromEntries(found);
  const gitV = await commandVersion('git', ['--version']);
  ch.git = { ...ch.git, version: gitV.version, versionOk: gitV.ok };
  out.channels = ch;

  const enabledExec = Object.entries(cfg.executors || {}).filter(([, v]) => v && v.enabled !== false);
  const enabledSources = Object.entries(cfg.sources || {}).filter(([, v]) => v && v.enabled).map(([k]) => k);
  out.config = {
    home: cfg.home,
    file: cfg.resolved.configFile,
    server: {
      host: cfg.server?.host || '127.0.0.1',
      port: ctx.server?.port ?? cfg.server?.port ?? 8787,
      tokenRequired: !!cfg.server?.token,
      sseEnabled: cfg.server?.sse !== false,
    },
    executorsEnabled: enabledExec.map(([k]) => k),
    sourcesEnabled: enabledSources,
    settings: {
      dailyBudgetCny: cfg.settings?.dailyBudgetCny,
      maxConcurrentWorkers: cfg.settings?.maxConcurrentWorkers,
      quietThreshold: cfg.settings?.quietThreshold,
      approvalTtlHours: cfg.settings?.approvalTtlHours,
    },
  };

  try { out.budget = todayCost(); } catch (e) { out.budget = { error: e.message }; }

  // 告警
  if (!out.db.ok) out.warnings.push(`数据库不可用: ${out.db.error}`);
  if (!out.executors.ready) out.warnings.push(out.executors.reason);
  else {
    const probes = Object.entries(out.executors.probes || {});
    const okCount = probes.filter(([, v]) => v.ok).length;
    if (probes.length && okCount === 0) out.warnings.push('所有执行器探测均失败，当前无法派单执行');
    if (!probes.length) out.warnings.push('执行器注册表为空（probe() 未返回任何执行器）');
  }
  if (!out.sensors.ready) out.warnings.push(out.sensors.reason);
  for (const [name, c] of Object.entries(ch)) {
    if (!c.ok) out.warnings.push(`通道缺失: ${name}（${c.note}）`);
  }
  if (!cfg.server?.token) out.notes.push('当前无 X-Hive-Token 校验（仅监听 127.0.0.1，本地免密）');
  if (cfg.notify?.mail?.enabled && !cfg.notify?.mail?.to) out.warnings.push('邮件通知已启用但 notify.mail.to 为空');
  const host = cfg.server?.host || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') out.warnings.push(`服务未绑定回环地址（${host}），存在暴露风险`);

  const probesOk = Object.values(out.executors.probes || {}).filter((v) => v.ok).length;
  out.ok = out.db.ok && out.executors.ready && probesOk > 0;
  if (!out.executors.ready) out.reason = 'executor registry not ready';
  else if (!out.ok) out.reason = out.db.ok ? 'no executor available' : 'database unavailable';
  out.summary = {
    executorsOk: probesOk,
    executorsTotal: Object.keys(out.executors.probes || {}).length,
    sensors: out.sensors.names.length,
    warnings: out.warnings.length,
  };
  return out;
}

function artifactFile(ctx) {
  const id = ctx.params[0];
  let row = null;
  try { row = q.get('SELECT * FROM artifacts WHERE id=?', id); } catch { /* ignore */ }
  if (!row) bad(`artifact 不存在: ${id}`, 404);
  const cfg = ctx.cfg;
  const roots = [cfg.resolved.artifacts, cfg.resolved.runs, cfg.resolved.workspace]
    .filter(Boolean).map((p) => path.resolve(p));
  const target = path.resolve(row.path);
  const inside = roots.some((r) => target === r || target.startsWith(r + path.sep));
  if (!inside) {
    throw new HttpError(403, '产物路径不在允许的目录（artifacts/runs/workspace）内');
  }
  if (!fs.existsSync(target)) bad(`产物文件不存在: ${row.path}`, 404);
  const st = fs.statSync(target);
  if (!st.isFile()) bad('产物不是普通文件', 400);
  return { __file: target, bytes: st.size, name: row.title || path.basename(target) };
}

// ───────────────────────────── 路由表 ─────────────────────────────

const ROUTES = [
  { method: 'GET', name: 'health', pattern: /^\/api\/health\/?$/, handler: health },
  { method: 'GET', name: 'overview', pattern: /^\/api\/overview\/?$/, handler: overview },

  { method: 'GET', name: 'items', pattern: /^\/api\/items\/?$/, handler: items },
  { method: 'POST', name: 'items.create', pattern: /^\/api\/items\/?$/, handler: createItem },
  { method: 'GET', name: 'items.detail', pattern: /^\/api\/items\/([^/]+)\/?$/, handler: itemDetail },
  { method: 'POST', name: 'items.action', pattern: /^\/api\/items\/([^/]+)\/action\/?$/, handler: itemAction },

  { method: 'GET', name: 'tasks', pattern: /^\/api\/tasks\/?$/, handler: tasks },
  { method: 'GET', name: 'tasks.detail', pattern: /^\/api\/tasks\/([^/]+)\/?$/, handler: taskDetail },
  { method: 'POST', name: 'tasks.retry', pattern: /^\/api\/tasks\/([^/]+)\/retry\/?$/, handler: taskRetry },
  { method: 'POST', name: 'tasks.cancel', pattern: /^\/api\/tasks\/([^/]+)\/cancel\/?$/, handler: taskCancel },

  { method: 'GET', name: 'approvals', pattern: /^\/api\/approvals\/?$/, handler: approvals },
  { method: 'POST', name: 'approvals.decide', pattern: /^\/api\/approvals\/([^/]+)\/decide\/?$/, handler: approvalDecide },

  { method: 'GET', name: 'events', pattern: /^\/api\/events\/?$/, handler: events },
  { method: 'GET', name: 'stream', pattern: /^\/api\/stream\/?$/, handler: stream },
  { method: 'POST', name: 'scan', pattern: /^\/api\/scan\/?$/, handler: scan },

  { method: 'GET', name: 'context', pattern: /^\/api\/context\/?$/, handler: contextGet },
  { method: 'POST', name: 'context.set', pattern: /^\/api\/context\/?$/, handler: contextPost },
  { method: 'POST', name: 'context.delete', pattern: /^\/api\/context\/([^/]+)\/delete\/?$/, handler: contextDelete },

  { method: 'GET', name: 'doctor', pattern: /^\/api\/doctor\/?$/, handler: doctor },

  { method: 'GET', name: 'artifact.file', pattern: /^\/api\/artifacts\/([^/]+)\/?$/, handler: artifactFile },
];

export function matchRoute(method, pathname) {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const m = r.pattern.exec(pathname);
    if (m) return { name: r.name, handler: r.handler, params: m.slice(1).map((s) => { try { return decodeURIComponent(s); } catch { return s; } }) };
  }
  // 路径存在但方法不对 → 405
  for (const r of ROUTES) {
    if (r.pattern.exec(pathname)) return { methodMismatch: true, allowed: r.method, name: r.name };
  }
  return null;
}

export const routeTable = ROUTES.map((r) => ({ method: r.method, path: r.pattern.source, name: r.name }));

export { HANDLED };
