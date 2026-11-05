// src/server/setup.mjs — 自检（doctor）与 Agent 依赖版本管理
//
// 设计边界（与 api.mjs 的降级约定一致）：
//  · 只读 core/db.mjs；唯一的写是 kv（自检探针键 + registry 元数据缓存），
//    不碰 items / tasks / approvals 三张表。
//  · 【绝不自动安装】：所有 install / uninstall / update / 降级都必须由用户点击触发。
//    本模块只提供「探测 → 生成命令 → 执行 → 复检」四步，不主动跑任何一次。
//  · 只走 npm registry + child_process，不引任何第三方依赖。
//  · registry 查询：先 https://registry.npmjs.org（scoped 包 / 编码成 %2f），
//    单个请求硬超时 12s；npmjs 直连在本机会被限速（实测 codex 元数据 5.4MB / 63s），
//    所以失败后回落到本机 npm 配置的 registry（npm config get registry，通常是国内镜像）。
//    两条都不通就如实返回 error，绝不编版本号。
//  · 安装/卸载命令：npm install -g <pkg>@<version> / npm uninstall -g <pkg>，超时 300s。
//    Windows 下 npm 是 .cmd 垫片，必须经 cmd.exe /c（裸名 spawn 会 EINVAL/ENOENT）。
//  · 结果里同时给 before / after 版本，前端能看到「真的变了」。
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { execFile } from 'node:child_process';

import { q, kvGet, kvSet } from '../core/db.mjs';

const nowIso = () => new Date().toISOString();

// ───────────────────────────── 依赖登记表（唯一事实源）─────────────────────────────

/**
 * 只有这里登记的依赖允许「一键安装」。
 *  probeKey   → executors.probe() 返回体里的键（复用它，避免重复 spawn）
 *  channelKey → channelsInfo() 返回体里的键（agently-cli 走通道探测）
 *  manual     → 只检测 + 给引导，不执行安装
 */
export const DEPENDENCIES = {
  nodejs: {
    id: 'nodejs',
    label: 'Node.js 运行时',
    command: 'node',
    versionArgs: ['-v'],
    probeKey: 'node',
    pkg: null,
    manual: true,
    required: true,
    guide: [
      '安装 LTS（>= 22.5，node:sqlite 才是内置模块）：https://nodejs.org/',
      '或 winget install OpenJS.NodeJS.LTS（或 choco install nodejs-lts）',
      '装完重启 HIVE 进程（看板服务本身就跑在 Node 上）',
    ],
    note: 'Node 是运行时底座，绝不通过 npm 全局安装（会与系统 Node 打架）。',
  },
  'dsh-cli': {
    id: 'dsh-cli',
    label: 'DSH CLI',
    command: 'dsh',
    versionArgs: ['--version'],
    probeKey: 'dsh',
    pkg: '@deepseek-ai/dsh',
    required: true,
    note: 'L4/L5 默认执行器（dsh --profile headless）',
  },
  'pi-cli': {
    id: 'pi-cli',
    label: 'Pi CLI',
    command: 'pi',
    versionArgs: ['--version'],
    probeKey: 'pi',
    pkg: '@earendil-works/pi-coding-agent',
    required: false,
    note: 'pi 执行器（-p --mode json）',
  },
  'codex-cli': {
    id: 'codex-cli',
    label: 'Codex CLI',
    command: 'codex',
    versionArgs: ['--version'],
    probeKey: 'codex',
    pkg: '@openai/codex',
    required: false,
    note: 'codex 执行器（exec --skip-git-repo-check）',
  },
  'claude-cli': {
    id: 'claude-cli',
    label: 'Claude Code CLI',
    command: 'claude',
    versionArgs: ['--version'],
    probeKey: 'claude',
    pkg: '@anthropic-ai/claude-code',
    required: false,
    note: 'claude 执行器（-p）；需要先在 CLI 里完成登录，本模块不代办登录',
  },
  'agently-cli': {
    id: 'agently-cli',
    label: 'Agently CLI（QQ 邮箱通道）',
    command: 'agently-cli',
    versionArgs: ['--version'],
    channelKey: 'agentlyCli',
    pkg: '@tencent-qqmail/agently-cli',
    required: false,
    note: 'mail 传感器的通道；授权登录需人工执行 agently-cli login',
  },
};

export const INSTALL_IDS = Object.keys(DEPENDENCIES);

// ───────────────────────────── 小工具 ─────────────────────────────

function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0 B';
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
  return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function execAsync(cmd, args, timeout = 8000, extra = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      execFile(cmd, args, {
        encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 8 << 20, ...extra,
      }, (err, stdout, stderr) => {
        finish({
          err,
          ok: !err,
          code: err && typeof err.code === 'number' ? err.code : (err ? null : 0),
          timedOut: !!(err && (err.killed || err.signal === 'SIGTERM')),
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      });
    } catch (e) {
      finish({ err: e, ok: false, code: null, timedOut: false, stdout: '', stderr: String(e && e.message) });
    }
  });
}

async function which(cmd) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const r = await execAsync(finder, [cmd], 5000);
  const first = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null;
  return { ok: r.ok && !!first, path: first, error: r.err ? String(r.err.message).split('\n')[0] : null };
}

async function commandVersion(cmd, args = ['--version']) {
  const r = await execAsync(cmd, args, 8000);
  const out = String(r.stdout || r.stderr || '').trim().split(/\r?\n/).filter(Boolean)[0] || null;
  return { ok: r.ok, version: out, error: r.err ? String(r.err.message).split('\n')[0] : null };
}

/** 守护进程锁文件（与 scripts/hive.mjs 同一约定：<home>/data/hive.lock）*/
export function readDaemonLock(cfg) {
  const lockPath = path.join(cfg?.home || process.cwd(), 'data', 'hive.lock');
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { raw = null; }
  const pid = Number(raw?.pid) || null;
  let alive = false;
  if (pid) { try { process.kill(pid, 0); alive = true; } catch { alive = false; } }
  return {
    running: alive,
    pid: alive ? pid : null,
    startedAt: alive ? (raw?.startedAt ?? null) : null,
    stale: !!raw && !alive,
    rawPid: pid,
    lockPath,
  };
}

// ───────────────────────────── 依赖检测 / 安装 ─────────────────────────────

/**
 * 探测一个依赖是否可用。
 * 优先复用外部已做的探测结果（executors.probe / channels），避免重复 spawn；
 * 缺失时再自己 which + --version 兜底。
 */
export async function detectDependency(id, { probe, channels } = {}) {
  const dep = DEPENDENCIES[id];
  if (!dep) return { ok: false, path: null, version: null, error: `未知依赖: ${id}`, source: 'none' };

  const key = dep.channelKey || dep.probeKey;
  const pack = dep.channelKey ? channels?.[key] : probe?.probes?.[key];
  if (pack && typeof pack.ok === 'boolean') {
    return {
      ok: !!pack.ok,
      path: pack.path ?? null,
      version: pack.version ?? null,
      error: pack.ok ? null : (pack.reason || pack.error || `${dep.command} 不可用`),
      source: dep.channelKey ? 'channel' : 'probe',
    };
  }

  const w = await which(dep.command);
  if (!w.ok) {
    return { ok: false, path: null, version: null, error: w.error || `${dep.command} 不在 PATH 中`, source: 'which' };
  }
  const v = await commandVersion(dep.command, dep.versionArgs);
  return { ok: v.ok, path: w.path, version: v.version, error: v.ok ? null : v.error, source: 'version' };
}

/** npm 全局安装的 argv（Windows 必须经 cmd.exe，Node 24 不允许直接 spawn .cmd）*/
function npmInstallSpec(pkg) {
  const text = `npm install -g ${pkg} --no-fund --no-audit`;
  if (process.platform === 'win32') {
    return { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', text], text };
  }
  return { cmd: 'npm', args: ['install', '-g', pkg, '--no-fund', '--no-audit'], text };
}

/**
 * 安装一个缺失依赖：检测 →（必要时）npm 全局安装 → 复检。
 * 返回 { ok, already, cmd, argv, stdout, stderr, verified, ... }，永不抛。
 */
export async function installDependency({ cfg, id, probe, channels, timeoutMs = 180000 } = {}) {
  const dep = DEPENDENCIES[id];
  if (!dep) {
    return {
      ok: false, id: String(id ?? ''), code: 'BAD_ID', installable: false,
      reason: `不支持的安装目标: ${id || '(空)'}；可用: ${INSTALL_IDS.join(', ')}`,
      allowed: INSTALL_IDS,
    };
  }

  const before = await detectDependency(id, { probe, channels });
  if (before.ok) {
    return {
      ok: true, id, label: dep.label, already: true, installed: false, installable: true,
      needManual: false, cmd: null, argv: null, stdout: '', stderr: '', ms: 0,
      detected: before, verified: before,
      note: `已安装（${before.version || before.path || '检测通过'}），未执行任何安装命令`,
    };
  }

  if (dep.manual) {
    return {
      ok: false, id, label: dep.label, already: false, installed: false, installable: false,
      needManual: true, cmd: null, argv: null, stdout: '', stderr: '', ms: 0,
      detected: before, verified: before,
      guide: dep.guide || [],
      reason: `「${dep.label}」只检测不自动安装（避免破坏运行时），请按引导手动安装`,
      note: dep.note || null,
    };
  }

  const spec = npmInstallSpec(dep.pkg);
  const t0 = Date.now();
  const r = await execAsync(spec.cmd, spec.args, timeoutMs);
  const ms = Date.now() - t0;

  // 复检：不吃外部缓存，直接 which + --version
  const after = await detectDependency(id, {});
  const installed = !!after.ok;
  return {
    ok: installed,
    id, label: dep.label, already: false, installed, installable: true, needManual: false,
    cmd: spec.text,
    argv: [spec.cmd, ...spec.args],
    stdout: (r.stdout || '').slice(-6000),
    stderr: (r.stderr || '').slice(-6000),
    exitCode: r.code,
    timedOut: !!r.timedOut,
    timeoutMs, ms,
    detected: before,
    verified: after,
    note: installed
      ? '安装成功，已重新检测到命令'
      : (r.timedOut
        ? `安装超时（>${Math.round(timeoutMs / 1000)}s）：可能是网络/代理问题，可手动重试或配 npm 镜像`
        : 'npm 执行结束但未检测到命令：可能需要重开终端或重启 HIVE（PATH 缓存），也可能安装目录不在 PATH'),
  };
}

// ───────────────────────────── 自检报告 ─────────────────────────────

const EXPECTED_TABLES = [
  'cursors', 'items', 'tasks', 'runs', 'artifacts',
  'approvals', 'events', 'pulses', 'context_facts', 'kv',
];

const RUNTIME_PROBE_NAMES = new Set(['node', 'pwsh']);

function worstStatus(items) {
  if (items.some((i) => i.status === 'FAIL')) return 'FAIL';
  if (items.some((i) => i.status === 'WARN')) return 'WARN';
  return 'PASS';
}

/**
 * 生成自检报告。
 * @param {{cfg:object, probe:object, channels:object, budget:object, dbStats?:object, server?:object}} input
 */
export async function doctorReport({ cfg, probe, channels, budget, dbStats, server } = {}) {
  const items = [];
  const push = (item) => { items.push({ fix: null, install: null, ...item }); return item; };

  // ── 1. Node 版本 ───────────────────────────────────────────────
  const nodeVer = String(process.versions.node || '0.0.0');
  const [maj, min] = nodeVer.split('.').map((x) => Number(x) || 0);
  const nodeOk = maj > 22 || (maj === 22 && min >= 5);
  push({
    id: 'node', group: 'core', title: 'Node.js 运行时',
    status: nodeOk ? 'PASS' : 'FAIL',
    detail: `v${nodeVer} · ${process.platform}/${process.arch} · pid ${process.pid}`,
    fix: nodeOk ? null : '升级到 Node >= 22.5（node:sqlite 是内置模块，低于此版本整个数据层不可用）',
    install: nodeOk ? null : 'nodejs',
    versions: true,
  });

  // ── 2. node:sqlite ────────────────────────────────────────────
  let sqlite = { ok: false, version: process.versions.sqlite || null, error: null };
  try {
    const m = await import('node:sqlite');
    sqlite.ok = typeof m.DatabaseSync === 'function';
  } catch (e) {
    sqlite.error = e && e.message ? e.message : String(e);
  }
  push({
    id: 'sqlite', group: 'core', title: 'node:sqlite 内置模块',
    status: sqlite.ok ? 'PASS' : 'FAIL',
    detail: sqlite.ok
      ? `SQLite ${sqlite.version || '?'} · DatabaseSync 可用（零外部依赖）`
      : `不可用：${sqlite.error || 'DatabaseSync 未导出'}`,
    fix: sqlite.ok ? null : '需要 Node >= 22.5；旧版本可用 --experimental-sqlite 启动（不推荐）',
    install: sqlite.ok ? null : 'nodejs',
  });

  // ── 3. 数据库可写（真写一个探针键再回读）────────────────────────
  const dbPath = cfg?.resolved?.db || '(未配置)';
  const wr = { ok: false, error: null, ms: 0 };
  const tW = Date.now();
  try {
    kvSet('setup.probe', { at: nowIso(), pid: process.pid });
    const back = kvGet('setup.probe', null);
    wr.ok = !!back && typeof back === 'object' && back.pid === process.pid;
    if (!wr.ok) wr.error = '写入后回读不一致';
  } catch (e) {
    wr.error = e && e.message ? e.message : String(e);
  }
  wr.ms = Date.now() - tW;
  let dbSize = 0;
  try { dbSize = fs.statSync(dbPath).size; } catch { dbSize = 0; }
  push({
    id: 'db-writable', group: 'core', title: '数据库可写',
    status: wr.ok ? 'PASS' : 'FAIL',
    detail: wr.ok ? `${dbPath} · ${fmtBytes(dbSize)} · 写入回读 ${wr.ms}ms` : `不可写：${wr.error}`,
    fix: wr.ok ? null : '检查 data/ 目录权限与磁盘空间；也可用 HIVE_HOME 指向可写目录',
  });

  // ── 4. 表齐全 ─────────────────────────────────────────────────
  let have = [];
  let tableErr = null;
  try {
    have = q.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
  } catch (e) { tableErr = e && e.message ? e.message : String(e); }
  const missing = EXPECTED_TABLES.filter((t) => !have.includes(t));
  push({
    id: 'tables', group: 'core', title: '数据表齐全',
    status: tableErr ? 'FAIL' : (missing.length ? 'FAIL' : 'PASS'),
    detail: tableErr ? `读取 sqlite_master 失败：${tableErr}`
      : `已建 ${have.length} 张表${missing.length ? ` · 缺 ${missing.join(', ')}` : '（10/10 必需表齐全）'}`,
    fix: (tableErr || missing.length)
      ? '先备份 data/hive.db，再让服务重建表（删除库后下次启动会按 SCHEMA 建表）；或从备份恢复'
      : null,
    missing_tables: missing,
  });

  // ── 5. 执行器探活 ─────────────────────────────────────────────
  const probes = Object.entries(probe?.probes || {});
  const execProbes = probes.filter(([n]) => !RUNTIME_PROBE_NAMES.has(n));
  const okNames = execProbes.filter(([, v]) => v && v.ok).map(([n]) => n);
  const badNames = execProbes.filter(([, v]) => !(v && v.ok)).map(([n]) => n);
  const execStatus = !probe?.ready ? 'FAIL' : (okNames.length === 0 ? 'FAIL' : (badNames.length ? 'WARN' : 'PASS'));
  push({
    id: 'executors', group: 'core', title: '执行器探活',
    status: execStatus,
    detail: probe?.ready
      ? `可用 ${okNames.length}/${execProbes.length}：${okNames.join(', ') || '—'}${badNames.length ? ` · 不可用：${badNames.join(', ')}` : ''}`
      : `执行器注册表未就绪：${probe?.reason || '未知'}${probe?.detail ? '（' + probe.detail + '）' : ''}`,
    fix: execStatus === 'PASS' ? null
      : (!probe?.ready
        ? '检查 src/executors/index.mjs 是否存在且导出 probe()'
        : `补齐执行器 CLI（${badNames.join(', ') || '无'}），或在 config/hive.json 关闭不用的执行器`),
  });

  // ── 6. 外部通道 ───────────────────────────────────────────────
  const chans = Object.entries(channels || {});
  const requiredChans = ['git', 'pwsh'];
  const missingChan = requiredChans.filter((n) => !channels?.[n]?.ok);
  let chanStatus = 'PASS';
  if (!chans.length) chanStatus = 'WARN';
  else if (missingChan.length) chanStatus = 'FAIL';
  else if (chans.some(([, c]) => !c || !c.ok)) chanStatus = 'WARN';
  push({
    id: 'channels', group: 'core', title: '外部通道',
    status: chanStatus,
    detail: chans.length
      ? chans.map(([n, c]) => `${n}:${c && c.ok ? 'ok' : '缺失'}`).join(' · ')
      : '通道探测未返回（channelsInfo 不可用）',
    fix: chanStatus === 'PASS' ? null
      : `补齐必需通道（${missingChan.join(', ') || '见明细'}）；git 供 git 传感器、pwsh 供 shell 执行器`,
  });

  // ── 7. 磁盘 ───────────────────────────────────────────────────
  let free = null;
  let diskErr = null;
  try {
    const s = fs.statfsSync(cfg?.home || process.cwd());
    free = Number(s.bavail) * Number(s.bsize);
  } catch (e) { diskErr = e && e.message ? e.message : String(e); }
  const diskStatus = free == null ? 'WARN' : (free < 200 * 1024 * 1024 ? 'FAIL' : (free < 1024 * 1024 * 1024 ? 'WARN' : 'PASS'));
  push({
    id: 'disk', group: 'core', title: '磁盘空间',
    status: diskStatus,
    detail: free == null ? `无法读取磁盘信息：${diskErr || '未知'}` : `${cfg?.home || process.cwd()} 可用 ${fmtBytes(free)}`,
    fix: diskStatus === 'PASS' ? null : '清理 data/runs、data/logs 旧产物（scripts/backup.mjs 可先备份再清理）',
  });

  // ── 8. 预算 ───────────────────────────────────────────────────
  const budgetCfg = Number(cfg?.settings?.dailyBudgetCny) || 0;
  const spent = Number(budget?.costCny) || 0;
  const ratio = budgetCfg > 0 ? spent / budgetCfg : 0;
  const warnRatio = Number(cfg?.settings?.budgetWarnRatio) || 0.8;
  const budgetStatus = !budgetCfg ? 'WARN' : (ratio >= 1 ? 'FAIL' : (ratio >= warnRatio ? 'WARN' : 'PASS'));
  push({
    id: 'budget', group: 'core', title: '今日预算',
    status: budgetStatus,
    detail: budgetCfg
      ? `¥${spent.toFixed(4)} / ¥${budgetCfg}（${Math.round(ratio * 100)}%）· tokens ${Number(budget?.tokensIn) || 0}/${Number(budget?.tokensOut) || 0}`
      : `今日 ¥${spent.toFixed(4)}，但 settings.dailyBudgetCny 未配置（无预算护栏）`,
    fix: budgetStatus === 'PASS' ? null
      : (!budgetCfg
        ? '在 config/hive.json 的 settings.dailyBudgetCny 配置日预算'
        : '调高 dailyBudgetCny，或把派单模型降到 cheap tier；超预算时守护进程会暂停派单'),
  });

  // ── 9. 守护进程 ───────────────────────────────────────────────
  const daemon = readDaemonLock(cfg);
  push({
    id: 'daemon', group: 'core', title: '守护进程',
    status: daemon.running ? 'PASS' : 'WARN',
    detail: daemon.running
      ? `运行中 · pid=${daemon.pid}${daemon.startedAt ? ' · since ' + daemon.startedAt : ''}`
      : (daemon.stale
        ? `未运行（发现残留锁文件 pid=${daemon.rawPid}，进程已不在）`
        : '未运行（看板可单独使用，但巡检/派发/看门狗不会跑）'),
    fix: daemon.running
      ? null
      : '启动：node --no-warnings scripts/hive.mjs daemon；或在看板「自动任务」页点「启动守护进程」；也可由 DSH 插件托管',
    meta: { pid: daemon.pid, lockPath: daemon.lockPath, stale: daemon.stale },
  });

  // ── 10. 依赖 CLI（可一键安装）─────────────────────────────────
  const deps = [];
  for (const dep of Object.values(DEPENDENCIES)) {
    let det;
    try { det = await detectDependency(dep.id, { probe, channels }); }
    catch (e) { det = { ok: false, path: null, version: null, error: String(e && e.message ? e.message : e), source: 'error' }; }
    const installable = !det.ok && !dep.manual;
    deps.push({
      id: dep.id, label: dep.label, command: dep.command, pkg: dep.pkg,
      manual: !!dep.manual, required: !!dep.required,
      ok: !!det.ok, path: det.path || null, version: det.version || null,
      error: det.error || null, source: det.source || null,
      installable, guide: !det.ok && dep.manual ? (dep.guide || []) : undefined,
    });
    push({
      id: 'dep:' + dep.id,
      group: 'deps',
      title: dep.label,
      status: det.ok ? 'PASS' : 'WARN',
      detail: det.ok
        ? `${det.version || '已安装'}${det.path ? ' · ' + det.path : ''}`
        : `未检测到：${det.error || dep.command + ' 不在 PATH 中'}`,
      fix: det.ok ? null
        : (dep.manual
          ? (dep.guide || []).join(' ／ ')
          : `点「一键安装」执行 npm install -g ${dep.pkg}`),
      install: installable ? dep.id : null,
      installable,
      guide: !det.ok && dep.manual ? (dep.guide || []) : undefined,
      meta: { command: dep.command, pkg: dep.pkg, note: dep.note || null, required: !!dep.required },
    });
  }

  const summary = {
    pass: items.filter((i) => i.status === 'PASS').length,
    warn: items.filter((i) => i.status === 'WARN').length,
    fail: items.filter((i) => i.status === 'FAIL').length,
    total: items.length,
    depsOk: deps.filter((d) => d.ok).length,
    depsTotal: deps.length,
  };

  let stats = dbStats || null;
  if (!stats) { try { stats = { error: '未传入' }; } catch { /* noop */ } }

  return {
    ok: summary.fail === 0,
    status: worstStatus(items),
    time: nowIso(),
    summary,
    items,
    deps,
    installable: INSTALL_IDS.filter((id) => !DEPENDENCIES[id].manual),
    env: {
      home: cfg?.home || null,
      codeRoot: cfg?.codeRoot || null,
      dbPath,
      dbSizeBytes: dbSize,
      node: nodeVer,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      server: server ? { port: server.port ?? null, host: server.host ?? null } : null,
      daemon,
      dbStats: stats,
    },
  };
}

// ═══════════════════════ 可选 Agent 依赖（版本管理）═══════════════════════
//
// 与上面 DEPENDENCIES（自检用的「通道/CLI 是否可用」）区别：
//  · DEPENDENCIES 回答「现在能不能用」，用于 doctor 的 PASS/WARN。
//  · AGENT_DEPS 回答「装了没 / 是什么版本 / 能不能升级降价 / 要不要卸载」，
//    并且是唯一允许用户点击执行 install / uninstall / update 的白名单。
//  · 同样【绝不自动安装】：本模块只生成并执行「用户点了那一下」对应的命令。

export const AGENT_DEPS = [
  {
    id: 'dsh',
    name: 'DSH',
    pkg: '@deepseek-ai/dsh',
    command: 'dsh',
    required: true,
    purpose: 'DSH（DeepSeek Harness）本体：L4/L5 默认执行器，长任务 / 多工具任务最稳的一条路。',
    fallback: '卸载后 L4/L5 无法派单，只能退回 llm 内联（长任务会降级成「建议」而不是真去干）。',
    docsUrl: 'https://www.npmjs.com/package/@deepseek-ai/dsh',
    risk: '升级可能改变 --profile headless 的参数或输出格式；升级后建议跑一次 tests/exec-smoke.mjs。',
  },
  {
    id: 'pi',
    name: 'Pi',
    pkg: '@earendil-works/pi-coding-agent',
    command: 'pi',
    required: false,
    purpose: '编码 Agent（pi CLI）：能在任务工作目录里读写文件、跑命令，是真改代码的执行器。',
    fallback: '不装不影响主链路；需要真改代码的 L4 任务会退化为 llm 出方案。',
    docsUrl: 'https://www.npmjs.com/package/@earendil-works/pi-coding-agent',
    risk: '大版本升级可能改变 --mode json 的输出结构（parseResult 解析失败会记 run 失败，不静默）。',
  },
  {
    id: 'codex',
    name: 'Codex',
    pkg: '@openai/codex',
    command: 'codex',
    required: false,
    purpose: '编码 Agent（OpenAI Codex CLI）：另一条编码 / 审阅路径（exec --skip-git-repo-check）。',
    fallback: '不可用时路由自动跳过它；本机当前账户余额不足会 402，属于账户问题而非安装问题。',
    docsUrl: 'https://www.npmjs.com/package/@openai/codex',
    risk: '升级后需重新确认账户/网络可用；402 与安装无关。',
  },
  {
    id: 'claude',
    name: 'Claude Code',
    pkg: '@anthropic-ai/claude-code',
    command: 'claude',
    required: false,
    purpose: '编码 Agent（Claude Code CLI）：长上下文代码任务，-p 非交互模式。',
    fallback: '不装则 L4/L5 回到 dsh；装了也需要先在 CLI 内登录（本系统不代办登录）。',
    docsUrl: 'https://www.npmjs.com/package/@anthropic-ai/claude-code',
    risk: '升级后若 token 失效会返回 401；CLI 自身重试约 197s，在 90s 超时下表现为「超时」。',
  },
  {
    id: 'agently',
    name: 'Agently（QQ 邮箱）',
    pkg: '@tencent-qqmail/agently-cli',
    command: 'agently-cli',
    required: false,
    purpose: 'QQ 邮件通道（agently-cli）：mail 传感器读邮件、HITL 发通知都靠它。',
    fallback: '不装则 mail 传感器静默 0 条（不报错），邮件类信息不会进收件箱。',
    docsUrl: 'https://www.npmjs.com/package/@tencent-qqmail/agently-cli',
    risk: '升级后可能需要重新 agently-cli login（授权态在本地配置里，不在 npm 包里）。',
  },
];

export const AGENT_DEPS_BY_ID = Object.fromEntries(AGENT_DEPS.map((d) => [d.id, d]));

// registry 默认走 npmjs；HIVE_NPM_REGISTRY 可覆盖（例如国内直连慢时指定镜像）。
// scoped 包路径把 / 编码成 %2f。
const NPMJS = (() => {
  const raw = String(process.env.HIVE_NPM_REGISTRY || 'https://registry.npmjs.org/').trim();
  const base = /^https?:\/\//i.test(raw) ? raw : 'https://registry.npmjs.org/';
  return base.replace(/\/+$/, '') + '/';
})();
const META_TTL_MS = 10 * 60 * 1000;
const REGISTRY_TIMEOUT_MS = 12000;
const MAX_META_BYTES = 16 * 1024 * 1024;
const KV_META_KEY = 'deps.registry.v1';

const _meta = {
  byPkg: new Map(),        // pkg -> { at, value }
  usedRegistry: null,      // 'npmjs' | 'configured'
  primaryFailedAt: 0,      // npmjs 直连失败时间（10 分钟内不再重试，避免每次等 12s）
  configured: null,        // { at, url }
  loaded: false,
};

/** scoped 包：@scope/name → @scope%2fname */
function encodePkg(pkg) {
  return encodeURIComponent(pkg).replace(/%2F/g, '%2f');
}

function primaryCoolingDown() {
  return _meta.primaryFailedAt > 0 && Date.now() - _meta.primaryFailedAt < META_TTL_MS;
}

/** 极简 semver 比较：a<b 返回 -1，a>b 返回 1；预发布版 < 正式版 */
export function compareVersions(a, b) {
  const parse = (v) => {
    const clean = String(v || '').trim().replace(/^v/i, '').split('+')[0];
    const [core, pre] = clean.split('-');
    const nums = core.split('.').map((x) => Number.parseInt(x, 10) || 0);
    while (nums.length < 3) nums.push(0);
    return { nums: nums.slice(0, 3), pre: pre ? pre.split('.') : [] };
  };
  const A = parse(a);
  const B = parse(b);
  for (let i = 0; i < 3; i++) {
    if (A.nums[i] !== B.nums[i]) return A.nums[i] < B.nums[i] ? -1 : 1;
  }
  if (!A.pre.length && !B.pre.length) return 0;
  if (!A.pre.length) return 1;
  if (!B.pre.length) return -1;
  const n = Math.max(A.pre.length, B.pre.length);
  for (let i = 0; i < n; i++) {
    const x = A.pre[i];
    const y = B.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) { if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1; }
    else if (xn !== yn) return xn ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** npm 命令 → 可执行 argv（Windows 必须经 cmd.exe，裸 npm.cmd 在 Node 24 会 EINVAL） */
function npmSpec(text) {
  if (process.platform === 'win32') {
    return { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', text], text };
  }
  const parts = text.split(' ').filter(Boolean);
  return { cmd: parts[0], args: parts.slice(1), text };
}

function httpJson(url, timeoutMs = REGISTRY_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    let req = null;
    let hard = null;
    const done = (v) => {
      if (settled) return;
      settled = true;
      if (hard) { try { clearTimeout(hard); } catch { /* noop */ } }
      resolve(v);
    };
    try {
      req = https.request(url, {
        method: 'GET',
        agent: false, // 显式直连：不让环境代理把 registry 请求绕成未知行为
        headers: { Accept: 'application/vnd.npm.install-v1+json', 'User-Agent': 'hive-setup/1.0' },
      }, (res) => {
        const chunks = [];
        let size = 0;
        let tooBig = false;
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_META_BYTES) { tooBig = true; try { req.destroy(); } catch { /* noop */ } return; }
          chunks.push(c);
        });
        res.on('end', () => {
          if (tooBig) return done({ ok: false, error: `registry 响应过大（>${Math.round(MAX_META_BYTES / 1048576)}MB）`, ms: Date.now() - t0, bytes: size });
          try {
            done({ ok: true, status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')), ms: Date.now() - t0, bytes: size });
          } catch (e) {
            done({ ok: false, error: `registry 返回非 JSON: ${e.message}`, ms: Date.now() - t0, bytes: size });
          }
        });
        res.on('error', (e) => done({ ok: false, error: e.message, ms: Date.now() - t0, bytes: size }));
      });
    } catch (e) {
      return done({ ok: false, error: e && e.message ? e.message : String(e) });
    }
    // 关键：setTimeout 只是「空闲超时」，慢速但持续的下载永远不会触发；
    // 必须再加一个绝对截止时间，否则 codex 这种 5MB 元数据会拖到 60s+。
    hard = setTimeout(() => {
      try { req.destroy(new Error(`registry 超时 ${timeoutMs}ms（绝对截止）`)); } catch { /* noop */ }
    }, timeoutMs);
    if (hard && typeof hard.unref === 'function') hard.unref();
    req.on('error', (e) => done({ ok: false, error: (e && (e.code || e.message)) || 'network error', ms: Date.now() - t0 }));
    req.end();
  });
}

/** 本机 npm 配置的 registry（通常被设成国内镜像）——npmjs 直连失败时的回落源 */
async function configuredRegistry(force = false) {
  if (!force && _meta.configured && Date.now() - _meta.configured.at < META_TTL_MS) return _meta.configured.url;
  const spec = npmSpec('npm config get registry');
  const r = await execAsync(spec.cmd, spec.args, 20000);
  const line = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  const url = /^https?:\/\//i.test(line) ? line.replace(/\/+$/, '') + '/' : '';
  _meta.configured = { at: Date.now(), url: url || null };
  return _meta.configured.url;
}

function normalizeMeta(doc, info) {
  const tags = (doc && doc['dist-tags']) || {};
  const all = Object.keys((doc && doc.versions) || {});
  all.sort((a, b) => compareVersions(b, a)); // 降序
  const latest = tags.latest || all[0] || null;
  const latestDoc = latest ? (doc.versions || {})[latest] : null;
  const unpacked = latestDoc && latestDoc.dist ? Number(latestDoc.dist.unpackedSize) : NaN;
  return {
    ok: true,
    latest,
    versions: all.slice(0, 20),          // 契约字段：最近 20 个
    versionsFull: all,                   // 内存里保留全量，用于算「比当前低的版本」
    totalVersions: all.length,
    distTags: tags,
    sizeHint: Number.isFinite(unpacked) && unpacked > 0 ? fmtBytes(unpacked) : null,
    source: info.url,
    sourceKind: info.kind,
    ms: info.ms,
    bytes: info.bytes,
    error: null,
    fetchedAt: nowIso(),
  };
}

function loadPersistedMeta() {
  if (_meta.loaded) return;
  _meta.loaded = true;
  try {
    const saved = kvGet(KV_META_KEY, null);
    if (!saved || typeof saved !== 'object' || !saved.byPkg) return;
    const at = Number(saved.at) || 0;
    if (!at || Date.now() - at > META_TTL_MS) return;
    for (const [pkg, value] of Object.entries(saved.byPkg)) {
      if (value && typeof value === 'object' && value.ok) _meta.byPkg.set(pkg, { at, value });
    }
    // 记住「npmjs 直连慢」这件事，重启后不必再白等 12s
    const downAt = Number(saved.primaryFailedAt) || 0;
    if (downAt && Date.now() - downAt < META_TTL_MS) _meta.primaryFailedAt = downAt;
    if (typeof saved.usedRegistry === 'string') _meta.usedRegistry = saved.usedRegistry;
  } catch { /* kv 不可用就只用内存缓存 */ }
}

function persistMeta() {
  try {
    const byPkg = {};
    for (const [pkg, e] of _meta.byPkg) {
      if (!e || !e.value || !e.value.ok) continue;
      // 全量版本表不进 kv（codex 有 5700+ 个版本）：只留前 400 个，够降级用
      const v = e.value;
      byPkg[pkg] = { ...v, versionsFull: Array.isArray(v.versionsFull) ? v.versionsFull.slice(0, 400) : [] };
    }
    if (!Object.keys(byPkg).length && !_meta.primaryFailedAt) return;
    kvSet(KV_META_KEY, {
      at: Date.now(),
      byPkg,
      primaryFailedAt: _meta.primaryFailedAt || 0,
      usedRegistry: _meta.usedRegistry || null,
    });
  } catch { /* 缓存写失败不影响主流程 */ }
}

async function fetchPkgMeta(pkg, { force = false } = {}) {
  loadPersistedMeta();
  const cached = _meta.byPkg.get(pkg);
  if (!force && cached && Date.now() - cached.at < META_TTL_MS) return cached.value;

  const attempts = [];
  if (force || !primaryCoolingDown()) attempts.push({ url: NPMJS + encodePkg(pkg), kind: 'npmjs' });
  const configured = await configuredRegistry(force);
  if (configured && !attempts.some((a) => a.url.startsWith(configured))) {
    attempts.push({ url: configured + encodePkg(pkg), kind: 'configured' });
  }

  let lastErr = null;
  let lastUrl = null;
  for (const a of attempts) {
    const r = await httpJson(a.url);
    if (r.ok && r.json) {
      if (a.kind === 'npmjs') { _meta.primaryFailedAt = 0; _meta.usedRegistry = 'npmjs'; }
      else { _meta.primaryFailedAt = Date.now(); _meta.usedRegistry = 'configured'; }
      const value = normalizeMeta(r.json, { url: a.url, kind: a.kind, ms: r.ms, bytes: r.bytes });
      _meta.byPkg.set(pkg, { at: Date.now(), value });
      persistMeta();
      return value;
    }
    lastErr = r.error || `HTTP ${r.status}`;
    lastUrl = a.url;
    if (a.kind === 'npmjs') _meta.primaryFailedAt = Date.now();
  }

  const value = {
    ok: false, latest: null, versions: [], totalVersions: 0, distTags: {}, sizeHint: null,
    source: lastUrl, sourceKind: null, error: lastErr || '没有可用的 registry',
    fetchedAt: nowIso(),
  };
  // 失败只缓存 60s：网络抖动不该被钉死 10 分钟
  _meta.byPkg.set(pkg, { at: Date.now() - META_TTL_MS + 60000, value });
  return value;
}

// ── 已安装版本探测（优先读 npm 全局根里的 package.json，最精确）───────────
let _npmRoot = { at: 0, value: null };
async function npmGlobalRoot(force = false) {
  if (!force && _npmRoot.value && Date.now() - _npmRoot.at < 300000) return _npmRoot.value;
  const spec = npmSpec('npm root -g');
  const r = await execAsync(spec.cmd, spec.args, 30000);
  const line = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  _npmRoot = { at: Date.now(), value: r.ok && line ? line : null };
  return _npmRoot.value;
}

async function installedState(dep, { force = false } = {}) {
  const root = await npmGlobalRoot(force);
  if (root) {
    const dir = path.join(root, dep.pkg);
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pj && pj.version) {
        return { installed: true, version: String(pj.version), source: 'npm-global', path: dir, error: null };
      }
    } catch { /* 不在全局根里（比如用别的方式装的），走 CLI 兜底 */ }
  }
  const w = await which(dep.command);
  if (!w.ok) {
    return { installed: false, version: null, source: 'none', path: null, error: w.error || `${dep.command} 不在 PATH 中` };
  }
  const v = await commandVersion(dep.command, ['--version']);
  const m = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?)/.exec(String(v.version || ''));
  return {
    installed: true, version: m ? m[1] : (v.version || null), source: 'cli', path: w.path,
    error: v.ok ? null : (v.error || null),
  };
}

/**
 * 依赖清单（含 registry 元数据）。
 * @param {{force?:boolean}} [opts] force=true 时重新查 registry（对应 POST /api/deps/check）
 */
export async function depsSnapshot({ force = false } = {}) {
  loadPersistedMeta();
  if (force) { _meta.primaryFailedAt = 0; _meta.configured = null; }

  const [states, metas] = await Promise.all([
    Promise.all(AGENT_DEPS.map((d) => installedState(d, { force }))),
    Promise.all(AGENT_DEPS.map((d) => fetchPkgMeta(d.pkg, { force }))),
  ]);
  const configured = await configuredRegistry(false);

  const deps = AGENT_DEPS.map((d, i) => {
    const st = states[i] || {};
    const meta = metas[i] || {};
    const version = st.version || null;
    const latest = meta.latest || null;
    const allVersions = Array.isArray(meta.versionsFull) && meta.versionsFull.length
      ? meta.versionsFull
      : (Array.isArray(meta.versions) ? meta.versions : []);
    return {
      id: d.id,
      name: d.name,
      pkg: d.pkg,
      purpose: d.purpose,
      fallback: d.fallback,
      required: !!d.required,
      installed: !!st.installed,
      version,
      versionSource: st.source || null,
      latest,
      versions: Array.isArray(meta.versions) ? meta.versions : [],
      // 降级用：比当前版本更低的最多 20 个（契约字段 versions 只放最近 20 个，
      // 对「当前版本较旧」的情况，最近 20 个可能全都更高，所以单独给一份）
      downgradeVersions: version
        ? allVersions.filter((v) => compareVersions(v, version) < 0).slice(0, 20)
        : [],
      totalVersions: meta.totalVersions || 0,
      distTags: meta.distTags || {},
      sizeHint: meta.sizeHint || null,
      docsUrl: d.docsUrl,
      risk: d.risk || null,
      updateAvailable: !!(st.installed && latest && version && compareVersions(latest, version) > 0),
      sameAsLatest: !!(st.installed && latest && version && compareVersions(latest, version) === 0),
      metaError: meta.error || null,
      metaSource: meta.source || null,
      metaFetchedAt: meta.fetchedAt || null,
      command: d.command,
    };
  });

  const failed = deps.filter((d) => d.metaError);
  return {
    ok: true,
    generatedAt: nowIso(),
    registry: {
      requested: NPMJS,
      configured,
      used: _meta.usedRegistry,
      primaryDown: primaryCoolingDown(),
      timeoutMs: REGISTRY_TIMEOUT_MS,
      errors: failed.map((d) => ({ id: d.id, error: d.metaError })),
    },
    deps,
    summary: {
      total: deps.length,
      installed: deps.filter((d) => d.installed).length,
      missing: deps.filter((d) => !d.installed).length,
      updatable: deps.filter((d) => d.updateAvailable).length,
      required: deps.filter((d) => d.required).length,
      metaFailed: failed.length,
    },
    notes: [
      _meta.usedRegistry === 'configured'
        ? 'npmjs.org 直连超时/失败，元数据已回落到本机 npm 配置的 registry（镜像）。'
        : null,
      failed.length ? `${failed.length} 个包的版本信息取不到（registry 不可用），latest/versions 为空 —— 不是「没版本」。` : null,
      '安装/卸载/升降级全部由你点击触发；本系统不会自动装任何东西。',
    ].filter(Boolean),
  };
}

function truncTail(s, n = 4000) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(-n) : str;
}

/**
 * 执行一次依赖操作（install / update / uninstall）。
 * 绝不自动调用 —— 只有 HTTP 层的用户点击会走到这里。
 * @param {{id:string, action:'install'|'update'|'uninstall', version?:string|null,
 *          dryRun?:boolean, confirm?:boolean, timeoutMs?:number}} args
 */
export async function depAction({ id, action, version = null, dryRun = false, confirm = false, timeoutMs = 300000 } = {}) {
  const dep = AGENT_DEPS_BY_ID[id];
  if (!dep) {
    const err = new Error(`未知依赖: ${id || '(空)'}；可用: ${AGENT_DEPS.map((d) => d.id).join(', ')}`);
    err.status = 404;
    throw err;
  }
  const act = String(action || '').trim();
  if (!['install', 'update', 'uninstall'].includes(act)) {
    const err = new Error(`未知动作: ${act || '(空)'}；可用: install | update | uninstall`);
    err.status = 400;
    throw err;
  }
  const wanted = version == null || version === '' ? null : String(version).trim();
  if (wanted && !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(wanted)) {
    const err = new Error(`版本号 / dist-tag 非法: ${wanted}`);
    err.status = 400;
    throw err;
  }
  if (wanted && act === 'uninstall') {
    const err = new Error('卸载不接受 version 参数');
    err.status = 400;
    throw err;
  }

  const before = await installedState(dep, { force: true });
  let cmdText = '';
  let targetVersion = null;

  if (act === 'uninstall') {
    if (!before.installed) {
      return {
        ok: true, noop: true, reason: '未安装（无需卸载）', action: act, id, pkg: dep.pkg,
        cmd: null, argv: null, exitCode: null, stdout: '', stderr: '',
        before: before.version || null, after: null, beforeState: before, afterState: before,
      };
    }
    if (dep.required && !confirm) {
      const err = new Error(`「${dep.name}」是必需依赖：${dep.fallback}\n卸载需要显式确认（请求体 {"confirm": true}）`);
      err.status = 409;
      throw err;
    }
    cmdText = `npm uninstall -g ${dep.pkg}`;
  } else {
    targetVersion = wanted;
    if (!targetVersion) {
      const meta = await fetchPkgMeta(dep.pkg, { force: false });
      targetVersion = meta.latest || null;
      if (!targetVersion) {
        return {
          ok: false, noop: false, action: act, id, pkg: dep.pkg,
          reason: `无法确定 latest 版本（registry 不可用）：${meta.error || '未知错误'}`,
          cmd: null, argv: null, exitCode: null, stdout: '', stderr: '',
          before: before.version || null, after: before.version || null,
          beforeState: before, afterState: before,
        };
      }
    }
    if (before.installed && before.version && compareVersions(before.version, targetVersion) === 0) {
      return {
        ok: true, noop: true, reason: `已是最新（${targetVersion}），未重复安装`,
        action: act, id, pkg: dep.pkg, targetVersion,
        cmd: null, argv: null, exitCode: null, stdout: '', stderr: '',
        before: before.version, after: before.version, beforeState: before, afterState: before,
      };
    }
    cmdText = `npm install -g ${dep.pkg}@${targetVersion}`;
  }

  const spec = npmSpec(cmdText);
  const base = {
    action: act, id, pkg: dep.pkg, targetVersion,
    cmd: cmdText, argv: [spec.cmd, ...spec.args],
    before: before.version || null, after: before.version || null,
    beforeState: before, afterState: before, exitCode: null, stdout: '', stderr: '',
  };

  if (dryRun) {
    return { ...base, ok: true, dryRun: true, noop: false, ms: 0, note: 'dryRun：只生成并返回命令，未执行' };
  }

  const t0 = Date.now();
  const r = await execAsync(spec.cmd, spec.args, timeoutMs);
  _npmRoot = { at: 0, value: null }; // 全局根的内容可能变了
  const after = await installedState(dep, { force: true });
  const changed = (before.version || null) !== (after.version || null);
  const ok = !r.timedOut && r.ok;
  return {
    ...base,
    ok,
    dryRun: false,
    noop: false,
    exitCode: r.code,
    timedOut: !!r.timedOut,
    timeoutMs,
    ms: Date.now() - t0,
    stdout: truncTail(r.stdout, 4000),
    stderr: truncTail(r.stderr, 4000),
    after: after.version || null,
    afterState: after,
    changed,
    note: r.timedOut
      ? `命令超时（>${Math.round(timeoutMs / 1000)}s）；可能仍在后台跑，稍后刷新可看到结果`
      : (ok
        ? (changed ? `版本已变化：${before.version || '未安装'} → ${after.version}` : '命令成功，但探测到的版本没变（可能装到别的目录/未生效）')
        : 'npm 命令失败，详见 stderr'),
  };
}

export default {
  DEPENDENCIES, INSTALL_IDS, AGENT_DEPS, AGENT_DEPS_BY_ID,
  doctorReport, installDependency, detectDependency, readDaemonLock,
  depsSnapshot, depAction, compareVersions,
};
