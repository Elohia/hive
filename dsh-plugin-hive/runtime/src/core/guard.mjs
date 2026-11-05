// src/core/guard.mjs — 红线守卫（policies.write_allowlist_dirs / never_touch 的机器强制）
import path from 'node:path';
import { loadConfig } from './config.mjs';

function norm(p) {
  try { return path.resolve(String(p)); } catch { return String(p); }
}

function inside(child, parent) {
  const c = norm(child).toLowerCase();
  const p = norm(parent).toLowerCase();
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** 写盘白名单校验：不在 allowlist 或命中 never_touch → 抛错 */
export function assertWritable(target) {
  const cfg = loadConfig();
  const pol = cfg.policies;
  const p = norm(target);
  for (const bad of pol.never_touch || []) {
    if (inside(p, bad)) {
      throw new Error(`红线：${p} 位于 never_touch（${bad}），禁止写入`);
    }
  }
  const allow = pol.write_allowlist_dirs || [];
  if (allow.length && !allow.some((d) => inside(p, d))) {
    throw new Error(`越界：${p} 不在 write_allowlist_dirs 内（允许：${allow.join(' | ')}）`);
  }
  return true;
}

/** 目标文本里是否提到禁改区（用于「派发前拦截」，而不是等执行器动手） */
export function checkGoalAgainstRedlines(text = '', extraPaths = []) {
  const cfg = loadConfig();
  const hits = [];
  const hay = String(text).toLowerCase();
  for (const bad of cfg.policies.never_touch || []) {
    const stem = bad.toLowerCase();
    if (hay.includes(stem)) hits.push(bad);
  }
  for (const p of extraPaths) {
    if (hay.includes(String(p).toLowerCase())) {
      if ((cfg.policies.never_touch || []).some((b) => inside(p, b))) hits.push(p);
    }
  }
  return { ok: hits.length === 0, hits: [...new Set(hits)] };
}

/** 可写性探测（不抛，返回原因） */
export function writableReason(target) {
  try { assertWritable(target); return { ok: true }; }
  catch (e) { return { ok: false, reason: e.message }; }
}
