// src/executors/codex.mjs — OpenAI Codex CLI 执行器
//
// 命令：`codex exec --skip-git-repo-check "<prompt>"`
// 输出：进度/日志走 stderr，最终回答走 stdout（纯文本）。
// 本机实测：codex 配的是 xiaomimimo 的自定义 provider，账户余额不足 → 402，
// 会连续重试 5 次后失败（单次可拖到 150s+）。故超时默认 600s 并且如实把错误抛出。

import { createCliExecutor } from './agent.mjs';

/** codex 明文输出：去掉末尾 "tokens used / <n>" 统计块，正文才是答案 */
function parseCodex(stdout, stderr) {
  let text = String(stdout || '').trim();
  let tokensTotal = null;
  const m = /\n\s*tokens used\s*\n\s*([\d,]+)\s*$/i.exec(text);
  if (m) {
    tokensTotal = Number(m[1].replace(/,/g, ''));
    text = text.slice(0, m.index).trim();
  }
  // 本机：codex 指向 xiaomimimo 自定义 provider，余额不足 → 402（错误都在 stderr）
  const bill = /(402|Insufficient account balance|Payment Required)/i.exec(`${stderr || ''}\n${text}`);
  return {
    text,
    // codex 只给总 token 数，没有 in/out 拆分 —— 不编造拆分
    tokens: { in: 0, out: 0 },
    costCny: 0,
    result: { text },
    meta: {
      ...(tokensTotal == null ? { usage_unknown: true } : { tokens_total: tokensTotal, usage_split_unknown: true }),
      ...(bill ? { billing_error: true, fail_reason: `codex 上游账户问题：${String(stderr || '').split(/\r?\n/).find((l) => /402|Insufficient account balance/i.test(l))?.trim().slice(0, 240) || bill[0]}` } : {}),
    },
  };
}

export default createCliExecutor({
  name: 'codex',
  command: 'codex',
  args: ['exec', '--skip-git-repo-check'],
  versionArgs: ['--version'],
  timeoutSec: 600,
  parse: parseCodex,
});
