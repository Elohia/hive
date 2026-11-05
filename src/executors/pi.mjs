// src/executors/pi.mjs — Pi Agent 执行器
//
// 命令：`pi -p --mode json "<prompt>"`
// 输出：JSONL 事件流（session / agent_start / message_* / turn_end / agent_end / agent_settled）。
// 最终答案在 `agent_end.messages` 里最后一条 assistant 消息的 content[type=text]，
// usage 也在同一条消息上（input/output/cacheRead/cacheWrite + cost.total，单位 USD）。
//
// 本机坑：默认会加载 F:\pi-agent\extensions 下的扩展，其中 pi-wechat-workbuddy 缺
// `qrcode-terminal` 依赖 → pi 直接 exit 1。故内置降级：检测到扩展加载失败时，
// 自动追加 --no-extensions 重跑一次，并在结果里记 degraded 标记（不静默）。

import { createCliExecutor, jsonLines, usdToCny } from './agent.mjs';

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.type === 'text').map((c) => c.text).join('');
}

function parsePi(stdout, _stderr, { cfg }) {
  const events = jsonLines(stdout);
  const rate = usdToCny(cfg);

  let text = '';
  let tokens = { in: 0, out: 0 };
  let costUsd = 0;
  let model = null;
  let stopReason = null;

  const addMsg = (m) => {
    text = contentText(m.content) || text;
    const u = m.usage || {};
    tokens.in += Number(u.input ?? u.prompt_tokens ?? 0) || 0;
    tokens.out += Number(u.output ?? u.completion_tokens ?? 0) || 0;
    const c = u.cost && typeof u.cost === 'object' ? Number(u.cost.total) || 0 : 0;
    costUsd += c;
    if (m.model) model = m.model;
    if (m.stopReason) stopReason = m.stopReason;
  };

  // 优先用 agent_end 的完整 messages（多轮 + 工具调用后的用量都在这里，且只出现一次）
  const end = events.find((e) => e?.type === 'agent_end');
  if (end && Array.isArray(end.messages)) {
    for (const m of end.messages) if (m?.role === 'assistant') addMsg(m);
  }
  if (!text || (tokens.in === 0 && tokens.out === 0)) {
    // 兜底：只扫 message_end / turn_end（不要把 message_start 和 agent_end 混在一起，会重复计数）
    for (const e of events) {
      if (e?.type !== 'message_end' && e?.type !== 'turn_end') continue;
      if (e?.message?.role !== 'assistant') continue;
      addMsg(e.message);
    }
  }

  return {
    text,
    tokens,
    costCny: +(costUsd * rate).toFixed(6),
    result: { text },
    meta: {
      model,
      stop_reason: stopReason,
      cost_usd: +costUsd.toFixed(6),
      cost_note: 'pi 上报 USD，按 config.llm.costUsdToCny（默认 7.1）折算 CNY',
      events: events.length,
    },
  };
}

export default createCliExecutor({
  name: 'pi',
  command: 'pi',
  args: ['-p', '--mode', 'json'],
  versionArgs: ['--version'],
  timeoutSec: 600,
  parse: parsePi,
  fallbacks: [
    {
      // 本机 pi-wechat-workbuddy 扩展缺 qrcode-terminal 会把 pi 直接打挂
      test: /Failed to load extension|Start without extensions/i,
      args: ['--no-extensions'],
      note: '扩展加载失败 → --no-extensions 重试',
    },
  ],
});
