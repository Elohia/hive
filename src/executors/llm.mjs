// src/executors/llm.mjs — 纯 LLM 执行器（inline，无子进程）
//
// 调 src/core/llm.mjs 的 chat()，把 prompt 变成结论；可要求 JSON 输出。
// 用途：L1/L2 的理解、整理、摘要、判定；便宜快（DeepSeek chat 单次 1–3s）。

import { loadConfig } from '../core/config.mjs';
import { keyStatus } from '../core/credentials.mjs';
import { chat, parseJson } from '../core/llm.mjs';

const name = 'llm';

function cfgOf(ctx) {
  return ctx?.config || ctx?.cfg || loadConfig();
}

async function available(ctx = {}) {
  const cfg = cfgOf(ctx);
  const c = cfg.executors?.llm || {};
  if (c.enabled === false) return { ok: false, reason: 'executors.llm 已禁用', version: null };
  const providerName = ctx.provider || cfg.llm?.default;
  const p = cfg.llm?.providers?.[providerName];
  if (!p) return { ok: false, reason: `未知 LLM provider: ${providerName}`, version: null };
  const ks = keyStatus()[providerName];
  if (!ks?.present) {
    return { ok: false, reason: `凭据缺失：refs.${p.keyRef || providerName}（${cfg.resolved?.credentials}）`, version: null, provider: providerName };
  }
  const model = c.model || p.models?.cheap;
  return { ok: true, reason: 'ok', version: model, provider: providerName, model };
}

/**
 * run(ctx)
 * ctx.prompt      必填
 * ctx.system      可选 system 提示
 * ctx.json        true → 要求 JSON 输出，result 里给解析后的对象
 * ctx.schemaHint  JSON 结构提示
 * ctx.tier        'cheap' | 'strong'
 * ctx.maxTokens   覆盖默认 max_tokens
 * ctx.budgetTokens 任务预算（用于给 max_tokens 兜底上限）
 */
async function run(ctx = {}) {
  const cfg = cfgOf(ctx);
  const c = cfg.executors?.llm || {};
  if (c.enabled === false) return fail('executors.llm 已禁用');
  const prompt = String(ctx.prompt ?? '').trim();
  if (!prompt) return fail('prompt 为空');

  const providerName = ctx.provider || cfg.llm?.default;
  const p = cfg.llm?.providers?.[providerName];
  if (!p) return fail(`未知 LLM provider: ${providerName}`);

  // max_tokens：显式 > 任务预算剩余 > 配置默认
  const budget = Number(ctx.budgetTokens) || 0;
  const maxTokens = Number(ctx.maxTokens) || (budget > 0 ? Math.min(budget, 8192) : (c.maxTokens || 2048));

  const messages = [];
  const system = ctx.system || c.system || '';
  if (system) messages.push({ role: 'system', content: String(system) });
  messages.push({ role: 'user', content: prompt });

  const t0 = Date.now();
  let r;
  try {
    r = await chat({
      provider: ctx.provider,
      tier: ctx.tier || c.tier || 'cheap',
      model: ctx.model,
      messages,
      json: !!ctx.json,
      schemaHint: ctx.schemaHint,
      maxTokens,
      temperature: ctx.temperature,
      timeoutMs: (Number(ctx.timeoutSec) || cfg.settings?.defaultTimeoutSec || 900) * 1000,
      retries: ctx.retries ?? 2,
    });
  } catch (e) {
    // chat() 内部已重试并兜底返回 {ok:false}；能抛到这里说明是编程错误/配置错误
    return fail(String(e?.message || e), { ms: Date.now() - t0 });
  }

  const usage = r.usage || { in: 0, out: 0 };
  const base = {
    ok: !!r.ok,
    exitCode: r.ok ? 0 : 1,
    stdout: r.text || '',
    stderr: r.ok ? '' : String(r.error || 'LLM 调用失败'),
    tokens: { in: usage.in || 0, out: usage.out || 0 },
    costCny: r.costCny || 0,
    artifacts: [],
    result: null,
    text: r.text || '',
    error: r.ok ? null : String(r.error || 'LLM 调用失败'),
    ms: r.ms ?? Date.now() - t0,
    provider: r.provider,
    model: r.model,
    tier: r.tier,
    reasoning: r.reasoning || null,
  };

  if (!r.ok) return base;

  let parsed = null;
  if (ctx.json) {
    parsed = parseJson(r.text);
    if (!parsed) {
      // JSON 解析失败按失败返回（调用方需要明确的失败，而不是"看起来有输出"）
      return {
        ...base,
        ok: false,
        error: `JSON 解析失败：${String(r.text).slice(0, 200)}`,
        result: { text: r.text, parse_error: true },
      };
    }
  }
  base.result = ctx.json ? parsed : { text: r.text };
  if (parsed) base.json = parsed;
  return base;
}

function fail(reason, extra = {}) {
  return {
    ok: false, exitCode: null, stdout: '', stderr: reason,
    tokens: { in: 0, out: 0 }, costCny: 0, artifacts: [], result: null,
    text: '', error: reason, ...extra,
  };
}

export default {
  name,
  kind: 'inline',
  available,
  run,
};
