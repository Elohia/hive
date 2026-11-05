// src/task/taskcenter.mjs — 统一任务中心（唯一状态写入 API）
// 所有模块必须经过本文件的函数改状态；不得直接写 items/tasks/approvals 表。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { q, tx, kvGet, kvSet, dbStats } from '../core/db.mjs';
import { emit } from '../core/events.mjs';
import { itemId as newItemId, taskId as newTaskId, runId as newRunId, approvalId as newApprovalId, shortHash } from '../core/ids.mjs';
import { loadConfig } from '../core/config.mjs';
import { assertWritable as guardAssertWritable } from '../core/guard.mjs';

const now = () => new Date().toISOString();

// ---------- 优先级 ----------
export function computePriority(item) {
  const cfg = loadConfig();
  const P = cfg.policies.priority;
  const level = item.autonomy_level || 2;
  const impact = item.impact ?? 3;
  const urgency = item.urgency ?? 3;
  const dw = P.domainWeight[item.domain] ?? P.domainWeight._default ?? 0.4;
  const ageH = item.created_at ? (Date.now() - Date.parse(item.created_at)) / 3600e3 : 0;
  let rec = 0;
  for (const [k, v] of Object.entries(P.recencyBoost)) {
    const h = Number(k.replace('hours', ''));
    if (ageH <= h) { rec = v; break; }
  }
  const eff = P.effortPenalty['L' + level] ?? 0.5;
  return +(impact * 2.0 + urgency * 1.5 + dw + (rec || 0) - eff).toFixed(3);
}

// ---------- 事项类型归一 ----------
/** 把各 sensor 自造的类型收敛到 6 个规范类型；并识别噪声（退信/订阅类） */
export function refineKind(rawKind, title = '', body = '') {
  const cfg = loadConfig();
  const alias = cfg.policies.kind_alias || {};
  const noise = cfg.policies.noise_patterns || [];
  const text = `${title}\n${body || ''}`;
  if (noise.some((p) => text.includes(p))) return { kind: 'fyi', urgency: 1, impact: 1, noisy: true };
  const k = alias[rawKind] || rawKind;
  const known = Object.keys(cfg.policies.kind_defaults || {});
  if (known.includes(k)) return { kind: k, noisy: false };
  return { kind: 'fyi', noisy: false, unmapped: rawKind };
}

// ---------- Item ----------
export function upsertItem(raw) {
  const cfg = loadConfig();
  const ts = now();
  const source = raw.source || 'manual';
  const dedupe_key = raw.dedupe_key
    || shortHash([source, raw.source_ref || raw.title || '', raw.source_ts || ''].join('|'), 24);

  const existing = q.get('SELECT * FROM items WHERE dedupe_key=?', dedupe_key);
  if (existing) {
    q.run('UPDATE items SET last_seen_at=?, updated_at=? WHERE id=?', ts, ts, existing.id);
    return { item: { ...existing, last_seen_at: ts, updated_at: ts }, created: false };
  }

  // 二级去重：同一来源 + 同一标题在窗口内只保留一条（传感器每轮会带不同的时间戳/ref）
  const ttlH = cfg.settings.dupTitleWindowHours ?? 24;
  if (ttlH > 0) {
    const cutoff = new Date(Date.now() - ttlH * 3600e3).toISOString();
    const twin = q.get(
      'SELECT * FROM items WHERE source=? AND title=? AND created_at >= ? ORDER BY created_at DESC LIMIT 1',
      source, String(raw.title || '').slice(0, 300), cutoff
    );
    if (twin) {
      q.run('UPDATE items SET last_seen_at=?, updated_at=? WHERE id=?', ts, ts, twin.id);
      emit({ actor: 'sensor', type: 'item.dedup_window', item_id: twin.id, message: `[${source}] 窗口内重复，并入既有条目：${twin.title}` });
      return { item: { ...twin, last_seen_at: ts, updated_at: ts }, created: false, deduped: true };
    }
  }

  // 类型归一 + 噪声识别（退信/订阅类直接降为 fyi，避免淹没 Inbox）
  const ref = refineKind(raw.kind || raw.kind_hint || 'fyi', raw.title || '', raw.body || '');
  const kindDefaults = cfg.policies.kind_defaults[ref.kind] || { urgency: 3, impact: 3 };
  const metaObj = raw.meta ? { ...raw.meta } : {};
  if (ref.noisy) metaObj.noisy = true;
  if (ref.unmapped) metaObj.kind_raw = ref.unmapped;
  if (raw.kind && raw.kind !== ref.kind) metaObj.kind_source = raw.kind;
  const it = {
    id: newItemId(),
    created_at: ts, updated_at: ts, last_seen_at: ts,
    source,
    source_ref: raw.source_ref ?? null,
    dedupe_key,
    title: String(raw.title || '(无标题)').slice(0, 300),
    body: raw.body ? String(raw.body) : null,
    kind: ref.kind,
    domain: raw.domain || null,
    // 噪声项强制最低优先，不受 sensor 的 urgency_hint 影响
    urgency: ref.noisy ? 1 : (raw.urgency ?? kindDefaults.urgency),
    impact: ref.noisy ? 1 : (raw.impact ?? kindDefaults.impact),
    autonomy_level: raw.autonomy_level ?? null,
    autonomy_ceiling: raw.autonomy_ceiling ?? 5,
    confidence: raw.confidence ?? null,
    level_reason: raw.level_reason ?? null,
    status: 'inbox',
    bucket: 'inbox',
    due_at: raw.due_at ?? null,
    meta: Object.keys(metaObj).length ? JSON.stringify(metaObj) : null,
  };
  it.priority = computePriority(it);
  q.run(
    `INSERT INTO items(id,created_at,updated_at,last_seen_at,source,source_ref,dedupe_key,title,body,kind,domain,
       urgency,impact,priority,autonomy_level,autonomy_ceiling,confidence,level_reason,status,bucket,due_at,meta)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    it.id, it.created_at, it.updated_at, it.last_seen_at, it.source, it.source_ref, it.dedupe_key,
    it.title, it.body, it.kind, it.domain, it.urgency, it.impact, it.priority,
    it.autonomy_level, it.autonomy_ceiling, it.confidence, it.level_reason, it.status, it.bucket, it.due_at, it.meta
  );
  emit({ actor: 'sensor', type: 'item.created', item_id: it.id, message: `[${source}] ${it.title}`, data: { kind: it.kind, priority: it.priority } });
  return { item: it, created: true };
}

export function getItem(id) { return q.get('SELECT * FROM items WHERE id=?', id) || null; }

export function listItems({ bucket, status, source, q: search, limit = 50, offset = 0, minPriority } = {}) {
  const w = [], a = [];
  if (bucket) { w.push('bucket = ?'); a.push(bucket); }
  if (status) { w.push('status = ?'); a.push(status); }
  if (source) { w.push('source = ?'); a.push(source); }
  if (minPriority != null) { w.push('priority >= ?'); a.push(minPriority); }
  if (search) { w.push('(title LIKE ? OR body LIKE ?)'); a.push(`%${search}%`, `%${search}%`); }
  const sql = `SELECT * FROM items ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
               ORDER BY priority DESC, updated_at DESC LIMIT ? OFFSET ?`;
  a.push(limit, offset);
  return q.all(sql, ...a);
}

export function updateItem(id, patch, { event } = {}) {
  const cur = getItem(id);
  if (!cur) throw new Error(`item 不存在: ${id}`);
  const merged = { ...cur, ...patch };
  merged.priority = computePriority(merged);
  merged.updated_at = now();
  q.run(
    `UPDATE items SET updated_at=?, title=?, body=?, kind=?, domain=?, urgency=?, impact=?, priority=?,
       autonomy_level=?, autonomy_ceiling=?, confidence=?, level_reason=?, status=?, bucket=?, due_at=?, meta=?
     WHERE id=?`,
    merged.updated_at, merged.title, merged.body, merged.kind, merged.domain, merged.urgency, merged.impact,
    merged.priority, merged.autonomy_level, merged.autonomy_ceiling, merged.confidence, merged.level_reason,
    merged.status, merged.bucket, merged.due_at, merged.meta, id
  );
  if (event) emit({ actor: event.actor || 'system', type: event.type || 'item.updated', item_id: id, message: event.message || '' });
  return merged;
}

export function setBucket(id, bucket, status) {
  const patch = { bucket };
  if (status) patch.status = status;
  return updateItem(id, patch, { event: { type: 'item.bucket', message: `→ ${bucket}${status ? '/' + status : ''}` } });
}

// ---------- Task ----------
export function createTask(o) {
  const cfg = loadConfig();
  const ts = now();
  const id = newTaskId();
  const t = {
    id, item_id: o.item_id ?? null, parent_id: o.parent_id ?? null,
    created_at: ts, updated_at: ts,
    title: o.title || '(未命名任务)', goal: o.goal ?? null,
    status: o.status || 'queued',
    executor: o.executor ?? null, model: o.model ?? null,
    autonomy_level: o.autonomy_level ?? 3,
    attempt: 0, max_attempts: o.max_attempts ?? cfg.settings.maxAttempts,
    lease_until: null, heartbeat_at: null,
    timeout_sec: o.timeout_sec ?? cfg.settings.defaultTimeoutSec,
    budget_tokens: o.budget_tokens ?? cfg.settings.defaultBudgetTokens,
    tokens_in: 0, tokens_out: 0, cost_cny: 0,
    priority: o.priority ?? 0,
    depends_on: JSON.stringify(o.depends_on || []),
    plan: o.plan ? JSON.stringify(o.plan) : null,
    result: null, last_error: null,
    output_dir: o.output_dir ?? null, started_at: null, finished_at: null,
  };
  q.run(
    `INSERT INTO tasks(id,item_id,parent_id,created_at,updated_at,title,goal,status,executor,model,autonomy_level,
      attempt,max_attempts,lease_until,heartbeat_at,timeout_sec,budget_tokens,tokens_in,tokens_out,cost_cny,
      priority,depends_on,plan,result,last_error,output_dir,started_at,finished_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    t.id, t.item_id, t.parent_id, t.created_at, t.updated_at, t.title, t.goal, t.status, t.executor, t.model,
    t.autonomy_level, t.attempt, t.max_attempts, t.lease_until, t.heartbeat_at, t.timeout_sec, t.budget_tokens,
    t.tokens_in, t.tokens_out, t.cost_cny, t.priority, t.depends_on, t.plan, t.result, t.last_error, t.output_dir,
    t.started_at, t.finished_at
  );
  emit({ actor: 'router', type: 'task.created', task_id: id, item_id: t.item_id, message: `${t.title} [L${t.autonomy_level}/${t.executor || '?'}]` });
  return t;
}

export function getTask(id) { return q.get('SELECT * FROM tasks WHERE id=?', id) || null; }

export function listTasks({ status, item_id, limit = 100 } = {}) {
  const w = [], a = [];
  if (status) { w.push('status = ?'); a.push(status); }
  if (item_id) { w.push('item_id = ?'); a.push(item_id); }
  const sql = `SELECT * FROM tasks ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
  a.push(limit);
  return q.all(sql, ...a);
}

export function updateTask(id, patch) {
  const cur = getTask(id);
  if (!cur) throw new Error(`task 不存在: ${id}`);
  const m = { ...cur, ...patch, updated_at: now() };
  q.run(
    `UPDATE tasks SET updated_at=?, status=?, executor=?, model=?, attempt=?, lease_until=?, heartbeat_at=?,
       tokens_in=?, tokens_out=?, cost_cny=?, plan=?, result=?, last_error=?, output_dir=?, started_at=?, finished_at=?
     WHERE id=?`,
    m.updated_at, m.status, m.executor, m.model, m.attempt, m.lease_until, m.heartbeat_at,
    m.tokens_in, m.tokens_out, m.cost_cny, m.plan, m.result, m.last_error, m.output_dir, m.started_at, m.finished_at, id
  );
  return m;
}

/** 原子领任务：依赖已满足 + 并发未超限 + 车道未满 + 未到退避时间 */
export function claimNextTask(maxConcurrent) {
  return tx(() => {
    const cfg = loadConfig();
    const nowIso = now();
    const running = q.get("SELECT COUNT(*) AS n FROM tasks WHERE status='running'")?.n ?? 0;
    if (running >= maxConcurrent) return null;

    // 车道限流：按自主等级限制并发
    const lanes = cfg.settings.lanes || {};
    const laneRunning = {};
    for (const r of q.all("SELECT autonomy_level, COUNT(*) n FROM tasks WHERE status='running' GROUP BY autonomy_level")) {
      laneRunning['L' + r.autonomy_level] = r.n;
    }

    // 依赖满足的候选
    const cands = q.all("SELECT * FROM tasks WHERE status='queued' ORDER BY priority DESC, created_at ASC LIMIT 100");
    for (const t of cands) {
      // 退避：lease_until 在 queued 状态下兼作「最早可跑时间」
      if (t.lease_until && t.lease_until > nowIso) continue;
      // 车道
      const laneCap = lanes['L' + (t.autonomy_level ?? 3)];
      if (typeof laneCap === 'number' && laneCap >= 0) {
        if ((laneRunning['L' + (t.autonomy_level ?? 3)] || 0) >= laneCap) continue;
      }
      let deps = [];
      try { deps = JSON.parse(t.depends_on || '[]'); } catch {}
      if (deps.length) {
        const okAll = deps.every((d) => {
          const r = q.get('SELECT status FROM tasks WHERE id=?', d);
          return r && r.status === 'succeeded';
        });
        if (!okAll) continue;
      }
      q.run("UPDATE tasks SET status='running', started_at=?, updated_at=?, heartbeat_at=?, lease_until=NULL WHERE id=? AND status='queued'",
        nowIso, nowIso, nowIso, t.id);
      return getTask(t.id);
    }
    return null;
  });
}

// ---------- Run ----------
export function openRun({ task_id, attempt, executor, command, cmdline }) {
  const id = newRunId();
  const cfg = loadConfig();
  const dir = path.join(cfg.resolved.runs, id);
  fs.mkdirSync(dir, { recursive: true });
  const ts = now();
  q.run(
    `INSERT INTO runs(id,task_id,attempt,executor,command,cmdline,pid,started_at,finished_at,duration_ms,exit_code,status,tokens_in,tokens_out,cost_cny,dir,error)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, task_id, attempt, executor ?? null, command ?? null, cmdline ?? null, null, ts, null, null, null, 'running', 0, 0, 0, dir, null
  );
  emit({ actor: 'worker', type: 'run.started', task_id, run_id: id, message: `${executor} attempt#${attempt}` });
  return { id, dir };
}

/** 只记录子进程 pid（不要用它结束 run —— 那是 finishRun 的职责） */
export function attachRunPid(runId, pid) {
  if (!runId) return;
  q.run('UPDATE runs SET pid=? WHERE id=?', pid ?? null, runId);
}

export function finishRun(id, patch) {
  const cur = q.get('SELECT * FROM runs WHERE id=?', id);
  if (!cur) return null;
  const ts = now();
  const dur = patch.duration_ms ?? (cur.started_at ? Date.now() - Date.parse(cur.started_at) : null);
  q.run(
    `UPDATE runs SET finished_at=?, duration_ms=?, exit_code=?, status=?, tokens_in=?, tokens_out=?, cost_cny=?, error=?, pid=? WHERE id=?`,
    ts, dur, patch.exit_code ?? null, patch.status || 'ok', patch.tokens_in ?? cur.tokens_in,
    patch.tokens_out ?? cur.tokens_out, patch.cost_cny ?? cur.cost_cny, patch.error ?? null, patch.pid ?? cur.pid, id
  );
  emit({
    actor: 'worker', type: `run.${patch.status || 'ok'}`, task_id: cur.task_id, run_id: id,
    level: (patch.status === 'failed' || patch.status === 'timeout') ? 'warn' : 'info',
    message: `${patch.status || 'ok'} ${dur ? Math.round(dur / 1000) + 's' : ''}`,
    data: patch.error ? { error: String(patch.error).slice(0, 500) } : null,
  });
  return q.get('SELECT * FROM runs WHERE id=?', id);
}

// ---------- Artifact ----------
export function addArtifact({ task_id, item_id, kind = 'file', title, filePath }) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  // 红线：产物必须落在白名单目录内
  try { (guardAssertWritable)(filePath); }
  catch (e) { emit({ actor: 'guard', type: 'artifact.blocked', level: 'error', task_id, item_id, message: e.message }); return null; }
  const st = fs.statSync(filePath);
  const buf = fs.readFileSync(filePath);
  const id = 'art_' + shortHash(filePath + st.mtimeMs, 16);
  q.run(
    `INSERT OR REPLACE INTO artifacts(id,task_id,item_id,kind,title,path,bytes,sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    id, task_id ?? null, item_id ?? null, kind, title || path.basename(filePath), filePath, st.size,
    crypto.createHash('sha256').update(buf).digest('hex'), now()
  );
  emit({ actor: 'worker', type: 'artifact.added', task_id, item_id, message: title || path.basename(filePath), data: { path: filePath, bytes: st.size } });
  return id;
}

// ---------- Approval ----------
export function createApproval(o) {
  const cfg = loadConfig();
  const id = newApprovalId();
  const ts = now();
  const ttl = (o.ttlHours ?? cfg.settings.approvalTtlHours) * 3600e3;
  const expires = new Date(Date.now() + ttl).toISOString();
  q.run(
    `INSERT INTO approvals(id,created_at,updated_at,item_id,task_id,kind,title,summary,context,options,recommendation,risk,
       status,decided_at,decided_by,decision,note,expires_at,notified_count,last_notified_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, ts, ts, o.item_id ?? null, o.task_id ?? null, o.kind || 'decision', o.title || '(待确认)',
    o.summary ?? null, JSON.stringify(o.context || {}), JSON.stringify(o.options || []),
    o.recommendation ?? null, o.risk || 'medium', 'pending', null, null, null, null, expires, 0, null
  );
  if (o.item_id) {
    try { updateItem(o.item_id, { bucket: 'outbox', status: 'awaiting_human' }); } catch {}
  }
  emit({ actor: 'hitl', type: 'approval.requested', approval_id: id, item_id: o.item_id, task_id: o.task_id, level: 'warn', message: o.title || '' });
  return getApproval(id);
}

export function getApproval(id) { return q.get('SELECT * FROM approvals WHERE id=?', id) || null; }

export function listApprovals({ status, limit = 50 } = {}) {
  const w = [], a = [];
  if (status) { w.push('status = ?'); a.push(status); }
  const sql = `SELECT * FROM approvals ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
  a.push(limit);
  return q.all(sql, ...a);
}

export function decideApproval(id, { decision, option, note, by = 'human' }) {
  const cur = getApproval(id);
  if (!cur) throw new Error(`approval 不存在: ${id}`);
  if (cur.status !== 'pending') throw new Error(`approval 已处理: ${cur.status}`);
  const ts = now();
  q.run('UPDATE approvals SET status=?, decided_at=?, decided_by=?, decision=?, note=?, updated_at=? WHERE id=?',
    decision, ts, by, option ?? null, note ?? null, ts, id);
  if (cur.item_id) {
    const st = decision === 'approved' ? 'planned' : 'dropped';
    try { updateItem(cur.item_id, { bucket: decision === 'approved' ? 'active' : 'archive', status: st }); } catch {}
  }
  emit({ actor: 'human', type: `approval.${decision}`, approval_id: id, item_id: cur.item_id, task_id: cur.task_id, level: 'warn', message: `${cur.title} → ${decision}${option ? ' [' + option + ']' : ''}` });
  return getApproval(id);
}

// ---------- 查询聚合 ----------
export function pendingWork() {
  return {
    inbox: q.get("SELECT COUNT(*) n FROM items WHERE bucket='inbox'")?.n ?? 0,
    outbox: q.get("SELECT COUNT(*) n FROM approvals WHERE status='pending'")?.n ?? 0,
    queued: q.get("SELECT COUNT(*) n FROM tasks WHERE status='queued'")?.n ?? 0,
    running: q.get("SELECT COUNT(*) n FROM tasks WHERE status='running'")?.n ?? 0,
    failed24h: q.get("SELECT COUNT(*) n FROM tasks WHERE status='failed' AND updated_at > ?", new Date(Date.now() - 86400e3).toISOString())?.n ?? 0,
  };
}

export function todayCost() {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const r = q.get('SELECT COALESCE(SUM(cost_cny),0) c, COALESCE(SUM(tokens_in),0) i, COALESCE(SUM(tokens_out),0) o FROM runs WHERE started_at >= ?', dayStart.toISOString());
  const budget = loadConfig().settings.dailyBudgetCny;
  return { costCny: +(r?.c || 0).toFixed(4), tokensIn: r?.i || 0, tokensOut: r?.o || 0, budget, ratio: budget ? +((r?.c || 0) / budget).toFixed(3) : 0 };
}
