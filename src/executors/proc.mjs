// src/executors/proc.mjs — 通用子进程执行基座（零 npm 依赖）
//
// 职责：
//   1. 命令解析：把 `dsh` / `pi.cmd` / `C:\x\y.exe` / `x.ps1` 解析成「能直接 CreateProcess 的形态」。
//      Windows 上 npm 全局 CLI 只有 .cmd/.ps1 壳，Node 的 spawn 对 .cmd 会直接 EINVAL，
//      所以这里读 .cmd 壳里的 `%dp0%\...` 目标，换成 `node <目标js>` 直接起（不经过 shell，引号/换行安全）。
//   2. spawn + 超时 kill 整棵进程树（Windows `taskkill /PID <pid> /T /F`）。
//   3. 行级 onLog 回调、stdout/stderr 上限保护、token 嗅探的公共工具。
//
// 默认导出 `proc` 执行器：跑一条任意命令（供 shell / 兜底 / 测试用）。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../core/config.mjs';

export const WIN = process.platform === 'win32';

// 命令名解析优先级：.exe 最快；.cmd 是 npm 壳；.ps1 兜底（只在没有 .cmd 时才会被选中）
const PREFER = ['.exe', '.com', '.cmd', '.bat', '.ps1', '.js', '.mjs', '.cjs'];
const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024; // 单流 8MB 上限，超出只记 truncated（仍继续排空管道）
const CMDLINE_MAX = 8000;                   // cmdline 落库/打印上限

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * 「这个路径可以当命令用吗」。
 * 注意 Windows 的 App Execution Alias（如 WindowsApps\...\pwsh.exe）是重解析点，
 * fs.statSync 会抛 EACCES，必须退回 lstatSync 才认得出 —— 否则 pwsh 会被判成「不在 PATH」。
 */
function entryOk(p) {
  try { return fs.statSync(p).isFile(); } catch { /* 落到下面 */ }
  try {
    const l = fs.lstatSync(p);
    if (l.isFile()) return true;
    if (l.isSymbolicLink()) return true; // 解析点/别名：交给 CreateProcess 去解析
    return false;
  } catch { return false; }
}

/** PATH 里找命令，返回绝对路径；找不到返回 null */
export function which(command) {
  if (!command) return null;
  if (path.isAbsolute(command)) return entryOk(command) ? command : null;
  if (command.includes('/') || command.includes('\\')) {
    const abs = path.resolve(command);
    return entryOk(abs) ? abs : null;
  }
  const dirs = String(process.env.PATH || '').split(WIN ? ';' : ':').filter(Boolean);
  const hasExt = /\.[a-z0-9]{1,5}$/i.test(command);
  for (const dir of dirs) {
    const base = path.join(dir, command);
    if (hasExt) {
      if (entryOk(base)) return base;
      continue;
    }
    if (WIN) {
      for (const ext of PREFER) {
        const cand = base + ext;
        if (entryOk(cand)) return cand;
      }
      if (entryOk(base)) return base;
    } else {
      if (!entryOk(base)) continue;
      try { fs.accessSync(base, fs.constants.X_OK); return base; } catch { /* 无执行位，继续找 */ }
    }
  }
  return null;
}

/**
 * 解析 npm 生成的 .cmd/.bat 壳：
 *   "%_prog%"  "%dp0%\node_modules\@scope\pkg\lib\bin.js" %*
 *   "%dp0%\node_modules\@scope\pkg\bin\x.exe"   %*
 * 取最后一个 %dp0%\... 目标；若它是 .exe 直接跑，否则用 node 跑它。
 * 返回 {kind:'exe'|'node', target} 或 null（解析失败 → 调用方走 cmd 兜底）。
 */
export function parseNpmShim(shimPath) {
  let text;
  try { text = fs.readFileSync(shimPath, 'utf8'); } catch { return null; }
  const re = /%[~]?dp0%\\?"?([^"\r\n]+?)"?\s*%?\*?$/gim;
  const hits = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const rel = m[1].trim().replace(/^["']|["']$/g, '');
    if (rel) hits.push(rel);
  }
  if (!hits.length) {
    // 兜底：宽松匹配所有 %dp0%\...
    const loose = /%[~]?dp0%\\([^"\r\n]+)/gi;
    while ((m = loose.exec(text)) !== null) hits.push(m[1].trim());
  }
  if (!hits.length) return null;
  const rel = hits[hits.length - 1];
  const target = path.resolve(path.dirname(shimPath), rel.replace(/^\\+/, ''));
  if (!isFile(target)) return null;
  const ext = path.extname(target).toLowerCase();
  if (ext === '.exe' || ext === '.com') return { kind: 'exe', target };
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '') return { kind: 'node', target };
  return null;
}

function pwshExe() {
  if (!WIN) return 'pwsh';
  const abs = which('pwsh');
  return abs || which('powershell') || 'pwsh.exe';
}

/** cmd.exe 兜底时的参数引用（只在壳解析失败时才用到） */
function quoteCmdArg(a) {
  const s = String(a);
  if (s === '') return '""';
  if (!/[\s"&|<>^()%!]/.test(s)) return s;
  return '"' + s.replace(/"/g, '\\"') + '"';
}
export function buildCmdLine(program, args) {
  return [program, ...args].map(quoteCmdArg).join(' ');
}

/**
 * 把「用户写的命令 + 参数」变成可 spawn 的 {exe, prefix, via}。
 * 找不到命令时返回 {error}。
 */
export function commandSpec(command, args = []) {
  const abs = which(command);
  if (!abs) {
    return { error: `未找到命令: ${command}（不在 PATH 中）`, command, args };
  }
  const ext = path.extname(abs).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') {
    const parsed = parseNpmShim(abs);
    if (parsed?.kind === 'exe') {
      return { exe: parsed.target, prefix: [], argv: args, abs, via: `${abs} → ${parsed.target}` };
    }
    if (parsed?.kind === 'node') {
      return { exe: process.execPath, prefix: [parsed.target], argv: args, abs, via: `${abs} → node ${parsed.target}` };
    }
    // 壳解析失败：cmd.exe /d /s /c "<整条命令行>"
    return {
      exe: process.env.ComSpec || 'cmd.exe',
      prefix: ['/d', '/s', '/c', buildCmdLine(abs, args)],
      argv: [],
      abs,
      via: `${abs} (cmd.exe 兜底，引号按 CRT 规则转义)`,
      shellFallback: true,
    };
  }
  if (ext === '.ps1') {
    return { exe: pwshExe(), prefix: ['-NoProfile', '-File', abs], argv: args, abs, via: abs };
  }
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return { exe: process.execPath, prefix: [abs], argv: args, abs, via: abs };
  }
  return { exe: abs, prefix: [], argv: args, abs, via: abs };
}

function makeLineSplitter(onLine) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        try { onLine(line); } catch { /* onLog 抛错不得打断子进程 */ }
      }
      if (buf.length > 1_000_000) { // 超长无换行：先吐出去，别憋爆内存
        try { onLine(buf); } catch {}
        buf = '';
      }
    },
    flush() {
      if (!buf) return;
      try { onLine(buf.replace(/\r$/, '')); } catch {}
      buf = '';
    },
  };
}

/**
 * 杀掉整棵进程树。
 * Windows: taskkill /PID <pid> /T /F（/T 连子进程树一起杀，Claude/codex 都会再起子进程）
 * POSIX:   kill(-pgid) 依赖 detached:true 建的新进程组
 */
export async function killTree(child, { timeoutSec = 20 } = {}) {
  const pid = child?.pid;
  if (!pid) return { ok: false, method: 'none', reason: '无 pid' };
  if (WIN) {
    const r = await runProcess({
      command: 'taskkill',
      args: ['/PID', String(pid), '/T', '/F'],
      timeoutSec,
      silent: true,
    });
    // taskkill 对已退出进程返回 128，不算异常
    const ok = r.exitCode === 0 || /not found|没有找到|找不到/i.test(r.stdout + r.stderr);
    if (!ok) { try { child.kill('SIGKILL'); } catch {} }
    return { ok, method: 'taskkill /T /F', pid, exitCode: r.exitCode, output: (r.stdout + r.stderr).trim().slice(0, 400) };
  }
  let ok = false;
  try { process.kill(-pid, 'SIGKILL'); ok = true; } catch {}
  if (!ok) { try { child.kill('SIGKILL'); ok = true; } catch {} }
  return { ok, method: 'kill(-pgid,SIGKILL)', pid };
}

/**
 * 跑一条子进程。
 * @param {object} o
 * @param {string} o.command            命令（绝对路径或 PATH 里的名字）
 * @param {string[]} [o.args]
 * @param {string} [o.workdir]          子进程 cwd（不存在会自动建）
 * @param {number} [o.timeoutSec]       超时秒数，超时 kill 整棵树
 * @param {object} [o.env]              追加/覆盖环境变量
 * @param {boolean} [o.appendPathEnv]   把 exe 所在目录塞进 PATH（agent CLI 起子进程时需要）
 * @param {function} [o.onSpawn]        ({pid, cmdline, exe, via}) => void
 * @param {function} [o.onLog]          ({stream:'stdout'|'stderr', line, ts}) => void（行级）
 * @param {number} [o.maxOutputBytes]   单流保存上限
 * @param {boolean} [o.silent]          不触发 onLog（内部用，如 taskkill）
 * @returns {Promise<object>} {ok,exitCode,signal,stdout,stderr,timedOut,killed,ms,pid,cmdline,spawnError,treeKill,truncated}
 */
export function runProcess(o = {}) {
  const {
    command, args = [], workdir, timeoutSec = 900, env,
    appendPathEnv = true, onSpawn, onLog, maxOutputBytes = DEFAULT_MAX_OUTPUT, silent = false,
  } = o;

  const startedAt = Date.now();
  const spec = commandSpec(command, args);
  if (spec.error) {
    return Promise.resolve({
      ok: false, exitCode: null, signal: null, stdout: '', stderr: spec.error,
      timedOut: false, killed: false, ms: 0, pid: null, cmdline: `${command} …`,
      spawnError: spec.error, treeKill: null, truncated: false, via: null,
    });
  }

  const finalArgs = [...spec.prefix, ...spec.argv];
  const cmdline = `${spec.exe} ${finalArgs.join(' ')}`.slice(0, CMDLINE_MAX);

  const childEnv = { ...process.env, ...(env || {}) };
  if (appendPathEnv && spec.abs) {
    const dir = path.dirname(spec.abs);
    const sep = WIN ? ';' : ':';
    if (!String(childEnv.PATH || '').split(sep).includes(dir)) childEnv.PATH = `${dir}${sep}${childEnv.PATH || ''}`;
  }

  let cwd = workdir;
  if (cwd) { try { fs.mkdirSync(cwd, { recursive: true }); } catch { cwd = undefined; } }

  let child;
  try {
    child = spawn(spec.exe, finalArgs, {
      cwd: cwd || undefined,
      env: childEnv,
      windowsHide: true,
      // POSIX 需要新进程组才能按组 kill；Windows 用 taskkill /T，不需要 detached
      detached: !WIN,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    return Promise.resolve({
      ok: false, exitCode: null, signal: null, stdout: '', stderr: String(e.message),
      timedOut: false, killed: false, ms: Date.now() - startedAt, pid: null, cmdline,
      spawnError: String(e.message), treeKill: null, truncated: false, via: spec.via,
    });
  }

  let stdout = '';
  let stderr = '';
  let outTrunc = false;
  let errTrunc = false;
  let timedOut = false;
  let killed = false;
  let spawnError = null;
  let treeKill = null;
  let settled = false;
  let killTimer = null;

  const emitLog = (stream) => (line) => {
    if (silent || typeof onLog !== 'function') return;
    try { onLog({ stream, line, ts: Date.now() }); } catch { /* 不得影响主流程 */ }
  };
  const outLines = makeLineSplitter(emitLog('stdout'));
  const errLines = makeLineSplitter(emitLog('stderr'));

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (s) => {
    outLines.push(s);
    if (Buffer.byteLength(stdout) < maxOutputBytes) stdout += s;
    else outTrunc = true;
  });
  child.stderr?.on('data', (s) => {
    errLines.push(s);
    if (Buffer.byteLength(stderr) < maxOutputBytes) stderr += s;
    else errTrunc = true;
  });

  child.on('spawn', () => {
    if (typeof onSpawn === 'function' && child.pid) {
      try { onSpawn({ pid: child.pid, cmdline, exe: spec.exe, via: spec.via, command, args }); } catch {}
    }
  });

  child.on('error', (e) => {
    spawnError = String(e?.message || e);
    // 'error' 之后一般还会来 close；这里只记录，不 resolve
  });

  let resolve;
  const promise = new Promise((r) => { resolve = r; });

  const timeoutMs = Math.max(0, Number(timeoutSec) || 0) * 1000;
  if (timeoutMs > 0) {
    killTimer = setTimeout(async () => {
      timedOut = true;
      const pid = child.pid;
      treeKill = await killTree(child);
      // 给 5s 让 close 自然到达，否则强制收尾
      killTimer = setTimeout(() => {
        killed = true;
        try { child.kill('SIGKILL'); } catch {}
        finalize(null, 'SIGKILL');
      }, 5000);
      if (typeof killTimer.unref === 'function') killTimer.unref();
      if (!pid) finalize(null, null);
    }, timeoutMs);
  }

  function finalize(exitCode, signal) {
    if (settled) return;
    settled = true;
    outLines.flush();
    errLines.flush();
    if (killTimer) clearTimeout(killTimer);
    const ms = Date.now() - startedAt;
    const ok = !timedOut && !spawnError && !killed && exitCode === 0;
    resolve({
      ok,
      exitCode: exitCode ?? null,
      signal: signal ?? null,
      stdout,
      stderr,
      timedOut,
      killed,
      ms,
      pid: child?.pid ?? null,
      cmdline,
      spawnError,
      treeKill,
      truncated: outTrunc || errTrunc,
      via: spec.via,
    });
  }

  child.on('close', (code, signal) => finalize(code, signal));
  // close 没来（极少数被 taskkill 之后管道悬挂）：兜底；无超时（timeoutSec=0）时不设兜底
  if (timeoutMs > 0) {
    const hardLimit = setTimeout(() => {
      if (!settled) { killed = true; finalize(child.exitCode, child.signalCode); }
    }, timeoutMs + 20_000);
    if (typeof hardLimit.unref === 'function') hardLimit.unref();
    promise.finally(() => clearTimeout(hardLimit));
  }
  return promise;
}

/** 探一个命令的版本号：跑 `<command> <versionArgs>`，取首行非空输出 */
export async function probeVersion(command, versionArgs = ['--version'], { timeoutSec = 30, workdir } = {}) {
  const r = await runProcess({ command, args: versionArgs, timeoutSec, workdir, silent: true });
  if (r.spawnError) return { ok: false, reason: r.spawnError, version: null, raw: '' };
  if (r.timedOut) return { ok: false, reason: `版本探测超时 ${timeoutSec}s`, version: null, raw: '' };
  const text = `${r.stdout}\n${r.stderr}`.trim();
  const line = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || '';
  if (r.exitCode !== 0 && !line) return { ok: false, reason: `退出码 ${r.exitCode}`, version: null, raw: text.slice(0, 400) };
  return { ok: !!line, reason: line ? 'ok' : '无版本输出', version: line ? line.slice(0, 200) : null, raw: text.slice(0, 400) };
}

// ---------------------------------------------------------------------------
// 默认执行器：跑任意命令（通用兜底；shell 执行器的母体）
// ---------------------------------------------------------------------------

const procExecutor = {
  name: 'proc',
  kind: 'process',

  async available(ctx = {}) {
    const cfg = ctx?.config || ctx?.cfg || loadConfig();
    const c = cfg.executors?.proc || {};
    if (c.enabled === false) return { ok: false, reason: 'executors.proc 已禁用', version: null };
    const command = ctx.command || c.command;
    if (!command) return { ok: false, reason: '未配置 executors.proc.command（通用执行器需要显式命令）', version: null };
    const abs = which(command);
    if (!abs) return { ok: false, reason: `未找到命令 ${command}（不在 PATH）`, version: null };
    const v = await probeVersion(abs, ['--version']);
    return { ok: true, reason: 'ok', version: v.version, path: abs };
  },

  async run(ctx = {}) {
    const cfg = ctx?.config || loadConfig();
    const c = cfg.executors?.proc || {};
    const command = ctx.command || c.command;
    const baseArgs = Array.isArray(ctx.args) ? ctx.args : (c.args || []);
    const prompt = ctx.prompt == null ? '' : String(ctx.prompt);
    const argv = [...baseArgs];
    if (ctx.appendPrompt !== false && prompt) argv.push(prompt);
    if (!command) {
      return {
        ok: false, exitCode: null, stdout: '', stderr: '未指定命令（ctx.command 或 executors.proc.command）',
        tokens: { in: 0, out: 0 }, costCny: 0, artifacts: [], result: null,
        error: '未指定命令',
      };
    }
    const workdir = ctx.workdir || cfg.resolved?.workspace || cfg.home;
    const timeoutSec = ctx.timeoutSec || c.timeoutSec || cfg.settings?.defaultTimeoutSec || 900;
    const r = await runProcess({ ...ctx, command, args: argv, workdir, timeoutSec });
    const ok = !r.timedOut && !r.killed && !r.spawnError && r.exitCode === 0;
    return {
      ok,
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      tokens: { in: 0, out: 0 },
      costCny: 0,
      artifacts: [],
      result: { text: r.stdout.trim() },
      text: r.stdout.trim(),
      error: ok ? null : (r.spawnError || (r.timedOut ? `超时 ${timeoutSec}s 已杀进程树` : r.killed ? '被取消' : `退出码 ${r.exitCode}`)),
      ms: r.ms,
      pid: r.pid,
      cmdline: r.cmdline,
      timedOut: r.timedOut,
      killed: r.killed,
      treeKill: r.treeKill,
      truncated: r.truncated,
      via: r.via,
    };
  },
};

export default procExecutor;
