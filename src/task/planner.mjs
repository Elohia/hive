// src/task/planner.mjs — 复杂任务拆解（LLM → 子任务 + 依赖图）
import { chat, parseJson } from '../core/llm.mjs';
import { emit } from '../core/events.mjs';

const PLAN_SCHEMA = {
  steps: [
    {
      key: 'string 唯一短标识',
      title: '一句话',
      goal: '这一步要达成什么（可验收）',
      executor: 'llm|dsh|pi|codex|claude|shell',
      depends_on: ['key'],
      deliverable: '产出物形式（文件/结论/变更）',
    },
  ],
  need_human: ['需要在开工前问人的点'],
  risk: 'low|medium|high',
};

/**
 * 拆解一个任务为 DAG
 * @returns {{steps:Array, need_human:string[], risk:string, byLlm:boolean}}
 */
export async function plan({ item, level, availableExecutors = [], maxSteps = 4 } = {}) {
  const title = item?.title || '任务';
  const body = (item?.body || '').slice(0, 2000);
  const execs = availableExecutors.length ? availableExecutors.join(',') : 'llm,dsh';

  const r = await chat({
    tier: 'cheap',
    json: true,
    maxTokens: 900,
    schemaHint: PLAN_SCHEMA,
    messages: [
      {
        role: 'system',
        content: `你是任务规划器。把任务拆成 1-${maxSteps} 个可验收的步骤，形成 DAG（depends_on 引用 key）。
可用执行器：${execs}。规则：
- llm 适合纯思考/写作/分析（快、便宜）；dsh/pi/codex 适合需要读写文件/跑命令/改代码。
- 第一步优先「取证/读现状」，最后一步优先「验证产物」。
- 如果任务根本不需要拆，就返回 1 个步骤。
- 只输出 JSON。`,
      },
      { role: 'user', content: `任务：${title}\n\n背景：${body}\n\n自主等级：L${level}` },
    ],
  });

  if (!r.ok) {
    return { steps: [{ key: 's1', title, goal: title, executor: level >= 3 ? 'dsh' : 'llm', depends_on: [], deliverable: '结论' }], need_human: [], risk: 'medium', byLlm: false, note: r.error };
  }
  const j = parseJson(r.text);
  if (!j || !Array.isArray(j.steps) || !j.steps.length) {
    return { steps: [{ key: 's1', title, goal: title, executor: level >= 3 ? 'dsh' : 'llm', depends_on: [], deliverable: '结论' }], need_human: [], risk: 'medium', byLlm: false, note: 'LLM 输出不可解析' };
  }
  const steps = j.steps.slice(0, maxSteps).map((s, i) => ({
    key: String(s.key || `s${i + 1}`).slice(0, 24),
    title: String(s.title || `步骤${i + 1}`).slice(0, 120),
    goal: String(s.goal || s.title || '').slice(0, 400),
    executor: ['llm', 'dsh', 'pi', 'codex', 'claude', 'shell'].includes(s.executor) ? s.executor : (level >= 3 ? 'dsh' : 'llm'),
    depends_on: Array.isArray(s.depends_on) ? s.depends_on.map(String).slice(0, 4) : [],
    deliverable: String(s.deliverable || '').slice(0, 120),
  }));
  // 断环：依赖只允许指向前面的步骤
  const seen = new Set();
  for (const s of steps) {
    s.depends_on = s.depends_on.filter((d) => seen.has(d));
    seen.add(s.key);
  }
  emit({ actor: 'router', type: 'plan.built', item_id: item?.id, message: `${steps.length} 步 · risk=${j.risk || 'medium'}`, data: { steps: steps.map((s) => s.key + ':' + s.executor) } });
  return { steps, need_human: Array.isArray(j.need_human) ? j.need_human.slice(0, 5) : [], risk: j.risk || 'medium', byLlm: true };
}

/** 每个步骤要注入的 prompt */
export function stepPrompt({ item, planSteps, step, prevResults = {} }) {
  const lines = [
    `任务：${item.title}`,
  ];
  if (item.body) lines.push(`背景：\n${item.body.slice(0, 2000)}`);
  lines.push(`当前步骤（${step.key}）：${step.title}`);
  lines.push(`这一步的目标：${step.goal}`);
  if (step.deliverable) lines.push(`期望产出：${step.deliverable}`);
  const prev = planSteps.filter((s) => step.depends_on.includes(s.key));
  if (prev.length) {
    lines.push('前置步骤结果：');
    for (const p of prev) {
      const r = prevResults[p.key];
      lines.push(`- ${p.title}: ${r ? String(r).slice(0, 800) : '(无)'}`);
    }
  }
  lines.push('\n要求：只用你自己的工具完成这一步，最后用一段话给出「本步结论 + 产出在哪」。不要做后续步骤的事。');
  return lines.join('\n');
}
