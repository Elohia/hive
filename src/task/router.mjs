// src/task/router.mjs — 前门：内联直答 / 派发 Worker / 升级人工
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../core/config.mjs';
import { chat } from '../core/llm.mjs';
import { emit } from '../core/events.mjs';
import { logger } from '../core/log.mjs';
import { shortHash } from '../core/ids.mjs';
import { q } from '../core/db.mjs';
import { triage } from './triage.mjs';
import { plan } from './planner.mjs';
import {
  getItem, updateItem, listItems, createTask, createApproval, addArtifact, todayCost,
} from './taskcenter.mjs';
import { buildContextText, systemPreamble } from '../context/profile.mjs';

/** 选执行器：默认 dsh（本机已实测可用），代码类优先 pi */
function pickExecutor(t, execs) {
  const has = (n) => execs.includes(n);
  if (t.primaryAction === 'code_change') return has('pi') ? 'pi' : has('dsh') ? 'dsh' : 'llm';
  if (t.level <= 2) return has('dsh') ? 'dsh' : has('pi') ? 'pi' : has('shell') ? 'shell' : 'llm';
  return has('dsh') ? 'dsh' : has('pi') ? 'pi' : 'llm';
}

async function loadExecutors() {
  try { return await import('../executors/index.mjs'); } catch { return null; }
}

async function availableExecutors() {
  const ex = await loadExecutors();
  if (!ex?.probe) return ['llm'];
  try {
    const p = await ex.probe();
    return Object.entries(p).filter(([, v]) => v?.ok).map(([k]) => k);
  } catch { return ['llm']; }
}

function writeArtifact(item, text, suffix = 'conclusion') {  const cfg = loadConfig();
  const dir = cfg.resolved.artifacts;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${item.id}-${suffix}.md`);
  const header = `# ${item.title}\n\n- item: ${item.id}\n- 来源: ${item.source}${item.source_ref ? ' / ' + item.source_ref : ''}\n- 等级: L${item.autonomy_level ?? '?'}\n- 时间: ${new Date().toISOString()}\n\n---\n\n`;
  fs.writeFileSync(file, header + text, 'utf8');
  addArtifact({ item_id: item.id, kind: 'report', title: `${item.title} · ${suffix}`, filePath: file });
  return file;
}

/** L1/L2：内联直答，不落地副作用 */
export async function handleInline(item, t) {
  const cfg = loadConfig();
  const ctxText = buildContextText({ budgetChars: 3500 });
  const action = t.primaryAction;

  const sys = systemPreamble() + `\n\n你现在要做的是「${action}」，自主等级 L${t.level}。`;
  const user = [
    `【事项】${item.title}`,
    item.body ? `【原始信息】\n${item.body.slice(0, 4000)}` : '',
    `【来源】${item.source}${item.source_ref ? ' / ' + item.source_ref : ''}`,
    ctxText ? `【我的上下文】\n${ctxText}` : '',
    '',
    t.level <= 1
      ? '请输出：①一段话概括这件事是什么 ②提取出的待办（若有）③建议归到哪个领域。简洁，不要客套。'
      : '请输出：①问题本质 ②我的选项（2-4 个，各含利弊）③你的建议与理由 ④如果有下一步，具体到「谁在什么时候做什么」。',
  ].filter(Boolean).join('\n\n');

  const r = await chat({
    tier: 'cheap',
    maxTokens: 1400,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    retries: 1,
    timeoutMs: 90000,
  });

  if (!r.ok) {
    updateItem(item.id, { status: 'failed', meta: { ...(item.meta ? JSON.parse(item.meta) : {}), error: r.error } });
    emit({ actor: 'router', type: 'inline.failed', item_id: item.id, level: 'error', message: String(r.error).slice(0, 300) });
    return { route: 'inline', ok: false, error: r.error };
  }

  const file = writeArtifact(item, r.text, `L${t.level}-analysis`);
  const meta = { ...(item.meta ? JSON.parse(item.meta) : {}), conclusion: r.text.slice(0, 4000), conclusionFile: file, costCny: r.costCny };
  updateItem(item.id, {
    status: 'done', bucket: 'active', meta,
  }, { event: { type: 'item.inline_done', actor: 'router', message: `L${t.level} 内联完成 ¥${r.costCny}` } });

  emit({ actor: 'router', type: 'inline.done', item_id: item.id, message: `L${t.level} 内联完成`, data: { tokens: r.usage, cost: r.costCny, file } });
  return { route: 'inline', ok: true, text: r.text, file, costCny: r.costCny };
}

/** 需要人拍板：把决策包成 Approval，附背景/建议/选项 */
export async function escalate(item, t, extra = {}) {
  const options = extra.options || [
    { id: 'approve', label: '批准，按建议执行', detail: 'AI 按推荐方案继续推进' },
    { id: 'revise', label: '改一下再执行', detail: '在备注里写要改什么' },
    { id: 'reject', label: '不做，归档', detail: '关闭这件事' },
  ];
  const ap = createApproval({
    item_id: item.id,
    kind: extra.kind || 'decision',
    title: item.title,
    summary: extra.summary || (item.body ? item.body.slice(0, 500) : t.reason),
    context: {
      level: t.level, reason: t.reason, primaryAction: t.primaryAction,
      source: item.source, source_ref: item.source_ref, priority: item.priority, ...(extra.context || {}),
    },
    options,
    recommendation: extra.recommendation || (options.find((o) => o.recommended)?.label ?? options[0].label),
    risk: extra.risk || (t.level >= 4 ? 'high' : 'medium'),
    ttlHours: extra.ttlHours,
  });
  return ap;
}

/**
 * 处理一个 item 的主入口
 * @returns {{route:'inline'|'dispatch'|'escalate'|'skip', ok:boolean, detail?:any}}
 */
export async function processItem(itemOrId, { force = false, skipApproval = false } = {}) {
  const cfg = loadConfig();
  const item = typeof itemOrId === 'string' ? getItem(itemOrId) : itemOrId;
  if (!item) return { route: 'skip', ok: false, error: 'item 不存在' };
  if (item.status === 'done' || item.status === 'dropped' || item.status === 'archived') {
    return { route: 'skip', ok: true, detail: `已是 ${item.status}` };
  }
  if (item.bucket === 'outbox' && !skipApproval) {
    return { route: 'skip', ok: true, detail: '在 Outbox 等人工' };
  }

  // 预算护栏
  const cost = todayCost();
  if (!force && cost.ratio >= 1) {
    emit({ actor: 'router', type: 'budget.blocked', item_id: item.id, level: 'warn', message: `今日预算已用 ${(cost.ratio * 100).toFixed(0)}%，暂停派单` });
    return { route: 'skip', ok: false, error: 'budget-exhausted', detail: cost };
  }

  const execs = await availableExecutors();

  // 1) 判定等级
  let t;
  if (item.autonomy_level && !force) {
    t = {
      level: item.autonomy_level, confidence: item.confidence ?? 0.7,
      reason: item.level_reason || '(已判定)', primaryAction: 'analyze', actions: [],
      needApproval: item.bucket === 'outbox', capabilitiesMissing: [],
    };
  } else {
    t = await triage(item, { availableExecutors: execs });
    updateItem(item.id, {
      autonomy_level: t.level, confidence: t.confidence, level_reason: t.reason,
      domain: item.domain || t.domain,
      meta: { ...(item.meta ? JSON.parse(item.meta) : {}), actions: t.actions, primaryAction: t.primaryAction },
    }, { event: { type: 'item.triaged', actor: 'triage', message: `L${t.level} (conf ${t.confidence}) ${t.reason}` } });
  }

  emit({ actor: 'router', type: 'route.start', item_id: item.id, message: `L${t.level} action=${t.primaryAction}` });

  // 2) 需要审批：对外/不可逆动作（任意等级），或 L4「关键环节人工确认」
  //    L5 = 端到端自主，只有敏感动作才请示；L1-L3 默认不问人。
  const needsHuman = !skipApproval && (t.needApproval || t.level === 4);
  if (needsHuman) {
    const ap = await escalate(item, t, {
      risk: t.level >= 4 ? 'high' : 'medium',
      recommendation: t.level >= 4
        ? `建议批准：AI 判定 L${t.level}，可自主完成大部分，关键节点会再回来确认。`
        : `该动作含对外/不可逆副作用（${t.primaryAction}），建议先批准再执行。`,
      context: { willUse: t.level >= 3 ? 'dsh/pi 等进程执行器' : 'llm 内联', primaryAction: t.primaryAction },
    });
    emit({ actor: 'router', type: 'route.escalate', item_id: item.id, approval_id: ap.id, level: 'warn', message: '已进 Outbox 等待拍板' });
    return { route: 'escalate', ok: true, approval: ap, triage: t };
  }

  // 3) L1/L2 且不需要真实工具 → 纯推理内联（快、便宜）
  if (t.level <= 2 && !t.needsTools) {
    const r = await handleInline(item, t);
    return { route: 'inline', ...r, triage: t };
  }

  // 4) 需要真实工具 / L3+ → 派发给进程执行器
  const executor = pickExecutor(t, execs);
  const p = await plan({ item, level: t.level, availableExecutors: execs });
  const parent = createTask({
    item_id: item.id, title: item.title, goal: item.body || item.title,
    executor: p.steps[0]?.executor || executor, autonomy_level: t.level,
    priority: item.priority, plan: p.steps,
    timeout_sec: cfg.settings.defaultTimeoutSec,
  });
  updateItem(item.id, { status: 'planned', bucket: 'active' }, { event: { type: 'item.planned', actor: 'router', message: `${p.steps.length} 步` } });

  // 多步任务：每步一个子 task，用 depends_on 串联
  const keyToTask = {};
  const created = [];
  for (let i = 0; i < p.steps.length; i++) {
    const s = p.steps[i];
    // 计划里点名了不可用的执行器 → 回落到本次选定的
    const exName = execs.includes(s.executor) ? s.executor : executor;
    const deps = s.depends_on.map((k) => keyToTask[k]).filter(Boolean);
    const tsk = i === 0 ? parent : createTask({
      item_id: item.id, parent_id: parent.id, title: s.title, goal: s.goal,
      executor: exName, autonomy_level: t.level, priority: item.priority,
      depends_on: deps, timeout_sec: cfg.settings.defaultTimeoutSec,
    });
    if (i === 0) {
      q.run('UPDATE tasks SET plan=?, goal=?, executor=? WHERE id=?',
        JSON.stringify(s), s.goal, exName, tsk.id);
    }
    keyToTask[s.key] = tsk.id;
    created.push({ key: s.key, task: tsk.id, executor: exName, depends_on: s.depends_on });
  }

  emit({ actor: 'router', type: 'route.dispatch', item_id: item.id, task_id: parent.id, message: `派发 ${created.length} 个任务` });
  return { route: 'dispatch', ok: true, triage: t, plan: p, tasks: created };
}

/** 批量：把 inbox 里未判定的都过一遍（低价值只判定不执行） */
export async function triageInbox({ limit = 20, executeMinLevel = 1 } = {}) {
  const items = listItems({ bucket: 'inbox', limit });
  const out = [];
  for (const it of items) {
    try {
      const r = await processItem(it);
      out.push({ id: it.id, title: it.title, route: r.route, level: r.triage?.level ?? it.autonomy_level });
    } catch (e) {
      emit({ actor: 'router', type: 'route.error', item_id: it.id, level: 'error', message: String(e.message).slice(0, 300) });
      out.push({ id: it.id, error: String(e.message) });
    }
  }
  return out;
}
