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
import { execFile, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { q, dbStats, cursorGet, cursorSet } from '../core/db.mjs';
import {
  doctorReport, installDependency, INSTALL_IDS, readDaemonLock,
  depsSnapshot, depAction, AGENT_DEPS_BY_ID,
} from './setup.mjs';
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

const PROBE_TTL_MS = 60000;
let _probeCache = { at: 0, value: null, path: '' };
let _probeInFlight = null;

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

/** 返回 {ready:boolean, reason?, probes?:{name:{ok,reason,version}}, path} —— 绝不抛
 *
 * 真实 probe() 要逐个 spawn 版本命令（本机 9 个执行器约 6–7 秒），
 * 所以：① 结果缓 60 秒；② 并发调用共享同一个 in-flight promise；
 * ③ 服务启动时用 warmExecutorsProbe() 预热，点开看板「环境自检」不再干等。
 */
export async function probeExecutors(cfg, { force = false } = {}) {
  const cacheKey = path.join(cfg.codeRoot || cfg.home, 'src', 'executors', 'index.mjs');
  if (!force && _probeCache.value && Date.now() - _probeCache.at < PROBE_TTL_MS && _probeCache.value.path === cacheKey) {
    return _probeCache.value;
  }
  if (_probeInFlight) return _probeInFlight;

  _probeInFlight = (async () => {
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
  })();

  try { return await _probeInFlight; }
  finally { _probeInFlight = null; }
}

// ── 外部通道探测（which + git --version）也缓存 60s，并支持启动预热 ──
const CHANNEL_TTL_MS = 60000;
const CHANNEL_DEFS = [
  ['agentlyCli', 'agently-cli', 'QQ 邮箱通道（mail sensor 依赖）'],
  ['git', 'git', 'git sensor 依赖'],
  ['pwsh', 'pwsh', 'shell 执行器依赖'],
  ['dsh', 'dsh', 'dsh 执行器依赖'],
  ['pi', 'pi', 'pi 执行器依赖'],
  ['codex', 'codex', 'codex 执行器依赖'],
  ['claude', 'claude', 'claude 执行器依赖'],
];
let _chanCache = { at: 0, value: null };
let _chanInFlight = null;

async function channelsInfo({ force = false } = {}) {
  if (!force && _chanCache.value && Date.now() - _chanCache.at < CHANNEL_TTL_MS) return _chanCache.value;
  if (_chanInFlight) return _chanInFlight;
  _chanInFlight = (async () => {
    // 全部并行（异步 spawn）；串行 spawn 在 Windows 上会让 /api/doctor 拖到数秒
    const found = await Promise.all(CHANNEL_DEFS.map(async ([key, cmd, note]) => [key, { ...(await which(cmd)), note }]));
    const ch = Object.fromEntries(found);
    const gitV = await commandVersion('git', ['--version']);
    ch.git = { ...ch.git, version: gitV.version, versionOk: gitV.ok };
    _chanCache = { at: Date.now(), value: ch };
    return ch;
  })();
  try { return await _chanInFlight; }
  finally { _chanInFlight = null; }
}

/** 服务启动后预热「环境自检」需要的两类慢探测（执行器 probe + 外部通道 which） */
let _warmStarted = false;
export function warmDoctorProbes(cfg) {
  if (_warmStarted) return;
  _warmStarted = true;
  try { probeExecutors(cfg).catch(() => {}); } catch { /* noop */ }
  try { channelsInfo().catch(() => {}); } catch { /* noop */ }
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

  out.executors = await probeExecutors(cfg);
  out.sensors = await sensorInventory(cfg);

  // 通道探测：并行 + 60s 缓存（启动时已预热；实测冷启动 ~2.4s，命中缓存 ~0ms）
  out.channels = await channelsInfo();

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
  for (const [name, c] of Object.entries(out.channels || {})) {
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

// ═════════════════════════ 仪表盘：执行器 / 自动任务 / 成本 / 自检 ═════════════════════════
//
// 数据边界（延续文件头约定）：
//  · runs / pulses 仍只用 core/db.mjs 的 q 做【只读 SELECT】。
//  · pulses 的 enabled 字段没有对应 API（taskcenter 不管 pulses，pulse.mjs 只有 seed/mark），
//    而这两个文件不在本任务的写作用域内 —— 因此只有「暂停/恢复」这一处内联 UPDATE，
//    且只改 enabled 一个字段，不动 spec / next_run_at / 状态机。
//  · 任务的标题/状态仍经 taskcenter 的 getTask() 读取，不直接 JOIN tasks 表。

const delay = (ms) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  if (t && typeof t.unref === 'function') t.unref();
});

const AGENT_NAMES = ['llm', 'dsh', 'pi', 'codex', 'claude', 'shell'];
const RUNTIME_PROBE_NAMES = new Set(['node', 'pwsh']);

function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daemonSummary(cfg) {
  const d = readDaemonLock(cfg);
  return {
    running: !!d.running,
    pid: d.pid ?? null,
    startedAt: d.startedAt ?? null,
    stale: !!d.stale,
    lockPath: d.lockPath ?? null,
  };
}

/** pulses 只读 SELECT（taskcenter 无 getter，见文件头约定）*/
function pulseRows() {
  try {
    return q.all(
      `SELECT id,name,spec,enabled,last_run_at,next_run_at,last_status,config
       FROM pulses ORDER BY id`
    ).map((p) => ({ ...p, enabled: !!p.enabled, config: parseJsonMaybe(p.config, {}) || {} }));
  } catch { return []; }
}

let _pulseModCache = null;
async function pulseModule(cfg) {
  if (_pulseModCache) return _pulseModCache;
  const load = await loadModule(cfg, 'src/task/pulse.mjs');
  _pulseModCache = load.ok ? load.mod : null;
  return _pulseModCache;
}

function scheduleText(spec) {
  const s = String(spec || '');
  let m = /^every:(\d+)([smh])$/.exec(s);
  if (m) return `每 ${m[1]} ${{ s: '秒', m: '分钟', h: '小时' }[m[2]]}`;
  m = /^daily:(\d{1,2}):(\d{2})$/.exec(s);
  if (m) return `每天 ${String(m[1]).padStart(2, '0')}:${m[2]}`;
  m = /^weekly:([\d,]+):(\d{1,2}):(\d{2})$/.exec(s);
  if (m) return `每周 [${m[1]}] ${String(m[2]).padStart(2, '0')}:${m[3]}`;
  return s || '—';
}

/** 单条脉冲 → 看板形状（nextFn 来自 src/task/pulse.mjs 的 nextRun，缺失时降级）*/
function shapePulse(p, nextFn) {
  let nextAt = p.next_run_at || null;
  if (!nextAt && typeof nextFn === 'function') {
    try { nextAt = nextFn(p.spec, new Date())?.toISOString() ?? null; } catch { nextAt = null; }
  }
  const due = !!nextAt && Date.parse(nextAt) <= Date.now();
  const handler = p.config?.handler ?? null;
  return {
    id: p.id,
    name: p.name || p.id,
    spec: p.spec,
    schedule: scheduleText(p.spec),
    enabled: !!p.enabled,
    handler,
    config: p.config ?? {},
    lastRunAt: p.last_run_at || null,
    lastStatus: p.last_status || null,
    nextRunAt: nextAt,
    due,
    overdueSec: due ? Math.max(0, Math.round((Date.now() - Date.parse(nextAt)) / 1000)) : 0,
  };
}

// ── 1) GET /api/agents —— 执行器汇总 ────────────────────────────────
async function agents(ctx) {
  const cfg = ctx.cfg;
  const probe = await probeExecutors(cfg);
  const probes = probe.probes || {};
  const since = new Date(Date.now() - 86400e3).toISOString();
  let rows24 = [];
  let rowsAll = [];
  try {
    rows24 = q.all(
      `SELECT COALESCE(executor,'(未知)') AS executor,
              COUNT(*) AS total,
              SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN status IN ('failed','timeout') THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running,
              AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END) AS avgMs,
              COALESCE(SUM(cost_cny),0) AS costCny,
              COALESCE(SUM(tokens_in),0) AS tokensIn,
              COALESCE(SUM(tokens_out),0) AS tokensOut,
              MAX(started_at) AS lastRunAt
         FROM runs WHERE started_at >= ? GROUP BY COALESCE(executor,'(未知)')`, since
    );
    rowsAll = q.all(
      `SELECT COALESCE(executor,'(未知)') AS executor,
              COUNT(*) AS total,
              COALESCE(SUM(cost_cny),0) AS costCny,
              COALESCE(SUM(tokens_in),0)+COALESCE(SUM(tokens_out),0) AS tokens
         FROM runs GROUP BY COALESCE(executor,'(未知)')`
    );
  } catch { /* runs 表异常不影响执行器清单 */ }

  const m24 = new Map(rows24.map((r) => [r.executor, r]));
  const mAll = new Map(rowsAll.map((r) => [r.executor, r]));
  const names = [
    ...AGENT_NAMES,
    ...Object.keys(probes).filter((n) => !AGENT_NAMES.includes(n) && !RUNTIME_PROBE_NAMES.has(n)),
  ];
  const executors = names.map((name) => {
    const p = probes[name] || {};
    const r24 = m24.get(name) || {};
    const all = mAll.get(name) || {};
    const total = Number(r24.total) || 0;
    const ok = Number(r24.ok) || 0;
    return {
      name,
      kind: p.kind ?? cfg.executors?.[name]?.kind ?? null,
      enabled: p.enabled ?? (cfg.executors?.[name]?.enabled !== false),
      ok: !!p.ok,
      version: p.version ?? null,
      reason: p.ok ? null : (p.reason ?? (probes[name] ? null : 'probe 未返回该执行器')),
      runs24h: { total, ok, failed: Number(r24.failed) || 0, running: Number(r24.running) || 0 },
      successRate: total ? +(ok / total).toFixed(3) : null,
      avgDurationMs: r24.avgMs != null ? Math.round(Number(r24.avgMs)) : null,
      costCny: +(Number(r24.costCny) || 0).toFixed(4),
      tokensIn: Number(r24.tokensIn) || 0,
      tokensOut: Number(r24.tokensOut) || 0,
      lastRunAt: r24.lastRunAt || null,
      lifetime: {
        runs: Number(all.total) || 0,
        costCny: +(Number(all.costCny) || 0).toFixed(4),
        tokens: Number(all.tokens) || 0,
      },
    };
  });
  const runtimes = Object.entries(probes)
    .filter(([n]) => RUNTIME_PROBE_NAMES.has(n))
    .map(([n, v]) => ({ name: n, ok: !!v.ok, version: v.version ?? null, reason: v.ok ? null : (v.reason ?? null) }));
  const sum = (f) => executors.reduce((a, e) => a + (Number(f(e)) || 0), 0);
  const timed = executors.filter((e) => e.avgDurationMs != null);
  return {
    ok: true,
    generatedAt: nowIso(),
    ready: !!probe.ready,
    reason: probe.reason ?? null,
    detail: probe.detail ?? null,
    windowHours: 24,
    executors,
    runtimes,
    summary: {
      executors: executors.length,
      available: executors.filter((e) => e.ok).length,
      enabled: executors.filter((e) => e.enabled).length,
      runs24h: sum((e) => e.runs24h.total),
      ok24h: sum((e) => e.runs24h.ok),
      failed24h: sum((e) => e.runs24h.failed),
      costCny24h: +sum((e) => e.costCny).toFixed(4),
      costCnyAll: +sum((e) => e.lifetime.costCny).toFixed(4),
      avgDurationMs: timed.length ? Math.round(timed.reduce((a, e) => a + e.avgDurationMs, 0) / timed.length) : null,
    },
    daemon: daemonSummary(cfg),
  };
}

// ── 2) GET /api/autopilots —— 脉冲（自动任务）列表 ─────────────────────
async function autopilots(ctx) {
  const cfg = ctx.cfg;
  const mod = await pulseModule(cfg);
  const nextFn = mod ? pickFn(mod, ['nextRun']) : null;
  const pulses = pulseRows().map((p) => shapePulse(p, nextFn));
  const daemon = daemonSummary(cfg);
  return {
    ok: true,
    generatedAt: nowIso(),
    daemon,
    pulses,
    summary: {
      total: pulses.length,
      enabled: pulses.filter((p) => p.enabled).length,
      paused: pulses.filter((p) => !p.enabled).length,
      due: pulses.filter((p) => p.enabled && p.due).length,
      failing: pulses.filter((p) => p.lastStatus === 'fail').length,
    },
    notes: [
      daemon.running
        ? '守护进程在跑：到期脉冲会被自动执行'
        : '守护进程未运行：脉冲不会自己跑，可「立即执行」补跑，或在下面启动守护进程',
      pulses.length ? null : '脉冲表为空：守护进程首次启动会 seedPulses() 写入默认巡检节奏（也可 node --no-warnings scripts/hive.mjs seed）',
    ].filter(Boolean),
  };
}

// ── 3) POST /api/autopilots/:id/toggle —— 暂停/恢复 ────────────────
function autopilotToggle(ctx) {
  const cfg = ctx.cfg;
  const id = ctx.params[0];
  const body = bodyObject(ctx);
  const cur = pulseRows().find((p) => p.id === id);
  if (!cur) bad(`脉冲不存在: ${id}`, 404);
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : !cur.enabled;
  // pulses 的唯一写入点（见本节顶部说明）：只改 enabled，不动其他字段。
  let changes = 0;
  try {
    const r = q.run('UPDATE pulses SET enabled=? WHERE id=?', enabled ? 1 : 0, id);
    changes = Number(r?.changes) || 0;
  } catch (e) {
    throw new HttpError(500, `脉冲开关写入失败: ${e.message}`);
  }
  emit({
    actor: 'human', type: enabled ? 'pulse.resumed' : 'pulse.paused', level: 'warn',
    message: `${cur.name || id} → ${enabled ? '启用' : '暂停'}`,
  });
  const after = pulseRows().find((p) => p.id === id) || cur;
  const shape = shapePulse(after, null);
  return {
    ok: true,
    id,
    enabled: shape.enabled,
    pulse: shape,
    changed: changes,
    note: enabled
      ? (cur.last_status === 'fail'
        ? '已恢复；上次执行失败，注意观察下一轮'
        : '已恢复：守护进程会在下个 tick 按周期执行')
      : '已暂停：守护进程跳过它，周期与上次结果保留',
    daemon: daemonSummary(cfg),
  };
}

// ── 4) POST /api/autopilots/:id/run —— 立即执行一次 ────────────────
// 守护进程里的 handler 表在 scripts/hive.mjs 的进程内存里，跨进程无法直接调用；
// 这里只代跑【能独立复现】的三个 handler（scan / triage / watchdog），
// 其余（digest 需要 LLM、context/selfcheck 依赖守护进程上下文）如实说明不代跑。
const PULSE_RUNNERS = {
  async scan(ctx, pulse) {
    const logs = [];
    const r = await runScan(ctx.cfg, {
      only: pulse.config?.source,
      timeoutMs: 60000,
      maxItems: 300,
      logs,
    });
    return {
      ok: !!r.ok,
      summary: r.ok
        ? `扫描 ${r.scanned} 条 · 新增 ${r.created} · 去重 ${r.seen}${r.failed ? ' · 失败 ' + r.failed : ''}`
        : `扫描失败: ${r.reason || '未知'}`,
      detail: r,
      logs: logs.slice(-20),
    };
  },
  async triage(ctx) {
    const load = await loadModule(ctx.cfg, 'src/task/router.mjs');
    if (!load.ok) return { ok: false, summary: '路由模块未就绪', reason: load.reason };
    const fn = pickFn(load.mod, ['triageInbox']);
    if (typeof fn !== 'function') return { ok: false, summary: 'router.mjs 未导出 triageInbox()' };
    const r = await fn({ limit: 15 });
    return { ok: true, summary: `判定 ${Array.isArray(r) ? r.length : 0} 项` };
  },
  async watchdog(ctx) {
    const load = await loadModule(ctx.cfg, 'src/task/watchdog.mjs');
    if (!load.ok) return { ok: false, summary: '看门狗模块未就绪', reason: load.reason };
    const fn = pickFn(load.mod, ['tick']);
    if (typeof fn !== 'function') return { ok: false, summary: 'watchdog.mjs 未导出 tick()' };
    const a = await fn();
    return { ok: true, summary: `${Array.isArray(a) ? a.length : 0} 个动作` };
  },
};

const PULSE_NOT_RUNNABLE = {
  digest: '晨报/晚报要调用 LLM 并推送通知，属于守护进程职责，Web 端不代跑（避免重复计费/重复推送）',
  context: '上下文刷新依赖守护进程的上下文模块，Web 端不代跑',
  selfcheck: '定时自检依赖看门狗的运行态统计，Web 端不代跑',
};

async function markPulse(cfg, pulse, status) {
  const mod = await pulseModule(cfg);
  const fn = mod ? pickFn(mod, ['markPulseRun']) : null;
  if (typeof fn === 'function') {
    try { fn(pulse, status); return { ok: true, via: 'pulse.mjs' }; }
    catch (e) { /* 落到下面的兜底 */ }
  }
  try {
    q.run('UPDATE pulses SET last_run_at=?, last_status=? WHERE id=?', nowIso(), status, pulse.id);
    return { ok: true, via: 'sql-fallback' };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function autopilotRun(ctx) {
  const cfg = ctx.cfg;
  const id = ctx.params[0];
  const row = pulseRows().find((p) => p.id === id);
  if (!row) bad(`脉冲不存在: ${id}`, 404);
  const pulse = shapePulse(row, null);
  const daemon = daemonSummary(cfg);
  const handler = String(pulse.handler || '');
  const runner = PULSE_RUNNERS[handler];

  if (!runner) {
    return {
      ok: false,
      ran: false,
      skipped: true,
      id,
      name: pulse.name,
      handler: handler || null,
      reason: PULSE_NOT_RUNNABLE[handler]
        ? PULSE_NOT_RUNNABLE[handler]
        : `脉冲 handler=${handler || '(未配置)'} 没有可独立复现的实现，Web 端不代跑`,
      hint: daemon.running
        ? '守护进程在跑：它会在下个 tick 自然触发；想立刻跑可重启守护进程或用 CLI'
        : '启动守护进程后由它按周期执行：node --no-warnings scripts/hive.mjs daemon',
      daemon,
    };
  }

  const t0 = Date.now();
  try {
    const r = await withTimeout(runner(ctx, row), 120000, `脉冲 ${pulse.name}`);
    const ms = Date.now() - t0;
    const mark = await markPulse(cfg, row, r && r.ok === false ? 'fail' : 'ok');
    emit({
      actor: 'human', type: 'pulse.manual_run', level: 'info',
      message: `人工补跑 ${pulse.name}（${handler}）${r?.summary ? ' · ' + r.summary : ''}`,
    });
    return {
      ok: !(r && r.ok === false),
      ran: true,
      id,
      name: pulse.name,
      handler,
      ms,
      result: r,
      marked: mark,
      note: daemon.running ? '守护进程在跑：本次为人工补跑，下个 tick 仍会自然触发' : '已人工执行一次',
      daemon,
    };
  } catch (e) {
    const ms = Date.now() - t0;
    await markPulse(cfg, row, 'fail');
    emit({ actor: 'human', type: 'pulse.manual_run', level: 'error', message: `人工补跑 ${pulse.name} 失败: ${String(e.message).slice(0, 300)}` });
    return { ok: false, ran: true, id, name: pulse.name, handler, ms, error: e.message, daemon };
  }
}

// ── 5) GET /api/cost?days=7 —— 成本聚合 ────────────────────────────
function costReport(ctx) {
  const days = qsInt(ctx.query, 'days', 7, 1, 90);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const from = new Date(today);
  from.setDate(from.getDate() - (days - 1));
  const fromIso = from.toISOString();

  let byExecutor = [];
  let topTasks = [];
  const byDay = [];
  let err = null;
  try {
    byExecutor = q.all(
      `SELECT COALESCE(executor,'(未知)') AS executor, COUNT(*) AS runs,
              SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN status IN ('failed','timeout') THEN 1 ELSE 0 END) AS failed,
              COALESCE(SUM(cost_cny),0) AS costCny,
              COALESCE(SUM(tokens_in),0) AS tokensIn,
              COALESCE(SUM(tokens_out),0) AS tokensOut
         FROM runs WHERE started_at >= ?
         GROUP BY COALESCE(executor,'(未知)') ORDER BY costCny DESC`, fromIso
    ).map((r) => ({
      executor: r.executor,
      runs: Number(r.runs) || 0,
      ok: Number(r.ok) || 0,
      failed: Number(r.failed) || 0,
      costCny: +Number(r.costCny || 0).toFixed(4),
      tokensIn: Number(r.tokensIn) || 0,
      tokensOut: Number(r.tokensOut) || 0,
      tokens: (Number(r.tokensIn) || 0) + (Number(r.tokensOut) || 0),
    }));

    const top = q.all(
      `SELECT task_id, COALESCE(SUM(cost_cny),0) AS costCny, COUNT(*) AS runs,
              COALESCE(SUM(tokens_in),0) AS tokensIn, COALESCE(SUM(tokens_out),0) AS tokensOut
         FROM runs WHERE started_at >= ? AND task_id IS NOT NULL
         GROUP BY task_id ORDER BY costCny DESC, tokensOut DESC LIMIT 10`, fromIso
    );
    topTasks = top.map((t) => {
      let title = null, status = null, executor = null;
      try {
        const tk = getTask(t.task_id); // 任务仍经 taskcenter 读
        title = tk?.title ?? null; status = tk?.status ?? null; executor = tk?.executor ?? null;
      } catch { /* ignore */ }
      return {
        task_id: t.task_id, title, status, executor,
        costCny: +Number(t.costCny || 0).toFixed(4),
        runs: Number(t.runs) || 0,
        tokensIn: Number(t.tokensIn) || 0,
        tokensOut: Number(t.tokensOut) || 0,
        tokens: (Number(t.tokensIn) || 0) + (Number(t.tokensOut) || 0),
      };
    });

    // 按「本地日」切窗口：started_at 存 UTC ISO，直接用 date() 会错位
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const aIso = d.toISOString();
      const e = new Date(d);
      e.setDate(e.getDate() + 1);
      const r = q.get(
        `SELECT COUNT(*) AS runs, COALESCE(SUM(cost_cny),0) AS costCny,
                COALESCE(SUM(tokens_in),0) AS tokensIn, COALESCE(SUM(tokens_out),0) AS tokensOut,
                SUM(CASE WHEN status IN ('failed','timeout') THEN 1 ELSE 0 END) AS failed
           FROM runs WHERE started_at >= ? AND started_at < ?`, aIso, e.toISOString()
      ) || {};
      byDay.push({
        date: localDateKey(d),
        label: localDateKey(d).slice(5),
        runs: Number(r.runs) || 0,
        failed: Number(r.failed) || 0,
        costCny: +Number(r.costCny || 0).toFixed(4),
        tokensIn: Number(r.tokensIn) || 0,
        tokensOut: Number(r.tokensOut) || 0,
        tokens: (Number(r.tokensIn) || 0) + (Number(r.tokensOut) || 0),
      });
    }
  } catch (e) { err = e.message; }

  const sum = (k) => byDay.reduce((a, d) => a + (Number(d[k]) || 0), 0);
  let budget = null;
  try { budget = todayCost(); } catch (e) { budget = { error: e.message }; }
  const bCfg = Number(budget?.budget) || 0;
  const bSpent = Number(budget?.costCny) || 0;
  const empty = byDay.every((d) => d.runs === 0);

  return {
    ok: true,
    generatedAt: nowIso(),
    days,
    error: err,
    range: {
      from: fromIso,
      to: new Date().toISOString(),
      fromDate: localDateKey(from),
      toDate: localDateKey(today),
      label: days === 1 ? '今天' : `近 ${days} 天`,
    },
    totals: {
      costCny: +sum('costCny').toFixed(4),
      tokensIn: sum('tokensIn'),
      tokensOut: sum('tokensOut'),
      tokens: sum('tokensIn') + sum('tokensOut'),
      runs: sum('runs'),
      failed: sum('failed'),
    },
    byDay,
    byExecutor,
    topTasks: topTasks.slice(0, 10),
    budget,
    budgetProgress: {
      budgetCny: bCfg,
      spentCny: bSpent,
      ratio: bCfg ? +(bSpent / bCfg).toFixed(3) : 0,
      remainingCny: bCfg ? +Math.max(0, bCfg - bSpent).toFixed(4) : null,
      warnRatio: Number(ctx.cfg?.settings?.budgetWarnRatio) || 0.8,
    },
    empty,
    note: empty
      ? '窗口内没有任何运行记录：成本为 0 是正常的（还没有任务真正调用过 LLM / CLI）'
      : null,
  };
}

// ── 6) GET /api/setup/doctor —— 自检 ───────────────────────────────
async function setupDoctor(ctx) {
  const cfg = ctx.cfg;
  const [probe, channels] = await Promise.all([
    probeExecutors(cfg),
    channelsInfo(),
  ]);
  let budget = null;
  try { budget = todayCost(); } catch (e) { budget = { error: e.message }; }
  let stats = null;
  try { stats = dbStats(); } catch (e) { stats = { error: e.message }; }
  return doctorReport({ cfg, probe, channels, budget, dbStats: stats, server: ctx.server });
}

// ── 7) 可选 Agent 依赖（版本管理）────────────────────────────────────
// 规则（用户明确要求）：
//  · 绝不自动安装 —— 只有用户点按钮才执行；
//  · 安装前先探测，已装且版本相同 → noop，不重复装；
//  · 安装/卸载后重新探测版本，返回 before / after；
//  · 每次操作都写 events（dep.install / dep.uninstall），便于审计。
const LEGACY_DEP_ALIAS = {
  'dsh-cli': 'dsh',
  'pi-cli': 'pi',
  'codex-cli': 'codex',
  'claude-cli': 'claude',
  'agently-cli': 'agently',
};

async function runDepAction(ctx, id, action, { version = null, dryRun = false, confirm = false } = {}) {
  const cfg = ctx.cfg;
  const t0 = Date.now();
  let r;
  try {
    r = await depAction({ id, action, version, dryRun, confirm });
  } catch (e) {
    if (e && e.status) throw new HttpError(e.status, e.message);
    throw e;
  }
  const ok = !!r.ok;
  const eventType = action === 'uninstall' ? 'dep.uninstall' : 'dep.install';
  emit({
    actor: 'human',
    type: eventType,
    level: ok ? 'info' : 'warn',
    message: `${r.id || id} ${action}${r.targetVersion ? ' @' + r.targetVersion : ''} → ${ok ? (r.noop ? 'noop' : (r.dryRun ? 'dryRun' : 'ok')) : 'fail'}${r.changed ? `（${r.before || '未安装'} → ${r.after}）` : ''}`,
    data: {
      id: r.id || id, pkg: r.pkg || null, action,
      version: r.targetVersion || version || null,
      before: r.before ?? null, after: r.after ?? null,
      exitCode: r.exitCode ?? null, ms: r.ms ?? null,
      noop: !!r.noop, dryRun: !!r.dryRun, ok,
    },
  });

  // 真装了/卸了 → 立刻强制复探执行器与通道，前端不用等 60s 缓存过期
  if (ok && !r.noop && !r.dryRun) {
    try {
      const probe = await probeExecutors(cfg, { force: true });
      r.executorProbe = {
        ready: !!probe.ready,
        ok: Object.entries(probe.probes || {}).filter(([, v]) => v && v.ok).map(([n]) => n),
      };
    } catch { /* 复探失败不影响结论 */ }
    try { await channelsInfo({ force: true }); } catch { /* 通道探测失败不影响结论 */ }
  }
  return { ...r, ok, id: r.id || id, action, durationMs: r.ms ?? (Date.now() - t0) };
}

async function depsEndpoint() {
  return depsSnapshot({ force: false });
}

async function depsCheck() {
  return depsSnapshot({ force: true });
}

async function depsInstall(ctx) {
  const body = bodyObject(ctx);
  return runDepAction(ctx, ctx.params[0], 'install', {
    version: body.version ?? null,
    dryRun: body.dryRun === true,
  });
}

async function depsUpdate(ctx) {
  const body = bodyObject(ctx);
  return runDepAction(ctx, ctx.params[0], 'update', { dryRun: body.dryRun === true });
}

async function depsUninstall(ctx) {
  const body = bodyObject(ctx);
  need(body.version == null || body.version === '', '卸载不接受 version 参数');
  return runDepAction(ctx, ctx.params[0], 'uninstall', {
    confirm: body.confirm === true,
    dryRun: body.dryRun === true,
  });
}

// ── 8) POST /api/setup/install —— 旧接口（兼容别名 → /api/deps/:id/install）
async function setupInstall(ctx) {
  const cfg = ctx.cfg;
  const body = bodyObject(ctx);
  const id = String(body.id || '').trim();
  const agentIds = Object.keys(AGENT_DEPS_BY_ID);
  need(id, `id 必填（Agent 依赖：${agentIds.join(', ')}；兼容旧 id：${INSTALL_IDS.join(', ')}）`);

  const legacy = LEGACY_DEP_ALIAS[id];
  if (legacy) {
    const r = await runDepAction(ctx, legacy, 'install', {
      version: body.version ?? null,
      dryRun: body.dryRun === true,
    });
    return { ...r, aliasOf: `/api/deps/${legacy}/install`, legacyId: id };
  }
  need(INSTALL_IDS.includes(id), `不支持的安装目标: ${id}；可用: ${agentIds.join(', ')} 或 ${INSTALL_IDS.join(', ')}`);

  // nodejs 走「只检测 + 引导」的旧语义（绝不 npm 安装 Node 本体）
  const timeoutMs = Math.min(300000, Math.max(5000, Number(body.timeoutMs) || 180000));
  const r = await installDependency({ cfg, id, timeoutMs });
  if (r.installed) {
    try {
      const probe = await probeExecutors(cfg, { force: true });
      r.executorProbe = {
        ready: !!probe.ready,
        ok: Object.entries(probe.probes || {}).filter(([, v]) => v && v.ok).map(([n]) => n),
      };
    } catch { /* 复探失败不影响安装结论 */ }
  }
  emit({
    actor: 'human', type: 'setup.install', level: r.ok ? 'info' : 'warn',
    message: `${id} → ${r.ok ? (r.already ? '已安装' : '安装成功') : (r.needManual ? '需人工安装' : '未安装')}`,
  });
  return { ok: !!r.ok, ...r };
}

// ── 9) POST /api/control/start|stop|scan —— 守护进程控制 ────────────
async function controlStart(ctx) {
  const cfg = ctx.cfg;
  const body = bodyObject(ctx);
  const d = readDaemonLock(cfg);
  if (d.running) {
    return {
      ok: true, running: true, started: false,
      daemon: daemonSummary(cfg),
      note: `守护进程已在运行（pid=${d.pid}），无需重复启动`,
    };
  }
  const script = path.join(cfg.codeRoot || cfg.home, 'scripts', 'hive.mjs');
  const cmdLine = `${process.execPath} --no-warnings ${script} daemon`;
  if (body.spawn === false) {
    return {
      ok: true, running: false, started: false, cmd: cmdLine,
      daemon: daemonSummary(cfg),
      note: '未实际拉起（spawn=false）：请在终端执行上面的命令，或由 DSH 插件托管守护进程',
    };
  }
  if (!fs.existsSync(script)) {
    return {
      ok: false, running: false, started: false,
      error: `找不到 ${script}`,
      note: 'scripts/hive.mjs 缺失：检查代码完整性（或由 DSH 插件托管守护进程）',
    };
  }
  if (d.stale) { try { fs.unlinkSync(d.lockPath); } catch { /* 残留锁清理失败不阻塞 */ } }
  try {
    const child = spawn(process.execPath, ['--no-warnings', script, 'daemon'], {
      detached: true, stdio: 'ignore', windowsHide: true, cwd: cfg.codeRoot || cfg.home, env: process.env,
    });
    child.unref();
    await delay(1500);
    const after = readDaemonLock(cfg);
    return {
      ok: true,
      running: !!after.running,
      started: true,
      pid: child.pid ?? null,
      daemon: daemonSummary(cfg),
      note: after.running
        ? `守护进程已启动（pid=${after.pid}）`
        : `已拉起进程（pid=${child.pid}），但 1.5s 内未看到锁文件；可能仍在初始化，稍后刷新状态`,
    };
  } catch (e) {
    return {
      ok: false, running: false, started: false,
      error: `拉起失败: ${e.message}`,
      note: `可手动执行：${cmdLine}`,
    };
  }
}

async function controlStop(ctx) {
  const cfg = ctx.cfg;
  const body = bodyObject(ctx);
  const d = readDaemonLock(cfg);
  if (!d.running) {
    let cleaned = false;
    if (d.stale) { try { fs.unlinkSync(d.lockPath); cleaned = true; } catch { /* noop */ } }
    return {
      ok: true, running: false, stopped: false, cleanedStaleLock: cleaned,
      daemon: daemonSummary(cfg),
      note: cleaned ? '没有活着的守护进程；已清理残留锁文件' : '守护进程未运行（无需停止）',
    };
  }
  if (body.confirm !== true) {
    throw new HttpError(409, `停止守护进程需要确认：请求体带 {"confirm": true}（pid=${d.pid}）`, { pid: d.pid });
  }
  const sig = body.force === true ? 'SIGKILL' : 'SIGTERM';
  try { process.kill(d.pid, sig); }
  catch (e) {
    return {
      ok: false, running: true, stopped: false,
      error: `发送 ${sig} 失败: ${e.message}`,
      daemon: daemonSummary(cfg),
    };
  }
  await delay(800);
  const after = readDaemonLock(cfg);
  if (!after.running && after.stale) { try { fs.unlinkSync(after.lockPath); } catch { /* noop */ } }
  return {
    ok: true,
    running: !!after.running,
    stopped: !after.running,
    signal: sig,
    daemon: daemonSummary(cfg),
    note: after.running
      ? `已发送 ${sig}，进程仍在（Windows 下 SIGTERM 可能被忽略；可重试 force=true）`
      : '守护进程已停止',
  };
}

// 看板「巡检」按钮走这里（与 POST /api/scan 同一实现，语义更明确）
function controlScan(ctx) {
  return scan(ctx);
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

  // ── 仪表盘（执行器 / 自动任务 / 成本 / 自检安装）────────────────────
  { method: 'GET', name: 'agents', pattern: /^\/api\/agents\/?$/, handler: agents },
  { method: 'GET', name: 'autopilots', pattern: /^\/api\/autopilots\/?$/, handler: autopilots },
  { method: 'POST', name: 'autopilots.toggle', pattern: /^\/api\/autopilots\/([^/]+)\/toggle\/?$/, handler: autopilotToggle },
  { method: 'POST', name: 'autopilots.run', pattern: /^\/api\/autopilots\/([^/]+)\/run\/?$/, handler: autopilotRun },
  { method: 'GET', name: 'cost', pattern: /^\/api\/cost\/?$/, handler: costReport },
  { method: 'GET', name: 'setup.doctor', pattern: /^\/api\/setup\/doctor\/?$/, handler: setupDoctor },
  { method: 'POST', name: 'setup.install', pattern: /^\/api\/setup\/install\/?$/, handler: setupInstall },

  // 可选 Agent 依赖：装 / 卸 / 升级 / 降级（全部由用户点击触发）
  { method: 'GET', name: 'deps', pattern: /^\/api\/deps\/?$/, handler: depsEndpoint },
  { method: 'POST', name: 'deps.check', pattern: /^\/api\/deps\/check\/?$/, handler: depsCheck },
  { method: 'POST', name: 'deps.install', pattern: /^\/api\/deps\/([^/]+)\/install\/?$/, handler: depsInstall },
  { method: 'POST', name: 'deps.update', pattern: /^\/api\/deps\/([^/]+)\/update\/?$/, handler: depsUpdate },
  { method: 'POST', name: 'deps.uninstall', pattern: /^\/api\/deps\/([^/]+)\/uninstall\/?$/, handler: depsUninstall },

  { method: 'POST', name: 'control.start', pattern: /^\/api\/control\/start\/?$/, handler: controlStart },
  { method: 'POST', name: 'control.stop', pattern: /^\/api\/control\/stop\/?$/, handler: controlStop },
  { method: 'POST', name: 'control.scan', pattern: /^\/api\/control\/scan\/?$/, handler: controlScan },

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
