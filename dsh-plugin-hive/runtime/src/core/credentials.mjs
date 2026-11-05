// src/core/credentials.mjs — 极简 YAML refs 解析（只取需要的那层，不落盘、不打印）
import fs from 'node:fs';
import { loadConfig } from './config.mjs';

let cache = null;

/** 解析 `refs:` 段的 `KEY: value`（DSH .credentials.yaml 形态） */
function parseRefs(text) {
  const out = {};
  const lines = text.split(/\r?\n/);
  let inRefs = false;
  let refsIndent = -1;
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^(\s*)([A-Za-z0-9_.\-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    if (!inRefs) {
      if (m[2] === 'refs' && indent === 0) { inRefs = true; refsIndent = 0; }
      continue;
    }
    // 退出 refs 段（同级或更浅的其它 key）
    if (indent <= refsIndent) {
      if (m[2] === 'refs') continue;
      break;
    }
    if (indent > refsIndent) {
      let v = m[3].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (v) out[m[2]] = v;
    }
  }
  return out;
}

export function loadRefs({ reload = false } = {}) {
  if (cache && !reload) return cache;
  const cfg = loadConfig();
  const file = cfg.resolved.credentials;
  if (!file || !fs.existsSync(file)) return (cache = {});
  try {
    cache = parseRefs(fs.readFileSync(file, 'utf8'));
  } catch {
    cache = {};
  }
  return cache;
}

export function getKey(refName) {
  const refs = loadRefs();
  if (refs[refName]) return refs[refName];
  if (process.env[refName]) return process.env[refName];
  return null;
}

/** 从不泄露完整密钥的角度描述可用性 */
export function keyStatus() {
  const cfg = loadConfig();
  const out = {};
  for (const [alias, refName] of Object.entries(cfg.credentials?.keys || {})) {
    const k = getKey(refName);
    out[alias] = { ref: refName, present: !!k, length: k ? k.length : 0 };
  }
  return out;
}
