// src/executors/index.mjs — 执行器注册表（唯一入口）
//
// 上层（router / worker / server）只认这里三个函数：
//   list()        → [{name, kind, enabled, command}]
//   get(name)     → 执行器对象（含 run）
//   probe()       → { name: {ok, reason, version, ...} }（附带 node/pwsh 运行时版本）
//   run(name, ctx)→ Result（绝不抛，异常也折成 {ok:false, error}）
//
// 契约见 docs/01-ARCHITECTURE.md §6.2。

import { loadConfig } from '../core/config.mjs';
import { runProcess } from './proc.mjs';
import proc from './proc.mjs';
import llm from './llm.mjs';
import dsh from './dsh.mjs';
import pi from './pi.mjs';
import codex from './codex.mjs';
import claude from './claude.mjs';
import shell from './shell.mjs';
import grok from './grok.mjs';

const EXECUTORS = new Map([
  [llm.name, llm],
  [dsh.name, dsh],
  [pi.name, pi],
  [codex.name, codex],
  [claude.name, claude],
  [shell.name, shell],
  // Grok Bot（本地消息桥 http://127.0.0.1:8799）：一个有记忆的人格会话当执行者
  [grok.name, grok],
  // 通用兜底：跑任意命令（config.executors.proc.command 或 ctx.command）
  [proc.name, proc],
]);

function cfgOf(opts) {
  return opts?.config || loadConfig();
}

/** 注册表清单（带 config 里的 enabled 状态） */
export function list(opts = {}) {
  const cfg = cfgOf(opts);
  return [...EXECUTORS.values()].map((e) => {
    const c = cfg.executors?.[e.name] || {};
    return {
      name: e.name,
      kind: e.kind,
      // proc 是通用兜底：没在 config 里显式配 command 就不算启用，避免 router 乱选
      enabled: c.enabled !== false && (e.name !== 'proc' || !!c.command),
      command: c.command || e.command || null,
      args: c.args || null,
    };
  });
}

/** 取执行器对象；未知名字返回 undefined（不抛） */
export function get(name) {
  return EXECUTORS.get(String(name || '').trim());
}

/** 注册了哪些名字 */
export function names() {
  return [...EXECUTORS.keys()];
}

/**
 * 探测所有执行器可用性 + 版本。
 * @param {object} [opts]
 * @param {string[]} [opts.names] 只探这些（默认全部）
 * @param {boolean} [opts.runtime] 是否附带 node/pwsh 运行时（默认 true）
 */
export async function probe(opts = {}) {
  const cfg = cfgOf(opts);
  const wanted = Array.isArray(opts.names) && opts.names.length ? opts.names : [...EXECUTORS.keys()];

  const tasks = wanted.map(async (name) => {
    const ex = EXECUTORS.get(name);
    if (!ex) return [name, { ok: false, reason: `未注册的执行器: ${name}`, version: null }];
    const c = cfg.executors?.[name] || {};
    // 显式关闭的执行器：不再探活，并标 disabled —— 否则自检会一直把「有意关掉的」
    // 条目报成「不可用 / 请补齐 CLI」，让人误以为坏了。
    if (c.enabled === false) {
      return [name, {
        ok: false, disabled: true, version: null, kind: ex.kind, enabled: false,
        reason: `已在 config/hive.json 中关闭${c.note ? '：' + String(c.note).slice(0, 140) : ''}`,
      }];
    }
    try {
      const r = await ex.available({ config: cfg });
      return [name, { ...r, kind: ex.kind, enabled: c.enabled !== false, disabled: false }];
    } catch (e) {
      return [name, { ok: false, disabled: false, reason: `available() 抛错: ${e?.message || e}`, version: null, kind: ex.kind, enabled: c.enabled !== false }];
    }
  });

  if (opts.runtime !== false) {
    tasks.push((async () => {
      const r = await runProcess({ command: process.execPath, args: ['-v'], timeoutSec: 20, silent: true });
      const v = (r.stdout || '').trim().split(/\r?\n/)[0] || null;
      return ['node', { ok: r.ok && !!v, reason: r.ok ? 'ok' : (r.spawnError || `退出码 ${r.exitCode}`), version: v, kind: 'runtime', enabled: true }];
    })());
    tasks.push((async () => {
      const r = await runProcess({
        command: 'pwsh',
        args: ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'],
        timeoutSec: 60, silent: true,
      });
      const v = (r.stdout || '').trim().split(/\r?\n/)[0] || null;
      return ['pwsh', { ok: r.ok && !!v, reason: r.ok ? 'ok' : (r.spawnError || `退出码 ${r.exitCode}`), version: v, kind: 'runtime', enabled: true }];
    })());
  }

  const pairs = await Promise.all(tasks);
  const out = {};
  for (const [k, v] of pairs) out[k] = v;
  return out;
}

/**
 * 跑一个执行器。
 * 未知执行器 / 参数缺失 / 执行器抛错，一律折成 {ok:false, error} 返回，不向上抛。
 */
export async function run(name, ctx = {}) {
  const ex = get(name);
  if (!ex) return failResult(`未注册的执行器: ${name}`, { stdout: '', stderr: `未注册的执行器: ${name}` });
  let cfg;
  try { cfg = cfgOf(ctx); } catch (e) { return failResult(`配置装载失败: ${e?.message || e}`); }
  const c = cfg.executors?.[ex.name] || {};
  if (c.enabled === false) return failResult(`执行器 ${ex.name} 已禁用（config.executors.${ex.name}.enabled=false）`);
  try {
    return await ex.run({ config: cfg, ...ctx });
  } catch (e) {
    // 执行器内部 bug / 不可恢复异常：记录完整信息，但对外仍是结构化失败
    return failResult(`${ex.name} 执行异常: ${e?.message || e}`, { stack: e?.stack });
  }
}

function failResult(reason, extra = {}) {
  return {
    ok: false, exitCode: null, stdout: '', stderr: reason,
    tokens: { in: 0, out: 0 }, costCny: 0, artifacts: [], result: null,
    text: '', error: reason, ...extra,
  };
}

export const registry = EXECUTORS;

export default { list, get, names, probe, run, registry };
