// src/executors/agent.mjs — CLI Agent 执行器公共基座（dsh / pi / codex / claude 共用）
//
// 统一接口（docs/01-ARCHITECTURE.md §6.2）：
//   export default { name, kind, available(ctx)->{ok,reason,version}, run(ctx)->Result }
//
// Result = { ok, exitCode, stdout, stderr, tokens:{in,out}, costCny, artifacts:[], result }
// 额外字段（上层可选用，不破坏契约）：text, error, ms, pid, cmdline, timedOut, killed, truncated, degraded

import fs from 'node:fs';
import { loadConfig } from '../core/config.mjs';
import { runProcess, probeVersion, which } from './proc.mjs';

const VERSION_TTL_MS = 10 * 60 * 1000; // 版本探测缓存：health 接口会被反复调
const versionCache = new Map();

// 终端转义序列（颜色 / 光标 / OSC 8 超链接）——写进 runs/*.stdout 前要剥掉
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
export function stripAnsi(s) {
  return String(s ?? '').replace(ANSI_RE, '');
}

/** 从文本里捡 JSONL 行（解析失败的普通日志行直接跳过） */
export function jsonLines(text) {
  const out = [];
  for (const line of stripAnsi(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || (t[0] !== '{' && t[0] !== '[')) continue;
    try { out.push(JSON.parse(t)); } catch { /* 非 JSON，忽略 */ }
  }
  return out;
}

function num(...vals) {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/** 在任意 JSON 结构里找 usage 字段（不同 CLI 命名不同，做一次宽容嗅探） */
export function sniffUsage(root) {
  const acc = { in: 0, out: 0, cost: null };
  const seen = new Set();
  (function walk(node, depth) {
    if (!node || typeof node !== 'object' || depth > 8 || seen.has(node)) return;
    seen.add(node);
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === 'object' && /usage/i.test(k)) {
        const i = num(v.input, v.prompt_tokens, v.promptTokens, v.input_tokens, v.inputTokens);
        const o = num(v.output, v.completion_tokens, v.completionTokens, v.output_tokens, v.outputTokens);
        if (i != null) acc.in = Math.max(acc.in, i);
        if (o != null) acc.out = Math.max(acc.out, o);
      }
      if (v && typeof v === 'object' && /^cost$/i.test(k)) {
        const t = num(v.total, v.totalCost, v.usd);
        if (t != null) acc.cost = Math.max(acc.cost ?? 0, t);
      } else if (/^cost(Usd|Cny|_usd|_cny|Total)?$/i.test(k) && typeof v === 'number') {
        acc.cost = Math.max(acc.cost ?? 0, v);
      }
      if (v && typeof v === 'object') walk(v, depth + 1);
    }
  })(root, 0);
  return acc;
}

/** 从任意 JSON 结构里捡「最后一段助手文本」 */
export function sniffText(root) {
  let best = '';
  (function walk(node, depth) {
    if (!node || typeof node !== 'object' || depth > 8) return;
    const push = (s) => { if (typeof s === 'string' && s.trim()) best = s; };
    if (typeof node.text === 'string') push(node.text);
    if (typeof node.result === 'string') push(node.result);
    if (typeof node.content === 'string') push(node.content);
    if (Array.isArray(node.content)) {
      const joined = node.content
        .map((c) => (typeof c === 'string' ? c : c?.type === 'text' ? c.text : ''))
        .filter(Boolean).join('');
      push(joined);
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v, depth + 1);
  })(root, 0);
  return best.trim();
}

/** USD → CNY 的估算汇率（可在 config.llm.costUsdToCny 覆盖）；仅用于预算估算 */
export function usdToCny(cfg) {
  const r = Number(cfg?.llm?.costUsdToCny);
  return Number.isFinite(r) && r > 0 ? r : 7.1;
}

function resolveWorkdir(cfg, ctx) {
  const w = ctx.workdir || cfg.resolved?.workspace || cfg.home;
  try { fs.mkdirSync(w, { recursive: true }); } catch { /* 建目录失败留给 spawn 报错 */ }
  return w;
}

/**
 * 造一个 CLI Agent 执行器。
 * @param {object} o
 * @param {string} o.name              执行器名（= config.executors 的键）
 * @param {string} [o.cfgKey]          配置键（默认 = name）
 * @param {string} o.command           默认命令
 * @param {string[]} [o.args]          默认参数（prompt 追加在最后）
 * @param {string[]} [o.versionArgs]
 * @param {number} [o.timeoutSec]
 * @param {function} [o.parse]         (stdout, stderr, ctx) -> {text, tokens:{in,out}, costCny?, result?}
 * @param {Array}  [o.fallbacks]       [{test:RegExp, args:string[], note, on:'stderr'|'stdout'|'both'}]
 * @param {function} [o.env]           (cfg, ctx) -> object 追加环境变量
 */
export function createCliExecutor(o) {
  const name = o.name;
  const cfgKey = o.cfgKey || name;

  function configFor(cfg) {
    return cfg.executors?.[cfgKey] || {};
  }

  function commandFor(cfg, ctx) {
    const c = configFor(cfg);
    return { command: ctx?.command || c.command || o.command, args: Array.isArray(ctx?.args) ? ctx.args : (c.args || o.args || []) };
  }

  async function available(ctx = {}) {
    const cfg = ctx?.config || ctx?.cfg || loadConfig();
    const c = configFor(cfg);
    if (c.enabled === false) return { ok: false, reason: `executors.${cfgKey} 已禁用`, version: null, command: null };
    const { command } = commandFor(cfg, ctx);
    const abs = which(command);
    if (!abs) return { ok: false, reason: `未找到命令 ${command}（不在 PATH）`, version: null, command };
    const versionArgs = o.versionArgs || ['--version'];
    const key = `${abs}|${versionArgs.join(' ')}`;
    const hit = versionCache.get(key);
    const now = Date.now();
    if (hit && now - hit.at < VERSION_TTL_MS) return { ...hit.value };
    const v = await probeVersion(abs, versionArgs, { timeoutSec: o.versionTimeoutSec || 30, workdir: cfg.resolved?.workspace });
    const value = v.ok
      ? { ok: true, reason: 'ok', version: v.version, command, path: abs }
      : { ok: false, reason: `${command} 存在但版本探测失败：${v.reason}`, version: null, command, path: abs };
    versionCache.set(key, { at: now, value });
    return { ...value };
  }

  async function run(ctx = {}) {
    const cfg = ctx?.config || loadConfig();
    const c = configFor(cfg);
    if (c.enabled === false) {
      return fail(`执行器 ${name} 已禁用（config.executors.${cfgKey}.enabled=false）`);
    }
    const prompt = ctx.prompt == null ? '' : String(ctx.prompt);
    const workdir = resolveWorkdir(cfg, ctx);
    const base = commandFor(cfg, ctx);
    const timeoutSec = ctx.timeoutSec || c.timeoutSec || o.timeoutSec || cfg.settings?.defaultTimeoutSec || 900;
    const extraEnv = typeof o.env === 'function' ? o.env(cfg, ctx) : undefined;

    let args = [...base.args];
    let degraded = null;
    let attempts = 0;
    // 有些执行器要在 prompt 前面加一段固定前缀（如 pwsh 的 UTF-8 输出编码）
    const finalPrompt = typeof o.transformPrompt === 'function' ? o.transformPrompt(prompt, { cfg, ctx }) : prompt;

    // 降级重试：某些 CLI 因本机扩展/插件损坏直接退出，按 o.fallbacks 再试一次
    const fallbacks = Array.isArray(o.fallbacks) ? o.fallbacks : [];
    let r;
    for (;;) {
      attempts++;
      const argv = [...args, ...(finalPrompt ? [finalPrompt] : [])];
      r = await runProcess({
        command: base.command,
        args: argv,
        workdir,
        timeoutSec,
        env: extraEnv,
        onSpawn: ctx.onSpawn,
        onLog: ctx.onLog,
      });
      const hay = `${r.stderr}\n${r.stdout}`;
      const fb = fallbacks.find((f) => f.test.test(hay));
      if (r.exitCode === 0 && !r.spawnError && !r.timedOut) break;
      if (!fb) break;
      const nextArgs = [...args, ...(fb.args || [])];
      if (nextArgs.length === args.length) break;
      args = nextArgs;
      degraded = fb.note || '降级重试';
      if (attempts >= 1 + fallbacks.length) break;
    }

    if (r.spawnError) {
      return {
        ...fail(r.spawnError),
        exitCode: null, stderr: r.spawnError, ms: r.ms, pid: r.pid, cmdline: r.cmdline, via: r.via, degraded,
      };
    }

    const stdout = stripAnsi(r.stdout);
    const stderr = stripAnsi(r.stderr);
    let parsed = { text: stdout.trim(), tokens: { in: 0, out: 0 }, costCny: 0, result: null };
    if (typeof o.parse === 'function') {
      try {
        const p = o.parse(stdout, stderr, { cfg, ctx, degraded }) || {};
        parsed = {
          text: p.text ?? stdout.trim(),
          tokens: { in: p.tokens?.in ?? 0, out: p.tokens?.out ?? 0 },
          costCny: p.costCny ?? 0,
          result: p.result ?? null,
          meta: p.meta,
        };
      } catch (e) {
        // 解析失败不算执行失败：保留原始输出，标记 parse_error
        parsed = { text: stdout.trim(), tokens: { in: 0, out: 0 }, costCny: 0, result: null, meta: { parse_error: String(e?.message || e) } };
      }
    }

    const ok = !r.timedOut && !r.killed && r.exitCode === 0;
    return {
      ok,
      exitCode: r.exitCode,
      stdout,
      stderr,
      tokens: parsed.tokens,
      costCny: parsed.costCny ?? 0,
      artifacts: [],
      result: ok ? { text: parsed.text, ...(parsed.result || {}), ...(degraded ? { degraded } : {}), ...(parsed.meta ? { meta: parsed.meta } : {}) } : null,
      text: parsed.text,
      error: ok ? null : (r.timedOut ? `超时 ${timeoutSec}s，已 kill 进程树` : r.killed ? '被取消/杀死' : `退出码 ${r.exitCode}`),
      ms: r.ms,
      pid: r.pid,
      cmdline: r.cmdline,
      timedOut: r.timedOut,
      killed: r.killed,
      truncated: r.truncated,
      treeKill: r.treeKill,
      via: r.via,
      degraded,
      attempts,
    };
  }

  function fail(reason) {
    return {
      ok: false, exitCode: null, stdout: '', stderr: reason,
      tokens: { in: 0, out: 0 }, costCny: 0, artifacts: [], result: null,
      text: '', error: reason, degraded: null,
    };
  }

  return { name, kind: 'process', command: o.command, available, run };
}

export default createCliExecutor;
