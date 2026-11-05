// src/task/pulse.mjs — 定时脉冲（巡检节奏）
import { q } from '../core/db.mjs';
import { loadConfig } from '../core/config.mjs';
import { emit } from '../core/events.mjs';
import { logger } from '../core/log.mjs';

/**
 * 支持三种 spec：
 *   every:<N><s|m|h>       例 every:15m
 *   daily:<HH:MM>          例 daily:09:30
 *   weekly:<1-7 逗号>:<HH:MM>  例 weekly:1,2,3,4,5:08:10
 */
export function parseSpec(spec) {
  let m;
  if ((m = /^every:(\d+)([smh])$/.exec(spec))) {
    const mul = { s: 1e3, m: 60e3, h: 3600e3 }[m[2]];
    return { kind: 'every', ms: Number(m[1]) * mul };
  }
  if ((m = /^daily:(\d{1,2}):(\d{2})$/.exec(spec))) {
    return { kind: 'daily', hh: Number(m[1]), mm: Number(m[2]) };
  }
  if ((m = /^weekly:([\d,]+):(\d{1,2}):(\d{2})$/.exec(spec))) {
    return { kind: 'weekly', days: m[1].split(',').map(Number), hh: Number(m[2]), mm: Number(m[3]) };
  }
  return null;
}

export function nextRun(spec, from = new Date()) {
  const p = parseSpec(spec);
  if (!p) return null;
  if (p.kind === 'every') return new Date(from.getTime() + p.ms);
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setHours(p.hh, p.mm, 0, 0);
  if (p.kind === 'daily') {
    if (d <= from) d.setDate(d.getDate() + 1);
    return d;
  }
  // weekly：ISO 1=周一 .. 7=周日
  const iso = (x) => (x.getDay() === 0 ? 7 : x.getDay());
  for (let i = 0; i < 8; i++) {
    if (p.days.includes(iso(d)) && d > from) return new Date(d);
    d.setDate(d.getDate() + 1);
    d.setHours(p.hh, p.mm, 0, 0);
  }
  return null;
}

export function seedPulses() {
  const cfg = loadConfig();
  const ts = new Date().toISOString();
  const want = [];

  // 1) 每个启用的 sensor 一条
  for (const [name, s] of Object.entries(cfg.sources || {})) {
    if (!s || s.enabled === false) continue;
    const sec = s.intervalSec || 1800;
    want.push({ id: `pulse-scan-${name}`, name: `巡检·${name}`, spec: `every:${Math.max(1, Math.round(sec / 60))}m`, config: { handler: 'scan', source: name } });
  }
  // 2) 判定/派发/看门狗/摘要
  want.push({ id: 'pulse-triage', name: '事项判定与路由', spec: 'every:10m', config: { handler: 'triage' } });
  want.push({ id: 'pulse-watchdog', name: '看门狗', spec: 'every:1m', config: { handler: 'watchdog' } });
  want.push({ id: 'pulse-digest-morning', name: '晨报', spec: 'daily:08:40', config: { handler: 'digest', slot: 'morning' } });
  want.push({ id: 'pulse-digest-evening', name: '晚报', spec: 'daily:21:30', config: { handler: 'digest', slot: 'evening' } });
  want.push({ id: 'pulse-context', name: '上下文刷新', spec: 'daily:07:50', config: { handler: 'context' } });
  want.push({ id: 'pulse-selfcheck', name: '自检', spec: 'every:6h', config: { handler: 'selfcheck' } });

  let added = 0;
  for (const p of want) {
    const exists = q.get('SELECT id FROM pulses WHERE id=?', p.id);
    if (exists) {
      q.run('UPDATE pulses SET name=?, spec=?, config=? WHERE id=?', p.name, p.spec, JSON.stringify(p.config), p.id);
      continue;
    }
    q.run(
      'INSERT INTO pulses(id,name,spec,enabled,last_run_at,next_run_at,last_status,config) VALUES(?,?,?,?,?,?,?,?)',
      p.id, p.name, p.spec, 1, null, nextRun(p.spec, new Date())?.toISOString() ?? ts, null, JSON.stringify(p.config)
    );
    added++;
  }
  if (added) logger.info(`seedPulses: 新增 ${added} 条脉冲`);
  return added;
}

export function allPulses() {
  return q.all('SELECT * FROM pulses ORDER BY id');
}

export function duePulses(now = new Date()) {
  const iso = now.toISOString();
  return q.all('SELECT * FROM pulses WHERE enabled=1 AND (next_run_at IS NULL OR next_run_at <= ?)', iso);
}

export function markPulseRun(pulse, status = 'ok', now = new Date()) {
  const nxt = nextRun(pulse.spec, now);
  q.run('UPDATE pulses SET last_run_at=?, next_run_at=?, last_status=? WHERE id=?',
    now.toISOString(), nxt?.toISOString() ?? null, status, pulse.id);
  emit({ actor: 'pulse', type: 'pulse.run', message: `${pulse.name} → ${status}`, data: { id: pulse.id, next: nxt?.toISOString() } });
}
