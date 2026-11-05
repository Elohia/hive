// tests/sensors-smoke.mjs — 传感器层实测冒烟
//
// 真跑每个 sensor，打印：实测条数 / 耗时 / 样例（**脱敏：正文只打前 60 字**）。
// 额外验证：
//   - 注册表契约（6 个传感器、get/list 正常）
//   - item 形状（必填字段、(source, source_ref) 去重键、ts 可解析、urgency 1-5）
//   - 增量语义（同一 cursor 再跑 mail → 0 条）
//   - ICS 解析器（内存样例，不写任何文件）
//   - 只读性（cursor 全走内存，不碰 data/hive.db）
//
// 运行：node --no-warnings tests/sensors-smoke.mjs
// 退出码：0 = 全部跑通；1 = 有传感器抛错 / item 形状非法 / 注册表坏
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/core/config.mjs';
import { scanAll, collect, list, get, names, ALLOWED_DOMAINS } from '../src/sensors/index.mjs';
import { memoryCursor, clip, oneLine } from '../src/sensors/_util.mjs';
import { groupMail, normalizeSubject, isSystemMail } from '../src/sensors/mail.mjs';

const cfg = loadConfig();
const T0 = Date.now();

const checks = [];
function check(label, cond, extra = '') {
  const pass = !!cond;
  checks.push({ label, pass, extra });
  console.log(`   ${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
  return pass;
}
function warn(label, extra = '') {
  checks.push({ label, pass: true, warn: true, extra });
  console.log(`   WARN  ${label}${extra ? `  ${extra}` : ''}`);
}

/** 脱敏样例：标题（单行截断）+ 正文前 60 字 */
function sampleOf(item) {
  const head = oneLine(item.title, 70);
  const body = clip(item.body, 60);
  return `${head} ｜ ${body || '（无正文）'}`;
}

function validateItem(item, expectSource) {
  const errs = [];
  for (const k of ['source', 'source_ref', 'title', 'body', 'ts', 'kind_hint', 'urgency_hint', 'meta']) {
    if (!(k in item)) errs.push(`缺字段 ${k}`);
  }
  if (item.source !== expectSource) errs.push(`source=${item.source} 应为 ${expectSource}`);
  if (!item.source_ref) errs.push('source_ref 空');
  if (!item.title) errs.push('title 空');
  if (!Number.isFinite(Date.parse(item.ts))) errs.push(`ts 非法:${item.ts}`);
  if (!(item.urgency_hint >= 1 && item.urgency_hint <= 5)) errs.push(`urgency=${item.urgency_hint}`);
  if (item.domain_hint != null && !ALLOWED_DOMAINS.includes(item.domain_hint)) errs.push(`domain 越界:${item.domain_hint}`);
  if (item.meta && typeof item.meta !== 'object') errs.push('meta 非对象');
  return errs;
}

console.log('=== HIVE sensors-smoke ===');
console.log(`home = ${cfg.home}`);
console.log(`node = ${process.version}  platform = ${process.platform}`);
console.log(`db   = ${cfg.resolved.db}`);
console.log('');

/* ---------------------------------- 0. 注册表 ---------------------------------- */
console.log('[0] 注册表');
const all = list(cfg);
check('registry.list 返回 6 个传感器', all.length === 6, `→ ${all.map((x) => x.name).join(',')}`);
check('registry.get 命中 mail', get('mail')?.name === 'mail');
check('registry.get 未知名字返回 null', get('__nope__') === null);
check('registry.names 与 list 一致', names().join(',') === all.map((x) => x.name).join(','));
console.log('');

/* ------------------------------- 1. 逐个真跑 ------------------------------- */
const ctxBase = {
  cfg,
  now: new Date(),
  cursor: memoryCursor(),
  notes: {},
  opts: {},
  log: () => {},   // 静默：sensor 内部日志不进 stdout
};

const perSensor = [];
const allDomains = new Set();
let shapeErrors = 0;

console.log('[1] 各传感器实测');
for (let i = 0; i < all.length; i++) {
  const s = all[i];
  const tA = Date.now();
  const items = [];
  let thrown = null;
  const notesForRun = {};
  const ctx = { ...ctxBase, notes: notesForRun };

  try {
    for await (const it of scanAll(ctx, { only: [s.name] })) items.push(it);
  } catch (e) {
    thrown = e;
  }
  const ms = Date.now() - tA;
  const n = notesForRun[s.name] || {};

  const header = `[1.${i + 1}] ${s.name.padEnd(13)} 条数=${String(items.length).padStart(3)}  ${String(ms).padStart(6)}ms  ${n.ok === false ? 'FAIL' : 'ok'}`;
  console.log(header);
  if (n.note) console.log(`     说明: ${n.note}`);
  if (n.error) console.log(`     错误: ${n.error}`);

  // 样例（脱敏）
  const samples = items.slice(0, 2);
  if (samples.length === 0) {
    console.log(`     样例: （无）`);
  } else {
    for (const it of samples) console.log(`     样例: ${sampleOf(it)}`);
    console.log(`     去重键: ${oneLine(items[0].source_ref, 60)}`);
  }

  // 形状校验
  let bad = 0;
  const badList = [];
  for (const it of items) {
    allDomains.add(it.domain_hint);
    const errs = validateItem(it, s.name);
    if (errs.length) { bad++; if (badList.length < 2) badList.push(`${oneLine(it.title, 40)} → ${errs.join(';')}`); }
  }
  shapeErrors += bad;
  if (bad > 0) console.log(`     ✗ 形状非法 ${bad} 条：${badList.join(' | ')}`);

  perSensor.push({
    name: s.name, count: items.length, ms, ok: n.ok !== false && !thrown,
    note: n.note || null, error: n.error || (thrown ? oneLine(thrown.message || thrown, 200) : null),
    bad,
  });
  console.log('');
}

/* ------------------------------ 2. 形状与失败 ------------------------------ */
console.log('[2] 形状与失败隔离');
check('全部 item 形状合法', shapeErrors === 0, `非法 ${shapeErrors} 条`);
check('没有任何传感器抛错', perSensor.every((p) => p.ok), perSensor.filter((p) => !p.ok).map((p) => p.name).join(',') || '全部正常');
check('来源标注与实际 sensor 一致', perSensor.every((p) => p.bad === 0));
check('domain_hint 只用策略白名单值（或 null）',
  [...allDomains].every((d) => d === null || ALLOWED_DOMAINS.includes(d)),
  `实测出现：${[...allDomains].map((d) => d ?? 'null').join(',')}`);
console.log('');

/* ------------------------------ 3. 增量语义 ------------------------------ */
console.log('[3] 增量（cursor 去重）');
{
  // 用**全新 cursor** 连跑两轮（两轮之间只隔数百毫秒，避开"新邮件到达"的竞态），
  // 只验证 cursor 去重本身；两轮都关闭正文抓取（默认即关闭）。
  const freshCursor = memoryCursor();
  const runMail = async (notes) => {
    const out = [];
    const c = { cfg, now: new Date(), cursor: freshCursor, notes, opts: {}, log: () => {} };
    for await (const it of scanAll(c, { only: ['mail'] })) out.push(it);
    return { items: out, note: notes.mail || {} };
  };

  let first = { items: [], note: {} };
  let second = { items: [], note: {} };
  try {
    first = await runMail({});
    second = await runMail({});
  } catch (e) {
    console.log(`   ✗ mail 增量测试抛错: ${oneLine(e?.message || e, 160)}`);
  }

  if (first.items.length === 0) {
    warn('首轮 mail 无产出，跳过增量断言', '（见上方 0 条原因）');
  } else {
    check('同 cursor 二轮 mail 产出 0 条（增量生效）', second.items.length === 0,
      `首轮 ${first.items.length} → 二轮 ${second.items.length}`);
  }

  // 默认不得触发 +read（会标记已读）
  const bodyMode = first.note?.bodies || {};
  check('默认不抓正文（+read 会标记已读，必须显式开启）',
    bodyMode.enabled === false && (bodyMode.ok || 0) === 0,
    `bodies=${JSON.stringify(bodyMode)}`);

  const dump = freshCursor._dump ? Object.keys(freshCursor._dump()) : [];
  check('cursor 全部落在内存（未写库）', dump.some((k) => k.includes('mail')), `keys=${dump.length}`);
}
console.log('');

/* ------------------------------ 3b. 邮件聚合（单元） ------------------------------ */
console.log('[3b] 邮件聚合（同发件人 + 同主题 → 1 条）');
{
  const bounce = (id, ts, extra = {}) => ({
    id, subject: '来自agent.qq.com的退信',
    snippet: `很抱歉您发送的邮件被退回，被退回邮件主题：[哨兵] 00:00 触发 1 条 时间：${ts}`,
    fromName: 'PostMaster', fromEmail: 'PostMaster@agent.qq.com',
    ts, isRead: false, hasAttachments: true, dir: 'inbox', ...extra,
  });
  const human = (id, subject, ts) => ({
    id, subject, snippet: '本周进度…', fromName: 'Alice', fromEmail: 'alice@example.com',
    ts, isRead: false, hasAttachments: false, dir: 'inbox',
  });

  const rows = [
    bounce('m1', '2026-10-29T16:01:41Z'),
    bounce('m2', '2026-10-29T01:33:41Z'),
    bounce('m3', '2026-10-28T16:01:14Z'),
    bounce('m4', '2026-10-28T01:45:39Z'),
    bounce('m5', '2026-10-27T16:00:38Z'),
    bounce('m6', '2026-10-26T16:00:00Z'),
    bounce('m7', '2026-10-25T16:00:00Z'),
    bounce('m8', '2026-10-24T16:00:00Z'),
    human('h1', '周报 2026-W44', '2026-10-29T10:00:00Z'),
    human('h2', 'Re: 周报 2026-W44', '2026-10-29T11:00:00Z'),
  ];

  const groups = groupMail(rows);
  check('10 封 → 2 组（8 封退信 = 1 组，2 封周报 = 1 组）', groups.length === 2, `实际 ${groups.length} 组`);
  const gb = groups.find((g) => /退信/.test(g.latest.subject));
  check('退信组内计数 = 8', gb?.count === 8, `count=${gb?.count}, 最近=${gb?.latest?.ts}`);
  check('退信被判定为系统通知(→fyi/urgency 1)', gb && isSystemMail(gb.latest));
  check('Re: 前缀归一后仍并入同组', groups.some((g) => /周报/.test(g.latest.subject) && g.count === 2));
  check('normalizeSubject 抹掉时间戳与编号',
    normalizeSubject('退信 2026-10-30 00:01:02 #3') === normalizeSubject('退信 2026-11-01 09:22:11 #7'));
  console.log(`     8 封退信 → 1 条：${oneLine(gb.latest.subject, 40)}（组内 ${gb.count} 封）`);
}
console.log('');

/* ---------------------- 3c. 聚合前后对比（同一批真实邮件） ---------------------- */
console.log('[3c] 聚合前后对比（放开年龄窗，跑同一批真实未读邮件）');
{
  const wideCursor = memoryCursor();
  const notesWide = {};
  const ctxWide = { cfg, now: new Date(), cursor: wideCursor, notes: notesWide, opts: { ageWindowHours: 24 * 3650 }, log: () => {} };
  const items = [];
  try {
    for await (const it of scanAll(ctxWide, { only: ['mail'] })) items.push(it);
  } catch (e) {
    console.log(`   ✗ 抛错: ${oneLine(e?.message || e, 160)}`);
  }
  const n = notesWide.mail || {};
  const absorbed = n.absorbedMails || 0;
  const listed = n.listed ?? 0;
  console.log(`     聚合前：${listed} 封未读（窗口内 ${n.inWindow ?? '?'} 封）`);
  console.log(`     聚合后：${items.length} 条（${n.groups ?? '?'} 组 / 吸收 ${absorbed} 封）`);
  for (const it of items.slice(0, 3)) {
    console.log(`     样例: ${sampleOf(it)}  [kind=${it.kind_hint} urgency=${it.urgency_hint} 组内=${it.meta?.groupCount ?? 1}]`);
  }

  const shrink = items.length < listed;                       // 条数必须少于邮件数
  const hasGroup = items.some((it) => (it.meta?.groupCount || 1) > 1);
  check(`真实邮件聚合生效（${listed} 封 → ${items.length} 条，吸收 ${absorbed} 封）`,
    listed > 0 && absorbed > 0 && shrink && hasGroup);

  if (items.length > 0) {
    check('系统通知类 kind_hint=fyi 且 urgency=1',
      items.filter((it) => it.meta?.system).every((it) => it.kind_hint === 'fyi' && it.urgency_hint === 1));
    check('聚合条目 body 写明"共 N 封 + 最近时间"',
      items.filter((it) => (it.meta?.groupCount || 1) > 1).every((it) => /共|本轮聚合/.test(it.body) && /最近时间/.test(it.body)));
  }
}
console.log('');

/* ------------------------------ 4. ICS 解析器 ------------------------------ */
console.log('[4] ICS 解析器（内存样例，不写文件）');
{
  const now = new Date();
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//HIVE//sensors-smoke//EN',
    'BEGIN:VEVENT',
    'UID:smoke-past@hive',
    `DTSTART:${fmt(new Date(now.getTime() - 48 * 3600_000))}`,
    `DTEND:${fmt(new Date(now.getTime() - 47 * 3600_000))}`,
    'SUMMARY:过去的事件（应被过滤）',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:smoke-ongoing@hive',
    `DTSTART:${fmt(new Date(now.getTime() - 0.5 * 3600_000))}`,
    `DTEND:${fmt(new Date(now.getTime() + 0.5 * 3600_000))}`,
    'SUMMARY:进行中的会议',
    'LOCATION:线上',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:smoke-soon@hive',
    `DTSTART:${fmt(new Date(now.getTime() + 2 * 3600_000))}`,
    `DTEND:${fmt(new Date(now.getTime() + 3 * 3600_000))}`,
    'SUMMARY:两小时后的评审',
    'DESCRIPTION:第一行\\n第二行',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:smoke-far@hive',
    `DTSTART:${fmt(new Date(now.getTime() + 100 * 3600_000))}`,
    'SUMMARY:远超 72h 的事件（应被过滤）',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const notesIcs = {};
  const ctxIcs = { cfg, now, cursor: memoryCursor(), notes: notesIcs, opts: { icsText: ics }, log: () => {} };
  const got = [];
  try {
    for await (const it of scanAll(ctxIcs, { only: ['calendar'] })) got.push(it);
  } catch (e) {
    console.log(`   ✗ ICS 样例扫描抛错: ${oneLine(e?.message || e, 160)}`);
  }
  check('内存 ICS 解析出窗口内 2 个事件', got.length === 2, `实际 ${got.length} 条 → ${got.map((g) => oneLine(g.title, 24)).join(' / ')}`);
  check('过去事件被排除', !got.some((g) => /过去的事件/.test(g.title)));
  check('超窗口事件被排除', !got.some((g) => /远超 72h/.test(g.title)));
  const ongoing = got.find((g) => /进行中/.test(g.title));
  check('进行中事件被标记', !!ongoing && ongoing.meta?.ongoing === true);
  check('ICS 描述换行被还原', got.some((g) => /第一行[\s\S]*第二行/.test(g.body)));
  for (const g of got) console.log(`     样例: ${sampleOf(g)}`);
}
console.log('');

/* ------------------------------ 5. self 健康快照 ------------------------------ */
console.log('[5] self 健康快照（只读连接）');
{
  const selfSensor = get('self');
  let snap = null;
  try { snap = selfSensor.status({ cfg }); } catch (e) { console.log(`   ✗ status 抛错: ${oneLine(e?.message || e, 160)}`); }
  check('self.status 可独立调用', !!snap);
  if (snap) {
    console.log(`     DB ${snap.dbMb}MB exists=${snap.dbExists}`);
    console.log(`     items=${JSON.stringify(snap.items)} tasks=${JSON.stringify(snap.tasks)}`);
    console.log(`     approvals=${JSON.stringify(snap.approvals)} events=${JSON.stringify(snap.events)}`);
    console.log(`     budget=${JSON.stringify(snap.budget)}`);
    check('快照含 DB 体积', typeof snap.dbMb === 'number');
    check('快照无读取错误', (snap.errors || []).length === 0, (snap.errors || []).join(';') || '');
  }
}
console.log('');

/* ------------------------------ 6. collect 聚合 ------------------------------ */
console.log('[6] collect 聚合（带诊断）');
{
  const ctxC = { cfg, now: new Date(), cursor: memoryCursor(), notes: {}, opts: { withBody: false }, log: () => {} };
  const { items, results, summary } = await collect(ctxC, { only: ['mail', 'docs', 'self'] });
  check('collect 返回 items/results/summary', Array.isArray(items) && Array.isArray(results) && !!summary);
  check('collect.results 覆盖点名传感器', results.length === 3, results.map((r) => `${r.name}:${r.count}`).join(' '));
  console.log(`     汇总: items=${summary.items} sensors=${summary.sensors} ok=${summary.ok} failed=${summary.failed.join(',') || '无'} totalMs=${summary.totalMs}`);
  for (const r of results) {
    console.log(`     · ${r.name.padEnd(8)} count=${String(r.count).padStart(3)} ms=${String(r.ms).padStart(6)} ${r.error ? `err=${r.error}` : (r.note || '')}`);
  }
}
console.log('');

/* --------------------------------- 汇总 --------------------------------- */
const totalMs = Date.now() - T0;
const failedChecks = checks.filter((c) => !c.pass);
const warned = checks.filter((c) => c.warn);

console.log('=== 实测条数汇总 ===');
for (const p of perSensor) {
  const flag = p.ok ? '' : '  ← 失败';
  console.log(`  ${p.name.padEnd(13)} ${String(p.count).padStart(3)} 条  ${String(p.ms).padStart(6)}ms${flag}`);
  if (p.count === 0 && p.note) console.log(`  ${' '.repeat(13)} └ ${p.note}`);
}
console.log('');
console.log(`总耗时 ${(totalMs / 1000).toFixed(1)}s · 断言 ${checks.length - failedChecks.length}/${checks.length} PASS` +
  (warned.length ? ` · WARN ${warned.length}` : '') +
  (failedChecks.length ? ` · FAIL ${failedChecks.length}` : ''));

if (failedChecks.length) {
  console.log('\n失败项：');
  for (const f of failedChecks) console.log(`  ✗ ${f.label}${f.extra ? `  ${f.extra}` : ''}`);
  process.exit(1);
}
console.log('\n== sensors-smoke: ALL PASS ==');
process.exit(0);
