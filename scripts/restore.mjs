#!/usr/bin/env node
// scripts/restore.mjs — 从备份恢复（校验 sha256 → 覆盖前询问 → 覆盖 → 复核）
//
// 硬要求（任务书）：校验 sha256 并在覆盖前询问（--yes 跳过）。
//
// 安全设计：
//  1) 先解包到临时目录，校验 manifest 里登记的 db sha256 与解出的 hive.db 完全一致，才允许继续；
//  2) 覆盖真实库前，自动把当前 db（含 -wal/-shm）另存到 data/backups/pre-restore-<ts>.{db,db-wal,db-shm}；
//  3) 守护进程活着时拒绝覆盖（除非 --force），避免把正在跑的 daemon 撕成半新半旧；
//  4) 覆盖后立刻 integrity_check + 逐表行数与 manifest 对照，不一致就报 FAIL；
//  5) --dry-run 只校验不动手；--target-db 可恢复到备用路径做演练（不碰生产库）。
//
// 用法：
//   node --no-warnings scripts/restore.mjs --from data\backup-test.zip --dry-run
//   node --no-warnings scripts/restore.mjs --from data\backup-test.zip
//   node --no-warnings scripts/restore.mjs --from data\backup-test.zip --yes
//   node --no-warnings scripts/restore.mjs --from data\backup-test.zip --target-db data\restore-drill.db --yes

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const nodeRequire = createRequire(import.meta.url);

const origEmitWarning = process.emitWarning;
process.emitWarning = (w, ...rest) => {
  const msg = typeof w === 'string' ? w : (w?.message || '');
  if (/SQLite is an experimental/i.test(msg)) return;
  return origEmitWarning.call(process, w, ...rest);
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ARGV = process.argv.slice(2);

function flagVal(name, def = null) {
  const i = ARGV.indexOf('--' + name);
  if (i === -1) return def;
  const v = ARGV[i + 1];
  return !v || v.startsWith('--') ? true : v;
}
const HAS = (n) => ARGV.includes('--' + n);

if (HAS('help') || HAS('h')) {
  console.log(`HIVE 恢复 restore v1

用法: node --no-warnings scripts/restore.mjs --from <备份> [选项]

选项:
  --from <path>       备份文件（.zip / .tar.gz / .db.gz）
  --yes               跳过覆盖前的交互确认（脚本/计划任务用）
  --dry-run           只解包+校验+试开库，不覆盖任何东西
  --target-db <path>  恢复到备用路径（演练用，不碰生产库）
  --with-config       同时把包里的 config/*.json 覆盖回配置目录（默认不动）
  --force             守护进程活着也强行覆盖（危险，会撕裂正在运行的 daemon）
  --no-safety-backup  覆盖前不另存当前库（不推荐）
  --allow-mismatch    sha256 不一致也继续（极不推荐，仅用于手工修包）
  --json              机器可读输出
  -h, --help          显示本帮助

流程:
  1 解包到临时目录 → 2 校验 db sha256（与 manifest 对照；有 .sha256 旁文件则连归档一起校验）
  → 3 试开库（integrity_check + 逐表行数） → 4 覆盖前询问（--yes 跳过）
  → 5 另存现场（pre-restore-*.db） → 6 覆盖 db（并删掉旧 -wal/-shm）
  → 7 复核行数与 manifest 一致

退出码: 0 = 成功/校验通过（含 --dry-run）; 1 = 恢复失败或复核不一致; 2 = 参数错误或校验不通过
`);
  process.exit(0);
}

const KNOWN = new Set(['--from', '--yes', '--dry-run', '--target-db', '--with-config', '--force', '--no-safety-backup', '--allow-mismatch', '--json', '--help', '-h']);
for (let i = 0; i < ARGV.length; i++) {
  const a = ARGV[i];
  if (!a.startsWith('-')) continue;
  if (!KNOWN.has(a)) { console.error(`✗ 未知参数: ${a}（--help 看用法）`); process.exit(2); }
  if (['--from', '--target-db'].includes(a)) {
    const v = ARGV[i + 1];
    if (!v || v.startsWith('--')) { console.error(`✗ ${a} 需要一个值`); process.exit(2); }
    i++;
  }
}

const from = flagVal('from', null);
if (!from || from === true) { console.error('✗ 必须给 --from <备份文件>（--help 看用法）'); process.exit(2); }
const archive = path.resolve(String(from));
const DRY = HAS('dry-run');
const YES = HAS('yes');
const FORCE = HAS('force');
const WITH_CONFIG = HAS('with-config');
const SAFETY = !HAS('no-safety-backup');
const ALLOW_MISMATCH = HAS('allow-mismatch');
const JSONOUT = HAS('json');
const targetDbArg = flagVal('target-db', null);

const say = (s) => { if (!JSONOUT) console.log(s); };
const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const bytesFmt = (n) => n >= 1 << 20 ? (n / (1 << 20)).toFixed(2) + ' MiB' : n >= 1 << 10 ? (n / (1 << 10)).toFixed(1) + ' KiB' : n + ' B';
const tsStamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };

const rows = [];
function add(item, status, detail) {
  rows.push({ item, status, detail: String(detail ?? '') });
  if (!JSONOUT) console.log(`${item.padEnd(22)} ${status.padEnd(4)}  ${rows[rows.length - 1].detail}`);
}

// ---------------------------------------------------------------- 配置
let cfg;
try {
  const { loadConfig } = await import(new URL('../src/core/config.mjs', import.meta.url).href);
  cfg = loadConfig();
} catch {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'hive.json'), 'utf8'));
  const abs = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));
  cfg = { ...raw, home: ROOT, resolved: { db: abs(raw.paths.db), runs: abs(raw.paths.runs), artifacts: abs(raw.paths.artifacts), logs: abs(raw.paths.logs) } };
}

const targetDb = path.resolve(String(targetDbArg || cfg.resolved.db));
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-restore-'));
const t0 = Date.now();

function lockAlive() {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(cfg.home, 'data', 'hive.lock'), 'utf8'));
    process.kill(lock.pid, 0);
    return lock;
  } catch { return null; }
}

function tableCounts(dbPath) {
  const { DatabaseSync } = nodeRequire('node:sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    const out = {};
    for (const r of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()) {
      out[r.name] = db.prepare(`SELECT COUNT(*) c FROM "${r.name}"`).get()?.c ?? 0;
    }
    const integrity = db.prepare('PRAGMA integrity_check').get()?.integrity_check;
    return { ok: true, counts: out, integrity };
  } finally { try { db.close(); } catch {} }
}

let exitCode = 0;
try {
  say(`HIVE 恢复 — 归档 ${archive}`);
  say(`目标库 ${targetDb}${targetDbArg ? '（--target-db 演练模式，不碰生产库）' : ''}`);

  // ---------- 1) 归档校验 ----------
  if (!fs.existsSync(archive)) throw Object.assign(new Error(`备份不存在: ${archive}`), { code: 2 });
  const aBytes = fs.statSync(archive).size;
  const aSha = sha256File(archive);
  const side = archive + '.sha256';
  if (fs.existsSync(side)) {
    const want = fs.readFileSync(side, 'utf8').trim().split(/\s+/)[0];
    const ok = want === aSha;
    add('归档 sha256', ok || ALLOW_MISMATCH ? 'PASS' : 'FAIL', `${aSha.slice(0, 16)}… 对照 .sha256 ${ok ? '一致' : '不一致!'}`);
    if (!ok && !ALLOW_MISMATCH) throw Object.assign(new Error('归档 sha256 与 .sha256 旁文件不一致'), { code: 2 });
  } else {
    add('归档 sha256', 'PASS', `${aSha.slice(0, 16)}…（${bytesFmt(aBytes)}，无 .sha256 旁文件，跳过对照）`);
  }

  // ---------- 2) 解包 ----------
  const isDbGz = /\.db\.gz$/i.test(archive);
  let manifest = null, snapPath = null;

  if (isDbGz) {
    const manPath = archive.replace(/\.db\.gz$/i, '.manifest.json');
    if (!fs.existsSync(manPath)) throw Object.assign(new Error(`dbgz 备份缺少旁置 manifest: ${manPath}`), { code: 2 });
    manifest = JSON.parse(fs.readFileSync(manPath, 'utf8'));
    snapPath = path.join(staging, 'hive.db');
    fs.writeFileSync(snapPath, zlib.gunzipSync(fs.readFileSync(archive)));
    add('解包(dbgz)', 'PASS', `node:zlib 解压 → ${bytesFmt(fs.statSync(snapPath).size)}`);
  } else {
    const r = spawnSync('tar', ['-x', '-f', archive, '-C', staging], { encoding: 'utf8', windowsHide: true, timeout: 600000 });
    if (r.error) throw Object.assign(new Error(`解包失败: ${r.error.message}`), { code: 1 });
    if (r.status !== 0) throw Object.assign(new Error(`tar 解包退出码 ${r.status}: ${(r.stderr || '').slice(0, 400)}`), { code: 1 });
    // manifest 可能在根或一层目录下
    const findFile = (dir, name, depth = 0) => {
      const hit = path.join(dir, name);
      if (fs.existsSync(hit)) return hit;
      if (depth > 2) return null;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const got = findFile(path.join(dir, e.name), name, depth + 1);
        if (got) return got;
      }
      return null;
    };
    const manPath = findFile(staging, 'manifest.json');
    snapPath = findFile(staging, 'hive.db');
    if (!manPath || !snapPath) throw Object.assign(new Error('包里找不到 manifest.json / hive.db（不是 HIVE 备份？）'), { code: 2 });
    manifest = JSON.parse(fs.readFileSync(manPath, 'utf8'));
    add('解包(tar)', 'PASS', `manifest schema=${manifest.schema} 解出 hive.db ${bytesFmt(fs.statSync(snapPath).size)}`);
  }

  // ---------- 3) db sha256 校验（核心） ----------
  const wantSha = manifest?.db?.sha256;
  const gotSha = sha256File(snapPath);
  const shaOk = wantSha === gotSha;
  add('db sha256', shaOk || ALLOW_MISMATCH ? 'PASS' : 'FAIL',
    shaOk ? `${gotSha.slice(0, 24)}… 与 manifest 一致` : `manifest=${String(wantSha).slice(0, 24)}… 实际=${gotSha.slice(0, 24)}… ${ALLOW_MISMATCH ? '(已 --allow-mismatch 放行)' : ''}`);
  if (!shaOk && !ALLOW_MISMATCH) throw Object.assign(new Error('db sha256 校验失败——备份已损坏或被改过'), { code: 2 });

  // ---------- 4) 试开库 + 与 manifest 行数对照 ----------
  const probe = tableCounts(snapPath);
  add('快照 integrity', probe.integrity === 'ok' ? 'PASS' : 'FAIL', `integrity_check=${probe.integrity}`);
  if (probe.integrity !== 'ok' && !ALLOW_MISMATCH) throw Object.assign(new Error('快照本身 integrity_check 不通过'), { code: 2 });
  const mTables = manifest?.tables || {};
  const diffs = Object.keys(mTables).filter((t) => (probe.counts[t] ?? -1) !== mTables[t]);
  add('快照行数', diffs.length ? 'WARN' : 'PASS',
    diffs.length ? `与 manifest 不符: ${diffs.map((t) => `${t} ${probe.counts[t]}≠${mTables[t]}`).join(', ')}` : '与 manifest 逐表一致');
  const liveBefore = fs.existsSync(targetDb) ? (() => { try { return tableCounts(targetDb).counts; } catch { return null; } })() : null;

  // ---------- 5) 守护进程检查 ----------
  const lock = lockAlive();
  if (lock && !FORCE && !DRY && targetDb === path.resolve(cfg.resolved.db)) {
    add('守护进程', 'FAIL', `daemon 还在跑 (pid=${lock.pid})，拒绝覆盖；先 node scripts/hive.mjs ... 停掉，或加 --force`);
    throw Object.assign(new Error('守护进程运行中'), { code: 2 });
  }
  add('守护进程', lock ? 'WARN' : 'PASS', lock ? `pid=${lock.pid} 在跑${FORCE ? '（--force 强行继续）' : ''}` : '未运行，可安全覆盖');

  // ---------- 6) dry-run 到此为止 ----------
  if (DRY) {
    add('模式', 'PASS', '--dry-run：已完成解包/校验/试开库，未改动任何文件');
    const elapsed = Date.now() - t0;
    finish(0, { ok: true, dryRun: true, archive, sha256: aSha, target: targetDb, manifest: manifest?.db, snapshotTables: probe.counts, elapsedMs: elapsed });
  }

  // ---------- 7) 覆盖前询问 ----------
  if (!YES) {
    if (!process.stdin.isTTY) {
      add('确认', 'FAIL', '非交互环境且未传 --yes —— 不敢自动覆盖，已中止');
      throw Object.assign(new Error('需要 --yes 才能非交互覆盖'), { code: 2 });
    }
    const ans = await new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`\n即将用快照覆盖 ${targetDb}\n（当前库${liveBefore ? `有 ${Object.entries(liveBefore).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(' ') || '全空'}` : '不存在'}）\n输入 yes 继续，其它任意键中止: `, (a) => { rl.close(); resolve(a.trim().toLowerCase()); });
    });
    if (ans !== 'yes' && ans !== 'y') {
      add('确认', 'PASS', '用户取消，未改动任何文件');
      finish(0, { ok: false, cancelled: true, archive, target: targetDb });
    }
    add('确认', 'PASS', '用户输入 yes');
  } else {
    add('确认', 'PASS', '--yes 跳过交互');
  }

  // ---------- 8) 另存现场 ----------
  if (SAFETY && fs.existsSync(targetDb)) {
    const bdir = path.join(cfg.home, 'data', 'backups');
    fs.mkdirSync(bdir, { recursive: true });
    const stem = path.join(bdir, `pre-restore-${tsStamp()}.db`);
    fs.copyFileSync(targetDb, stem);
    let extra = 0;
    for (const suf of ['-wal', '-shm']) {
      if (fs.existsSync(targetDb + suf)) { fs.copyFileSync(targetDb + suf, stem + suf); extra++; }
    }
    add('现场另存', 'PASS', `${path.basename(stem)} (+${extra} 个 WAL 文件)`);
  } else if (SAFETY) {
    add('现场另存', 'SKIP', '目标库不存在，无需另存');
  } else {
    add('现场另存', 'WARN', '已按 --no-safety-backup 跳过');
  }

  // ---------- 9) 覆盖 ----------
  fs.mkdirSync(path.dirname(targetDb), { recursive: true });
  fs.copyFileSync(snapPath, targetDb);
  let removedWal = 0;
  for (const suf of ['-wal', '-shm']) {
    const p = targetDb + suf;
    if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); removedWal++; }
  }
  add('覆盖 db', 'PASS', `${targetDb} ← 快照${removedWal ? `，清掉旧 -wal/-shm ${removedWal} 个` : ''}`);

  // ---------- 10) 可选：配置回填 ----------
  if (WITH_CONFIG) {
    const cfgDir = path.join(staging, 'config');
    if (fs.existsSync(cfgDir)) {
      const homeCfg = path.join(cfg.home, 'config');
      for (const f of fs.readdirSync(cfgDir)) {
        const dst = path.join(homeCfg, f);
        if (fs.existsSync(dst)) fs.copyFileSync(dst, dst + '.bak-' + tsStamp());
        fs.copyFileSync(path.join(cfgDir, f), dst);
      }
      add('配置回填', 'PASS', `${fs.readdirSync(cfgDir).join(', ')} → config/（原文件已 .bak 备份）`);
    } else add('配置回填', 'WARN', '包里没有 config/（用 --format dbgz 打包时不会带）');
  }

  // ---------- 11) 复核 ----------
  const after = tableCounts(targetDb);
  add('复核 integrity', after.integrity === 'ok' ? 'PASS' : 'FAIL', `integrity_check=${after.integrity}`);
  const mismatch = Object.keys(probe.counts).filter((t) => (after.counts[t] ?? -1) !== probe.counts[t]);
  add('复核行数', mismatch.length ? 'FAIL' : 'PASS',
    mismatch.length ? `不一致: ${mismatch.map((t) => `${t} ${after.counts[t]}≠${probe.counts[t]}`).join(', ')}` : `${Object.keys(probe.counts).length} 张表逐表一致`);

  if (!JSONOUT && liveBefore) {
    console.log('\n覆盖前后对照:');
    const keys = [...new Set([...Object.keys(liveBefore), ...Object.keys(after.counts)])].sort();
    console.log('  表'.padEnd(16) + '覆盖前'.padStart(8) + '覆盖后'.padStart(8) + 'manifest'.padStart(10));
    for (const k of keys) {
      console.log('  ' + k.padEnd(14) + String(liveBefore[k] ?? '-').padStart(8) + String(after.counts[k] ?? '-').padStart(8) + String(mTables[k] ?? '-').padStart(10));
    }
  }

  const ok = after.integrity === 'ok' && !mismatch.length;
  finish(ok ? 0 : 1, {
    ok, archive, sha256: aSha, target: targetDb, elapsedMs: Date.now() - t0,
    before: liveBefore, after: after.counts, manifestTables: mTables,
    rows,
  });
} catch (e) {
  exitCode = e.code === 2 ? 2 : 1;
  if (JSONOUT) console.log(JSON.stringify({ ok: false, error: String(e.message), exitCode, rows }, null, 2));
  else console.error(`\n✗ 恢复失败: ${e.message}`);
  process.exitCode = exitCode;
} finally {
  try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
}

function finish(code, payload) {
  exitCode = code;
  if (JSONOUT) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log('-'.repeat(96));
    console.log(code === 0 ? `✓ 恢复${payload.dryRun ? '校验' : ''}完成（${payload.elapsedMs ?? 0}ms）` : `✗ 恢复完成但有异常，退出码 ${code}`);
    if (!payload.dryRun && payload.ok) console.log('  下一步: node --no-warnings scripts/healthcheck.mjs && node --no-warnings scripts/hive.mjs doctor');
  }
  process.exit(code);
}
