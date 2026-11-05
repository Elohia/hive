// src/core/ids.mjs — 无依赖单调 ID
import crypto from 'node:crypto';

const B36 = (n) => n.toString(36);
let seq = 0;
let lastMs = 0;

export function id(prefix = 'x') {
  const ms = Date.now();
  if (ms === lastMs) seq = (seq + 1) % 1296; else { lastMs = ms; seq = 0; }
  const ts = B36(ms).padStart(9, '0');
  const sq = B36(seq).padStart(2, '0');
  const rnd = crypto.randomBytes(4).toString('hex').slice(0, 6);
  return `${prefix}_${ts}${sq}${rnd}`;
}

export const itemId = () => id('itm');
export const taskId = () => id('tsk');
export const runId = () => id('run');
export const approvalId = () => id('apr');

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function shortHash(s, len = 12) {
  return sha256(Buffer.from(String(s), 'utf8')).slice(0, len);
}
