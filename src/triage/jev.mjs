// src/triage/jev.mjs — 本地 JEV（TypeSafe System One）决策模型客户端
//
// 为什么用它：本地 `jevlocal-0.5b` 是 0.5B 小模型，跑在 RTX2060 上，**热点 300–800ms、零 token 成本**。
// 它能给出三原语（noul 是非概率 / choice 多选 / score 分级），并自带**校准过的置信度**
// （1220 题实测：高置信带 acc 88%、低置信带 5%）。
//
// 所以接法不是「让 0.5B 替大模型做判定」——它中文领域知识弱（A股舆情域仅 5–35%），
// 而是：**当快速预判器**——高置信才拍板（省一次大模型调用），低置信就如实把活儿交回去，
// 同时把它的信号（紧急度/是否需要外部动作）记进判定证据里，供人事后核对。
//
// 契约（与官方 Jev/OpenJev wire 同构，见 D:\00-fish\jev-clone\docs\contract.md）：
//   POST /v1/systemone { model, state, questions: { qid: {type:'noul'|'choice'|'score', instructions, criteria} } }
//   返回 { model, answers: { qid: { noul } | { choice, probabilities, confidence } | { score, legend, probabilities, confidence } }, usage }
//
// 依赖边界：不 import Python、不读 .env；纯 HTTP。服务不在就静默降级（返回 null），绝不挡住判定主流程。
import { loadConfig } from '../core/config.mjs';

export const L1_TO_L5 = [
  '1 只需理解并归档，无后续动作',
  '2 需要分析并给出建议，不产生外部副作用',
  '3 可产出一部分交付物，需人确认后使用',
  '4 可基本自主推进，关键节点需人确认',
  '5 可端到端自主完成并自行验证',
];

export const JEV_DEFAULTS = {
  // 默认关闭，且 mode='off'。原因不是「没起服务」，而是**实测它对本项目的判定没有判别力**：
  //   · L1–L5 五档：topProb 0.28–0.36（基线 0.2，近似均匀）
  //   · 噪音 noul：退信 0.500 / 营销 0.608 / 真实合同 0.637 —— 三者挤在一起，分不开
  //   · 是否外部动作：0.569 / 0.657 / 0.672 —— 同样分不开
  // 它的 85% 是 sst2 影评情感（具体二元、in-domain），换成本项目的任务即 out-of-distribution。
  // 保留本模块的价值：① 记录这次负结果，防止后人再踩；② 你其他英文二元判定任务可直接复用 judge()。
  enabled: false,                       // 想试就改成 true + mode='always'，但别指望它能替代规则/大模型
  endpoint: 'http://127.0.0.1:8931',
  model: 'jevlocal-0.5b',
  timeoutMs: 25000,                     // 冷启动现载模型要 ~77s，所以只在「探活」时给长超时，判定给短超时
  minConfidence: 0.55,                  // 兼容字段（历史）；真正拍板判据用 minTopProb
  // ⚠ 关键：不要用 confidence 当拍板阈值。
  //   confidence = 1 − H(p)/lnK，K 是**选项数**。5 档 score 的 confidence 上限只有 ~0.24
  //   （最确定的情况 p=[0.6,.1,.1,.1,.1] 也只有 0.237），拿 0.55 去比永远不达标。
  //   所以拍板看「最高档概率」 topProb，它不受 K 影响。
  minTopProb: 0.5,
  minNoiseProb: 0.8,                    // noul 噪音判据：二元题，0.8 以上才算明确
  // 语种分流：jevlocal-0.5b 的能力边界是「英文强、中文弱」
  //   （1200+ 题实测：sst2 85% / agnews 68%，但中文 A股舆情域仅 5–35%）
  //   本机在真实中文事项上实测自报置信 0.01–0.04，等于没信息，还会白花 1–12s。
  //   所以默认只在「英文为主」的事项上用它；always = 无视语种全用（自己机器上做对比实验时开）。
  mode: 'off',                          // 'off' | 'english' | 'always'（默认 off，理由见 enabled 注释）
};

/** 粗判文本语种：ASCII 字母占比 + 是否含中日韩字符 */
export function looksEnglish(text) {
  const s = String(text || '');
  if (!s) return false;
  if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(s)) return false; // 含 CJK 一律不算
  const letters = s.replace(/[^A-Za-z]/g, '').length;
  const total = s.replace(/\s/g, '').length || 1;
  return letters / total > 0.5;
}

/** 该不该为这条事项调用 JEV */
export function shouldUseJev(cfg, item) {
  const jc = jevConfig(cfg);
  if (!jc.enabled || jc.mode === 'off') return false;
  if (jc.mode === 'always') return true;
  return looksEnglish(`${item?.title || ''} ${item?.body || ''}`);
}

export function jevConfig(cfg) {
  const c = cfg?.triage?.jev || {};
  return { ...JEV_DEFAULTS, ...c };
}

function stateOf(item) {
  const lines = [
    `来源: ${item.source || 'unknown'}`,
    `标题: ${String(item.title || '').slice(0, 300)}`,
  ];
  const body = String(item.body || '').trim();
  if (body) lines.push(`内容: ${body.slice(0, 900)}`);
  if (item.kind) lines.push(`类别: ${item.kind}`);
  if (item.urgency) lines.push(`自报紧急度: ${item.urgency}`);
  if (item.impact) lines.push(`自报影响: ${item.impact}`);
  return lines.join('\n');
}

/** 探活：冷启动会现载模型（~77s），所以这里给足超时并如实报告 loaded */
export async function health(cfg, { timeoutMs = 90000 } = {}) {
  const jc = jevConfig(cfg);
  const t0 = Date.now();
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const r = await fetch(`${jc.endpoint}/health`, { signal: ac.signal });
    clearTimeout(timer);
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}`, ms: Date.now() - t0, endpoint: jc.endpoint };
    const j = await r.json();
    return { ok: j.status === 'ok', model: j.model, loaded: !!j.loaded, ms: Date.now() - t0, endpoint: jc.endpoint };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), ms: Date.now() - t0, endpoint: jc.endpoint };
  }
}

/**
 * 让 JEV 判一条事项。
 *
 * ⚠ 实测结论（先看这段，别再把 level 当决策用）：
 *   对「L1–L5 自主等级」这种**抽象多档**问题，jevlocal-0.5b 的概率分布几乎是均匀的
 *   （实测 topProb 0.28–0.31，基线 1/5 = 0.2；中英文都一样）→ 它没有这个判别力。
 *   文档里 85% / 68% 来自 sst2 / agnews 那种**具体二元 / 新闻类目**判断。
 *
 * 所以决策只用两个**具体二元**信号（这才是它的能力区）：
 *   · noise : 是否噪音（广告/推广/自动通知/退信）→ noul P(yes)
 *   · act   : 是否需要我对外产生动作 → choice{act,info}
 * level 只作**参考证据**记录，`levelDecided` 恒为 false，永不改判定结果。
 *
 * @returns {Promise<null | {noise:number|null, act:number|null, kind:'act'|'info'|null,
 *   noiseDecided:boolean, actDecided:boolean, decided:boolean,
 *   level:number|null, levelTopProb:number, levelConfidence:number, levelDecided:false,
 *   ms:number, probabilities:object|null}>}
 */
export async function judge(item, { cfg, timeoutMs } = {}) {
  const jc = jevConfig(cfg ?? loadConfig());
  if (!jc.enabled) return null;
  const body = {
    model: jc.model,
    state: stateOf(item),
    questions: {
      // 决策用的两个具体二元问题（JEV 的强项）
      noise: {
        type: 'noul',
        instructions: '这条内容是否属于噪音——广告、推广、自动通知、退信、营销邮件，不需要我采取任何行动',
      },
      act: {
        type: 'choice',
        instructions: '处理这条事项是否需要我对外部世界产生动作',
        criteria: {
          act: '需要产生外部动作：发消息、签文件、付款、改代码、发布',
          info: '只需我知道或整理信息：通知、摘要、参考材料',
        },
      },
      // 仅作参考证据，不参与决策（抽象多档问题超出 0.5B 能力）
      level: { type: 'score', instructions: '判定处理这条事项需要多高的自主等级', criteria: L1_TO_L5 },
    },
  };

  const t0 = Date.now();
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs ?? Math.min(jc.timeoutMs, 20000));
    const r = await fetch(`${jc.endpoint}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const j = await r.json();
    const a = j?.answers;
    if (!a) return null;

    const noise = a.noise && Number.isFinite(Number(a.noise.noul)) ? +Number(a.noise.noul).toFixed(3) : null;
    const actProb = Number(a.act?.probabilities?.act);
    const act = Number.isFinite(actProb) ? +actProb.toFixed(3) : null;
    const kind = a.act?.choice === 'act' ? 'act' : (a.act?.choice === 'info' ? 'info' : null);
    const actTop = a.act?.probabilities
      ? +Math.max(...Object.values(a.act.probabilities).map(Number)).toFixed(3) : null;

    const score = Number(a.level?.score);
    const level = Number.isFinite(score) ? Math.max(1, Math.min(5, Math.round(score))) : null;
    const levelProbs = a.level?.probabilities || {};
    const levelTopProb = Object.keys(levelProbs).length
      ? +Math.max(...Object.values(levelProbs).map(Number)).toFixed(3) : 0;
    const levelConfidence = Number(a.level?.confidence);

    if (noise === null && act === null) return null;

    const noiseDecided = noise !== null && noise >= jc.minNoiseProb;
    const actDecided = actTop !== null && actTop >= jc.minTopProb;

    return {
      noise, act, kind,
      noiseDecided, actDecided,
      decided: noiseDecided || actDecided,
      level, levelTopProb,
      levelConfidence: Number.isFinite(levelConfidence) ? +levelConfidence.toFixed(3) : 0,
      levelDecided: false,            // 恒 false：多档等级不作为决策
      probabilities: levelProbs,
      ms: Date.now() - t0,
    };
  } catch {
    return null;
  }
}

/** 只做预筛：拿信号，不拍板。用于 stats/看板展示与规则增强 */
export async function preScreen(item, { cfg } = {}) {
  const r = await judge(item, { cfg });
  if (!r) return null;
  return { noise: r.noise, act: r.act, kind: r.kind, level: r.level, decided: r.decided, ms: r.ms };
}
