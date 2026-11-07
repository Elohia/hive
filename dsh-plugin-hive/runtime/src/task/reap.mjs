// src/task/reap.mjs — 收件箱收敛器（防止「只进不出」越攒越多）
//
// 为什么需要它：传感器是**只进不出**的——每天几十份报告/变更/告警都会变成事项。
// 判定与路由能消化一部分（L1/L2 内联完即 done），但剩下的会永久堆在 inbox：
//   · 优先级低于阈值的（quiet）
//   · 需要人拍板但人没空的（L3+ 卡在 Approval）
//   · 判定失败的（L0）
// 不收敛的话，一周就是几百条，面板直接失效。所以这里做三件事：
//
//   1) 老化归档：inbox 里超过 N 天没被碰过的 → archived（不是删除，随时可恢复）
//   2) 容量上限：inbox 超过 M 条 → 按优先级从低到高归档，只留最该看的 M 条
//   3) 重复折叠：同 source + 同标题（忽略时间戳差异）多于 1 条的，只留最新一条
//
// 原则：**只归档，不删除**。宁可多留一条可恢复的记录，也不静默丢信息。
// 每个动作都写 event（item.reaped），面板上能查到「为什么这条没了」。
import { loadConfig } from '../core/config.mjs';
import { q } from '../core/db.mjs';
import { emit } from '../core/events.mjs';
import { logger } from '../core/log.mjs';
import { updateItem } from './taskcenter.mjs';

export const REAP_DEFAULTS = {
  enabled: true,
  inboxTtlDays: 3,     // 超过 3 天没动 → 归档
  inboxMax: 60,        // inbox 最多留 60 条，多的按优先级折叠
  foldDuplicates: true, // 同源同标题折叠
  // 「过期情报」：报告/值守这类**信息类**来源，判定为 L1/L2（看一眼就行）的，
  // 过 staleInfoDays 天就没价值了——报告的价值在当天。单独一条更快的老化规则，
  // 否则它们会占满 inbox 直到 3 天 TTL，把真正要处理的挤下去。
  staleInfoDays: 1,
  staleInfoSources: ['docs', 'pulses_local'],
  staleInfoMaxLevel: 2,
};

/**
 * 过期情报归档（比通用老化更快）：只动信息类来源 + 低等级，不动任何 L3+ 或待拍板的。
 * 单独导出，方便面板/测试单独验证。
 */
export function reapStaleInfo({ cfg = loadConfig(), dryRun = false } = {}) {
  const rc = reapConfig(cfg);
  const days = Number(rc.staleInfoDays) || 0;
  const sources = rc.staleInfoSources || [];
  const maxLevel = Number(rc.staleInfoMaxLevel ?? 2);
  if (!days || !sources.length) return { aged: 0, sample: [] };
  const rows = q.all(`
    SELECT id, title, source, priority, autonomy_level, created_at, updated_at FROM items
    WHERE status='inbox'
      AND source IN (${sources.map(() => '?').join(',')})
      AND COALESCE(autonomy_level, 0) <= ?
      AND julianday('now') - julianday(COALESCE(NULLIF(updated_at,''), created_at)) > ?
    ORDER BY priority ASC`, ...sources, maxLevel, days);
  const out = { aged: 0, sample: [] };
  for (const r of rows) {
    out.sample.push({ id: r.id, title: String(r.title || '').slice(0, 60), priority: r.priority, reason: `过期情报（${r.source} / L${r.autonomy_level}，静置 ${days} 天）` });
    if (dryRun) { out.aged++; continue; }
    try {
      updateItem(r.id, { status: 'archived', bucket: 'archived' }, {
        event: { type: 'item.reaped', actor: 'reaper', message: `过期情报自动归档（${r.source} / L${r.autonomy_level}，静置 > ${days} 天）` },
      });
      out.aged++;
    } catch { /* 单条失败不影响其它 */ }
  }
  return out;
}

export function reapConfig(cfg) {
  return { ...REAP_DEFAULTS, ...(cfg?.settings?.reap || {}) };
}

/**
 * 跑一次收敛。
 * @param {{cfg?:object, dryRun?:boolean}} [opts]
 * @returns {{ok:boolean, dryRun:boolean, before:number, after:number, aged:number, overflow:number, folded:number, sample:Array}}
 */
export function reap(opts = {}) {
  const cfg = opts.cfg || loadConfig();
  const rc = reapConfig(cfg);
  const dryRun = !!opts.dryRun;
  const out = { ok: true, dryRun, before: 0, after: 0, aged: 0, overflow: 0, folded: 0, sample: [], errors: [] };

  if (!rc.enabled) {
    out.ok = true;
    out.skipped = 'reap.enabled=false';
    return out;
  }

  const inboxCount = () => q.get("SELECT COUNT(*) n FROM items WHERE status='inbox'")?.n ?? 0;
  out.before = inboxCount();
  if (!out.before) { out.after = 0; return out; }

  const archive = (row, reason) => {
    out.sample.push({ id: row.id, title: String(row.title || '').slice(0, 60), priority: row.priority, reason });
    if (dryRun) return;
    try {
      updateItem(row.id, { status: 'archived', bucket: 'archived' }, {
        event: { type: 'item.reaped', actor: 'reaper', message: reason },
      });
    } catch (e) {
      out.errors.push(`${row.id}: ${e?.message || e}`);
    }
  };

  // ── 1) 重复折叠：同 source + 同标题留下来最新的那条 ──────────────────
  if (rc.foldDuplicates) {
    const dups = q.all(`
      SELECT id, source, title, priority, created_at FROM items
      WHERE status='inbox'
      ORDER BY source, title, created_at DESC`);
    const seen = new Map();
    for (const r of dups) {
      const key = `${r.source}\u0000${String(r.title || '')}`;
      if (!seen.has(key)) { seen.set(key, r.id); continue; }
      archive(r, `同源同标题重复（保留 ${seen.get(key)}），折叠归档`);
      out.folded++;
    }
  }

  // ── 1.5) 过期情报（报告类，比通用老化更快）──────────────────────────
  const stale = reapStaleInfo({ cfg, dryRun });
  out.aged += stale.aged;
  out.sample.push(...stale.sample.slice(0, 10));

  // ── 2) 老化归档：超过 N 天没被碰过 ────────────────────────────────────
  const ttl = Number(rc.inboxTtlDays) || 0;
  if (ttl > 0) {
    const aged = q.all(`
      SELECT id, title, priority, created_at, updated_at FROM items
      WHERE status='inbox'
        AND julianday('now') - julianday(COALESCE(NULLIF(updated_at,''), created_at)) > ?
      ORDER BY priority ASC`, ttl);
    for (const r of aged) {
      archive(r, `静置超过 ${ttl} 天未处理，老化归档`);
      out.aged++;
    }
  }

  // ── 3) 容量上限：只留优先级最高的 M 条 ────────────────────────────────
  const cap = Number(rc.inboxMax) || 0;
  if (cap > 0) {
    const rest = q.all(`
      SELECT id, title, priority, created_at FROM items
      WHERE status='inbox'
      ORDER BY priority DESC, COALESCE(updated_at, created_at) DESC`);
    for (const r of rest.slice(cap)) {
      archive(r, `收件箱超过上限 ${cap} 条，按优先级折叠归档`);
      out.overflow++;
    }
  }

  if (!dryRun) {
    out.after = inboxCount();
    const total = out.aged + out.overflow + out.folded;
    if (total) {
      emit({
        actor: 'reaper', type: 'reap.done',
        message: `收敛 ${total} 条：老化 ${out.aged} · 超容 ${out.overflow} · 折叠 ${out.folded}（${out.before} → ${out.after}）`,
        data: { aged: out.aged, overflow: out.overflow, folded: out.folded, before: out.before, after: out.after },
      });
      logger.info?.(`reap: ${out.before} → ${out.after}（老化 ${out.aged} / 超容 ${out.overflow} / 折叠 ${out.folded}）`);
    }
  } else {
    out.after = Math.max(0, out.before - (out.aged + out.overflow + out.folded));
  }

  out.sample = out.sample.slice(0, 20);
  return out;
}

export default { reapConfig, reap, REAP_DEFAULTS };
