// src/core/config.mjs — 唯一配置装载点（零硬编码）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 代码根：源码所在位置（不随 HIVE_HOME 变） */
export const CODE_ROOT = path.resolve(here, '..', '..');

/** 项目根（数据/配置）：优先 HIVE_HOME，其次由源码位置推导 */
export function resolveHome() {
  if (process.env.HIVE_HOME && fs.existsSync(process.env.HIVE_HOME)) return path.resolve(process.env.HIVE_HOME);
  return CODE_ROOT;
}

let _cache = null;

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) {
    if (fallback !== undefined) return fallback;
    throw new Error(`配置读取失败 ${p}: ${e.message}`);
  }
}

export function loadConfig({ reload = false } = {}) {
  if (_cache && !reload) return _cache;
  const home = resolveHome();
  const cfgPath = path.join(home, 'config', 'hive.json');
  const raw = readJson(cfgPath);
  const policies = readJson(path.join(home, 'config', 'policies.json'));
  const abs = (p) => (p ? (path.isAbsolute(p) ? p : path.join(home, p)) : null);

  const cfg = {
    ...raw,
    home,
    codeRoot: CODE_ROOT,
    version: readVersion(),
    policies,
    resolved: {
      db: abs(raw.paths.db),
      runs: abs(raw.paths.runs),
      artifacts: abs(raw.paths.artifacts),
      logs: abs(raw.paths.logs),
      workspace: abs(raw.paths.workspace),
      prompts: abs(raw.paths.prompts),
      credentials: raw.credentials?.file || null,
      configFile: cfgPath,
      // 代码资产永远跟源码走，不跟数据目录走（否则换 HIVE_HOME 就看板 404）
      web: path.join(CODE_ROOT, 'web'),
      scripts: path.join(CODE_ROOT, 'scripts'),
    },
  };
  for (const d of ['runs', 'artifacts', 'logs', 'workspace', 'prompts']) {
    fs.mkdirSync(cfg.resolved[d], { recursive: true });
  }
  _cache = cfg;
  return cfg;
}

export function getHome() { return resolveHome(); }

/** 版本号永远读代码根的 VERSION */
function readVersion() {
  try { return fs.readFileSync(path.join(CODE_ROOT, 'VERSION'), 'utf8').trim(); } catch { return '0.0.0'; }
}
