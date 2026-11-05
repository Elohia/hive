// src/sensors/docs.mjs — 文档变更传感器（只读）
//
// 目标信号："最近在写什么"。
// 做法：扫 config.sources.docs.roots，取 lookbackHours 内变更的文本文件，按 mtime 倒序。
//
// 降噪（本机实测必要）：
//   C:/HIVE-SAMPLE/automations\reports 有 3871 个文件，其中 data\*.json 是机器产物（行情/心跳），
//   若不过滤会在 72h 窗口里刷出上百条噪声。因此：
//     - 跳过 data/logs/tmp 之类目录（DEFAULT_SKIP_DIRS + 额外 NOISE_DIRS）
//     - 跳过心跳/状态/清单/锁这类机器文件名
//     - .json 仅保留"看起来像人工产出"的（在 reports 根目录且非 data 子目录）
// 产出粒度：每个文件一条（最多 perRoot 条 / 全局 maxItems 条），正文只取前 400 字摘要。
import path from 'node:path';
import {
  walkFilesSync, clampInt, note, oneLine, truncate, readTextSafe, relPath,
  isDir, resolveFromHome, normalizeText,
} from './_util.mjs';

const NAME = 'docs';

const NOISE_DIRS = new Set(['data', 'logs', 'log', 'tmp', 'temp', 'cache', '.cache', 'artifacts', 'runs']);
const NOISE_NAMES = new Set([
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  'tsconfig.json', 'jsconfig.json', 'manifest.json', 'state.json',
  'seen.md', 'heartbeat.json', 'lock.json', 'run-lock.json', 'dm-lock.json',
  'write-seen.json', '.mig-2.0.0',
]);
// 机器产物命名：supervisor_* / sentinel_* / *_runs.json / 看板.html …
const NOISE_NAME_RE = /(?:^|[._-])(heartbeat|lock|snapshot|ledger|manifest|runs|state)(?:[._-]|$)/i;
const MACHINE_NAME_RE = /^(看板|dashboard|supervisor_|sentinel_)|(?:^|[._-])(supervisor|sentinel)(?:[._-]|$)/i;
const SKIP_EXT = new Set(['.log', '.lock', '.tmp', '.db', '.db-wal', '.db-shm', '.sqlite']);

function isNoise(rel, name, ext) {
  if (SKIP_EXT.has(ext)) return true;
  if (NOISE_NAMES.has(name.toLowerCase())) return true;
  if (NOISE_NAME_RE.test(name)) return true;
  if (MACHINE_NAME_RE.test(name)) return true;
  const segs = rel.split('/').map((s) => s.toLowerCase());
  // 任何一层目录叫 data/logs/tmp → 机器产物
  for (let i = 0; i < segs.length - 1; i++) {
    if (NOISE_DIRS.has(segs[i])) return true;
  }
  // 数字命名的时间序列文件（600202_30m.json 这类）
  if (/^\d{6}[_-]/.test(name)) return true;
  if (/^\d{4}-\d{2}-\d{2}/.test(name) && ext === '.json') return true;
  return false;
}

function snippetOf(file, ext, maxChars) {
  if (!['.md', '.txt', '.html'].includes(ext)) return '';
  const raw = readTextSafe(file, 64 * 1024);
  if (!raw) return '';
  let t = ext === '.html' ? raw.replace(/<[^>]*>/g, ' ') : raw;
  t = normalizeText(t);
  // 跳过 YAML front-matter / 标题行，取正文第一段
  const lines = t.split('\n').filter((l) => l.trim() && !/^---+$/.test(l.trim()) && !/^#{1,6}\s/.test(l.trim()) && !/^[a-zA-Z_]+:\s/.test(l.trim()));
  const body = lines.join(' ').replace(/\s+/g, ' ').trim();
  return truncate(body, maxChars);
}

/**
 * 领域判定：必须落在 policies.json 的白名单内（ops|code|comms|work|trade|startup|ai|content|life|family）。
 * 依据路径关键词收敛，宁可保守归 work，也不产出自由词。
 */
export function domainOfDoc(root, rel) {
  const p = `${root}\\${rel}`.toLowerCase();
  if (/pi-agent|trading?|stock|quant|行情|盘面|收盘|涨停|持仓|复盘|题材|资金/.test(p)) return 'trade';
  if (/elohia|persona|人格|数字分身|模拟器|life-sim/.test(p)) return 'ai';
  if (/hive|dsh|harness|agent|架构|roadmap|技能|skill/.test(p)) return 'ai';
  if (/content|小红书|抖音|视频|封面|文案|脚本|内容/.test(p)) return 'content';
  if (/family|家庭|孩子|家人/.test(p)) return 'family';
  return 'work';
}

export default {
  name: NAME,
  title: '文档变更',
  enabled(cfg) {
    return !!(cfg?.sources?.docs?.enabled);
  },

  async *scan(ctx) {
    const cfg = ctx?.cfg || {};
    const sc = cfg?.sources?.docs || {};
    const opts = ctx?.opts || {};
    const roots = Array.isArray(sc.roots) ? sc.roots.filter(Boolean) : [];
    const lookbackHours = clampInt(sc.lookbackHours, 1, 24 * 365, 72);
    const exts = (Array.isArray(sc.exts) && sc.exts.length ? sc.exts : ['.md', '.txt', '.html', '.json'])
      .map((e) => String(e).toLowerCase());
    const perRoot = clampInt(opts.perRoot, 1, 100, 8);
    const maxItems = clampInt(opts.maxItems, 1, 300, 24);
    const snippetChars = clampInt(opts.snippetChars, 0, 2_000, 400);
    const deadlineMs = clampInt(opts.deadlineMs, 1_000, 30_000, 8_000);

    const t0 = Date.now();
    const now = ctx?.now instanceof Date ? ctx.now : new Date();
    const cutMs = now.getTime() - lookbackHours * 3600_000;

    if (roots.length === 0) {
      note(ctx, NAME, { ok: true, count: 0, note: 'config.sources.docs.roots 为空' });
      return;
    }

    let emitted = 0;
    const perRootStats = [];
    let totalScanned = 0;
    let totalRecent = 0;
    let totalNoise = 0;

    for (const rawRoot of roots) {
      if (emitted >= maxItems || Date.now() - t0 > deadlineMs) break;
      const root = resolveFromHome(cfg, rawRoot);
      if (!root || !isDir(root)) {
        perRootStats.push({ root: rawRoot, exists: false, recent: 0, emitted: 0 });
        continue;
      }

      let files = [];
      let truncated = false;
      try {
        const walked = walkFilesSync(root, {
          maxDepth: clampInt(opts.maxDepth, 1, 10, 5),
          exts,
          deadlineMs: Math.max(1_000, Math.floor(deadlineMs / 2)),
        });
        files = walked.files;
        truncated = walked.truncated;
      } catch (e) {
        perRootStats.push({ root: rawRoot, exists: true, error: oneLine(e?.message || e, 100), recent: 0, emitted: 0 });
        continue;
      }

      totalScanned += files.length;
      const recent = files.filter((f) => f.mtimeMs >= cutMs);
      totalRecent += recent.length;
      recent.sort((a, b) => b.mtimeMs - a.mtimeMs);

      let rootEmitted = 0;
      let rootNoise = 0;
      let jsonEmitted = 0;
      const jsonQuota = clampInt(opts.jsonQuota, 0, 50, 2);
      for (const f of recent) {
        if (emitted >= maxItems || rootEmitted >= perRoot) break;
        const rel = relPath(root, f.path);
        if (isNoise(rel, f.name, f.ext)) { rootNoise++; continue; }
        // .json 基本都是机器产物（行情/心跳/清单）：每个 root 只留 jsonQuota 个，
        // 把名额让给 .md/.txt/.html（"最近在写什么"的真正信号），但排序仍严格按 mtime。
        if (f.ext === '.json') {
          if (jsonEmitted >= jsonQuota) { rootNoise++; continue; }
          jsonEmitted++;
        }

        try {
          const ageHours = Math.max(0, (now.getTime() - f.mtimeMs) / 3600_000);
          const snippet = snippetChars > 0 ? snippetOf(f.path, f.ext, snippetChars) : '';
          const rootLabel = String(rawRoot).replace(/^[A-Za-z]:\\/, '');
          const body = [
            `文件：${f.path}`,
            `变更时间：${new Date(f.mtimeMs).toISOString()}（${ageHours < 1 ? '不到 1 小时前' : `${ageHours.toFixed(1)} 小时前`}）`,
            `大小：${f.size} 字节`,
            snippet ? '' : null,
            snippet ? `内容摘要：${snippet}` : null,
          ].filter((x) => x != null).join('\n');

          rootEmitted++;
          emitted++;
          yield {
            source: NAME,
            source_ref: `doc:${f.path}:${Math.round(f.mtimeMs)}`,
            title: oneLine(`${rootLabel.split(/[\\/]/).pop() || rootLabel} · ${rel}`, 160),
            body,
            ts: new Date(f.mtimeMs).toISOString(),
            kind_hint: 'doc_change',
            domain_hint: domainOfDoc(rawRoot, rel),
            urgency_hint: 2,
            meta: {
              root: rawRoot,
              absPath: f.path,
              rel,
              ext: f.ext,
              bytes: f.size,
              mtime: new Date(f.mtimeMs).toISOString(),
              ageHours: Number(ageHours.toFixed(2)),
            },
          };
        } catch (e) {
          // 单个文件失败跳过
          ctx?.log?.('warn', 'sensor:docs 文件失败', { file: f.path, error: oneLine(e?.message || e, 100) });
        }
      }
      totalNoise += rootNoise;
      perRootStats.push({
        root: rawRoot, exists: true, recent: recent.length, emitted: rootEmitted,
        noise: rootNoise, scanned: files.length, truncated,
      });
    }

    note(ctx, NAME, {
      ok: true,
      count: emitted,
      lookbackHours,
      scanned: totalScanned,
      recent: totalRecent,
      noiseSkipped: totalNoise,
      perRoot: perRootStats,
      ms: Date.now() - t0,
      note: totalRecent === 0
        ? `近 ${lookbackHours}h 无文本文件变更（扫了 ${totalScanned} 个文件）`
        : `近 ${lookbackHours}h 变更 ${totalRecent} 个，产出 ${emitted} 条（跳过机器产物 ${totalNoise} 个）`,
    });

    ctx?.log?.('info', 'sensor:docs', { scanned: totalScanned, recent: totalRecent, emitted, noise: totalNoise });
  },
};

export const __internals = { isNoise, snippetOf, domainOfDoc };
