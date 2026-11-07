// src/task/triage.mjs — L1..L5 自主等级判定（确定性优先，本地 JEV 预筛，LLM 仅在低置信时兜底）
import { q } from '../core/db.mjs';
import { loadConfig } from '../core/config.mjs';
import { chat, parseJson } from '../core/llm.mjs';
import * as jev from '../triage/jev.mjs';

/** 动作意图关键词表：命中即认为请求包含该动作。顺序 = 优先级（越靠后越“重”）
 *  英文一律加 \b 词边界 —— 否则 `post` 会命中 "PostMaster"，`read` 会命中 "already"。 */
const ACTION_RULES = [
  { action: 'read',      re: /(查看|读取|看一下|有啥|有什么|列出|查一下|\blist\b|\bshow\b|\bread\b|\bcheck\b)/i },
  { action: 'summarize', re: /(总结|摘要|归纳|整理|提取|待办|梳理|\bsummari[sz]e\b|\bdigest\b|\bextract\b|\broundup\b)/i },
  { action: 'classify',  re: /(分类|打标|归类|判定类型|\bclassify\b|\btag\b)/i },
  { action: 'analyze',   re: /(分析|评估|判断|对比|诊断|复盘|为什么|原因|\banaly[sz]e\b|\bassess\b|\breview\b|\bdiagnos)/i },
  { action: 'plan',      re: /(方案|计划|规划|路线|怎么办|如何|建议|\bpropose\b|\bplan\b|\bproposal\b|\brecommend\b)/i },
  { action: 'draft',     re: /(起草|草稿|写一篇|拟|撰写|文案|大纲|\bdraft\b|\boutline\b|\bcompose\b)/i },
  { action: 'write_local', re: /(生成|写入|保存|导出|建个文件|\bmake a file\b|\bwrite\b|\bexport\b|\bgenerate\b)/i },
  { action: 'research',  re: /(调研|研究|搜集|查资料|对比资料|\bresearch\b|\bsurvey\b|\binvestigate\b)/i },
  { action: 'code_change', re: /(改代码|修 ?bug|修复|实现功能|重构|提交代码|\bfix bug\b|\bimplement\b|\brefactor\b|\bcommit\b)/i },
  { action: 'send_external', re: /(发送|回复邮件|发给|通知对方|联系对方|\bsend\b|\breply\b|\bemail to\b|\bmail to\b)/i },
  { action: 'publish',   re: /(发布|发推|发帖|上传|公开|\bpublish\b|\btweet\b|\brelease to prod\b)/i },
  { action: 'delete',    re: /(删除|清空|移除|\bdelete\b|\bremove\b|\bpurge\b)/i },
  { action: 'spend',     re: /(购买|订阅|充值|付费|下单|\bbuy\b|\bpurchase\b|\bsubscribe\b|\bpay\b)/i },
  { action: 'deploy',    re: /(部署|上线|\bdeploy\b)/i },
];

const DOMAIN_RULES = [
  ['trade',   /(持仓|股票|仓位|大盘|交易|止损|量化|基金|A股|盘面|买入|卖出|stock|trade|position)/i],
  ['work',    /(领导|项目|方案|汇报|工地|甲供|施工|图纸|验收|驻场|会议|deadline|经理|同事)/i],
  ['startup', /(创业|合伙|注册公司|股权|融资|副业|变现|商业模式|startup|co-?found)/i],
  ['content', /(小红书|抖音|视频号|公众号|选题|脚本|封面|发布|涨粉|content|video|script)/i],
  ['ai',      /(agent|模型|prompt|llm|大模型|微调|训练|推理|ai |智能体)/i],
  ['family',  /(老婆|孩子|家人|父母|体检|生日|结婚|family|wife|kid)/i],
  ['life',    /(搬家|装修|旅行|健身|睡眠|健康|生活|life|home)/i],
];

export function guessDomain(text = '') {
  for (const [d, re] of DOMAIN_RULES) if (re.test(text)) return d;
  return null;
}

export function guessActions(text = '', hints = []) {
  const acts = new Set(hints);
  for (const r of ACTION_RULES) if (r.re.test(text)) acts.add(r.action);
  if (acts.size === 0) acts.add('read');
  return [...acts];
}

/** 取“最重”的动作作为判定基准（风险由最危险的那一步决定） */
export function heaviestAction(actions, byOrder) {
  let best = 'read', bestScore = -1;
  const order = byOrder.filter((a) => actions.includes(a));
  for (const a of order) {
    const idx = byOrder.indexOf(a);
    if (idx > bestScore) { bestScore = idx; best = a; }
  }
  return best;
}

function historicalSuccess(domain, kind) {
  const since = new Date(Date.now() - 60 * 86400e3).toISOString();
  const r = q.get(
    `SELECT COUNT(*) n, SUM(CASE WHEN t.status='succeeded' THEN 1 ELSE 0 END) ok
     FROM tasks t LEFT JOIN items i ON i.id=t.item_id
     WHERE t.updated_at >= ? AND (i.domain IS ? OR i.domain IS NULL) AND (i.kind = ? OR ? IS NULL)`,
    since, domain ?? null, kind ?? null, kind ?? null
  );
  const n = r?.n || 0;
  const ok = r?.ok || 0;
  return { n, rate: n ? ok / n : 0 };
}

function hasApprovedPattern(kind) {
  const r = q.get("SELECT COUNT(*) n FROM approvals WHERE kind=? AND status='approved'", kindToApproval(kind));
  return (r?.n || 0) > 0;
}

function kindToApproval(kind) {
  const map = { decision: 'decision', risk: 'decision', todo: 'decision', issue: 'decision', opportunity: 'decision', fyi: 'decision' };
  return map[kind] || 'decision';
}

const LOCAL_REF = /(D:\\|F:\\|C:\\|仓库|\brepo\b|项目|代码|文件|目录|workspace|\.mjs|\.md|\.json|\.ts|\.py|\bgit\b|分支|提交|测试|跑一下|运行)/i;

/**
 * 判定
 * @returns {{level:number, confidence:number, reason:string, actions:string[], primaryAction:string,
 *            needApproval:boolean, capabilitiesMissing:string[], byLlm:boolean, needsTools:boolean}}
 */
export async function triage(item, { availableExecutors = [], allowLlm = true } = {}) {
  const cfg = loadConfig();
  const P = cfg.policies;
  const actionOrder = Object.keys(P.actions); // 按声明顺序 = 由轻到重
  const text = `${item.title || ''}\n${item.body || ''}`;
  const hints = Array.isArray(item.meta?.actions) ? item.meta.actions : (item.meta ? JSON.parse(item.meta)?.actions || [] : []);
  const actions = guessActions(text, hints);
  const primary = heaviestAction(actions, actionOrder);
  const base = P.actions[primary]?.base ?? 2;

  const reasons = [`动作「${primary}」基准 L${base}`];
  let level = base;
  let needApproval = !!P.actions[primary]?.approval;

  // 下调：不可逆 / 对外可见 / 大额 / 低置信
  const meta = item.meta ? (typeof item.meta === 'string' ? JSON.parse(item.meta) : item.meta) : {};
  if (meta.irreversible && level > P.modifiers.irreversible.cap) {
    level = P.modifiers.irreversible.cap; reasons.push('不可逆 → 封顶 L' + level);
  }
  if (meta.external_visible && level > P.modifiers.external_visible.cap) {
    level = P.modifiers.external_visible.cap; reasons.push('对外可见 → 封顶 L' + level);
    needApproval = true;
  }
  if (typeof meta.amountCny === 'number' && meta.amountCny > P.modifiers.spend_over_cny.threshold) {
    if (level > P.modifiers.spend_over_cny.cap) { level = P.modifiers.spend_over_cny.cap; reasons.push(`金额 ¥${meta.amountCny} → 封顶 L${level}`); }
    needApproval = true;
  }

  // 上调：历史成功率高 / 已有同型审批
  const hist = historicalSuccess(item.domain, item.kind);
  if (hist.n >= P.promotions.proven_success_rate.minSamples && hist.rate >= P.promotions.proven_success_rate.rate) {
    level = Math.min(5, level + P.promotions.proven_success_rate.bump);
    reasons.push(`同类成功率 ${(hist.rate * 100).toFixed(0)}% (n=${hist.n}) → +1`);
  }
  if (hasApprovedPattern(item.kind)) {
    level = Math.min(5, level + P.promotions.approved_pattern.bump);
    reasons.push('已有同型审批通过 → +1');
  }

  // 上限
  const ceiling = item.autonomy_ceiling ?? 5;
  if (level > ceiling) { level = ceiling; reasons.push(`受策略上限 L${ceiling} 约束`); }

  // 置信度：规则命中的动作数量 + 关键词密度
  const hitCount = ACTION_RULES.filter((r) => r.re.test(text)).length;
  let confidence = Math.min(0.95, 0.55 + hitCount * 0.08 + (item.kind ? 0.08 : 0));

  let byLlm = false;
  let byJev = false;
  let jevSignal = null;

  // ① 本地 JEV 预筛：零 token、热点 300–800ms。
  //    ⚠ 它做不了「L1–L5 抽象多档」判定（实测概率近似均匀，topProb 0.28–0.31 / 基线 0.2），
  //    所以这里只用它的两个**具体二元**信号：噪音概率、是否需要外部动作。
  if (jev.shouldUseJev(loadConfig(), item)) {
    try {
      const j = await jev.judge(item, {});
      if (j) {
        jevSignal = j;
        // 噪音 → 直接压到 L1（它是 noul 二元题，0.8 以上才算明确）
        if (j.noiseDecided) {
          const before = level;
          level = 1;
          reasons.push(`JEV 判为噪音（P=${j.noise}，${j.ms}ms，零 token）→ 压到 L1${before > 1 ? `（原 L${before}）` : ''}`);
          byJev = true;
        } else if (j.actDecided && j.kind === 'act') {
          // 明确的「需外部动作」→ 只做提示，等级仍由规则决定（小模型不拍等级）
          reasons.push(`JEV 判「需外部动作」（P=${j.act}，${j.ms}ms）`);
        } else if (j.noise !== null && j.noise < 0.3) {
          reasons.push(`JEV 判「非噪音」（P(噪音)=${j.noise}）`);
        }
        // 参考证据（不参与决策）
        if (j.level) reasons.push(`JEV 参考等级 L${j.level}（topProb ${j.levelTopProb}，仅参考）`);
      }
    } catch { /* JEV 不可用绝不影响判定 */ }
  }

  // ② 大模型兜底：JEV 没给出结论、且规则置信仍低时才烧 token
  if (!byJev && confidence < 0.6 && allowLlm) {
    try {
      const r = await chat({
        tier: 'cheap',
        maxTokens: 260,
        json: true,
        schemaHint: { level: '1-5', action: 'read|summarize|analyze|plan|draft|write_local|code_change|send_external|publish|delete|spend|deploy|research', confidence: '0-1', reason: 'string' },
        messages: [
          { role: 'system', content: '你是任务自主等级判定器。L1只读整理 L2分析建议 L3产出中间成果 L4大部分自主+关键确认 L5端到端自主交付。只输出 JSON。' },
          { role: 'user', content: `标题：${item.title}\n内容：${(item.body || '').slice(0, 800)}\n来源：${item.source}\n判定 L1-L5 与主动作。` },
        ],
      });
      if (r.ok) {
        const j = parseJson(r.text);
        if (j && Number.isFinite(+j.level)) {
          const ll = Math.max(1, Math.min(5, Math.round(+j.level)));
          const agree = ll === level;
          // LLM 只在“更保守”或“规则置信低”时生效，且需保守取小
          level = Math.min(level, ll);
          confidence = Math.max(0.62, Math.min(0.9, +j.confidence || 0.7));
          reasons.push(`LLM 判 L${ll}${agree ? '（一致）' : '，取保守值'}：${String(j.reason || '').slice(0, 80)}`);
          byLlm = true;
        }
      }
    } catch { /* 降级为纯规则 */ }
  }

  // 能力闸门：所需执行器不在本机 → 降到 L2
  const need = primary === 'code_change' ? ['dsh', 'pi'] : (level >= 4 ? ['dsh'] : []);
  const missing = need.filter((e) => !availableExecutors.includes(e));
  if (missing.length) {
    level = Math.min(level, 2);
    reasons.push(`缺执行器 [${missing.join(',')}] → 降级 L2`);
  }

  if (P.side_effect_actions.includes(primary)) needApproval = true;

  // 需要真实工具（读本地文件/跑命令）——纯 LLM 内联干不了
  const needsTools = LOCAL_REF.test(text) || ['code_change', 'write_local', 'research'].includes(primary);

  level = Math.max(1, Math.min(5, level));

  return {
    level, confidence: +confidence.toFixed(2), reason: reasons.join('；'),
    actions, primaryAction: primary, needApproval, capabilitiesMissing: missing, byLlm, needsTools,
    byJev, jev: jevSignal,
    triageSource: byJev ? 'jev' : (byLlm ? 'llm' : 'rule'),
    domain: item.domain || guessDomain(text),
  };
}
