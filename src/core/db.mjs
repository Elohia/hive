// src/core/db.mjs — SQLite 单库（node:sqlite，零依赖）
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from './config.mjs';

let _db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cursors (
  source TEXT NOT NULL, key TEXT NOT NULL, value TEXT, updated_at TEXT,
  PRIMARY KEY (source, key)
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_seen_at TEXT,
  source TEXT NOT NULL, source_ref TEXT, dedupe_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL, body TEXT,
  kind TEXT NOT NULL, domain TEXT,
  urgency INTEGER DEFAULT 3, impact INTEGER DEFAULT 3,
  priority REAL,
  autonomy_level INTEGER, autonomy_ceiling INTEGER, confidence REAL, level_reason TEXT,
  status TEXT NOT NULL DEFAULT 'inbox', bucket TEXT NOT NULL DEFAULT 'inbox',
  due_at TEXT, meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_bucket ON items(bucket, status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_items_source ON items(source);
CREATE INDEX IF NOT EXISTS idx_items_updated ON items(updated_at DESC);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, item_id TEXT, parent_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  title TEXT NOT NULL, goal TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  executor TEXT, model TEXT,
  autonomy_level INTEGER,
  attempt INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 3,
  lease_until TEXT, heartbeat_at TEXT,
  timeout_sec INTEGER, budget_tokens INTEGER,
  tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, cost_cny REAL DEFAULT 0,
  priority REAL, depends_on TEXT,
  plan TEXT, result TEXT, last_error TEXT,
  output_dir TEXT, started_at TEXT, finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_item ON tasks(item_id);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt INTEGER NOT NULL,
  executor TEXT, command TEXT, cmdline TEXT,
  pid INTEGER, started_at TEXT, finished_at TEXT, duration_ms INTEGER,
  exit_code INTEGER, status TEXT,
  tokens_in INTEGER, tokens_out INTEGER, cost_cny REAL,
  dir TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id, started_at DESC);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY, task_id TEXT, item_id TEXT, kind TEXT,
  title TEXT, path TEXT NOT NULL, bytes INTEGER, sha256 TEXT, created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  item_id TEXT, task_id TEXT,
  kind TEXT NOT NULL, title TEXT NOT NULL, summary TEXT,
  context TEXT, options TEXT, recommendation TEXT, risk TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_at TEXT, decided_by TEXT, decision TEXT, note TEXT,
  expires_at TEXT, notified_count INTEGER DEFAULT 0, last_notified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
  actor TEXT NOT NULL, type TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'info',
  item_id TEXT, task_id TEXT, run_id TEXT, approval_id TEXT,
  message TEXT, data TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_events_item ON events(item_id, id DESC);

CREATE TABLE IF NOT EXISTS pulses (
  id TEXT PRIMARY KEY, name TEXT, spec TEXT NOT NULL, enabled INTEGER DEFAULT 1,
  last_run_at TEXT, next_run_at TEXT, last_status TEXT, config TEXT
);

CREATE TABLE IF NOT EXISTS context_facts (
  id TEXT PRIMARY KEY, category TEXT, key TEXT, value TEXT,
  evidence TEXT, confidence REAL, updated_at TEXT, UNIQUE(category, key)
);

CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, updated_at TEXT);
`;

export function dbPath() {
  const cfg = loadConfig();
  return cfg.resolved.db;
}

export function getDb() {
  if (_db) return _db;
  const cfg = loadConfig();
  fs.mkdirSync(path.dirname(cfg.resolved.db), { recursive: true });
  const db = new DatabaseSync(cfg.resolved.db);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=NORMAL');
  db.exec('PRAGMA busy_timeout=8000');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(SCHEMA);
  _db = db;
  return db;
}

export function closeDb() {
  if (_db) { try { _db.close(); } catch {} _db = null; }
}

/** node:sqlite 只接受 string/number/bigint/null/Buffer/Uint8Array —— 统一归一化 */
function bind(v) {
  if (v === undefined) return null;
  if (v === null) return null;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'bigint') return v;
  if (t === 'boolean') return v ? 1 : 0;
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

export const q = {
  all(sql, ...p) { return getDb().prepare(sql).all(...p.map(bind)); },
  get(sql, ...p) { return getDb().prepare(sql).get(...p.map(bind)); },
  run(sql, ...p) { return getDb().prepare(sql).run(...p.map(bind)); },
  exec(sql) { return getDb().exec(sql); },
};

/** 事务：fn 抛错则回滚 */
export function tx(fn) {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

export function kvGet(k, fallback = null) {
  const r = q.get('SELECT v FROM kv WHERE k=?', k);
  if (!r) return fallback;
  try { return JSON.parse(r.v); } catch { return r.v; }
}

export function kvSet(k, v) {
  q.run(
    'INSERT INTO kv(k,v,updated_at) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at',
    k, JSON.stringify(v), new Date().toISOString()
  );
}

export function cursorGet(source, key) {
  const r = q.get('SELECT value FROM cursors WHERE source=? AND key=?', source, key);
  return r ? r.value : null;
}

export function cursorSet(source, key, value) {
  q.run(
    'INSERT INTO cursors(source,key,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(source,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
    source, key, value == null ? null : String(value), new Date().toISOString()
  );
}

export function dbStats() {
  const t = (name) => q.get(`SELECT COUNT(*) AS n FROM ${name}`)?.n ?? 0;
  return {
    items: t('items'), tasks: t('tasks'), runs: t('runs'), approvals: t('approvals'),
    events: t('events'), artifacts: t('artifacts'), pulses: t('pulses'),
  };
}
