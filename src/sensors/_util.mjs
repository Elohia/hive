// src/sensors/_util.mjs — 传感器公共件（零 npm 依赖 / 只读 / 一切外部命令带超时）
//
// 设计约束（对应 docs/01-ARCHITECTURE.md §6.1 与任务硬要求）：
//   1. 零外部依赖：只用 node: 内置模块。
//   2. 只读：本模块不写业务表；cursor 由调用方注入（daemon 提供 ctx.cursor）。
//   3. 所有外部命令走 child_process.execFile 且必带 timeout（≤60s），杜绝无限等待。
//   4. 隐私：只提供 clip() 这类截断助手，日志里永不输出完整正文。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { loadConfig } from '../core/config.mjs';

export const IS_WIN = process.platform === 'win32';

/** 单个外部命令的硬上限（毫秒）——任务要求不超过 60s */
export const MAX_CMD_TIMEOUT_MS = 60_000;

/* ============================== 基础数值/文本 ============================== */

export function clampInt(v, min, max, def) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

export function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** 任意时间表示 → ISO 字符串（失败返回 null） */
export function toIso(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
  if (typeof v === 'number') return Number.isFinite(v) ? new Date(v).toISOString() : null;
  const s = String(v).trim();
  // 已是 ISO 且可解析
  const ms = Date.parse(s);
  if (Number.isFinite(ms)) return new Date(ms).toISOString();
  return null;
}

/** 去掉 BOM */
export function stripBom(s) {
  return typeof s === 'string' ? s.replace(/^\uFEFF/, '') : s;
}

/** 截断到 n 个字符，超长补省略号 */
export function truncate(s, n = 200) {
  const t = s == null ? '' : String(s);
  if (t.length <= n) return t;
  return t.slice(0, n) + '…';
}

/** 压成单行（换行/多空白 → 单个空格），再截断 */
export function oneLine(s, n = 200) {
  const t = (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
  return truncate(t, n);
}

/**
 * 隐私截断：日志/测试输出里只允许出现前 n 个字符 + 省略号。
 * 邮件正文、文档正文一律先过这里再打印。
 */
export function clip(s, n = 60) {
  const t = (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length <= n ? t : t.slice(0, n) + '…';
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeFromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(Number.parseInt(d, 10)))
    .replace(/&([a-zA-Z]+|#39);/g, (m, name) => (name in ENTITIES ? ENTITIES[name] : m));
}

function safeFromCodePoint(cp) {
  try { return String.fromCodePoint(cp); } catch { return ''; }
}

/** HTML → 可读纯文本（保守实现，够用即可） */
export function stripHtml(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ');
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\s*\/\s*(p|div|tr|li|h[1-6]|table|blockquote)\s*>/gi, '\n');
  s = s.replace(/<[^>]*>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t\u00a0]+/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** 纯文本归一：保留换行，压缩行内空白 */
export function normalizeText(s) {
  if (!s) return '';
  let t = String(s).replace(/\r\n?/g, '\n');
  t = t.replace(/[ \t\u00a0]+/g, ' ');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

/** 短哈希（用于稳定 source_ref） */
export function hash(s, n = 16) {
  return crypto.createHash('sha1').update(String(s ?? ''), 'utf8').digest('hex').slice(0, n);
}

/* ============================== 安全 JSON 解析 ============================== */

/** 按括号平衡截取第一个完整 JSON 值（尊重字符串与转义） */
function balancedFrom(s, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 宽容 JSON 解析：
 *   - 去掉 BOM
 *   - 剔除 `tip:` 之类的噪声行（agently-cli 会往 stderr 打 tip，但保不齐未来混进 stdout）
 *   - 从第一个 `{`/`[` 开始按括号平衡截取
 * 解析不出来返回 null（调用方决定降级），绝不抛错。
 */
export function safeJson(text) {
  if (text == null) return null;
  let s = stripBom(String(text)).trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* 继续降级 */ }

  const filtered = s
    .split(/\r?\n/)
    .filter((line) => !/^\s*tip\s*:/i.test(line))
    .join('\n')
    .trim();
  if (filtered !== s) {
    try { return JSON.parse(filtered); } catch { /* 继续降级 */ }
  }

  const braces = filtered.indexOf('{');
  const brackets = filtered.indexOf('[');
  let start = -1;
  if (braces < 0) start = brackets;
  else if (brackets < 0) start = braces;
  else start = Math.min(braces, brackets);
  if (start < 0) return null;

  const frag = balancedFrom(filtered, start);
  if (!frag) return null;
  try { return JSON.parse(frag); } catch { return null; }
}

/** 读文本文件（失败返回 null，不抛） */
export function readTextSafe(file, maxBytes = 512 * 1024) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(st.size, maxBytes);
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, 0);
      return stripBom(buf.toString('utf8'));
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

export function readJsonSafe(file, fallback = null) {
  const t = readTextSafe(file);
  if (t == null) return fallback;
  const j = safeJson(t);
  return j == null ? fallback : j;
}

/** stat 安全版 */
export function statSafe(p) {
  try { return fs.statSync(p); } catch { return null; }
}

export function pathExists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

export function isDir(p) {
  const st = statSafe(p);
  return !!st && st.isDirectory();
}

/** 相对某根的展示用路径（跨盘符时退回绝对路径的 basename 链） */
export function relPath(root, abs) {
  try {
    const r = path.relative(root, abs);
    if (!r || r.startsWith('..')) return abs;
    return r.split(path.sep).join('/');
  } catch { return abs; }
}

/* ============================== 命令执行（带超时） ============================== */

/** shell 模式下允许出现在参数里的字符（防注入；我们的参数只有 id/flag/数字） */
const SHELL_SAFE_ARG = /^[\w@.,:+=~\\/-]+$/;

function argShellSafe(a) {
  return typeof a === 'string' && SHELL_SAFE_ARG.test(a);
}

function runOnce(file, args, { timeoutMs, cwd, env, maxBuffer, useShell }) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(
        file,
        args,
        {
          cwd,
          timeout: Math.min(timeoutMs, MAX_CMD_TIMEOUT_MS),
          maxBuffer,
          windowsHide: true,
          encoding: 'utf8',
          ...(env ? { env: { ...process.env, ...env } } : {}),
          ...(useShell ? { shell: true } : {}),
        },
        (err, stdout, stderr) => {
          const res = {
            ok: !err,
            code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
            stdout: stdout || '',
            stderr: stderr || '',
            ms: Date.now() - t0,
            timedOut: false,
            spawnError: null,
            error: null,
            shellUsed: useShell,
          };
          if (err) {
            if (err.killed || err.signal) {
              res.timedOut = true;
              res.error = `timeout(${timeoutMs}ms)`;
            } else if (err.code === 'ENOENT' || err.code === 'EINVAL' || err.code === 'EACCES') {
              res.spawnError = String(err.code);
              res.error = `spawn ${err.code}: ${file}`;
            } else {
              res.error = oneLine(err.message || String(err), 300);
            }
          }
          resolve(res);
        },
      );
      // 极端情况下不留下悬挂句柄
      child.on('error', () => {});
    } catch (e) {
      resolve({
        ok: false, code: null, stdout: '', stderr: '', ms: Date.now() - t0,
        timedOut: false, spawnError: 'SYNC_THROW', error: oneLine(e.message || e, 300), shellUsed: useShell,
      });
    }
  });
}

/**
 * 统一外部命令入口（execFile + timeout）。
 *
 * Windows 注意：npm 全局 CLI 装出来的是 `agently-cli.cmd` / `.ps1`，
 * execFile 直接 spawn 会 ENOENT（裸名）或 EINVAL（.cmd 全路径）——
 * 实测（Node 24 / Windows）只有 `{shell:true}` 或 `cmd.exe /c` 能跑通。
 * 因此：先按裸名直连（git 这类真 exe 走这条，无 shell、无注入面）；
 * 若确认是 shim spawn 失败，再对参数做白名单校验后回退 shell 模式。
 */
export async function runCli(file, args = [], opts = {}) {
  const {
    timeoutMs = 30_000, cwd, env, maxBuffer = 8 * 1024 * 1024, allowShellFallback = true,
  } = opts;

  let res = await runOnce(file, args, { timeoutMs, cwd, env, maxBuffer, useShell: false });

  if (!res.ok && !res.timedOut && IS_WIN && allowShellFallback && res.spawnError) {
    if (args.every(argShellSafe)) {
      const retry = await runOnce(file, args, { timeoutMs, cwd, env, maxBuffer, useShell: true });
      retry.fallbackFrom = res.spawnError;
      res = retry;
    } else if (opts.onUnsafeShell) {
      opts.onUnsafeShell(args);
    }
  }
  return res;
}

/* ============================== 文件遍历（有预算上限） ============================== */

export const DEFAULT_SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'coverage',
  '__pycache__', '.venv', 'venv', '.cache', '.next', '.nuxt', '.turbo', 'target',
  '$recycle.bin', 'system volume information',
]);

/**
 * 有预算的递归遍历：返回文件描述数组（不抛错）。
 * 预算：最多 maxDirs 个目录 / maxFiles 个文件 / deadlineMs 毫秒。
 */
export function walkFilesSync(root, opts = {}) {
  const {
    maxDepth = 4,
    exts = null,                     // 例如 ['.md','.txt']（小写）；null = 全部
    skipDirs = DEFAULT_SKIP_DIRS,
    maxFiles = 20_000,
    maxDirs = 4_000,
    deadlineMs = 8_000,
    followSymlinks = false,
  } = opts;

  const t0 = Date.now();
  const out = [];
  let dirs = 0;
  let truncated = false;
  const extSet = exts ? new Set(exts.map((e) => e.toLowerCase())) : null;

  const stop = () => out.length >= maxFiles || dirs >= maxDirs || Date.now() - t0 > deadlineMs;

  const visit = (dir, depth) => {
    if (stop()) { truncated = true; return; }
    dirs++;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      if (stop()) { truncated = true; return; }
      const full = path.join(dir, ent.name);
      let isDirectory = ent.isDirectory();
      let isFile = ent.isFile();
      if (ent.isSymbolicLink()) {
        if (!followSymlinks) continue;
        const st = statSafe(full);
        if (!st) continue;
        isDirectory = st.isDirectory();
        isFile = st.isFile();
      }
      if (isDirectory) {
        if (skipDirs.has(ent.name.toLowerCase())) continue;
        if (depth < maxDepth) visit(full, depth + 1);
        continue;
      }
      if (!isFile) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (extSet && !extSet.has(ext)) continue;
      const st = statSafe(full);
      if (!st) continue;
      out.push({ path: full, name: ent.name, ext, size: st.size, mtimeMs: st.mtimeMs });
    }
  };

  if (isDir(root)) visit(root, 0);
  return { files: out, truncated, dirs, ms: Date.now() - t0 };
}

/**
 * 有界地发现嵌套 git 仓库（返回仓库根目录数组）。
 * 用于 config 里配的是"项目父目录"而不是仓库根的情况（本机实测大量如此）。
 */
export function findGitRoots(root, opts = {}) {
  const { maxDepth = 3, maxRepos = 8, maxDirs = 1_500, deadlineMs = 6_000 } = opts;
  const t0 = Date.now();
  const found = [];
  const seen = new Set();
  let dirs = 0;
  let truncated = false;

  const stop = () => found.length >= maxRepos || dirs >= maxDirs || Date.now() - t0 > deadlineMs;

  const visit = (dir, depth) => {
    if (stop()) { truncated = true; return; }
    dirs++;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const names = new Set(ents.map((e) => e.name));
    if (names.has('.git') && !seen.has(dir)) { seen.add(dir); found.push(dir); }
    if (depth >= maxDepth) return;
    for (const ent of ents) {
      if (!ent.isDirectory()) continue;
      const lname = ent.name.toLowerCase();
      if (lname === '.git') continue;
      if (DEFAULT_SKIP_DIRS.has(lname)) continue;
      visit(path.join(dir, ent.name), depth + 1);
    }
  };

  if (isDir(root)) visit(root, 0);
  return { roots: found, truncated, dirs, ms: Date.now() - t0 };
}

/* ============================== ctx / cursor / 诊断 ============================== */

/** 内存 cursor：测试与只读场景用，绝不落库 */
export function memoryCursor(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get(source, key) {
      const k = `${source}\u0000${key}`;
      return map.has(k) ? map.get(k) : null;
    },
    set(source, key, value) {
      map.set(`${source}\u0000${key}`, value == null ? null : String(value));
      return true;
    },
    delete(source, key) { map.delete(`${source}\u0000${key}`); },
    _dump() { return Object.fromEntries(map.entries()); },
  };
}

/** 构造扫描上下文；缺省全部给安全默认值（sensor 可单独跑） */
export function makeCtx(partial = {}) {
  return {
    cfg: partial.cfg || loadConfig(),
    now: partial.now instanceof Date ? partial.now : new Date(),
    cursor: partial.cursor || memoryCursor(),
    notes: partial.notes && typeof partial.notes === 'object' ? partial.notes : {},
    opts: partial.opts && typeof partial.opts === 'object' ? partial.opts : {},
    log: typeof partial.log === 'function' ? partial.log : () => {},
  };
}

/** 传感器把"这次为什么 0 条/降级在哪"写到 ctx.notes[name]，供 daemon/看板/冒烟读取 */
export function note(ctx, name, patch) {
  if (!ctx || typeof ctx !== 'object') return;
  if (!ctx.notes || typeof ctx.notes !== 'object') ctx.notes = {};
  const prev = ctx.notes[name] && typeof ctx.notes[name] === 'object' ? ctx.notes[name] : {};
  ctx.notes[name] = { ...prev, ...patch };
}

/** 解析配置里的相对路径（相对 cfg.home） */
export function resolveFromHome(cfg, p) {
  if (!p) return null;
  if (path.isAbsolute(p)) return p;
  return path.join(cfg?.home || process.cwd(), p);
}

/** 简单 glob：仅支持最后一段含 `*`（如 data/calendar/*.ics） */
export function expandSimpleGlob(cfg, pattern) {
  const abs = resolveFromHome(cfg, pattern);
  if (!abs) return [];
  if (!abs.includes('*')) return pathExists(abs) ? [abs] : [];
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  const re = new RegExp('^' + base.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of ents) if (e.isFile() && re.test(e.name)) out.push(path.join(dir, e.name));
  return out;
}

/** 从文本猜紧急度（1 最不急 … 5 最急） */
export function inferUrgency(text, def = 3) {
  const t = String(text || '');
  if (/紧急|立即|马上|尽快|asap|urgent|critical|中断|故障|宕机|down/i.test(t)) return 5;
  if (/退信|无法送达|失败|报错|error|failed|中断|异常|欠费|过期|逾期/i.test(t)) return 4;
  if (/提醒|请注意|请确认|到期|待办|reminder|deadline/i.test(t)) return 3;
  return def;
}

/* ============================== 领域白名单 ============================== */

/**
 * policies.json 认可的领域值。传感器一律只能产出这些值（或 null 交由 triage 自行判定），
 * 不允许出现自由词（否则策略权重表匹配不上）。
 */
export const ALLOWED_DOMAINS = Object.freeze([
  'ops', 'code', 'comms', 'work', 'trade', 'startup', 'ai', 'content', 'life', 'family',
]);

/** 传感器内部语义 → 策略领域（只做收敛，不新增自由词） */
const DOMAIN_ALIAS = Object.freeze({
  finance: 'life',      // 账单/发票 → 个人事务
  security: 'ops',      // 登录/验证码提醒 → 系统运维
  calendar: 'work',     // 会议/日程 → 工作
  docs: 'work',         // 文档变更默认归工作
  system: 'ops',        // 自检 → 运维
  mail: 'comms',
  git: 'code',
  code_repo: 'code',
});

/** 收敛任意领域值到白名单内；无法收敛则返回 null（让上层自己判） */
export function coerceDomain(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (!s) return null;
  if (ALLOWED_DOMAINS.includes(s)) return s;
  if (DOMAIN_ALIAS[s]) return DOMAIN_ALIAS[s];
  return null;
}

/** 是否白名单内的领域值 */
export function isAllowedDomain(v) {
  return typeof v === 'string' && ALLOWED_DOMAINS.includes(v);
}

export { loadConfig };
