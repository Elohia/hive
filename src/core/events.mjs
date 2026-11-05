// src/core/events.mjs — 事件总线 + 持久化（I3 事件溯源）
import { q } from './db.mjs';

const subs = new Set();

export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function emit(ev) {
  const ts = new Date().toISOString();
  const row = {
    ts,
    actor: ev.actor || 'system',
    type: ev.type || 'event',
    level: ev.level || 'info',
    item_id: ev.item_id ?? null,
    task_id: ev.task_id ?? null,
    run_id: ev.run_id ?? null,
    approval_id: ev.approval_id ?? null,
    message: ev.message ?? '',
    data: ev.data === undefined ? null : (typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data)),
  };
  let id = null;
  try {
    const r = q.run(
      `INSERT INTO events(ts,actor,type,level,item_id,task_id,run_id,approval_id,message,data)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      row.ts, row.actor, row.type, row.level, row.item_id, row.task_id, row.run_id,
      row.approval_id, row.message, row.data
    );
    id = Number(r.lastInsertRowid);
  } catch {
    // 事件写入失败不得阻断业务：只丢弃该条事件
  }
  const payload = { id, ...row };
  for (const fn of subs) {
    try { fn(payload); } catch {}
  }
  return payload;
}

export function recent({ limit = 100, since = 0, task_id, item_id, level } = {}) {
  const where = [];
  const args = [];
  if (since) { where.push('id > ?'); args.push(since); }
  if (task_id) { where.push('task_id = ?'); args.push(task_id); }
  if (item_id) { where.push('item_id = ?'); args.push(item_id); }
  if (level) { where.push('level = ?'); args.push(level); }
  const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  args.push(limit);
  return q.all(sql, ...args);
}

export function countEventsSince(iso) {
  return q.get('SELECT COUNT(*) AS n FROM events WHERE ts >= ?', iso)?.n ?? 0;
}

export function countErrorsSince(iso) {
  return q.get("SELECT COUNT(*) AS n FROM events WHERE ts >= ? AND level='error'", iso)?.n ?? 0;
}
