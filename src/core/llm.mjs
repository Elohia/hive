// src/core/llm.mjs — OpenAI 兼容客户端（node:https 直连，显式绕过环境代理）
import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';
import { loadConfig } from './config.mjs';
import { getKey } from './credentials.mjs';

function request(urlStr, { headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const lib = u.protocol === 'http:' ? http : https;
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method: 'POST',
      // agent: false —— 不继承全局代理；DeepSeek 等国内直连可达
      agent: false,
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(text)); }
          catch (e) { reject(new Error(`响应非 JSON (${res.statusCode}): ${text.slice(0, 300)}`)); }
        } else {
          reject(Object.assign(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 500)}`), { status: res.statusCode }));
        }
      });
    });
    req.setTimeout(timeoutMs || 120000, () => req.destroy(new Error('LLM 请求超时')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function costOf(pricing, usage) {
  if (!pricing) return 0;
  // pricing 单位：元 / 百万 token
  const inM = (usage.in || 0) / 1e6;
  const outM = (usage.out || 0) / 1e6;
  return +(inM * (pricing.in || 0) + outM * (pricing.out || 0)).toFixed(6);
}

// ---- 可注入传输层 ----------------------------------------------------------
// 作为 DSH 插件运行时，HIVE 不自己拿 API key，而是借用宿主已配置的模型：
// 插件在启动时 setTransport(fn)，之后所有 chat() 都走宿主的 ctx.llm.stream。
let _transport = null;
export function setTransport(fn) { _transport = typeof fn === 'function' ? fn : null; }
export function hasTransport() { return !!_transport; }


/**
 * 调模型
 * @param {object} o
 * @param {string} [o.provider] 配置里的 provider 别名，默认 llm.default
 * @param {'cheap'|'strong'} [o.tier]
 * @param {Array<{role:string,content:string}>} o.messages
 * @param {boolean} [o.json] 要求返回 JSON
 * @param {number} [o.maxTokens]
 * @param {object} [o.schemaHint] JSON 结构提示（拼进 system）
 * @param {number} [o.retries]
 */
export async function chat(o) {
  const cfg = loadConfig();

  // 0) 注入式传输层（DSH 插件模式）：用宿主已配置的模型，无需自备 API key
  if (_transport) {
    try {
      const r = await _transport({
        messages: [...o.messages],
        json: !!o.json,
        schemaHint: o.schemaHint,
        maxTokens: o.maxTokens ?? 2048,
        temperature: o.temperature,
        tier: o.tier || 'cheap',
        timeoutMs: o.timeoutMs || 120000,
      });
      if (r && r.ok) return { ...r, viaHost: true };
      return { ok: false, error: r?.error || '宿主模型调用失败', provider: 'host', model: r?.model || '?', tier: o.tier || 'cheap', usage: { in: 0, out: 0 }, costCny: 0, viaHost: true };
    } catch (e) {
      return { ok: false, error: `宿主模型异常: ${e.message}`, provider: 'host', model: '?', tier: o.tier || 'cheap', usage: { in: 0, out: 0 }, costCny: 0, viaHost: true };
    }
  }

  const providerName = o.provider || cfg.llm.default;
  const p = cfg.llm.providers[providerName];
  if (!p) throw new Error(`未知 LLM provider: ${providerName}`);

  const tier = o.tier || 'cheap';
  const model = o.model || p.models[tier] || p.models.cheap;
  // keyRef 是 config.credentials.keys 里的别名；解析成真实 ref 名再取密钥
  const refName = cfg.credentials?.keys?.[p.keyRef] || p.keyRef;
  const key = getKey(refName);
  if (!key) throw new Error(`缺少凭据 refs.${refName}（${cfg.resolved.credentials}）`);

  const messages = [...o.messages];
  if (o.json) {
    const hint = o.schemaHint ? `\n只输出 JSON，严格符合结构：${JSON.stringify(o.schemaHint)}` : '\n只输出 JSON，不要 markdown 代码块。';
    const sys = messages.find((m) => m.role === 'system');
    if (sys) sys.content += hint; else messages.unshift({ role: 'system', content: hint.trim() });
  }

  const body = {
    model,
    messages,
    temperature: o.temperature ?? 0.3,
    max_tokens: o.maxTokens ?? 2048,
    stream: false,
  };
  if (o.json) body.response_format = { type: 'json_object' };

  const url = p.baseURL.replace(/\/+$/, '') + '/chat/completions';
  const retries = o.retries ?? 2;
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const t0 = Date.now();
      const res = await request(url, {
        headers: { authorization: `Bearer ${key}`, ...(p.headers || {}) },
        body,
        timeoutMs: o.timeoutMs || 120000,
      });
      const text = res?.choices?.[0]?.message?.content ?? '';
      const usage = {
        in: res?.usage?.prompt_tokens ?? 0,
        out: res?.usage?.completion_tokens ?? 0,
      };
      return {
        ok: true, text, provider: providerName, model, tier,
        usage, costCny: costOf(p.pricing?.[tier], usage),
        ms: Date.now() - t0,
        reasoning: res?.choices?.[0]?.message?.reasoning_content ?? null,
      };
    } catch (e) {
      lastErr = e;
      if (e.status && e.status >= 400 && e.status < 500 && e.status !== 429) break; // 参数/鉴权错误不重试
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  return { ok: false, error: String(lastErr?.message || lastErr), provider: providerName, model, tier, usage: { in: 0, out: 0 }, costCny: 0 };
}

/** JSON 输出：容错解析（剥 code fence / 取首个 {...}） */
export function parseJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(t); } catch {}
  const s = t.indexOf('{'); const e = t.lastIndexOf('}');
  if (s >= 0 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch {} }
  return null;
}
