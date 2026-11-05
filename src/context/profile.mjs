// src/context/profile.mjs — 个人上下文聚合（谁、在做什么、关注什么、还欠什么）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { q } from '../core/db.mjs';
import { loadConfig } from '../core/config.mjs';
import { emit } from '../core/events.mjs';

const read = (p, max = 4000) => {
  try { return fs.readFileSync(p, 'utf8').slice(0, max); } catch { return null; }
};

const EXTERNAL_SOURCES = [
  // [类别, 路径, 截断, 说明]
  ['worldview', 'D:\\elohia\\docs\\WORLDVIEW.md', 2500, '内核档案（世界观/决策规则）'],
  ['persona', 'D:\\elohia\\reports\\P1-人格画像v3-我是谁.md', 1800, '人格画像 v3'],
  ['projects', 'D:\\pi-agent\\AGENTS.md', 1200, 'pi-agent 项目约定'],
  ['projects', 'D:\\hive\\AGENTS.md', 900, '本系统约定'],
];

/** 从 context_facts 表读结构化事实 */
export function getFacts() {
  return q.all('SELECT * FROM context_facts ORDER BY category, key');
}

export function upsertFact({ category, key, value, evidence, confidence = 0.7 }) {
  // id 必须从完整 (category,key) 派生 —— 之前只取 hex 前 20 位会把
  // preference:communication 和 preference:decision_style 撞成同一个 id
  const id = 'cf_' + crypto.createHash('sha256').update(`${category}\u0000${key}`).digest('hex').slice(0, 24);
  const ts = new Date().toISOString();
  q.run(
    `INSERT INTO context_facts(id,category,key,value,evidence,confidence,updated_at) VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(category,key) DO UPDATE SET value=excluded.value, evidence=excluded.evidence,
       confidence=excluded.confidence, updated_at=excluded.updated_at`,
    id, category, key, String(value), evidence ?? null, confidence, ts
  );
  emit({ actor: 'context', type: 'context.fact.updated', message: `${category}/${key}` });
  return q.get('SELECT * FROM context_facts WHERE category=? AND key=?', category, key);
}

/** 最近 7 天的活动指纹：哪些项目有动静 */
export function recentActivity() {
  const since = new Date(Date.now() - 7 * 86400e3).toISOString();
  const bySource = q.all(
    `SELECT source, COUNT(*) n, MAX(updated_at) last FROM items WHERE updated_at >= ? GROUP BY source ORDER BY n DESC`, since
  );
  const topItems = q.all(
    `SELECT id,title,domain,kind,priority,source FROM items WHERE updated_at >= ? ORDER BY priority DESC LIMIT 8`, since
  );
  return { bySource, topItems };
}

/** 未完成的事：Inbox 里 high priority + 历史未竟（来自 elohia 未竟之事库，若存在） */
export function openLoops() {
  const inbox = q.all(
    "SELECT id,title,kind,domain,priority,autonomy_level FROM items WHERE bucket='inbox' ORDER BY priority DESC LIMIT 10"
  );
  const pendingApprovals = q.all("SELECT id,title,kind FROM approvals WHERE status='pending' ORDER BY created_at DESC LIMIT 5");
  const failedTasks = q.all("SELECT id,title,last_error FROM tasks WHERE status='failed' ORDER BY updated_at DESC LIMIT 5");
  return { inbox, pendingApprovals, failedTasks };
}

/** 拼出可注入 prompt 的上下文文本（有 token 预算） */
export function buildContextText({ budgetChars = 6000, include = ['facts', 'activity', 'loops', 'external'] } = {}) {
  const parts = [];
  const push = (s) => { if (s) parts.push(s); };

  if (include.includes('facts')) {
    const facts = getFacts();
    if (facts.length) {
      push('【个人事实】\n' + facts.map((f) => `- [${f.category}] ${f.key}：${f.value}`).join('\n'));
    }
  }

  if (include.includes('activity')) {
    const a = recentActivity();
    if (a.bySource.length) {
      push('【近 7 天信息源活跃度】\n' + a.bySource.map((x) => `- ${x.source}: ${x.n} 条`).join('\n'));
    }
    if (a.topItems.length) {
      push('【当前最高优先级事项】\n' + a.topItems.map((x) => `- L${x.autonomy_level ?? '?'} ${x.title} (${x.domain || '-'}/${x.kind}, ${x.priority})`).join('\n'));
    }
  }

  if (include.includes('loops')) {
    const l = openLoops();
    if (l.pendingApprovals.length) push('【等我拍板】\n' + l.pendingApprovals.map((x) => `- ${x.title}`).join('\n'));
    if (l.failedTasks.length) push('【失败待处理】\n' + l.failedTasks.map((x) => `- ${x.title}：${(x.last_error || '').slice(0, 80)}`).join('\n'));
  }

  if (include.includes('external')) {
    const cfg = loadConfig();
    for (const [cat, p, max, desc] of EXTERNAL_SOURCES) {
      if (!fs.existsSync(p)) continue;
      // 同一路径不重复读
      if (parts.some((x) => x.includes(`来源文件：${p}`))) continue;
      const t = read(p, max);
      if (t) push(`【${desc}】（来源文件：${p}）\n${t}`);
    }
  }

  let out = parts.join('\n\n');
  if (out.length > budgetChars) out = out.slice(0, budgetChars) + '\n…（已截断）';
  return out;
}

/** 系统提示：让任何执行器都「认识我」 */
export function systemPreamble() {
  return [
    '你是 HIVE——用户的主动服务型智能体。用户是张健（elohia）：土木工程背景，同时做 AI/量化/内容创作，',
    '有家庭责任，时间稀缺，讨厌空话与恭维，要求「对就是对，错就是错」。',
    '你的输出要：结论先行、给可执行动作、标明不确定处、能引用证据就引用。',
    '不要编造事实；宁可说「不知道」。',
  ].join('');
}

/** 每日一页：给「晨报」用的摘要 */
export function dailyBrief() {
  const ctx = buildContextText({ budgetChars: 3500 });
  const stats = {
    inbox: q.get("SELECT COUNT(*) n FROM items WHERE bucket='inbox'")?.n ?? 0,
    outbox: q.get("SELECT COUNT(*) n FROM approvals WHERE status='pending'")?.n ?? 0,
    running: q.get("SELECT COUNT(*) n FROM tasks WHERE status='running'")?.n ?? 0,
    done24h: q.get("SELECT COUNT(*) n FROM items WHERE status='done' AND updated_at >= ?", new Date(Date.now() - 86400e3).toISOString())?.n ?? 0,
  };
  return { stats, contextText: ctx };
}
