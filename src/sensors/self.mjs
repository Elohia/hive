// src/sensors/self.mjs — 自检传感器（只读）
//
// 检查项：失败任务堆积 / 卡死任务（租约过期）/ 错误事件 / 待批审批 / 预算超支 / DB 体积。
// 只读保障：用 node:sqlite 的 **readOnly 连接**，不经过 src/core/db.mjs 的 getDb()
//          （getDb 会执行 PRAGMA journal_mode=WAL 与建表，属于写操作）。
//          因此本模块绝不产生任何数据库写入。
// 产出策略：健康时 0 条（不污染收件箱）；有问题才逐条 yield，且 status() 始终可查全量快照。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { clampInt, note, oneLine, toIso } from './_util.mjs';

const NAME = 'self';

const FAILED_STATUSES = ['failed', 'error', 'timeout', 'dead', 'cancelled', 'aborted'];

function dbPathOf(cfg) {
  return cfg?.resolved?.db || cfg?.paths?.db || path.join(cfg?.home || process.cwd(), 'data', 'hive.db');
}

function openReadOnly(dbPath) {
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

function safeGet(db, sql, ...params) {
  try { return db.prepare(sql).get(...params); } catch { return null; }
}

function safeAll(db, sql, ...params) {
  try { return db.prepare(sql).all(...params); } catch { return []; }
}

function isoHoursAgo(hours) {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

/**
 * 采集健康快照（只读）。任何单项失败都降级为 null，不影响其它项。
 * @returns {object} snapshot
 */
export function healthSnapshot(cfg) {
  const dbPath = dbPathOf(cfg);
  const snap = {
    dbPath,
    dbExists: false,
    dbBytes: 0,
    dbMb: 0,
    items: null,
    tasks: null,
    approvals: null,
    events: null,
    budget: null,
    failedTasks: [],
    staleRunning: [],
    errorEvents: [],
    pendingApprovals: [],
    collectedAt: new Date().toISOString(),
    errors: [],
  };

  try {
    const st = fs.statSync(dbPath);
    snap.dbExists = true;
    snap.dbBytes = st.size;
    snap.dbMb = Number((st.size / 1024 / 1024).toFixed(2));
  } catch (e) {
    snap.errors.push(`db-stat: ${oneLine(e?.message || e, 100)}`);
    return snap;
  }

  const db = openReadOnly(dbPath);
  if (!db) {
    snap.errors.push('db-open-readonly-failed');
    return snap;
  }

  try {
    // items
    const inbox = safeGet(db, "SELECT COUNT(*) AS n FROM items WHERE bucket='inbox'");
    const itemsTotal = safeGet(db, 'SELECT COUNT(*) AS n FROM items');
    snap.items = { inbox: inbox?.n ?? null, total: itemsTotal?.n ?? null };

    // tasks
    const tTotal = safeGet(db, 'SELECT COUNT(*) AS n FROM tasks');
    const tQueued = safeGet(db, "SELECT COUNT(*) AS n FROM tasks WHERE status='queued'");
    const tRunning = safeGet(db, "SELECT COUNT(*) AS n FROM tasks WHERE status='running'");
    const marks = FAILED_STATUSES.map(() => '?').join(',');
    const tFailed = safeGet(db, `SELECT COUNT(*) AS n FROM tasks WHERE status IN (${marks})`, ...FAILED_STATUSES);
    snap.tasks = {
      total: tTotal?.n ?? null,
      queued: tQueued?.n ?? null,
      running: tRunning?.n ?? null,
      failed: tFailed?.n ?? null,
    };
    snap.failedTasks = safeAll(
      db,
      `SELECT id, title, status, attempt, last_error, finished_at FROM tasks WHERE status IN (${marks}) ORDER BY finished_at DESC LIMIT 5`,
      ...FAILED_STATUSES,
    ) || [];

    // 卡死：running 且租约已过期
    const nowIso = new Date().toISOString();
    snap.staleRunning = safeAll(
      db,
      "SELECT id, title, lease_until, heartbeat_at, started_at FROM tasks WHERE status='running' AND lease_until IS NOT NULL AND lease_until < ? ORDER BY lease_until ASC LIMIT 5",
      nowIso,
    ) || [];

    // 审批
    const pCount = safeGet(db, "SELECT COUNT(*) AS n FROM approvals WHERE status='pending'");
    snap.approvals = { pending: pCount?.n ?? null };
    snap.pendingApprovals = safeAll(
      db,
      "SELECT id, kind, title, created_at, expires_at FROM approvals WHERE status='pending' ORDER BY created_at DESC LIMIT 5",
    ) || [];

    // 事件
    const since24 = isoHoursAgo(24);
    const eErr = safeGet(db, "SELECT COUNT(*) AS n FROM events WHERE level='error' AND ts >= ?", since24);
    const eWarn = safeGet(db, "SELECT COUNT(*) AS n FROM events WHERE level='warn' AND ts >= ?", since24);
    const eAll = safeGet(db, 'SELECT COUNT(*) AS n FROM events');
    snap.events = { errors24h: eErr?.n ?? null, warns24h: eWarn?.n ?? null, total: eAll?.n ?? null };
    snap.errorEvents = safeAll(
      db,
      "SELECT id, ts, actor, type, message FROM events WHERE level='error' AND ts >= ? ORDER BY id DESC LIMIT 5",
      since24,
    ) || [];

    // 预算：今日已花（tasks.cost_cny 汇总） vs settings.dailyBudgetCny
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const spent = safeGet(
      db,
      'SELECT COALESCE(SUM(cost_cny),0) AS c FROM tasks WHERE COALESCE(finished_at, started_at, created_at) >= ?',
      dayStart.toISOString(),
    );
    const limit = Number(cfg?.settings?.dailyBudgetCny);
    const warnRatio = Number(cfg?.settings?.budgetWarnRatio) || 0.8;
    const used = Number(spent?.c ?? 0);
    snap.budget = {
      usedCny: Number(used.toFixed(4)),
      limitCny: Number.isFinite(limit) && limit > 0 ? limit : null,
      ratio: Number.isFinite(limit) && limit > 0 ? Number((used / limit).toFixed(3)) : null,
      warnRatio,
    };
  } catch (e) {
    snap.errors.push(`db-read: ${oneLine(e?.message || e, 160)}`);
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }

  return snap;
}

export default {
  name: NAME,
  title: '系统自检',

  enabled(cfg) {
    return !!(cfg?.sources?.self?.enabled);
  },

  /** 供 daemon / 冒烟直接读健康快照（只读，不产出 item） */
  status(ctx) {
    const cfg = ctx?.cfg || {};
    return healthSnapshot(cfg);
  },

  async *scan(ctx) {
    const cfg = ctx?.cfg || {};
    const opts = ctx?.opts || {};
    const maxItems = clampInt(opts.maxItems, 1, 50, 5);
    const dbWarnMb = clampInt(opts.dbWarnMb, 1, 100_000, 200);
    const t0 = Date.now();

    const snap = healthSnapshot(cfg);
    const problems = [];

    /* 1. 失败任务堆积 */
    const failed = snap.tasks?.failed ?? 0;
    if (failed > 0) {
      problems.push({
        kind: 'self_task_failed',
        ref: `self:tasks_failed:${failed}`,
        title: `任务失败堆积：${failed} 个`,
        body: [
          `失败任务：${failed} 个（仅列出最近 ${snap.failedTasks.length} 条）`,
          '',
          ...snap.failedTasks.map((t) => `- ${t.id} [${t.status}] attempt=${t.attempt} ${oneLine(t.title, 80)}${t.last_error ? `\n    err: ${oneLine(t.last_error, 160)}` : ''}`),
        ].join('\n'),
        ts: snap.collectedAt,
        urgency: failed >= 3 ? 5 : 4,
        meta: { failed, tasks: snap.failedTasks },
      });
    }

    /* 2. 卡死任务（租约过期） */
    const stale = snap.staleRunning?.length ?? 0;
    if (stale > 0) {
      problems.push({
        kind: 'self_task_stale',
        ref: `self:tasks_stale:${stale}`,
        title: `疑似卡死任务：${stale} 个租约已过期`,
        body: [
          `running 但 lease_until 已过期：${stale} 个`,
          '',
          ...snap.staleRunning.map((t) => `- ${t.id} lease_until=${t.lease_until} ${oneLine(t.title, 80)}`),
        ].join('\n'),
        ts: snap.collectedAt,
        urgency: 4,
        meta: { stale, tasks: snap.staleRunning },
      });
    }

    /* 3. 错误事件 */
    const errs = snap.events?.errors24h ?? 0;
    if (errs > 0) {
      problems.push({
        kind: 'self_events_error',
        ref: `self:events_error:${errs}:${snap.errorEvents[0]?.id ?? 0}`,
        title: `近 24h 错误事件：${errs} 条`,
        body: [
          `错误事件（24h）：${errs} 条`,
          `告警事件（24h）：${snap.events?.warns24h ?? '?'} 条`,
          '',
          ...snap.errorEvents.map((e) => `- [${e.ts}] ${e.actor}/${e.type} ${oneLine(e.message, 140)}`),
        ].join('\n'),
        ts: snap.collectedAt,
        urgency: errs >= 5 ? 4 : 3,
        meta: { errors24h: errs, events: snap.errorEvents },
      });
    }

    /* 4. 待批审批（阻塞在人工） */
    const pend = snap.approvals?.pending ?? 0;
    if (pend > 0) {
      problems.push({
        kind: 'self_approvals_pending',
        ref: `self:approvals:${pend}`,
        title: `有待批审批：${pend} 个`,
        body: [
          `待批审批：${pend} 个（需要人）`,
          '',
          ...snap.pendingApprovals.map((a) => `- ${a.id} [${a.kind}] ${oneLine(a.title, 100)}（expires ${a.expires_at || '?'}）`),
        ].join('\n'),
        ts: snap.collectedAt,
        urgency: 3,
        meta: { pending: pend, approvals: snap.pendingApprovals },
      });
    }

    /* 5. 预算 */
    const bud = snap.budget;
    if (bud && bud.ratio != null) {
      if (bud.ratio >= 1) {
        problems.push({
          kind: 'self_budget_exceeded',
          ref: `self:budget_over:${bud.usedCny}`,
          title: `预算超支：已花 ¥${bud.usedCny} / 上限 ¥${bud.limitCny}`,
          body: `今日已花 ¥${bud.usedCny}，超过日预算 ¥${bud.limitCny}（${(bud.ratio * 100).toFixed(1)}%）→ 应暂停派单。`,
          ts: snap.collectedAt, urgency: 5, meta: { budget: bud },
        });
      } else if (bud.ratio >= bud.warnRatio) {
        problems.push({
          kind: 'self_budget_warn',
          ref: `self:budget_warn:${bud.usedCny}`,
          title: `预算告警：已花 ¥${bud.usedCny} / ¥${bud.limitCny}（${(bud.ratio * 100).toFixed(0)}%）`,
          body: `今日已花 ¥${bud.usedCny}，达到告警线 ${(bud.warnRatio * 100).toFixed(0)}%（上限 ¥${bud.limitCny}）。`,
          ts: snap.collectedAt, urgency: 4, meta: { budget: bud },
        });
      }
    } else if (bud && bud.limitCny == null) {
      // 无上限配置不算问题，只记录
      note(ctx, NAME, { budgetNote: '未配置 settings.dailyBudgetCny，预算检查跳过' });
    }

    /* 6. DB 体积 */
    if (snap.dbMb > dbWarnMb) {
      problems.push({
        kind: 'self_db_growth',
        ref: `self:db_size:${snap.dbBytes}`,
        title: `数据库偏大：${snap.dbMb} MB`,
        body: [
          `DB：${snap.dbPath}`,
          `体积：${snap.dbMb} MB（阈值 ${dbWarnMb} MB）`,
          `items=${snap.items?.total} tasks=${snap.tasks?.total} events=${snap.events?.total}`,
          '建议：跑一次归档（itemRetentionDays）与 VACUUM。',
        ].join('\n'),
        ts: snap.collectedAt, urgency: 3, meta: { dbMb: snap.dbMb, dbBytes: snap.dbBytes },
      });
    }

    /* 7. 库打开失败（严重） */
    if (!snap.dbExists || snap.errors.length > 0) {
      problems.push({
        kind: 'self_db_unavailable',
        ref: `self:db:${snap.dbExists ? 'read-errors' : 'missing'}`,
        title: `数据库${snap.dbExists ? '读取异常' : '不存在'}：${snap.dbPath}`,
        body: [`dbExists=${snap.dbExists}`, `errors=${snap.errors.join(' | ') || '无'}`].join('\n'),
        ts: snap.collectedAt, urgency: 5, meta: { errors: snap.errors },
      });
    }

    // 逐条产出（单条失败跳过）
    let emitted = 0;
    for (const p of problems) {
      if (emitted >= maxItems) break;
      try {
        emitted++;
        yield {
          source: NAME,
          source_ref: p.ref,
          title: p.title,
          body: p.body,
          ts: toIso(p.ts) || new Date().toISOString(),
          kind_hint: p.kind,
          domain_hint: 'ops',
          urgency_hint: p.urgency,
          meta: { ...p.meta, snapshot: { dbMb: snap.dbMb, items: snap.items, tasks: snap.tasks, events: snap.events, budget: snap.budget } },
        };
      } catch (e) {
        ctx?.log?.('warn', 'sensor:self 产出失败', { error: oneLine(e?.message || e, 100) });
      }
    }

    note(ctx, NAME, {
      ok: true,
      count: emitted,
      problems: problems.length,
      snapshot: {
        dbMb: snap.dbMb,
        dbExists: snap.dbExists,
        items: snap.items,
        tasks: snap.tasks,
        approvals: snap.approvals,
        events: snap.events,
        budget: snap.budget,
      },
      errors: snap.errors,
      ms: Date.now() - t0,
      note: problems.length === 0
        ? `健康：无失败任务/无错误事件/预算与体积正常（DB ${snap.dbMb}MB）`
        : `发现 ${problems.length} 类问题 → 产出 ${emitted} 条`,
    });

    ctx?.log?.('info', 'sensor:self', { problems: problems.length, emitted, dbMb: snap.dbMb });
  },
};

export const __internals = { healthSnapshot, dbPathOf, openReadOnly };
