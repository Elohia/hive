/* web/app.js — HIVE 看板（原生 ESM，零依赖，零外网请求）
 *
 * 设计约定：
 *  · 只做「监控 + 干预」：所有状态都在 data/hive.db，本页不做任何本地持久化（除 URL hash）。
 *  · 任何 API 失败都只提示，不白屏；空库/空列表给引导文案。
 *  · 实时：SSE /api/stream；断线由 EventSource 自动重连，彻底关闭时降级为轮询。
 */

// ───────────────────────────── 基础工具 ─────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);
const truncate = (s, n = 80) => {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
};
const cssEscape = (s) => (window.CSS && CSS.escape ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, '\\$&'));

const URL_TOKEN = new URLSearchParams(location.search).get('token') || '';
// 截图 / 调试用：?nosse=1 关闭 SSE 长连接（headless 截图带虚拟时间时会卡在长连接上）
// ?doctor=1 打开即弹环境自检抽屉（便于截图/排障）
const PAGE_QUERY = new URLSearchParams(location.search);
const NO_SSE = PAGE_QUERY.get('nosse') === '1';
const OPEN_DOCTOR = PAGE_QUERY.get('doctor') === '1';

const fmt = {
  time(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { hour12: false });
  },
  clock(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('zh-CN', { hour12: false });
  },
  ago(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const sec = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (sec < 45) return '刚刚';
    if (sec < 3600) return Math.round(sec / 60) + ' 分钟前';
    if (sec < 86400) return Math.round(sec / 3600) + ' 小时前';
    if (sec < 86400 * 30) return Math.round(sec / 86400) + ' 天前';
    return d.toLocaleDateString('zh-CN');
  },
  money(n) {
    const v = Number(n);
    return '¥' + (Number.isFinite(v) ? v.toFixed(2) : '0.00');
  },
  bytes(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return '0 B';
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
    return (v / 1024 / 1024).toFixed(1) + ' MB';
  },
  hoursLeft(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return (d.getTime() - Date.now()) / 3600e3;
  },
};

const LABELS = {
  status: {
    inbox: '收件箱', planned: '已计划', running: '执行中', blocked: '受阻',
    awaiting_human: '待人工', done: '已完成', failed: '失败',
    dropped: '已丢弃', archived: '已归档',
    queued: '排队', succeeded: '成功', cancelled: '已取消', timeout: '超时',
    pending: '待拍板', approved: '已批准', rejected: '已拒绝', expired: '已过期', auto: '自动',
    ok: '成功',
  },
  bucket: { inbox: '收件箱', outbox: '待拍板', active: '进行中', archive: '归档' },
  kind: { todo: '待办', issue: '问题', opportunity: '机会', decision: '决策', risk: '风险', fyi: '情报' },
  domain: { work: '工作', trade: '交易', startup: '创业', ai: 'AI', content: '内容', life: '生活', family: '家庭' },
  level: { 1: '整理', 2: '建议', 3: '中间件', 4: '确认后落地', 5: '端到端' },
  levelHint: { 1: '只读+整理，不需审批', 2: '只读+建议，不需审批', 3: '白名单目录内产出中间件', 4: '关键环节人工确认', 5: '全流程自主，仅不可逆动作需审批' },
  risk: { low: '低', medium: '中', high: '高', critical: '极高' },
  itemStatuses: ['inbox', 'planned', 'running', 'blocked', 'awaiting_human', 'done', 'failed', 'dropped', 'archived'],
};

const ICON = {
  inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 12.5h4.2l1.6 2.6h5.4l1.6-2.6h4.2"/><path d="M5.2 4.5h13.6L21 12.5v5.2a1.8 1.8 0 0 1-1.8 1.8H4.8A1.8 1.8 0 0 1 3 17.7v-5.2z"/></svg>',
  outbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a5.5 5.5 0 0 0-5.5 5.5c0 4-1.8 5.2-1.8 5.2h14.6s-1.8-1.2-1.8-5.2A5.5 5.5 0 0 0 12 3z"/><path d="M9.8 17.6a2.4 2.4 0 0 0 4.4 0"/></svg>',
  tasks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5h3M4 12h3M4 17.5h3"/><path d="M10 6.5h10M10 12h10M10 17.5h10"/></svg>',
  logs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7 9.5l3 2.5-3 2.5M13 14.5h4"/></svg>',
  context: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 20.5v-2.2c0-.7-.3-1.3-.8-1.8A6.5 6.5 0 1 1 18.5 11c0 1.6-.6 3-1.6 4.1-.5.5-.8 1.1-.8 1.8v.6"/><path d="M9 20.5h6"/><path d="M12 7v4"/></svg>',
  hive: '<svg viewBox="0 0 32 32"><path d="M16 2.5l11.7 6.75v13.5L16 29.5 4.3 22.75V9.25z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M16 8.2l6.7 3.87v7.73L16 23.7l-6.7-3.9v-7.73z" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
};

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

// ───────────────────────────── API ─────────────────────────────
async function api(path, opts = {}) {
  const headers = {
    Accept: 'application/json',
    ...(URL_TOKEN ? { 'X-Hive-Token': URL_TOKEN } : {}),
    ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    ...(opts.headers || {}),
  };
  const res = await fetch(path, { ...opts, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { error: text.slice(0, 400) || `HTTP ${res.status}` }; }
  if (!res.ok) throw new ApiError((data && data.error) || `HTTP ${res.status}`, res.status, data);
  return data;
}

const qs = (obj) => Object.entries(obj)
  .filter(([, v]) => v !== '' && v != null)
  .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
  .join('&');

// ───────────────────────────── 状态 ─────────────────────────────
const state = {
  tab: 'inbox',
  overview: null,
  health: null,
  online: true,
  items: [],
  itemQuery: { bucket: 'inbox', source: '', status: '', q: '', level: '' },
  approvals: [],
  approvalStatus: 'pending',
  tasks: [],
  taskStatus: '',
  events: [],
  eventLevel: '',
  logPaused: false,
  context: null,
  details: new Map(),
  notes: new Map(),
  deciding: new Map(),
  editingFact: null,
  busy: new Set(),
  sse: null,
  sseOpen: false,
  sseError: false,
  pollTimer: null,
  refreshTimer: null,
  logTimer: null,
  doctor: null,
};

// ───────────────────────────── 通用 HTML ─────────────────────────────
const chip = (cls, text, title) => `<span class="chip ${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;

function levelChip(level) {
  if (!level) return chip('muted', 'L?', '未判定自主等级');
  const l = Number(level);
  return `<span class="chip level l${l}" title="L${l} · ${esc(LABELS.levelHint[l] || '')}">L${l}</span>`;
}

function statusChip(status) {
  const s = status || 'inbox';
  return `<span class="chip st st-${esc(s)}">${esc(LABELS.status[s] || s)}</span>`;
}

function section(title, html) {
  return `<div class="detail-section"><h4>${esc(title)}</h4>${html}</div>`;
}

function renderVal(v) {
  if (v == null || v === '') return '<span class="detail-empty">—</span>';
  if (typeof v === 'string') return esc(v);
  if (typeof v === 'number' || typeof v === 'boolean') return esc(String(v));
  if (Array.isArray(v)) return v.map((x) => `<div>· ${renderVal(x)}</div>`).join('') || '<span class="detail-empty">—</span>';
  return `<pre class="mini">${esc(JSON.stringify(v, null, 2))}</pre>`;
}

function renderKV(obj) {
  if (!obj || typeof obj !== 'object' || !Object.keys(obj).length) {
    return '<span class="detail-empty">无背景说明</span>';
  }
  const rows = Object.entries(obj).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${renderVal(v)}</dd>`).join('');
  return `<dl class="kv">${rows}</dl>`;
}

function emptyState({ icon, title, lines = [], command = '', actions = '' }) {
  return `<div class="empty">${icon || ICON.hive}
    <h2>${esc(title)}</h2>
    ${lines.map((l) => `<p>${l}</p>`).join('')}
    ${command ? `<p><code>${esc(command)}</code></p>` : ''}
    ${actions ? `<div class="row">${actions}</div>` : ''}
  </div>`;
}

function timelineHtml(events) {
  if (!events || !events.length) return '<div class="detail-empty">还没有事件</div>';
  const rows = [...events].reverse().map((e) => {
    const lv = e.level === 'error' ? 'error' : e.level === 'warn' ? 'warn' : 'info';
    return `<div class="tl-item"><span class="tl-dot ${lv}"></span><div class="tl-main">
      <div class="tl-head"><span class="tl-time">${fmt.time(e.ts)}</span><span class="tl-actor">${esc(e.actor)}</span><span class="tl-type">${esc(e.type)}</span></div>
      <div class="tl-msg">${esc(e.message || '')}</div>
    </div></div>`;
  }).join('');
  return `<div class="timeline">${rows}</div>`;
}

function tasksMiniHtml(tasks) {
  if (!tasks || !tasks.length) return '';
  return `<div class="task-mini">${tasks.map((t) => `<div class="row">
    ${statusChip(t.status)}
    <span class="title">${esc(t.title || t.id)}</span>
    ${levelChip(t.autonomy_level)}
    ${t.executor ? chip('src', t.executor) : ''}
    ${chip('muted', `尝试 ${t.attempt}/${t.max_attempts}`)}
    ${t.cost_cny ? chip('muted', fmt.money(t.cost_cny)) : ''}
    <span class="chip muted" title="${esc(t.id)}">${esc(truncate(t.id, 14))}</span>
  </div>${t.last_error ? `<div class="detail-empty" style="color:#ffb3bb">${esc(truncate(t.last_error, 300))}</div>` : ''}`).join('')}</div>`;
}

function artifactsHtml(list) {
  if (!list || !list.length) return '';
  return `<div class="art-list">${list.map((a) => `<div class="art-item">
    <span class="name"><a href="/api/artifacts/${encodeURIComponent(a.id)}" target="_blank" rel="noopener">${esc(a.title || a.path)}</a></span>
    ${a.kind ? chip('muted', a.kind) : ''}
    <span class="size">${fmt.bytes(a.bytes)}</span>
  </div>`).join('')}</div>`;
}

function runsHtml(runs) {
  if (!runs || !runs.length) return '';
  return `<div class="task-mini">${runs.map((r) => `<div class="row">
    ${statusChip(r.status === 'ok' ? 'succeeded' : (r.status || 'queued'))}
    <span class="title">${esc(r.executor || '—')}${r.command ? ' · ' + esc(r.command) : ''}</span>
    ${chip('muted', `退出 ${r.exit_code ?? '—'}`)}
    ${chip('muted', r.duration_ms != null ? Math.round(r.duration_ms / 1000) + 's' : '—')}
    ${r.cost_cny ? chip('muted', fmt.money(r.cost_cny)) : ''}
    ${chip('muted', fmt.time(r.started_at))}
  </div>${r.error ? `<div class="detail-empty" style="color:#ffb3bb">${esc(truncate(r.error, 300))}</div>` : ''}`).join('')}</div>`;
}

function approvalsMiniHtml(list) {
  if (!list || !list.length) return '';
  return `<div class="task-mini">${list.map((a) => `<div class="row">
    ${statusChip(a.status)}
    <span class="title">${esc(a.title || a.id)}</span>
    <span class="chip risk-${esc(a.risk || 'medium')}">风险 ${esc(LABELS.risk[a.risk] || a.risk || '中')}</span>
    ${a.decision ? chip('muted', '决定：' + a.decision) : ''}
    ${a.note ? chip('muted', '备注：' + truncate(a.note, 40)) : ''}
  </div>`).join('')}</div>`;
}

function itemDetailHtml(d) {
  if (!d) return '';
  const parts = [];
  parts.push(section('事件时间线', timelineHtml(d.events)));
  if (d.tasks && d.tasks.length) parts.push(section('任务', tasksMiniHtml(d.tasks)));
  if (d.approvals && d.approvals.length) parts.push(section('审批', approvalsMiniHtml(d.approvals)));
  if (d.runs && d.runs.length) parts.push(section('运行记录', runsHtml(d.runs)));
  if (d.artifacts && d.artifacts.length) parts.push(section('产物', artifactsHtml(d.artifacts)));
  if (d.item && d.item.meta && Object.keys(d.item.meta).length) {
    parts.push(section('meta', `<pre class="mini">${esc(JSON.stringify(d.item.meta, null, 2))}</pre>`));
  }
  parts.push(section('标识与时间', `<dl class="kv">
    <dt>ID</dt><dd style="font-family:var(--mono)">${esc(d.item.id)}</dd>
    <dt>来源</dt><dd>${esc(d.item.source)}${d.item.source_ref ? ' · ' + esc(d.item.source_ref) : ''}</dd>
    <dt>去重键</dt><dd style="font-family:var(--mono);word-break:break-all">${esc(d.item.dedupe_key)}</dd>
    <dt>创建</dt><dd>${fmt.time(d.item.created_at)}</dd>
    <dt>更新</dt><dd>${fmt.time(d.item.updated_at)}</dd>
    <dt>最近感知</dt><dd>${fmt.time(d.item.last_seen_at)}</dd>
  </dl>`));
  return parts.join('');
}

function taskDetailHtml(d) {
  if (!d) return '';
  const t = d.task;
  const parts = [];
  if (t.last_error) parts.push(section('错误', `<pre class="mini" style="color:#ffb3bb">${esc(t.last_error)}</pre>`));
  if (t.plan) parts.push(section('计划 plan', typeof t.plan === 'string' ? `<pre class="mini">${esc(t.plan)}</pre>` : `<pre class="mini">${esc(JSON.stringify(t.plan, null, 2))}</pre>`));
  if (t.result) parts.push(section('结果 result', typeof t.result === 'string' ? `<pre class="mini">${esc(t.result)}</pre>` : `<pre class="mini">${esc(JSON.stringify(t.result, null, 2))}</pre>`));
  if (d.runs && d.runs.length) parts.push(section('运行记录', runsHtml(d.runs)));
  if (d.artifacts && d.artifacts.length) parts.push(section('产物', artifactsHtml(d.artifacts)));
  parts.push(section('事件时间线', timelineHtml(d.events)));
  parts.push(section('标识与预算', `<dl class="kv">
    <dt>任务 ID</dt><dd style="font-family:var(--mono)">${esc(t.id)}</dd>
    <dt>所属事项</dt><dd>${t.item_id ? esc(t.item_id) : '—'}</dd>
    <dt>执行器</dt><dd>${esc(t.executor || '—')}${t.model ? ' · ' + esc(t.model) : ''}</dd>
    <dt>时间/预算</dt><dd>超时 ${esc(t.timeout_sec ?? '—')}s · token 预算 ${esc(t.budget_tokens ?? '—')}</dd>
    <dt>已用</dt><dd>in ${esc(t.tokens_in ?? 0)} / out ${esc(t.tokens_out ?? 0)} · ${fmt.money(t.cost_cny)}</dd>
    <dt>开始/结束</dt><dd>${t.started_at ? fmt.time(t.started_at) : '—'} → ${t.finished_at ? fmt.time(t.finished_at) : '—'}</dd>
    <dt>租约</dt><dd>${t.lease_until ? fmt.time(t.lease_until) : '—'}</dd>
  </dl>`));
  return parts.join('');
}

// ───────────────────────────── 顶栏 ─────────────────────────────
function setOnline(online, text) {
  state.online = online;
  const banner = $('#banner');
  if (online) { banner.hidden = true; banner.textContent = ''; }
  else {
    banner.hidden = false;
    banner.textContent = text || '与 /api 的连接中断（服务可能未启动或被重启）。页面每 5 秒自动重试，SSE 恢复后自动刷新。';
  }
  const dot = $('#health-dot');
  const ht = $('#health-text');
  if (!online) { dot.className = 'dot err'; ht.textContent = '离线'; }
}

function renderHeader() {
  const ov = state.overview;
  if (!ov) return;
  const c = ov.counts || {};
  const b = ov.budget || {};
  const ok = state.online && (!state.health || state.health.ok !== false);
  const dot = $('#health-dot');
  dot.className = 'dot ' + (state.online ? (ok ? 'ok' : 'warn') : 'err');
  $('#health-text').textContent = state.online ? (ok ? '正常' : '降级') : '离线';
  $('#health-sub').textContent = 'v' + (ov.version || '—');

  $('#budget-text').textContent = fmt.money(b.costCny);
  const ratio = Math.max(0, Math.min(1, Number(b.ratio) || 0));
  const bar = $('#budget-bar');
  bar.style.width = (ratio * 100).toFixed(1) + '%';
  bar.classList.toggle('warn', ratio >= 0.8);
  $('#budget-ratio').textContent = Math.round(ratio * 100) + '% / ' + fmt.money(b.budget ?? 0);

  $('#running-text').textContent = String(c.running ?? 0);
  $('#queued-text').textContent = '排队 ' + (c.queued ?? 0);
  $('#outbox-text').textContent = String(c.outbox ?? 0);
  $('#outbox-sub').textContent = (c.outbox ?? 0) > 0 ? '等你拍板' : '无待办审批';
  $('#inbox-text').textContent = String(c.inbox ?? 0);
  $('#inbox-sub').textContent = (c.inbox ?? 0) > 0 ? '等待处理的事项' : '收件箱为空';

  $('#badge-inbox').textContent = String(c.inbox ?? 0);
  const ob = $('#badge-outbox');
  ob.textContent = String(c.outbox ?? 0);
  ob.classList.toggle('hot', (c.outbox ?? 0) > 0);
  $('#badge-tasks').textContent = String((c.running ?? 0) + (c.queued ?? 0));

  $('#foot-version').textContent = 'v' + (ov.version || '—');
  $('#foot-addr').textContent = (state.health && state.health.server ? `${state.health.server.host}:${state.health.server.port}` : location.host);
}

function renderConn() {
  const el = $('#conn');
  const dot = $('#conn-dot');
  const txt = $('#conn-text');
  if (NO_SSE) {
    dot.className = 'dot';
    txt.textContent = 'SSE 已关闭（nosse=1）';
    el.title = '调试/截图模式：不使用 SSE 长连接；页面仍会定时刷新';
    return;
  }
  if (state.sseOpen) { dot.className = 'dot live'; txt.textContent = '实时'; el.title = 'SSE 已连接 /api/stream'; }
  else if (state.sseError) { dot.className = 'dot warn'; txt.textContent = '重连中'; el.title = 'SSE 断线，自动重连中（或已降级轮询）'; }
  else { dot.className = 'dot warn'; txt.textContent = '连接中'; }
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 4200);
  setTimeout(() => el.remove(), 4600);
}

// ───────────────────────────── 收件箱 ─────────────────────────────
const DEFAULT_SOURCES = ['mail', 'git', 'docs', 'calendar', 'x', 'wechat', 'dsh', 'pi', 'web', 'manual', 'agent', 'self'];

function fillSelect(sel, options, keep) {
  const html = options.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join('');
  if (sel.dataset.sig === html) return;
  sel.dataset.sig = html;
  sel.innerHTML = html;
  if (keep != null) sel.value = keep;
}

function refreshSourceOptions() {
  const sel = $('#f-source');
  const cur = sel.value || state.itemQuery.source;
  const set = new Set(DEFAULT_SOURCES);
  for (const it of [...(state.overview?.topItems || []), ...state.items]) if (it && it.source) set.add(it.source);
  fillSelect(sel, [['', '全部来源'], ...[...set].sort().map((s) => [s, s])], cur);
}

function itemCard(it) {
  const p = Number(it.priority) || 0;
  const cls = p >= 12 ? 'prio-hot' : p >= 8 ? 'prio-warm' : p >= 5 ? 'prio-cool' : 'prio-low';
  const key = 'item:' + it.id;
  const open = state.details.has(key);
  const dim = ['done', 'dropped', 'archived'].includes(it.status);
  const terminal = it.status === 'dropped' || it.status === 'archived';
  const actions = terminal
    ? '<button class="btn sm" data-act="restore">恢复到收件箱</button>'
    : `<button class="btn primary sm" data-act="dispatch">派单执行</button>
       <select class="input" data-act="relevel" aria-label="调整自主等级" title="调整自主等级">
         <option value="">调级…</option>
         ${[1, 2, 3, 4, 5].map((l) => `<option value="${l}">→ L${l} ${LABELS.level[l]}</option>`).join('')}
       </select>
       <button class="btn sm" data-act="archive">归档</button>
       <button class="btn sm danger" data-act="drop">丢弃</button>`;

  return `<article class="card ${cls}" data-kind="item" data-id="${esc(it.id)}">
    <div class="card-main">
      <div class="prio">${p ? p.toFixed(1) : '—'}<small>优先级</small></div>
      <div class="card-body">
        <div class="card-title"><h3${dim ? ' class="done"' : ''}>${esc(it.title)}</h3>${levelChip(it.autonomy_level)}</div>
        <div class="chips">
          ${chip('src', it.source)}
          ${it.kind ? chip('kind', LABELS.kind[it.kind] || it.kind) : ''}
          ${it.domain ? chip('domain', LABELS.domain[it.domain] || it.domain) : ''}
          ${statusChip(it.status)}
          ${chip('muted', `紧急 ${it.urgency ?? '—'} · 影响 ${it.impact ?? '—'}`)}
          ${it.due_at ? chip('muted', '截止 ' + fmt.time(it.due_at)) : ''}
          ${chip('muted', fmt.ago(it.created_at))}
        </div>
        ${it.body ? `<p class="body-preview">${esc(truncate(it.body, 600))}</p>` : ''}
        ${it.level_reason ? `<div class="chips">${chip('muted', '判定：' + truncate(it.level_reason, 80))}</div>` : ''}
      </div>
      <button class="icon-btn" data-act="toggle" title="展开事件时间线与产物" aria-label="展开">${open ? '▴' : '▾'}</button>
    </div>
    <div class="card-actions">
      ${actions}
      <span class="spacer"></span>
      ${chip('muted', LABELS.bucket[it.bucket] || it.bucket || '—')}
    </div>
    <div class="detail" ${open ? '' : 'hidden'}>${open ? itemDetailHtml(state.details.get(key)) : ''}</div>
  </article>`;
}

function visibleItems() {
  const lv = state.itemQuery.level;
  return state.items.filter((it) => !lv || String(it.autonomy_level || '') === lv);
}

function filtersActive() {
  const q = state.itemQuery;
  return !!(q.source || q.status || q.level || q.q || q.bucket !== 'inbox');
}

function renderInbox() {
  refreshSourceOptions();
  const rows = visibleItems();
  const el = $('#inbox-list');
  if (!rows.length) {
    if (filtersActive()) {
      el.innerHTML = emptyState({
        icon: ICON.inbox,
        title: '没有符合筛选条件的事项',
        lines: ['当前筛选：' + [
          state.itemQuery.bucket ? '栏位=' + (LABELS.bucket[state.itemQuery.bucket] || state.itemQuery.bucket) : '',
          state.itemQuery.source ? '来源=' + state.itemQuery.source : '',
          state.itemQuery.status ? '状态=' + (LABELS.status[state.itemQuery.status] || state.itemQuery.status) : '',
          state.itemQuery.level ? '等级=L' + state.itemQuery.level : '',
          state.itemQuery.q ? '搜索=' + state.itemQuery.q : '',
        ].filter(Boolean).join(' · ')],
        actions: '<button class="btn" data-empty-act="clear-filters">清除筛选</button>',
      });
      return;
    }
    el.innerHTML = emptyState({
      icon: ICON.inbox,
      title: '收件箱还是空的',
      lines: [
        '系统还没有感知到任何事项。让它动起来有三种方式：',
        '① 启动守护进程（按 config 的脉冲自动巡检）；② 点右上角「立即巡检」手动跑一轮传感器；③ 直接投递一条事项，立刻进入 triage → 路由。',
      ],
      command: 'node scripts/hive.mjs daemon',
      actions: '<button class="btn primary" data-empty-act="new-item">+ 投递一条事项</button><button class="btn" data-empty-act="scan">立即巡检一次</button>',
    });
    return;
  }
  el.innerHTML = rows.map(itemCard).join('');
}

async function loadItems() {
  const q = state.itemQuery;
  try {
    const data = await api('/api/items?' + qs({ bucket: q.bucket, source: q.source, status: q.status, q: q.q, limit: 100 }));
    state.items = data.items || [];
    setOnline(true);
    renderInbox();
  } catch (e) {
    setOnline(false);
    $('#inbox-list').innerHTML = errorCard('收件箱加载失败', e);
  }
}

// ───────────────────────────── 待拍板 ─────────────────────────────
function normOptions(opts) {
  if (!Array.isArray(opts) || !opts.length) return [];
  return opts.map((o) => {
    if (o == null) return null;
    if (typeof o === 'string') return { value: o, label: o, desc: '' };
    if (typeof o === 'object') {
      const value = o.value ?? o.id ?? o.key ?? o.label ?? o.title;
      return {
        value: value == null ? JSON.stringify(o) : String(value),
        label: String(o.label ?? o.title ?? value ?? '选项'),
        desc: o.desc ?? o.description ?? o.note ?? '',
      };
    }
    return { value: String(o), label: String(o), desc: '' };
  }).filter(Boolean);
}

function expireChip(iso, status) {
  if (!iso) return '';
  if (status && status !== 'pending') return '';
  const hrs = fmt.hoursLeft(iso);
  if (hrs == null) return '';
  if (hrs <= 0) return '<span class="chip risk-high">已过期</span>';
  if (hrs < 6) return `<span class="chip risk-high">${Math.round(hrs)} 小时后过期</span>`;
  if (hrs < 24) return `<span class="chip risk-medium">${Math.round(hrs)} 小时后过期</span>`;
  return `<span class="chip muted">${Math.round(hrs / 24)} 天后过期</span>`;
}

function approvalCard(a) {
  const pending = a.status === 'pending';
  const opts = normOptions(a.options);
  const sel = state.deciding.get(a.id) || '';
  const risk = a.risk || 'medium';
  const note = state.notes.get(a.id) || '';

  const optionsHtml = opts.length
    ? `<div class="detail-section"><h4>可执行选项（点选后批准）</h4><div class="opts">${opts.map((o) => `<button class="opt ${sel === o.value ? 'is-sel' : ''}" data-opt="${esc(o.value)}">${esc(o.label)}${o.desc ? `<small>${esc(o.desc)}</small>` : ''}</button>`).join('')}</div></div>`
    : '';

  const actions = pending
    ? `<button class="btn primary sm" data-act="approve">批准${sel ? ' · ' + esc(truncate(sel, 18)) : ''}</button>
       <button class="btn danger sm" data-act="reject">拒绝</button>
       <span class="spacer"></span>
       <span class="hint">批准 → 事项进入 active；拒绝 → 归档</span>`
    : `<div class="decided">
         <span class="chip ${a.status === 'approved' ? 'st-succeeded' : 'st-cancelled'}">${esc(LABELS.status[a.status] || a.status)}</span>
         ${a.decision ? `<span>决定：<b>${esc(a.decision)}</b></span>` : ''}
         ${a.note ? `<span>备注：${esc(a.note)}</span>` : ''}
         <span class="hint">${esc(a.decided_by || '')} ${a.decided_at ? '· ' + fmt.time(a.decided_at) : ''}</span>
       </div>`;

  return `<article class="card approval" data-kind="approval" data-id="${esc(a.id)}">
    <div class="card-main">
      <div class="approval-head">
        <h3>${esc(a.title)}</h3>
      </div>
      <div class="chips">
        <span class="chip risk-${esc(risk)}">风险 ${esc(LABELS.risk[risk] || risk)}</span>
        ${statusChip(a.status)}
        ${a.kind ? chip('kind', a.kind) : ''}
        ${a.item_title ? chip('muted', '事项：' + truncate(a.item_title, 36)) : ''}
        ${chip('muted', fmt.ago(a.created_at))}
        ${expireChip(a.expires_at, a.status)}
      </div>
      ${a.summary ? `<p class="approval-summary">${esc(a.summary)}</p>` : ''}
      <div class="approval-grid">
        <section><h4>背景 context</h4>${renderKV(a.context)}</section>
        <section><h4>建议 recommendation</h4><div class="reco">${a.recommendation ? esc(a.recommendation) : '<span class="detail-empty">系统未给出建议</span>'}</div></section>
      </div>
      ${optionsHtml}
      ${pending ? `<div class="note"><textarea data-role="note" placeholder="备注（可选，会写入审批记录，例如：这个先别发，等我改稿" rows="2">${esc(note)}</textarea></div>` : ''}
      <div class="card-actions">${actions}</div>
    </div>
  </article>`;
}

function renderOutbox() {
  const el = $('#outbox-list');
  if (!state.approvals.length) {
    const pendingView = state.approvalStatus === 'pending';
    el.innerHTML = pendingView
      ? emptyState({
        icon: ICON.outbox,
        title: '没有待你拍板的事',
        lines: [
          '审批（Outbox）是系统唯一的副作用闸门：只有发信 / 发布 / 删除 / 花钱 / 部署这类不可逆动作，或自主等级不够时，才会在这里请示。',
          '平时的感知、整理、分析、草稿都在后台自动完成，不打扰你。',
        ],
      })
      : emptyState({
        icon: ICON.outbox,
        title: '这个状态下没有审批记录',
        lines: ['试试切到「全部」，或等待系统产生新的请示。'],
        actions: '<button class="btn" data-empty-act="outbox-all">查看全部审批</button>',
      });
    return;
  }
  el.innerHTML = state.approvals.map(approvalCard).join('');
}

async function loadApprovals() {
  try {
    const data = await api('/api/approvals?' + qs({ status: state.approvalStatus, limit: 200 }));
    state.approvals = data.approvals || [];
    setOnline(true);
    renderOutbox();
  } catch (e) {
    setOnline(false);
    $('#outbox-list').innerHTML = errorCard('审批加载失败', e);
  }
}

// ───────────────────────────── 任务 ─────────────────────────────
function taskCard(t) {
  const st = t.status || 'queued';
  const key = 'task:' + t.id;
  const open = state.details.has(key);
  const mark = st === 'running' ? '▶' : st === 'failed' ? '!' : st === 'succeeded' ? '✓' : '·';
  const actions = [];
  if (['failed', 'cancelled', 'timeout', 'blocked'].includes(st)) actions.push('<button class="btn primary sm" data-act="retry">重试</button>');
  if (['queued', 'running', 'blocked'].includes(st)) actions.push('<button class="btn danger sm" data-act="cancel">取消</button>');
  if (!actions.length) actions.push('<span class="hint">该状态无可用操作</span>');

  return `<article class="card" data-kind="task" data-id="${esc(t.id)}">
    <div class="card-main">
      <div class="prio">${mark}<small>${esc(LABELS.status[st] || st)}</small></div>
      <div class="card-body">
        <div class="card-title"><h3>${esc(t.title || t.id)}</h3>${levelChip(t.autonomy_level)}</div>
        <div class="chips">
          ${statusChip(st)}
          ${t.executor ? chip('src', t.executor) : ''}
          ${t.model ? chip('muted', t.model) : ''}
          ${chip('muted', `尝试 ${t.attempt ?? 0}/${t.max_attempts ?? 0}`)}
          ${t.cost_cny ? chip('muted', fmt.money(t.cost_cny)) : ''}
          ${t.item_title ? chip('muted', '事项：' + truncate(t.item_title, 32)) : ''}
          ${chip('muted', fmt.ago(t.created_at))}
        </div>
        ${t.last_error ? `<p class="body-preview" style="color:#ffb3bb">${esc(truncate(t.last_error, 320))}</p>` : ''}
        ${!t.last_error && t.goal ? `<p class="body-preview">${esc(truncate(t.goal, 320))}</p>` : ''}
      </div>
      <button class="icon-btn" data-act="toggle" title="展开运行记录与产物">${open ? '▴' : '▾'}</button>
    </div>
    <div class="card-actions">
      ${actions.join('')}
      <span class="spacer"></span>
      ${chip('muted', truncate(t.id, 22))}
    </div>
    <div class="detail" ${open ? '' : 'hidden'}>${open ? taskDetailHtml(state.details.get(key)) : ''}</div>
  </article>`;
}

function renderTasks() {
  const el = $('#tasks-list');
  if (!state.tasks.length) {
    el.innerHTML = emptyState({
      icon: ICON.tasks,
      title: state.taskStatus ? '这个状态下没有任务' : '还没有任务',
      lines: state.taskStatus
        ? ['换个状态筛选看看，或到收件箱把某个事项「派单执行」。']
        : ['任务由 Router 在事项判定为 dispatch 时创建；你也可以在收件箱里对某个事项点「派单执行」，立即产生一个 queued 任务。',
           '执行器（dsh / pi / codex / claude / llm / shell）由 daemon 的 worker 领取任务并运行。'],
      actions: state.taskStatus ? '<button class="btn" data-empty-act="task-all">查看全部任务</button>' : '',
    });
    return;
  }
  el.innerHTML = state.tasks.map(taskCard).join('');
}

async function loadTasks() {
  try {
    const data = await api('/api/tasks?' + qs({ status: state.taskStatus, limit: 200 }));
    state.tasks = data.tasks || [];
    setOnline(true);
    renderTasks();
  } catch (e) {
    setOnline(false);
    $('#tasks-list').innerHTML = errorCard('任务加载失败', e);
  }
}

// ───────────────────────────── 日志 ─────────────────────────────
function eventRefChips(e) {
  const out = [];
  if (e.item_id) out.push(`<span class="chip link" data-ref="item" data-ref-id="${esc(e.item_id)}" title="${esc(e.item_id)}">事项</span>`);
  if (e.task_id) out.push(`<span class="chip link" data-ref="task" data-ref-id="${esc(e.task_id)}" title="${esc(e.task_id)}">任务</span>`);
  if (e.approval_id) out.push(`<span class="chip link" data-ref="approval" data-ref-id="${esc(e.approval_id)}" title="${esc(e.approval_id)}">审批</span>`);
  return out.join('');
}

function logRow(e) {
  const lv = e.level === 'error' ? 'error' : e.level === 'warn' ? 'warn' : 'info';
  const data = e.data != null && typeof e.data === 'object' && Object.keys(e.data).length
    ? ` <span class="chip muted" title="${esc(truncate(JSON.stringify(e.data), 300))}">data</span>` : '';
  return `<div class="log-row lv-${lv}" data-eid="${esc(e.id ?? '')}">
    <span class="t">${fmt.clock(e.ts)}</span>
    <span class="log-level ${lv}">${lv === 'error' ? '错误' : lv === 'warn' ? '警告' : '信息'}</span>
    <span class="log-actor">${esc(e.actor || '—')}</span>
    <span class="log-type" title="${esc(e.type || '')}">${esc(e.type || '')}</span>
    <span class="log-msg">${esc(e.message || '')}${data}</span>
    <span class="log-refs">${eventRefChips(e)}</span>
  </div>`;
}

function renderLogs() {
  const el = $('#logs-list');
  if (!state.events.length) {
    el.innerHTML = emptyState({
      icon: ICON.logs,
      title: '还没有事件',
      lines: [
        '每一条状态变更（感知 / 判定 / 路由 / 派单 / 运行 / 审批 / 失败）都会同时写入 events 表，并从这里实时推送。',
        '这是「一切可重放」的入口：任何结论都能回溯到某次 Run 的原始输出。',
      ],
      actions: '<button class="btn" data-empty-act="scan">立即巡检一次</button>',
    });
    $('#log-count').textContent = '';
    return;
  }
  el.innerHTML = state.events.map(logRow).join('');
  $('#log-count').textContent = `共 ${state.events.length} 条${state.eventLevel ? '（已按级别过滤）' : ''}`;
}

async function loadEvents() {
  try {
    const data = await api('/api/events?' + qs({ limit: 200, level: state.eventLevel }));
    state.events = data.events || [];
    setOnline(true);
    renderLogs();
  } catch (e) {
    setOnline(false);
    $('#logs-list').innerHTML = errorCard('事件加载失败', e);
  }
}

// ───────────────────────────── 上下文 ─────────────────────────────
function factCard(f) {
  return `<article class="card fact" data-kind="fact" data-id="${esc(f.id)}">
    <div class="k">${esc(f.key)}</div>
    <div class="v">${esc(f.value)}</div>
    <div class="meta">
      ${f.confidence != null ? `<span>置信 ${Math.round(Number(f.confidence) * 100)}%</span>` : ''}
      ${f.evidence ? `<span title="${esc(f.evidence)}">证据：${esc(truncate(f.evidence, 36))}</span>` : ''}
      <span>${fmt.ago(f.updated_at)}</span>
    </div>
    <div class="acts">
      <button class="btn sm" data-act="edit-fact">编辑</button>
      <button class="btn sm danger" data-act="del-fact">删除</button>
    </div>
  </article>`;
}

function renderContext() {
  const el = $('#context-list');
  const data = state.context;
  if (!data || !data.facts || !data.facts.length) {
    el.innerHTML = emptyState({
      icon: ICON.context,
      title: '还没有个人上下文',
      lines: [
        '上下文是系统的「底料」：它让系统知道你现在在做什么项目、家庭与健康约束、偏好与红线，从而判断一件事值不值得打扰你、能不能自己做完。',
        '建议先加 3 条：当前主项目 / 作息与精力 / 不可打扰的红线。每条都可以带证据（文件、会话、行号），保证可追溯。',
      ],
      actions: '<button class="btn primary" data-empty-act="new-fact">+ 新增事实</button>',
    });
    return;
  }
  const groups = data.grouped || {};
  el.innerHTML = Object.entries(groups).map(([cat, facts]) => `<div class="ctx-group">
    <h3>${esc(cat)}</h3>
    <div class="ctx-grid">${facts.map(factCard).join('')}</div>
  </div>`).join('');
}

async function loadContext() {
  try {
    state.context = await api('/api/context');
    setOnline(true);
    renderContext();
  } catch (e) {
    setOnline(false);
    $('#context-list').innerHTML = errorCard('上下文加载失败', e);
  }
}

// ───────────────────────────── 错误卡 ─────────────────────────────
function errorCard(title, e) {
  return `<div class="empty">
    <h2>${esc(title)}</h2>
    <p>${esc(e && e.message ? e.message : String(e))}</p>
    <p>看板依赖本地 daemon 的 HTTP API。确认服务在跑：<code>node scripts/hive.mjs daemon</code></p>
    <div class="row"><button class="btn" data-empty-act="reload">重试</button></div>
  </div>`;
}

// ───────────────────────────── 刷新编排 ─────────────────────────────
async function refreshOverview() {
  try {
    const [ov, health] = await Promise.all([api('/api/overview'), api('/api/health')]);
    state.overview = ov;
    state.health = health;
    state.offlineToastShown = false;
    setOnline(true);
    renderHeader();
    refreshSourceOptions();
  } catch (e) {
    setOnline(false);
    if (!state.overview && !state.offlineToastShown) {
      state.offlineToastShown = true;
      toast('无法连接 API：' + e.message, 'err');
    }
  }
}

function scheduleRefresh() {
  if (state.refreshTimer) return;
  state.refreshTimer = setTimeout(async () => {
    state.refreshTimer = null;
    await refreshOverview();
    const tab = state.tab;
    if (tab === 'inbox') await loadItems();
    else if (tab === 'outbox') {
      const focused = document.activeElement;
      const typing = focused && focused.tagName === 'TEXTAREA' && focused.closest('#outbox-list');
      if (!typing) await loadApprovals();
    } else if (tab === 'tasks') await loadTasks();
    else if (tab === 'context') await loadContext();
  }, 700);
}

function scheduleLogRender() {
  if (state.logTimer) return;
  state.logTimer = setTimeout(() => {
    state.logTimer = null;
    if (state.tab === 'logs') renderLogs();
  }, 120);
}

async function refreshActiveList() {
  switch (state.tab) {
    case 'inbox': return loadItems();
    case 'outbox': return loadApprovals();
    case 'tasks': return loadTasks();
    case 'logs': return loadEvents();
    case 'context': return loadContext();
    default: return undefined;
  }
}

async function refreshAll() {
  await refreshOverview();
  await refreshActiveList();
}

// ───────────────────────────── 展开详情 ─────────────────────────────
async function toggleDetail(kind, id) {
  const card = document.querySelector(`.card[data-kind="${kind}"][data-id="${cssEscape(id)}"]`);
  if (!card) return;
  const box = $('.detail', card);
  const btn = $('[data-act="toggle"]', card);
  if (!box) return;
  if (!box.hidden) {
    box.hidden = true;
    if (btn) btn.textContent = '▾';
    return;
  }
  box.hidden = false;
  if (btn) btn.textContent = '▴';
  const key = `${kind}:${id}`;
  if (state.details.has(key)) {
    box.innerHTML = kind === 'item' ? itemDetailHtml(state.details.get(key)) : taskDetailHtml(state.details.get(key));
    return;
  }
  box.innerHTML = '<div class="detail-empty">加载中…</div>';
  try {
    const data = kind === 'item'
      ? await api('/api/items/' + encodeURIComponent(id))
      : await api('/api/tasks/' + encodeURIComponent(id));
    state.details.set(key, data);
    box.innerHTML = kind === 'item' ? itemDetailHtml(data) : taskDetailHtml(data);
  } catch (e) {
    box.innerHTML = `<div class="detail-empty" style="color:#ffb3bb">加载失败：${esc(e.message)}</div>`;
  }
}

// ───────────────────────────── 动作 ─────────────────────────────
async function withBusy(el, fn) {
  if (el) { el.disabled = true; el.classList.add('spin'); }
  try { return await fn(); }
  finally { if (el) { el.disabled = false; el.classList.remove('spin'); } }
}

async function itemAction(id, action, payload, el) {
  return withBusy(el, async () => {
    const r = await api(`/api/items/${encodeURIComponent(id)}/action`, {
      method: 'POST',
      body: JSON.stringify({ action, payload }),
    });
    return r;
  });
}

async function onItemAction(act, id, el, card) {
  try {
    if (act === 'toggle') return toggleDetail('item', id);
    if (act === 'dispatch') {
      const r = await itemAction(id, 'dispatch', {}, el);
      toast('已派单：任务 ' + (r.task ? r.task.id : '') + ' 进入队列', 'ok');
    } else if (act === 'archive') {
      if (!confirm('归档后该事项从收件箱移出，进入 archive 栏位。继续？')) return;
      await itemAction(id, 'archive', {}, el);
      toast('已归档', 'ok');
    } else if (act === 'drop') {
      if (!confirm('丢弃会把它标记为 dropped 并归档（不是删除数据库记录）。继续？')) return;
      await itemAction(id, 'drop', {}, el);
      toast('已丢弃', 'ok');
    } else if (act === 'restore') {
      await itemAction(id, 'restore', {}, el);
      toast('已恢复回收件箱', 'ok');
    } else {
      return;
    }
    if (card) state.details.delete('item:' + id);
    await refreshAll();
  } catch (e) {
    toast('操作失败：' + e.message, 'err');
  }
}

async function onTaskAction(act, id, el) {
  try {
    if (act === 'toggle') return toggleDetail('task', id);
    if (act === 'retry') {
      const r = await withBusy(el, () => api(`/api/tasks/${encodeURIComponent(id)}/retry`, { method: 'POST', body: '{}' }));
      toast(r.note || '已重新入队', 'ok');
    } else if (act === 'cancel') {
      if (!confirm('取消后任务不再执行（若进程仍在跑，Watchdog 会在下一次 tick 结束它）。继续？')) return;
      const r = await withBusy(el, () => api(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' }));
      toast(r.note || '已取消', 'ok');
    } else {
      return;
    }
    state.details.delete('task:' + id);
    await refreshAll();
  } catch (e) {
    toast('操作失败：' + e.message, 'err');
  }
}

async function onApprovalAction(act, id, el, card) {
  try {
    if (act === 'approve' || act === 'reject') {
      const decision = act === 'approve' ? 'approved' : 'rejected';
      const option = state.deciding.get(id) || null;
      const noteEl = card ? $('[data-role="note"]', card) : null;
      const note = noteEl ? noteEl.value.trim() : (state.notes.get(id) || '');
      const title = card ? ($('.approval-head h3', card)?.textContent || id) : id;
      const verb = decision === 'approved' ? '批准' : '拒绝';
      const extra = option ? `\n选项：${option}` : '';
      const noteLine = note ? `\n备注：${note}` : '';
      if (!confirm(`${verb}「${title}」？${extra}${noteLine}\n\n这是副作用闸门，决定会写入审批记录。`)) return;
      const r = await withBusy(el, () => api(`/api/approvals/${encodeURIComponent(id)}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision, option, note: note || null, by: 'dashboard' }),
      }));
      toast(decision === 'approved' ? '已批准' + (r.item ? '，事项进入 active' : '') : '已拒绝，事项归档', 'ok');
      state.deciding.delete(id);
      state.notes.delete(id);
    } else {
      return;
    }
    await refreshAll();
  } catch (e) {
    toast('审批失败：' + e.message, 'err');
  }
}

// ───────────────────────────── 事件绑定 ─────────────────────────────
function applyTab(name) {
  const tab = ['inbox', 'outbox', 'tasks', 'logs', 'context'].includes(name) ? name : 'inbox';
  state.tab = tab;
  $$('.tab').forEach((t) => {
    const on = t.dataset.tab === tab;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  $$('.panel').forEach((p) => {
    const on = p.dataset.panel === tab;
    p.classList.toggle('is-active', on);
    p.hidden = !on;
  });
  if (location.hash !== '#' + tab) history.replaceState(null, '', '#' + tab);
  return tab;
}

function switchTab(name) {
  applyTab(name);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  return refreshActiveList();
}

function bindEvents() {
  // 标签页
  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) switchTab(tab.dataset.tab);
  });

  // 指标卡跳转
  $('#metrics').addEventListener('click', (e) => {
    const m = e.target.closest('[data-goto]');
    if (!m) return;
    if (m.dataset.goto === 'doctor') return openDoctor();
    switchTab(m.dataset.goto);
  });

  // 顶栏动作
  $('#btn-scan').addEventListener('click', triggerScan);
  $('#btn-doctor').addEventListener('click', () => openDoctor());
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#drawer-mask').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

  // 收件箱筛选
  let qTimer = null;
  $('#f-q').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { state.itemQuery.q = e.target.value.trim(); loadItems(); }, 260);
  });
  const onFilter = () => {
    state.itemQuery.bucket = $('#f-bucket').value;
    state.itemQuery.source = $('#f-source').value;
    state.itemQuery.status = $('#f-status').value;
    state.itemQuery.level = $('#f-level').value;
    loadItems();
  };
  ['#f-bucket', '#f-source', '#f-status'].forEach((sel) => $(sel).addEventListener('change', onFilter));
  $('#f-level').addEventListener('change', () => { state.itemQuery.level = $('#f-level').value; renderInbox(); });
  $('#btn-refresh-inbox').addEventListener('click', loadItems);

  // 投递事项
  $('#btn-new-item').addEventListener('click', () => toggleNewItem(true));
  $('#ni-cancel').addEventListener('click', () => toggleNewItem(false));
  $('#new-item-form').addEventListener('submit', submitNewItem);

  // 待拍板 / 任务 / 日志筛选
  $('#outbox-filter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-status]');
    if (!b) return;
    state.approvalStatus = b.dataset.status;
    $$('#outbox-filter .seg').forEach((s) => s.classList.toggle('is-active', s === b));
    loadApprovals();
  });
  $('#task-filter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-status]');
    if (!b) return;
    state.taskStatus = b.dataset.status;
    $$('#task-filter .seg').forEach((s) => s.classList.toggle('is-active', s === b));
    loadTasks();
  });
  $('#log-filter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-level]');
    if (!b) return;
    state.eventLevel = b.dataset.level;
    $$('#log-filter .seg').forEach((s) => s.classList.toggle('is-active', s === b));
    loadEvents();
  });
  $('#log-pause').addEventListener('change', (e) => { state.logPaused = e.target.checked; });
  $('#btn-log-clear').addEventListener('click', () => { state.events = []; renderLogs(); });
  $('#btn-log-refresh').addEventListener('click', loadEvents);
  $('#btn-refresh-tasks').addEventListener('click', loadTasks);

  // 上下文
  $('#btn-new-fact').addEventListener('click', () => openFactForm(null));
  $('#btn-refresh-context').addEventListener('click', loadContext);
  $('#cf-cancel').addEventListener('click', () => closeFactForm());
  $('#fact-form').addEventListener('submit', submitFact);

  // 主区域事件委托
  const main = $('#main');
  main.addEventListener('click', onMainClick);
  main.addEventListener('change', onMainChange);
  main.addEventListener('input', onMainInput);
}

function onMainClick(e) {
  // 空状态按钮
  const emptyAct = e.target.closest('[data-empty-act]');
  if (emptyAct) {
    const act = emptyAct.dataset.emptyAct;
    if (act === 'new-item') return toggleNewItem(true);
    if (act === 'scan') return triggerScan();
    if (act === 'clear-filters') return clearFilters();
    if (act === 'reload') return refreshAll();
    if (act === 'new-fact') return openFactForm(null);
    if (act === 'outbox-all') {
      state.approvalStatus = '';
      $$('#outbox-filter .seg').forEach((s) => s.classList.toggle('is-active', s.dataset.status === ''));
      return loadApprovals();
    }
    if (act === 'task-all') {
      state.taskStatus = '';
      $$('#task-filter .seg').forEach((s) => s.classList.toggle('is-active', s.dataset.status === ''));
      return loadTasks();
    }
    return;
  }

  // 事件引用 chip
  const ref = e.target.closest('[data-ref]');
  if (ref) return jumpToRef(ref.dataset.ref, ref.dataset.refId);

  // 审批选项
  const opt = e.target.closest('[data-opt]');
  if (opt) {
    const card = opt.closest('[data-kind="approval"]');
    const id = card?.dataset.id;
    if (id) {
      state.deciding.set(id, opt.dataset.opt);
      $$('.opt', card).forEach((o) => o.classList.toggle('is-sel', o === opt));
      const btn = $('[data-act="approve"]', card);
      if (btn) btn.textContent = '批准 · ' + truncate(opt.dataset.opt, 18);
    }
    return;
  }

  // 卡片动作
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const card = btn.closest('[data-kind]');
  if (!card) return;
  const kind = card.dataset.kind;
  const id = card.dataset.id;

  if (kind === 'item') return onItemAction(act, id, btn, card);
  if (kind === 'task') return onTaskAction(act, id, btn);
  if (kind === 'approval') return onApprovalAction(act, id, btn, card);
  if (kind === 'fact') {
    if (act === 'edit-fact') {
      const fact = (state.context?.facts || []).find((f) => f.id === id);
      return openFactForm(fact || null);
    }
    if (act === 'del-fact') return deleteFact(id);
  }
  return undefined;
}

function onMainChange(e) {
  const sel = e.target.closest('select[data-act="relevel"]');
  if (!sel) return;
  const card = sel.closest('[data-kind="item"]');
  const id = card?.dataset.id;
  const level = Number(sel.value);
  if (!id || !level) return;
  if (!confirm(`把该事项的自主等级调整为 L${level}（${LABELS.level[level]}）？`)) { sel.value = ''; return; }
  sel.value = '';
  (async () => {
    try {
      await api(`/api/items/${encodeURIComponent(id)}/action`, {
        method: 'POST',
        body: JSON.stringify({ action: 'relevel', payload: { level, reason: 'dashboard 手动调整' } }),
      });
      toast(`已调级 → L${level}`, 'ok');
      state.details.delete('item:' + id);
      await refreshAll();
    } catch (err) {
      toast('调级失败：' + err.message, 'err');
    }
  })();
}

function onMainInput(e) {
  const ta = e.target.closest('textarea[data-role="note"]');
  if (!ta) return;
  const card = ta.closest('[data-kind="approval"]');
  if (card) state.notes.set(card.dataset.id, ta.value);
}

async function jumpToRef(kind, id) {
  if (kind === 'approval') {
    state.approvalStatus = '';
    $$('#outbox-filter .seg').forEach((s) => s.classList.toggle('is-active', s.dataset.status === ''));
    await switchTab('outbox');
    const el = document.querySelector(`.card[data-kind="approval"][data-id="${cssEscape(id)}"]`);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('prio-warm'); }
    else toast('审批不在当前列表（可能已被处理）', 'info');
    return;
  }
  if (kind === 'task') {
    state.taskStatus = '';
    $$('#task-filter .seg').forEach((s) => s.classList.toggle('is-active', s.dataset.status === ''));
    await switchTab('tasks');
    const el = document.querySelector(`.card[data-kind="task"][data-id="${cssEscape(id)}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (!state.details.has('task:' + id)) await toggleDetail('task', id);
    } else toast('任务不在当前列表', 'info');
    return;
  }
  // item
  state.itemQuery = { bucket: '', source: '', status: '', q: '', level: '' };
  $('#f-bucket').value = ''; $('#f-source').value = ''; $('#f-status').value = ''; $('#f-level').value = '';
  await switchTab('inbox');
  const el = document.querySelector(`.card[data-kind="item"][data-id="${cssEscape(id)}"]`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (!state.details.has('item:' + id)) await toggleDetail('item', id);
  } else toast('事项不在当前列表', 'info');
}

function clearFilters() {
  state.itemQuery = { bucket: 'inbox', source: '', status: '', q: '', level: '' };
  $('#f-q').value = '';
  $('#f-bucket').value = 'inbox';
  $('#f-source').value = '';
  $('#f-status').value = '';
  $('#f-level').value = '';
  loadItems();
}

// ───────────────────────────── 新建事项 ─────────────────────────────
function toggleNewItem(show) {
  const form = $('#new-item-form');
  form.hidden = !show;
  if (show) setTimeout(() => $('#ni-title').focus(), 30);
  else form.reset();
}

async function submitNewItem(e) {
  e.preventDefault();
  const title = $('#ni-title').value.trim();
  if (!title) return;
  const btn = $('#ni-submit');
  btn.disabled = true;
  try {
    await api('/api/items', {
      method: 'POST',
      body: JSON.stringify({
        title,
        body: title,
        kind: $('#ni-kind').value,
        domain: $('#ni-domain').value || null,
        source: 'manual',
      }),
    });
    toast('已投递，等待 triage', 'ok');
    toggleNewItem(false);
    await refreshAll();
  } catch (err) {
    toast('投递失败：' + err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

// ───────────────────────────── 上下文编辑 ─────────────────────────────
function openFactForm(fact) {
  state.editingFact = fact;
  const form = $('#fact-form');
  form.hidden = false;
  $('#cf-category').value = fact?.category || '';
  $('#cf-key').value = fact?.key || '';
  $('#cf-value').value = fact?.value || '';
  $('#cf-evidence').value = fact?.evidence || '';
  $('#cf-confidence').value = fact?.confidence != null ? String(fact.confidence) : '0.8';
  // 编辑模式下分类/键不可改（upsert 以 category+key 为唯一键）
  $('#cf-category').readOnly = !!fact;
  $('#cf-key').readOnly = !!fact;
  $('#cf-submit').textContent = fact ? '保存修改' : '保存';
  $('#cf-value').focus();
}

function closeFactForm() {
  state.editingFact = null;
  $('#fact-form').hidden = true;
  $('#fact-form').reset();
  $('#cf-category').readOnly = false;
  $('#cf-key').readOnly = false;
  $('#cf-confidence').value = '0.8';
}

async function submitFact(e) {
  e.preventDefault();
  const editing = state.editingFact;
  const payload = {
    category: (editing ? editing.category : $('#cf-category').value.trim()) || '未分类',
    key: (editing ? editing.key : $('#cf-key').value.trim()),
    value: $('#cf-value').value.trim(),
    evidence: $('#cf-evidence').value.trim() || null,
    confidence: Number($('#cf-confidence').value),
  };
  if (!payload.key || !payload.value) { toast('key 与 value 必填', 'err'); return; }
  const btn = $('#cf-submit');
  btn.disabled = true;
  try {
    await api('/api/context', { method: 'POST', body: JSON.stringify(payload) });
    toast(editing ? '已更新上下文' : '已新增上下文', 'ok');
    closeFactForm();
    await loadContext();
    await refreshOverview();
  } catch (err) {
    toast('保存失败：' + err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function deleteFact(id) {
  if (!confirm('从上下文里删除这条事实？')) return;
  try {
    await api(`/api/context/${encodeURIComponent(id)}/delete`, { method: 'POST', body: '{}' });
    toast('已删除', 'ok');
    await loadContext();
    await refreshOverview();
  } catch (err) {
    toast('删除失败：' + err.message, 'err');
  }
}

// ───────────────────────────── 巡检 ─────────────────────────────
async function triggerScan() {
  const btn = $('#btn-scan');
  if (state.busy.has('scan')) return;
  state.busy.add('scan');
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = '巡检中…';
  toast('正在跑一轮传感器巡检（最长约 30 秒）', 'info');
  try {
    const r = await api('/api/scan', { method: 'POST', body: JSON.stringify({}) });
    if (r.ok === false) toast('巡检未执行：' + (r.reason || '未知原因') + (r.detail ? `（${r.detail}）` : ''), 'err');
    else if (r.running) toast('已有一轮巡检在进行，本次跳过', 'info');
    else toast(`巡检完成：扫描 ${r.scanned ?? 0} 条 · 新建 ${r.created ?? 0} · 去重 ${r.seen ?? 0}${r.failed ? ' · 失败 ' + r.failed : ''}`, 'ok');
    await refreshAll();
  } catch (e) {
    toast('巡检失败：' + e.message, 'err');
  } finally {
    state.busy.delete('scan');
    btn.disabled = false;
    btn.textContent = prev;
  }
}

// ───────────────────────────── 环境自检抽屉 ─────────────────────────────
function showDrawer(html) {
  $('#drawer-body').innerHTML = html;
  $('#drawer').hidden = false;
  $('#drawer-mask').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeDrawer() {
  $('#drawer').hidden = true;
  $('#drawer-mask').hidden = true;
  document.body.style.overflow = '';
}

async function openDoctor() {
  showDrawer('<div class="detail-empty">正在探测环境（执行器 / 通道 / 数据库）…</div>');
  try {
    const d = await api('/api/doctor');
    state.doctor = d;
    renderDoctor(d);
  } catch (e) {
    showDrawer(`<div class="dr-section"><h3>探测失败</h3><p class="dr-warn">${esc(e.message)}</p></div>`);
  }
}

function renderDoctor(d) {
  const probes = Object.entries(d.executors?.probes || {});
  const chans = Object.entries(d.channels || {});
  const okCell = (ok) => `<span class="${ok ? 'ok-yes' : 'ok-no'}">${ok ? '✓ 就绪' : '✗ 缺失'}</span>`;

  const execRows = probes.length
    ? probes.map(([name, p]) => `<tr><td>${esc(name)}</td><td>${okCell(p.ok)}</td><td class="mono">${esc(p.version || '—')}</td><td class="mono">${esc(p.reason || '')}</td></tr>`).join('')
    : `<tr><td colspan="4" class="detail-empty">${esc(d.executors?.reason || '执行器注册表未就绪')}${d.executors?.detail ? '（' + esc(d.executors.detail) + '）' : ''}</td></tr>`;

  const chanRows = chans.map(([name, c]) => `<tr><td>${esc(name)}</td><td>${okCell(c.ok)}</td><td class="mono">${esc(c.path || c.version || c.error || '—')}</td><td class="mono">${esc(c.note || '')}</td></tr>`).join('');

  const warnings = (d.warnings || []).map((w) => `<div class="dr-warn">⚠ ${esc(w)}</div>`).join('');
  const notes = (d.notes || []).map((w) => `<div class="hint">· ${esc(w)}</div>`).join('');

  showDrawer(`
    <div class="dr-section">
      <div class="dr-verdict ${d.ok ? 'ok' : 'bad'}">${d.ok ? '✓ 环境基本就绪' : '✗ 环境不完整'}${d.reason ? ' · ' + esc(d.reason) : ''}</div>
      ${warnings ? `<div style="margin-top:8px">${warnings}</div>` : ''}
      ${notes ? `<div style="margin-top:8px">${notes}</div>` : ''}
    </div>

    <div class="dr-section">
      <h3>执行器 executors（${d.summary ? d.summary.executorsOk + '/' + d.summary.executorsTotal + ' 可用' : '—'}）</h3>
      <table class="dr-table"><thead><tr><th>名称</th><th>状态</th><th>版本</th><th>原因</th></tr></thead><tbody>${execRows}</tbody></table>
    </div>

    <div class="dr-section">
      <h3>外部通道 channels</h3>
      <table class="dr-table"><thead><tr><th>通道</th><th>状态</th><th>路径 / 版本</th><th>说明</th></tr></thead><tbody>${chanRows}</tbody></table>
    </div>

    <div class="dr-section">
      <h3>数据库</h3>
      <table class="dr-table"><tbody>
        <tr><td>状态</td><td>${okCell(d.db?.ok)}</td></tr>
        <tr><td>路径</td><td class="mono">${esc(d.db?.path || '—')}</td></tr>
        <tr><td>主库 / WAL</td><td class="mono">${fmt.bytes(d.db?.sizeBytes)} / ${fmt.bytes(d.db?.walBytes)}</td></tr>
        <tr><td>行数</td><td class="mono">${esc(Object.entries(d.db?.stats || {}).map(([k, v]) => k + '=' + v).join('  '))}</td></tr>
      </tbody></table>
    </div>

    <div class="dr-section">
      <h3>配置</h3>
      <table class="dr-table"><tbody>
        <tr><td>home</td><td class="mono">${esc(d.config?.home || '—')}</td></tr>
        <tr><td>监听</td><td class="mono">${esc((d.config?.server?.host || '') + ':' + (d.config?.server?.port || ''))}</td></tr>
        <tr><td>token</td><td>${d.config?.server?.tokenRequired ? '已启用' : '未启用（本地免密）'}</td></tr>
        <tr><td>启用执行器</td><td class="mono">${esc((d.config?.executorsEnabled || []).join(', ') || '—')}</td></tr>
        <tr><td>启用传感器</td><td class="mono">${esc((d.config?.sourcesEnabled || []).join(', ') || '—')}</td></tr>
        <tr><td>今日预算</td><td class="mono">${fmt.money(d.budget?.costCny)} / ${fmt.money(d.budget?.budget)}</td></tr>
        <tr><td>Node</td><td class="mono">${esc(d.node?.version || '')} · ${esc(d.node?.platform || '')}/${esc(d.node?.arch || '')}</td></tr>
      </tbody></table>
    </div>

    <div class="dr-section">
      <h3>原始 JSON</h3>
      <pre class="mini">${esc(JSON.stringify(d, null, 2))}</pre>
    </div>
  `);
}

// ───────────────────────────── SSE ─────────────────────────────
function setConnState({ open, error }) {
  if (open != null) state.sseOpen = open;
  if (error != null) state.sseError = error;
  renderConn();
}

function connectSSE() {
  if (!('EventSource' in window)) { startPolling(); return; }
  const url = '/api/stream' + (URL_TOKEN ? '?token=' + encodeURIComponent(URL_TOKEN) : '');
  let es;
  try { es = new EventSource(url); }
  catch { startPolling(); return; }
  state.sse = es;

  es.onopen = () => {
    setConnState({ open: true, error: false });
    setOnline(true);
    stopPolling();
  };
  es.onerror = () => {
    setConnState({ open: false, error: true });
    if (es.readyState === 2 /* CLOSED */) {
      es.close();
      startPolling();
    }
  };
  es.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'hello') { setConnState({ open: true, error: false }); return; }
    if (msg.type === 'event' && msg.event) onLiveEvent(msg.event);
  };
}

function onLiveEvent(ev) {
  if (!ev) return;
  if (ev.id != null && state.events.some((e) => String(e.id) === String(ev.id))) return;
  if (!state.eventLevel || ev.level === state.eventLevel) {
    if (!state.logPaused) {
      state.events = [ev, ...state.events].slice(0, 500);
      if (state.tab === 'logs') scheduleLogRender();
    }
  }
  scheduleRefresh();
}

function startPolling() {
  if (state.pollTimer) return;
  setConnState({ open: false, error: true });
  state.pollTimer = setInterval(async () => {
    await refreshOverview();
    await refreshActiveList();
  }, 5000);
}

function stopPolling() {
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
}

// ───────────────────────────── 启动 ─────────────────────────────
function restoreTab() {
  const h = (location.hash || '').replace('#', '');
  if (['inbox', 'outbox', 'tasks', 'logs', 'context'].includes(h)) return h;
  return 'inbox';
}

async function boot() {
  bindEvents();

  fillSelect($('#f-source'), [['', '全部来源'], ...DEFAULT_SOURCES.map((s) => [s, s])], '');
  fillSelect($('#f-status'), [['', '全部状态'], ...LABELS.itemStatuses.map((s) => [s, LABELS.status[s]])], '');

  applyTab(restoreTab());
  setConnState({ open: false, error: false });

  await refreshOverview();
  await refreshActiveList();
  if (!NO_SSE) connectSSE();
  if (OPEN_DOCTOR) setTimeout(() => openDoctor(), 50);

  // 兜底：即使 SSE 静默，也定期刷新（页面可见时才拉）
  setInterval(() => { if (!document.hidden) refreshOverview(); }, 45000);
  setInterval(() => { if (!document.hidden) refreshActiveList(); }, 60000);
  setInterval(() => {
    $('#foot-time').textContent = '本地时间 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
  }, 1000);

  window.addEventListener('hashchange', () => {
    const t = restoreTab();
    if (t !== state.tab) switchTab(t);
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
