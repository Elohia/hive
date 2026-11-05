// src/task/watchdog.mjs — 租约/超时/预算/卡死回收 + 崩溃恢复
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { q } from '../core/db.mjs';
import { loadConfig } from '../core/config.mjs';
import { emit } from '../core/events.mjs';
import { logger } from '../core/log.mjs';
import { updateTask, listApprovals, decideApproval, createApproval, getItem } from './taskcenter.mjs';

const pexec = promisify(execFile);

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function killTree(pid) {
  if (!pid) return false;
  try {
    await pexec('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 10000, windowsHide: true });
    return true;
  } catch {
    try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; }
  }
}

/** 启动时恢复：把 running 但已死/租约过期的任务收回 */
export function recover({ force = false } = {}) {
  const nowIso = new Date().toISOString();
  const rows = q.all("SELECT * FROM tasks WHERE status='running'");
  const recovered = [];
  for (const t of rows) {
    const expired = !t.lease_until || t.lease_until < nowIso;
    const dead = !procAliveOfTask(t);
    if (force || (expired && dead) || expired) {
      const attempt = t.attempt || 0;
      const canRetry = attempt < (t.max_attempts || 3);
      updateTask(t.id, {
        status: canRetry ? 'queued' : 'failed',
        lease_until: null,
        last_error: canRetry ? 'daemon 重启/租约过期，已回收重排' : '租约过期且重试耗尽',
      });
      q.run("UPDATE runs SET status='killed', finished_at=?, error='租约过期回收' WHERE task_id=? AND status='running'", nowIso, t.id);
      emit({
        actor: 'watchdog', type: 'task.recovered', task_id: t.id, level: 'warn',
        message: `${t.title} → ${canRetry ? 'queued(重排)' : 'failed'}`,
      });
      recovered.push({ id: t.id, to: canRetry ? 'queued' : 'failed' });
    }
  }
  if (recovered.length) logger.warn(`watchdog.recover 回收 ${recovered.length} 个任务`);
  return recovered;
}

function procAliveOfTask(t) {
  const r = q.get("SELECT pid FROM runs WHERE task_id=? AND status='running' ORDER BY started_at DESC LIMIT 1", t.id);
  return r?.pid ? pidAlive(r.pid) : false;
}

/** 每次 tick：超时/超预算/心跳停 → kill；审批过期 → 提醒或自动拒绝 */
export async function tick() {
  const cfg = loadConfig();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const actions = [];

  const running = q.all("SELECT * FROM tasks WHERE status='running'");
  for (const t of running) {
    const started = t.started_at ? Date.parse(t.started_at) : now;
    const elapsed = (now - started) / 1000;
    const timeout = t.timeout_sec || cfg.settings.defaultTimeoutSec;

    const run = q.get("SELECT * FROM runs WHERE task_id=? AND status='running' ORDER BY started_at DESC LIMIT 1", t.id);
    const tokens = (run?.tokens_in || 0) + (run?.tokens_out || 0);
    const overBudget = t.budget_tokens && tokens > t.budget_tokens;
    const overTime = elapsed > timeout + 30;

    if (overTime || overBudget) {
      const reason = overTime ? `超时 ${Math.round(elapsed)}s > ${timeout}s` : `超预算 ${tokens} > ${t.budget_tokens} tokens`;
      const killed = await killTree(run?.pid);
      q.run("UPDATE runs SET status=?, finished_at=?, error=? WHERE id=?", overTime ? 'timeout' : 'killed', nowIso, reason, run?.id);
      const attempt = t.attempt || 0;
      const canRetry = attempt < (t.max_attempts || 3);
      updateTask(t.id, { status: canRetry ? 'queued' : 'failed', lease_until: null, last_error: reason });
      emit({ actor: 'watchdog', type: 'task.killed', task_id: t.id, run_id: run?.id, level: 'warn', message: `${t.title}：${reason}（kill=${killed}）` });
      actions.push({ task: t.id, action: 'killed', reason });
      // 最终失败 → 进 Outbox 问人
      if (!canRetry) {
        try {
          createApproval({
            item_id: t.item_id, task_id: t.id, kind: 'decision',
            title: `任务反复失败，是否人工接管：${t.title}`,
            summary: reason + '\n\n' + (t.last_error || ''),
            context: { taskId: t.id, reason },
            options: [
              { id: 'retry-once', label: '再试一次', detail: '重置重试次数后再跑一遍' },
              { id: 'manual', label: '我自己来做', detail: '关闭自动执行' },
              { id: 'drop', label: '放弃这件事', detail: '归档' },
            ],
            recommendation: '建议先看 run 目录里的 stderr 再决定',
            risk: 'medium',
          });
        } catch {}
      }
    }
  }

  // 审批过期
  const expired = q.all("SELECT * FROM approvals WHERE status='pending' AND expires_at IS NOT NULL AND expires_at < ?", nowIso);
  for (const ap of expired) {
    decideApproval(ap.id, { decision: 'expired', by: 'system', note: '超过有效期未处理' });
    emit({ actor: 'watchdog', type: 'approval.expired', approval_id: ap.id, level: 'warn', message: ap.title });
    actions.push({ approval: ap.id, action: 'expired' });
  }

  return actions;
}

/** 周期性统计健康度，写事件（看板用） */
export function health() {
  const since = new Date(Date.now() - 3600e3).toISOString();
  return {
    running: q.get("SELECT COUNT(*) n FROM tasks WHERE status='running'")?.n ?? 0,
    queued: q.get("SELECT COUNT(*) n FROM tasks WHERE status='queued'")?.n ?? 0,
    stalled: q.all("SELECT id FROM tasks WHERE status='running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)", new Date(Date.now() - 300e3).toISOString()).length,
    errLastHour: q.get("SELECT COUNT(*) n FROM events WHERE level='error' AND ts >= ?", since)?.n ?? 0,
    pendingApprovals: q.get("SELECT COUNT(*) n FROM approvals WHERE status='pending'")?.n ?? 0,
  };
}
