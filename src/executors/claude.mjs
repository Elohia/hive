// src/executors/claude.mjs — Claude Code 执行器
//
// 命令：`claude -p "<prompt>"`
// 输出：默认纯文本；若调用方给了 --output-format json（通过 ctx.args 或 config），
// 则 stdout 是单条 JSON（{result, usage:{input_tokens,output_tokens}, total_cost_usd}）。
// 本执行器两种都能解析。

import { createCliExecutor, jsonLines, sniffUsage, usdToCny } from './agent.mjs';

function parseClaude(stdout, _stderr, { cfg }) {
  const raw = String(stdout || '').trim();
  const rate = usdToCny(cfg);

  // 情况 1：--output-format json（单条 JSON 结果）
  if (raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw);
      if (j && (j.result !== undefined || j.usage)) {
        const u = j.usage || {};
        const usd = Number(j.total_cost_usd ?? j.cost_usd ?? 0) || 0;
        return {
          text: typeof j.result === 'string' ? j.result : (j.result ? JSON.stringify(j.result) : ''),
          tokens: {
            in: Number(u.input_tokens ?? u.input ?? 0) || 0,
            out: Number(u.output_tokens ?? u.output ?? 0) || 0,
          },
          costCny: +(usd * rate).toFixed(6),
          result: { text: typeof j.result === 'string' ? j.result : '', json: j },
          meta: { cost_usd: +usd.toFixed(6), cost_note: 'claude 上报 USD，按 costUsdToCny 折算' },
        };
      }
    } catch { /* 不是单条 JSON，继续走文本 */ }
  }

  // 情况 2：--output-format stream-json（JSONL）
  const events = jsonLines(raw);
  if (events.length) {
    const usages = sniffUsage(events);
    const last = [...events].reverse().find((e) => typeof e?.result === 'string');
    const text = last?.result || events.map((e) => (typeof e?.result === 'string' ? e.result : '')).filter(Boolean).pop() || '';
    if (text) {
      return {
        text,
        tokens: { in: usages.in, out: usages.out },
        costCny: +((usages.cost || 0) * rate).toFixed(6),
        result: { text },
        meta: { usage_unknown: usages.in === 0 && usages.out === 0 },
      };
    }
  }

  // 情况 3：纯文本
  return {
    text: raw,
    tokens: { in: 0, out: 0 },
    costCny: 0,
    result: { text: raw },
    meta: { usage_unknown: true },
  };
}

export default createCliExecutor({
  name: 'claude',
  command: 'claude',
  args: ['-p'],
  versionArgs: ['--version'],
  timeoutSec: 900,
  parse: parseClaude,
});
