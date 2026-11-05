// src/context/builder.mjs — 持续理解「我是谁 / 在做什么 / 关注什么 / 欠着什么」
// 从真实信号（事项、仓库、文档、邮件、既有产物）归纳成结构化上下文，写回 context_facts。
import fs from 'node:fs';
import path from 'node:path';
import { q } from '../core/db.mjs';
import { loadConfig } from '../core/config.mjs';
import { chat, parseJson } from '../core/llm.mjs';
import { emit } from '../core/events.mjs';
import { upsertFact, getFacts, buildContextText, systemPreamble } from './profile.mjs';

function since(hours) { return new Date(Date.now() - hours * 3600e3).toISOString(); }

/** 采集原始信号（不调 LLM） */
export function collectSignals({ hours = 168 } = {}) {
  const cfg = loadConfig();
  const sinceIso = since(hours);

  const items = q.all(
    `SELECT id,source,kind,domain,title,priority,autonomy_level,status,bucket,updated_at
     FROM items WHERE updated_at >= ? ORDER BY priority DESC LIMIT 40`, sinceIso
  );
  const bySource = q.all(
    `SELECT source, COUNT(*) n FROM items WHERE updated_at >= ? GROUP BY source ORDER BY n DESC`, sinceIso
  );
  const pending = q.all(`SELECT id,title,kind,domain,priority FROM items WHERE bucket='inbox' ORDER BY priority DESC LIMIT 15`);
  const approvals = q.all(`SELECT id,title,kind,summary FROM approvals WHERE status='pending' ORDER BY created_at DESC LIMIT 8`);
  const failed = q.all(`SELECT id,title,last_error FROM tasks WHERE status='failed' ORDER BY updated_at DESC LIMIT 8`);
  const done = q.all(`SELECT id,title,updated_at FROM items WHERE status='done' AND updated_at >= ? ORDER BY updated_at DESC LIMIT 12`, sinceIso);
  const facts = getFacts();

  return { sinceIso, hours, items, bySource, pending, approvals, failed, done, facts };
}

/** 把信号压成给模型看的紧凑文本 */
function digestSignals(s) {
  const L = [];
  L.push(`时间窗：近 ${s.hours} 小时`);
  L.push(`信息源活跃度：${s.bySource.map((x) => `${x.source}=${x.n}`).join(' ') || '无'}`);
  if (s.pending.length) {
    L.push('\n【Inbox 待处理（按优先级）】');
    for (const i of s.pending) L.push(`- [${i.domain || '-'}/${i.kind}] ${i.title}`);
  }
  if (s.approvals.length) {
    L.push('\n【等我拍板】');
    for (const a of s.approvals) L.push(`- ${a.title}`);
  }
  if (s.done.length) {
    L.push('\n【近期已完成】');
    for (const d of s.done) L.push(`- ${d.title}`);
  }
  if (s.failed.length) {
    L.push('\n【失败待处理】');
    for (const f of s.failed) L.push(`- ${f.title}：${String(f.last_error || '').slice(0, 60)}`);
  }
  if (s.items.length) {
    L.push('\n【高优先级事项】');
    for (const i of s.items.slice(0, 15)) L.push(`- (${i.source}) ${i.title}`);
  }
  if (s.facts.length) {
    L.push('\n【已知的个人事实】');
    for (const f of s.facts.slice(0, 25)) L.push(`- [${f.category}] ${f.key}=${f.value}`);
  }
  return L.join('\n');
}

const SCHEMA = {
  identity: { role: 'string', responsibilities: ['string'], constraints: ['string'] },
  current_focus: [{ what: 'string', evidence: 'string', confidence: '0-1' }],
  open_loops: [{ what: 'string', why_stuck: 'string', next_action: 'string' }],
  interests: ['string'],
  habits: ['string'],
  risks: [{ what: 'string', severity: 'low|medium|high' }],
  opportunities: [{ what: 'string', why_now: 'string' }],
};

/**
 * 刷新个人上下文（会调一次便宜模型）
 * @returns {{ok:boolean, wrote:number, summary:object, error?:string}}
 */
export async function refreshContext({ hours = 168, dryRun = false } = {}) {
  const s = collectSignals({ hours });
  const digest = digestSignals(s);

  if (!s.items.length && !s.facts.length) {
    return { ok: false, wrote: 0, summary: null, error: '信号太少，无法归纳（先跑 hive scan）' };
  }

  const r = await chat({
    tier: 'cheap',
    json: true,
    maxTokens: 1400,
    schemaHint: SCHEMA,
    messages: [
      {
        role: 'system',
        content: systemPreamble() + `\n你是「上下文归纳器」。根据真实的系统信号，归纳用户此刻的工作状态。
铁律：只写信号里能支撑的结论；没证据就留空数组，绝不编造。
evidence 字段必须引用信号里的具体标题片段。`,
      },
      { role: 'user', content: digest },
    ],
  });

  if (!r.ok) {
    emit({ actor: 'context', type: 'context.refresh.failed', level: 'error', message: String(r.error).slice(0, 300) });
    return { ok: false, wrote: 0, summary: null, error: r.error };
  }
  const j = parseJson(r.text);
  if (!j) {
    return { ok: false, wrote: 0, summary: null, error: 'LLM 输出不可解析: ' + String(r.text).slice(0, 200) };
  }

  let wrote = 0;
  const put = (category, key, value, evidence, confidence = 0.7) => {
    if (value == null || value === '' || (Array.isArray(value) && !value.length)) return;
    wrote++;
    if (dryRun) return;
    upsertFact({ category, key, value: typeof value === 'string' ? value : JSON.stringify(value), evidence, confidence });
  };

  if (j.identity) {
    put('role', 'role', j.identity.role, 'context-builder', 0.8);
    put('role', 'responsibilities', j.identity.responsibilities, 'context-builder', 0.75);
    put('constraint', 'constraints', j.identity.constraints, 'context-builder', 0.7);
  }
  if (Array.isArray(j.current_focus)) {
    put('focus', 'current_focus', j.current_focus.map((x) => x.what), JSON.stringify(j.current_focus.map((x) => x.evidence)), 0.75);
  }
  if (Array.isArray(j.open_loops)) put('loop', 'open_loops', j.open_loops, 'inbox+failed', 0.7);
  if (Array.isArray(j.interests)) put('interest', 'interests', j.interests, 'signals', 0.65);
  if (Array.isArray(j.habits)) put('habit', 'habits', j.habits, 'signals', 0.6);
  if (Array.isArray(j.risks)) put('risk', 'risks', j.risks, 'signals', 0.7);
  if (Array.isArray(j.opportunities)) put('opportunity', 'opportunities', j.opportunities, 'signals', 0.6);

  if (!dryRun) {
    put('meta', 'last_refresh', new Date().toISOString(), 'context-builder', 1.0);
    put('meta', 'signal_summary', { items: s.items.length, pending: s.pending.length, approvals: s.approvals.length, failed: s.failed.length, sources: s.bySource }, 'context-builder', 1.0);
  }

  emit({
    actor: 'context', type: 'context.refreshed', message: `归纳 ${wrote} 项 · 花费 ¥${r.costCny}`,
    data: { wrote, cost: r.costCny, dryRun },
  });

  return { ok: true, wrote, summary: j, costCny: r.costCny, digest };
}

/** 给 CLI 用：把上下文打印成人类可读 */
export function renderContext() {
  const facts = getFacts();
  if (!facts.length) return '（上下文为空，先跑 `hive context --refresh`）';
  const byCat = {};
  for (const f of facts) (byCat[f.category] ||= []).push(f);
  const out = [];
  for (const [cat, arr] of Object.entries(byCat)) {
    out.push(`\n## ${cat}`);
    for (const f of arr) out.push(`- ${f.key}: ${f.value}`);
  }
  return out.join('\n');
}

/** 把外部既有资产（elohia 画像/世界观的要点）作为初始事实种子，只需跑一次 */
export function seedBaselineFacts() {
  const cfg = loadConfig();
  const seeds = [
    ['role', 'role', '土木工程（工地/机电）为主业，同时做 AI Agent 工程、量化交易与内容创作', 'C:/HIVE-SAMPLE/workspace\\docs\\WORLDVIEW.md'],
    ['constraint', 'time', '时间稀缺：有家庭责任与主业，能投入副业的时间碎片化', 'C:/HIVE-SAMPLE/workspace\\AGENTS.md'],
    ['preference', 'communication', '中文交流；结论先行；厌恶空话与恭维；要求「对就是对，错就是错」', 'C:/HIVE-SAMPLE/dsh-home\\AGENTS.md'],
    ['preference', 'decision_style', '谋而后动、后发先至；大计划常以「要不…」试探后停在口头（历史兑现率低）', 'C:/HIVE-SAMPLE/workspace\\reports\\P8-未竟之事v0.md'],
    ['interest', 'tech', 'Agent 架构 / 记忆系统 / 工具链编排 / 可复用积木', 'C:/HIVE-SAMPLE/workspace\\docs\\WORLDVIEW.md'],
    ['interest', 'trade', 'A股量化、趋势交易、盘面与题材', 'C:/HIVE-SAMPLE/automations'],
  ];
  let n = 0;
  for (const [cat, key, val, ev] of seeds) {
    const exists = q.get('SELECT 1 FROM context_facts WHERE category=? AND key=?', cat, key);
    if (exists) continue;
    upsertFact({ category: cat, key, value: val, evidence: ev, confidence: 0.85 });
    n++;
  }
  return n;
}
