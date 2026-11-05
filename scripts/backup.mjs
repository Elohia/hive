#!/usr/bin/env node
// scripts/backup.mjs — HIVE 备份：db 一致性快照 + artifacts + runs 索引 → 单个归档
//
// 关键设计（对应任务硬要求「不得装包」「幂等」）：
//  1) 零 npm 依赖：只用 node: 内置模块 + Windows 自带 bsdtar（C:\Windows\system32\tar.exe，实测 3.8.9）；
//  2) db 快照用 SQLite 官方 `VACUUM INTO`（在线一致性快照，不用 cp 拷 WAL 脏页）；
//  3) 有 sha256 契约：manifest.json 里登记 hive.db 的 sha256，restore 会逐个校验；
//  4) 幂等：同一 --out 重复执行就覆盖（先写临时文件再 rename，不会留半截包）；
//  5) 有退出码：0 = 成功；1 = 失败；2 = 参数错误。
//
// 用法：
//   node --no-warnings scripts/backup.mjs
//   node --no-warnings scripts/backup.mjs --out data\backup-test.zip
//   node --no-warnings scripts/backup.mjs --format dbgz        # 纯 node 兜底格式（.db.gz + .manifest.json）
//   node --no-warnings scripts/backup.mjs --with-runs --keep 7

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const origEmitWarning = process.emitWarning;
process.emitWarning = (w, ...rest) => {
  const msg = typeof w === 'string' ? w : (w?.message || '');
  if (/SQLite is an experimental/i.test(msg)) return;
  return origEmitWarning.call(process, w, ...rest);
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ARGV = process.argv.slice(2);

// ---------------------------------------------------------------- 参数
function flagVal(name, def = null) {
  const i = ARGV.indexOf('--' + name);
  if (i === -1) return def;
  const v = ARGV[i + 1];
  return !v || v.startsWith('--') ? true : v;
}
const HAS = (n) => ARGV.includes('--' + n);

if (HAS('help') || HAS('h')) {
  console.log(`HIVE 备份 backup v1

用法: node --no-warnings scripts/backup.mjs [选项]

选项:
  --out <path>       归档输出路径（默认 data/backups/hive-backup-<YYYYmmdd-HHmmss>.zip）
  --format <fmt>     zip（默认，走 bsdtar）| dbgz（纯 node:zlib，可无 tar 恢复）
  --keep <n>         保留最近 n 份备份，更老的自动删（默认 10；0 = 不清理）
  --with-runs        把 data/runs 的原始产物也装进包（体积可能很大，默认只存索引）
  --no-artifacts     不打包 data/artifacts 里的文件（默认打包）
  --no-sidecar       不写 <out>.sha256 校验旁文件
  --quiet            只输出结果行
  --json             机器可读输出
  -h, --help         显示本帮助

打包内容:
  hive.db              VACUUM INTO 出来的一致性快照（不是 cp！）
  manifest.json        schema/版本/主机/db sha256/各表行数/包含清单
  config/hive.json     ← 唯一配置落点（恢复时--with-config 才会覆盖回去）
  config/policies.json
  VERSION
  artifacts/           data/artifacts 下的文件（--no-artifacts 关闭）
  runs/index.json      runs 目录索引（--with-runs 则含原始内容）
  runs/...             仅 --with-runs

退出码: 0 = 成功; 1 = 失败; 2 = 参数错误
`);
  process.exit(0);
}

const KNOWN = new Set(['--out', '--format', '--keep', '--with-runs', '--no-artifacts', '--no-sidecar', '--quiet', '--json', '--help', '-h']);
for (let i = 0; i < ARGV.length; i++) {
  const a = ARGV[i];
  if (!a.startsWith('-')) continue;
  if (!KNOWN.has(a)) { console.error(`✗ 未知参数: ${a}（--help 看用法）`); process.exit(2); }
  if (['--out', '--format', '--keep'].includes(a)) {
    const v = ARGV[i + 1];
    if (!v || v.startsWith('--')) { console.error(`✗ ${a} 需要一个值`); process.exit(2); }
    i++;
  }
}

const FORMAT = String(flagVal('format', 'zip')).toLowerCase();
if (!['zip', 'dbgz'].includes(FORMAT)) { console.error(`✗ --format 只支持 zip | dbgz（收到 ${FORMAT}）`); process.exit(2); }
const KEEP = Number(flagVal('keep', 10));
if (!Number.isFinite(KEEP) || KEEP < 0) { console.error('✗ --keep 需要非负整数'); process.exit(2); }

const QUIET = HAS('quiet');
const JSONOUT = HAS('json');
const WITH_RUNS = HAS('with-runs');
const WITH_ARTIFACTS = !HAS('no-artifacts');
const SIDECAR = !HAS('no-sidecar');

const say = (s) => { if (!QUIET) console.log(s); };
const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const bytesFmt = (n) => n >= 1 << 30 ? (n / (1 << 30)).toFixed(2) + ' GiB'
  : n >= 1 << 20 ? (n / (1 << 20)).toFixed(2) + ' MiB'
    : n >= 1 << 10 ? (n / (1 << 10)).toFixed(1) + ' KiB' : n + ' B';
const tsStamp = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// ---------------------------------------------------------------- 配置（缺失也能退）
let cfg;
try {
  const { loadConfig } = await import(new URL('../src/core/config.mjs', import.meta.url).href);
  cfg = loadConfig();
} catch {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'hive.json'), 'utf8'));
  const abs = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));
  cfg = {
    ...raw, home: ROOT,
    resolved: {
      db: abs(raw.paths.db), runs: abs(raw.paths.runs), artifacts: abs(raw.paths.artifacts),
      logs: abs(raw.paths.logs), workspace: abs(raw.paths.workspace),
    },
  };
  say('· 提示: src/core/config.mjs 不可用，已用裸 JSON 解析配置');
}

const outArg = flagVal('out', null);
const defaultDir = path.join(cfg.home, 'data', 'backups');
const baseNoExt = FORMAT === 'dbgz'
  ? path.resolve(String(outArg || path.join(defaultDir, `hive-backup-${tsStamp()}.db`)).replace(/\.(db\.gz|gz)$/i, ''))
  : path.resolve(String(outArg || path.join(defaultDir, `hive-backup-${tsStamp()}.zip`)));
const outPath = FORMAT === 'dbgz' ? baseNoExt + '.db.gz' : baseNoExt.endsWith('.zip') ? baseNoExt : baseNoExt + '.zip';

const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-backup-'));
const t0 = Date.now();
const steps = [];
function step(name, ok, detail, ms) {
  steps.push({ name, ok, detail, ms });
  say(`${ok ? '✓' : '✗'} ${name.padEnd(14)} ${ms != null ? String(ms).padStart(5) + 'ms  ' : '        '}${detail}`);
}

let exitCode = 0;
async function main() {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  if (!fs.existsSync(cfg.resolved.db)) throw new Error(`数据库不存在: ${cfg.resolved.db}`);

  // ---------- 1) db 一致性快照（VACUUM INTO） ----------
  const { DatabaseSync } = await import('node:sqlite');
  const snapPath = path.join(staging, 'hive.db');
  let counts = {}, tables = {}, journalSrc = '?', dbBytes = 0, dbSha = '', sqliteVer = '?';
  {
    const t = Date.now();
    const db = new DatabaseSync(cfg.resolved.db);
    try {
      journalSrc = db.prepare('PRAGMA journal_mode').get()?.journal_mode ?? '?';
      sqliteVer = db.prepare('SELECT sqlite_version() AS v').get()?.v ?? '?';
      // 先把 WAL 落盘，再 VACUUM INTO 出纯净快照
      let ckpt = 'n/a';
      try {
        const r = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
        ckpt = r ? JSON.stringify(r) : 'ok';
      } catch { ckpt = 'skipped'; }
      const q = (s) => "VACUUM INTO '" + s.replace(/'/g, "''") + "'";
      db.exec(q(snapPath));
      const tbl = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
      for (const n of tbl) {
        tables[n] = db.prepare(`SELECT COUNT(*) c FROM "${n}"`).get()?.c ?? 0;
      }
      counts = tables;
      dbBytes = fs.statSync(snapPath).size;
      dbSha = sha256File(snapPath);
      step('db 快照', true, `VACUUM INTO → ${bytesFmt(dbBytes)} sha256=${dbSha.slice(0, 16)}…（wal_checkpoint=${ckpt}, journal=${journalSrc}）`, Date.now() - t);
    } finally { try { db.close(); } catch {} }
  }

  // ---------- 2) manifest ----------
  const manifest = {
    schema: 'hive-backup-v1',
    created_at: new Date().toISOString(),
    host: os.hostname(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    home: cfg.home,
    app_version: (() => { try { return fs.readFileSync(path.join(cfg.home, 'VERSION'), 'utf8').trim(); } catch { return null; } })(),
    format: FORMAT,
    db: {
      file: 'hive.db', bytes: dbBytes, sha256: dbSha,
      source: path.relative(cfg.home, cfg.resolved.db).replace(/\\/g, '/'),
      source_journal_mode: journalSrc, sqlite: sqliteVer,
    },
    tables,
    includes: [],
    artifacts: { included: WITH_ARTIFACTS, files: 0, bytes: 0 },
    runs: { included: WITH_RUNS, dirs: 0, files: 0, bytes: 0 },
  };

  // ---------- 3) 配置 / VERSION ----------
  {
    const t = Date.now();
    const cfgDir = path.join(staging, 'config');
    fs.mkdirSync(cfgDir, { recursive: true });
    const picked = [];
    for (const f of ['hive.json', 'policies.json']) {
      const src = path.join(cfg.home, 'config', f);
      if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(cfgDir, f)); picked.push('config/' + f); }
    }
    const vf = path.join(cfg.home, 'VERSION');
    if (fs.existsSync(vf)) { fs.copyFileSync(vf, path.join(staging, 'VERSION')); picked.push('VERSION'); }
    manifest.includes.push(...picked);
    step('配置/版本', true, picked.join(', ') || '（无可打包项）', Date.now() - t);
  }

  // ---------- 4) artifacts ----------
  if (WITH_ARTIFACTS) {
    const t = Date.now();
    const src = cfg.resolved.artifacts;
    let files = 0, bytes = 0;
    if (fs.existsSync(src)) {
      const dst = path.join(staging, 'artifacts');
      fs.mkdirSync(dst, { recursive: true });
      const walk = (d, relD = '') => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const abs = path.join(d, e.name);
          const relP = relD ? path.join(relD, e.name) : e.name;
          if (e.isDirectory()) { fs.mkdirSync(path.join(dst, relP), { recursive: true }); walk(abs, relP); }
          else if (e.isFile()) { fs.copyFileSync(abs, path.join(dst, relP)); files++; bytes += fs.statSync(abs).size; }
        }
      };
      walk(src);
      if (files) manifest.includes.push('artifacts/');
    }
    manifest.artifacts = { included: true, files, bytes };
    step('artifacts', true, files ? `${files} 个文件 / ${bytesFmt(bytes)}` : '目录为空，只记录 0 个文件', Date.now() - t);
  } else {
    step('artifacts', true, '已按 --no-artifacts 跳过（只留空白）', 0);
  }

  // ---------- 5) runs 索引（可选内容） ----------
  {
    const t = Date.now();
    const src = cfg.resolved.runs;
    const dirs = [];
    let files = 0, bytes = 0;
    if (fs.existsSync(src)) {
      for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const d = path.join(src, e.name);
        let f = 0, b = 0;
        const walk = (dd) => {
          for (const x of fs.readdirSync(dd, { withFileTypes: true })) {
            const p = path.join(dd, x.name);
            if (x.isDirectory()) walk(p); else { f++; b += fs.statSync(p).size; }
          }
        };
        walk(d);
        dirs.push({ id: e.name, files: f, bytes: b, mtime: new Date(fs.statSync(d).mtimeMs).toISOString() });
        files += f; bytes += b;
      }
    }
    const runsDir = path.join(staging, 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(path.join(runsDir, 'index.json'), JSON.stringify({
      generated_at: new Date().toISOString(), count: dirs.length, files, bytes, runs: dirs,
    }, null, 2), 'utf8');
    manifest.includes.push('runs/index.json');
    manifest.runs = { included: WITH_RUNS, dirs: dirs.length, files, bytes };
    if (WITH_RUNS && dirs.length) {
      fs.cpSync(src, runsDir, { recursive: true });   // index.json 会被目录内容覆盖无关，保持两者
      fs.writeFileSync(path.join(runsDir, 'index.json'), JSON.stringify({
        generated_at: new Date().toISOString(), count: dirs.length, files, bytes, runs: dirs,
      }, null, 2), 'utf8');
      manifest.includes.push('runs/');
    }
    step('runs', true, `${dirs.length} 个 run 目录 / ${files} 文件 / ${bytesFmt(bytes)}（内容${WITH_RUNS ? '已打包' : '只存索引'}）`, Date.now() - t);
  }

  // ---------- 6) manifest 落盘 ----------
  fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  // ---------- 7) 打包 ----------
  const tmpOut = outPath + '.part';
  try { fs.rmSync(tmpOut, { force: true }); } catch {}
  if (FORMAT === 'zip') {
    const t = Date.now();
    const r = spawnSync('tar', ['-a', '-c', '-f', tmpOut, '-C', staging, '.'], { encoding: 'utf8', windowsHide: true, timeout: 600000 });
    if (r.error) throw new Error(`tar 执行失败: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`tar 退出码 ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 400)}`);
    fs.renameSync(tmpOut, outPath);
    step('压缩(zip)', true, `bsdtar -a → ${path.basename(outPath)}`, Date.now() - t);
  } else {
    const t = Date.now();
    const gz = zlib.gzipSync(fs.readFileSync(snapPath), { level: 9 });
    fs.writeFileSync(tmpOut, gz);
    fs.renameSync(tmpOut, outPath);
    const manPath = baseNoExt + '.manifest.json';
    fs.writeFileSync(manPath, JSON.stringify(manifest, null, 2), 'utf8');
    manifest.includes.push(path.basename(manPath));
    step('压缩(dbgz)', true, `node:zlib gzip → ${path.basename(outPath)} + ${path.basename(manPath)}`, Date.now() - t);
  }

  // ---------- 8) 校验 ----------
  const archiveBytes = fs.statSync(outPath).size;
  const archiveSha = sha256File(outPath);
  if (SIDECAR) fs.writeFileSync(outPath + '.sha256', `${archiveSha}  ${path.basename(outPath)}\n`, 'utf8');
  step('归档', true, `${bytesFmt(archiveBytes)} sha256=${archiveSha.slice(0, 16)}…${SIDECAR ? ' (+.sha256)' : ''}`, 0);

  // ---------- 9) 保留策略 ----------
  if (KEEP > 0) {
    const dir = path.dirname(outPath);
    const mine = fs.readdirSync(dir)
      .filter((f) => /^hive-backup-.*\.(zip|db\.gz)$/i.test(f) && !f.endsWith('.part'))
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    const drop = mine.slice(KEEP);
    for (const d of drop) {
      for (const p of [d.f, d.f + '.sha256']) { try { fs.rmSync(path.join(dir, p), { force: true }); } catch {} }
      const stem = d.f.replace(/\.(zip|db\.gz)$/i, '');
      try { fs.rmSync(path.join(dir, stem + '.manifest.json'), { force: true }); } catch {}
    }
    if (drop.length) step('保留策略', true, `--keep ${KEEP}：删掉 ${drop.length} 份旧备份 (${drop.map((d) => d.f).join(', ')})`, 0);
  }

  // ---------- 10) 输出 ----------
  const elapsed = Date.now() - t0;
  const payload = {
    ok: true, out: outPath, format: FORMAT, bytes: archiveBytes, sha256: archiveSha,
    sidecar: SIDECAR ? outPath + '.sha256' : null,
    manifest: { db: manifest.db, tables, artifacts: manifest.artifacts, runs: manifest.runs },
    elapsedMs: elapsed, steps,
  };
  if (JSONOUT) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log('-'.repeat(96));
    console.log(`✓ 备份完成 ${elapsed}ms → ${outPath}`);
    console.log(`  大小 ${bytesFmt(archiveBytes)}  sha256 ${archiveSha}`);
    console.log(`  db 快照 ${bytesFmt(dbBytes)}；表行数: ${Object.entries(tables).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(' ') || '(全空)'}`);
    console.log(`  恢复: node --no-warnings scripts/restore.mjs --from "${outPath}" --dry-run`);
  }
  return 0;
}

try {
  exitCode = await main();
} catch (e) {
  exitCode = 1;
  if (JSONOUT) console.log(JSON.stringify({ ok: false, error: String(e.message), steps }, null, 2));
  else console.error(`\n✗ 备份失败: ${e.message}`);
} finally {
  try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
}
process.exit(exitCode);
