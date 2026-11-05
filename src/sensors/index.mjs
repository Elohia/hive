// src/sensors/index.mjs — 传感器注册表
//
// 统一契约（docs/01-ARCHITECTURE.md §6.1）：
//   export default { name, enabled(cfg), async *scan(ctx) }
//   yield { source, source_ref, title, body, ts, kind_hint, domain_hint, urgency_hint, meta }
//
// 注册表职责：
//   - list(cfg)               → 传感器清单（名称/启用/间隔），给看板与 pulses 注册用
//   - get(name)               → 单个传感器
//   - scanAll(ctx, {only})    → 依次跑，**任一 sensor 抛错只隔离它自己**，其余照跑
//   - collect(ctx, {only})    → 收集成数组 + 逐传感器诊断（条数/耗时/失败原因）
//
// 只读：本模块不写库。cursor 由 ctx.cursor 注入（daemon 提供）。
import { makeCtx, note, clampInt, oneLine, coerceDomain, ALLOWED_DOMAINS } from './_util.mjs';

import mail from './mail.mjs';
import git from './git.mjs';
import docs from './docs.mjs';
import calendar from './calendar.mjs';
import pulsesLocal from './pulses_local.mjs';
import self from './self.mjs';

/** 注册顺序 = 执行顺序（快/重要的先跑；自检放最后，能看到前几步的痕迹） */
const SENSORS = [mail, git, docs, calendar, pulsesLocal, self];

const BY_NAME = new Map(SENSORS.map((s) => [s.name, s]));

/** item 上限，防止某个传感器失控把库写爆 */
const MAX_BODY_CHARS = 20_000;
const MAX_TITLE_CHARS = 200;

/* ------------------------------ 查询 ------------------------------ */

/** 传感器清单 */
export function list(cfg) {
  return SENSORS.map((s) => {
    let enabled = true;
    try {
      enabled = typeof s.enabled === 'function' ? !!s.enabled(cfg) : true;
    } catch { enabled = false; }
    return {
      name: s.name,
      title: s.title || s.name,
      enabled,
      intervalSec: clampInt(cfg?.sources?.[s.name]?.intervalSec, 1, 86400, 1800),
      hasStatus: typeof s.status === 'function',
    };
  });
}

/** 传感器名字数组 */
export function names() {
  return SENSORS.map((s) => s.name);
}

/** 取单个传感器（不存在返回 null） */
export function get(name) {
  if (!name) return null;
  return BY_NAME.get(String(name).trim()) || null;
}

/** 只要启用的传感器名 */
export function enabledNames(cfg) {
  return list(cfg).filter((x) => x.enabled).map((x) => x.name);
}

/* ------------------------------ 归一化 ------------------------------ */

function normalizeItem(raw, fallbackSource, diag) {
  if (!raw || typeof raw !== 'object') return null;

  const source = String(raw.source || fallbackSource || '').trim();
  const sourceRef = raw.source_ref == null ? '' : String(raw.source_ref).trim();
  const title = oneLine(raw.title || '', MAX_TITLE_CHARS);

  // (source, source_ref) 是去重键，缺一不可
  if (!source || !sourceRef || !title) return null;

  const body = typeof raw.body === 'string' ? raw.body.slice(0, MAX_BODY_CHARS) : (raw.body == null ? '' : String(raw.body).slice(0, MAX_BODY_CHARS));
  const ts = typeof raw.ts === 'string' && Number.isFinite(Date.parse(raw.ts)) ? raw.ts : new Date().toISOString();

  // 领域只允许 policies.json 白名单内的值；自由词一律收敛，收敛不了给 null 交给 triage
  const domain = coerceDomain(raw.domain_hint);
  if (raw.domain_hint != null && !domain && diag) diag.badDomains.add(String(raw.domain_hint));

  return {
    source,
    source_ref: sourceRef,
    title,
    body,
    ts,
    kind_hint: raw.kind_hint ? String(raw.kind_hint) : 'signal',
    domain_hint: domain,
    urgency_hint: clampInt(raw.urgency_hint ?? raw.urgency, 1, 5, 3),
    meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : {},
  };
}

/* ------------------------------ 执行 ------------------------------ */

/** 解析 only 参数：支持字符串（逗号分隔）或数组 */
function resolveOnly(only) {
  if (only == null) return null;
  const arr = Array.isArray(only) ? only : String(only).split(',');
  const out = arr.map((s) => String(s).trim()).filter(Boolean);
  return out.length ? out : null;
}

/**
 * 依次运行传感器。单个传感器抛错 → 记 note 并继续下一个。
 * @param {object} ctx  { cfg, now, cursor, notes, opts, log }
 * @param {{only?: string|string[]}} options only 指定后**强制运行**（即使 config 里 disabled），方便手工点名
 */
export async function* scanAll(ctx = {}, { only } = {}) {
  const c = ctx && typeof ctx === 'object' && ctx.cfg ? ctx : makeCtx(ctx);
  if (!c.notes || typeof c.notes !== 'object') c.notes = {};

  const wanted = resolveOnly(only);
  const cfg = c.cfg;

  for (const sensor of SENSORS) {
    const name = sensor.name;
    if (wanted) {
      if (!wanted.includes(name)) continue;
    } else {
      let enabled = true;
      try { enabled = typeof sensor.enabled === 'function' ? !!sensor.enabled(cfg) : true; }
      catch { enabled = false; }
      if (!enabled) { note(c, name, { ok: true, count: 0, skipped: true, note: 'config 中已禁用' }); continue; }
    }

    const t0 = Date.now();
    let count = 0;
    let skippedItems = 0;
    let failed = false;
    let errorMessage = null;
    const diag = { badDomains: new Set() };

    try {
      for await (const raw of sensor.scan(c)) {
        const item = normalizeItem(raw, name, diag);
        if (!item) { skippedItems++; continue; }
        count++;
        yield item;
      }
    } catch (e) {
      failed = true;
      errorMessage = oneLine(e?.message || e, 300);
      // 失败不静默：写 note（daemon 会把它转成 events(level=error)）
      try { c.log?.('error', `sensor:${name} 扫描失败`, { error: errorMessage }); } catch { /* ignore */ }
    } finally {
      // 保留传感器自己写的 note（例如"无未读→降级"），只补上运行统计
      note(c, name, {
        ok: !failed,
        count,
        itemsSkipped: skippedItems,
        ms: Date.now() - t0,
        ...(diag.badDomains.size ? { domainWarnings: [...diag.badDomains] } : {}),
        ...(failed ? { error: errorMessage } : {}),
      });
    }
  }
}

/**
 * 收集版：返回数组 + 诊断，方便 CLI / 测试 / daemon 一次性拿结果。
 * @returns {Promise<{items: object[], results: object[], summary: object}>}
 */
export async function collect(ctx = {}, { only } = {}) {
  const c = ctx && typeof ctx === 'object' && ctx.cfg ? ctx : makeCtx(ctx);
  const items = [];
  for await (const item of scanAll(c, { only })) items.push(item);

  const order = resolveOnly(only) || enabledNames(c.cfg);
  const results = order
    .filter((n) => BY_NAME.has(n))
    .map((n) => ({ name: n, ...(c.notes?.[n] || { ok: null, count: 0 }) }));

  const summary = {
    sensors: results.length,
    items: items.length,
    ok: results.filter((r) => r.ok !== false).length,
    failed: results.filter((r) => r.ok === false).map((r) => r.name),
    withItems: results.filter((r) => (r.count || 0) > 0).length,
    totalMs: results.reduce((a, r) => a + (r.ms || 0), 0),
  };

  return { items, results, summary };
}

/** 供上层（triage/policies）校验用的领域白名单 */
export { ALLOWED_DOMAINS };

export default { list, get, names, enabledNames, scanAll, collect };
