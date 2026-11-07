// src/executors/grok.mjs — Grok Bot 执行器
//
// 为什么不走 CLI：Grok Bot 是个桌面客户端，没有官方 CLI。但它自带一个本地**消息桥**
// （`D:\bot\bridge.mjs`，默认 http://127.0.0.1:8799），把「发一条消息 / 等回复」暴露成 HTTP，
// 所以这里按 HTTP 执行器接，契约与其它执行器一致（available + run → Result）。
//
// 桥的契约（读 D:\bot\bridge.mjs 确认）：
//   GET  /status                     → { ok, connected, chat, seq, messages }
//   GET  /chat                       → { chat, agents: string[] }   当前会话 + 可用会话
//   POST /send {text,wait,timeout_ms,chat}
//                                    → { ok, sent, chat, seq, reply: { role, text, chat, seq } | null }
//
// 语义：一个 Grok Bot 会话 = 一个「有记忆的执行者」。所以支持 `chat` 指定用哪个人格
// （趋势分析师 / 数据分析师 / A股调用 / 链上bot …），默认用桥当前所在会话。
//
// 注意：Grok Bot 会真的在桌面上打字、把消息发进那个会话，属于**对外副作用**，
// 所以它在 TASK_EXECUTORS 里只用于「研究/分析/起草」这类不自动发消息的动作。

const DEFAULT_BRIDGE = 'http://127.0.0.1:8799';

function bridgeOf(cfg) {
  const c = cfg?.executors?.grok || {};
  return String(c.bridgeUrl || DEFAULT_BRIDGE).replace(/\/+$/, '');
}

async function httpJson(url, { method = 'GET', body, timeoutMs = 15000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { ok: r.ok, status: r.status, json, text };
  } catch (e) {
    return { ok: false, status: 0, json: null, text: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 探活：桥通 + 已连上 Grok Bot 窗口才算可用 */
export async function available({ config } = {}) {
  const base = bridgeOf(config);
  const r = await httpJson(`${base}/status`, { timeoutMs: 8000 });
  if (!r.ok || !r.json) {
    return { ok: false, reason: `消息桥不可达（${base}）：${String(r.text).slice(0, 120)}。先跑 D:\\bot\\start.ps1 或用 grok_bot_start` };
  }
  if (!r.json.connected) {
    return { ok: false, reason: `消息桥在，但没连上 Grok Bot 窗口（chat=${r.json.chat || '-'}）` };
  }
  // 顺便报当前会话名，让人知道会派到哪
  const chat = r.json.chat || '';
  return { ok: true, version: `grok-bot${chat ? ' · ' + chat : ''}`, chat, detail: { bridge: base, messages: r.json.messages ?? null } };
}

export async function run({ config, task, prompt, chat, timeoutMs, workdir } = {}) {
  const cfg = config;
  const c = cfg?.executors?.grok || {};
  const base = bridgeOf(cfg);
  const text = String(task || prompt || '').trim();
  if (!text) return fail('任务为空：grok 执行器需要一个要它做的事');

  const targetChat = String(chat || c.chat || '').trim();
  const waitMs = Math.min(Number(timeoutMs) || Number(c.timeoutMs) || 180000, 600000);

  const t0 = Date.now();
  // 工作目录：Grok Bot 在自己的会话里干活，没有 cwd 概念；写进提示里让它知道在哪儿动手
  const finalText = workdir ? `工作目录：${workdir}\n\n${text}` : text;

  const r = await httpJson(`${base}/send`, {
    method: 'POST',
    body: { text: finalText, wait: true, timeout_ms: waitMs, ...(targetChat ? { chat: targetChat } : {}) },
    timeoutMs: waitMs + 15000,
  });

  if (!r.ok || !r.json) {
    return fail(`派单失败（HTTP ${r.status}）：${String(r.text).slice(0, 200)}`, { ms: Date.now() - t0 });
  }
  const reply = r.json.reply;
  const replyText = String(reply?.text || '').trim();
  const usedChat = r.json.chat || targetChat || '';
  if (!replyText) {
    return fail(`已发送到「${usedChat}」，但在 ${Math.round(waitMs / 1000)}s 内没等到回复（可能仍在生成，去 Grok Bot 里看）`, {
      ms: Date.now() - t0, stdout: '', stderr: '', result: { sent: r.json.sent, chat: usedChat, seq: r.json.seq },
    });
  }
  return {
    ok: true,
    exitCode: 0,
    stdout: replyText,
    stderr: '',
    // Grok Bot 不向我们暴露 token 用量（套餐内），成本按 0 记
    tokens: { in: 0, out: 0 },
    costCny: 0,
    text: replyText,
    artifacts: [],
    result: { text: replyText, chat: usedChat, seq: r.json.seq },
    meta: { chat: usedChat, bridge: base, usage_unknown: true, ms: Date.now() - t0 },
    ms: Date.now() - t0,
  };
}

function fail(reason, extra = {}) {
  return {
    ok: false, exitCode: null, stdout: '', stderr: reason,
    tokens: { in: 0, out: 0 }, costCny: 0, artifacts: [], result: null,
    text: '', error: reason, ...extra,
  };
}

/** 列出可派单的会话（看板「执行器」页会用到） */
export async function listChats({ config } = {}) {
  const base = bridgeOf(config);
  const r = await httpJson(`${base}/chat`, { timeoutMs: 12000 });
  if (!r.ok || !r.json) return { ok: false, chats: [], error: String(r.text).slice(0, 150) };
  return { ok: true, chat: r.json.chat || '', chats: Array.isArray(r.json.agents) ? r.json.agents : [] };
}

export default {
  name: 'grok',
  kind: 'http',
  command: null,
  timeoutSec: 900,
  available,
  run,
};
