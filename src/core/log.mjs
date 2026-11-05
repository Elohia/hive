// src/core/log.mjs — 文件日志（滚动友好，不阻塞）
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';

let stream = null;
let currentDay = null;

function dayKey() { return new Date().toISOString().slice(0, 10); }

function ensure() {
  const cfg = loadConfig();
  const d = dayKey();
  if (stream && currentDay === d) return stream;
  try { stream?.close(); } catch {}
  currentDay = d;
  const file = path.join(cfg.resolved.logs, `hive-${d}.log`);
  stream = fs.createWriteStream(file, { flags: 'a' });
  return stream;
}

const LV = { debug: 10, info: 20, warn: 30, error: 40 };

export function log(level, msg, extra) {
  const line = `[${new Date().toISOString()}] ${String(level).toUpperCase().padEnd(5)} ${msg}` +
    (extra ? ' ' + safe(extra) : '');
  try { ensure().write(line + '\n'); } catch {}
  if (process.env.HIVE_VERBOSE || LV[level] >= 20) {
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
  }
}

function safe(o) {
  try { return typeof o === 'string' ? o : JSON.stringify(o); } catch { return String(o); }
}

export const logger = {
  debug: (m, e) => log('debug', m, e),
  info: (m, e) => log('info', m, e),
  warn: (m, e) => log('warn', m, e),
  error: (m, e) => log('error', m, e),
};

/** 保留最近 N 天日志 */
export function pruneLogs(keepDays = 14) {
  const cfg = loadConfig();
  const cutoff = Date.now() - keepDays * 86400e3;
  for (const f of fs.readdirSync(cfg.resolved.logs)) {
    const p = path.join(cfg.resolved.logs, f);
    try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch {}
  }
}
