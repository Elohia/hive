// src/sensors/calendar.mjs — 日历传感器（ICS，只读）
//
// 本机现实：没有日历应用，也没有 data/calendar/ 目录 → 默认**0 条**并说明原因。
// 因此这里实现一个零依赖的最小 ICS(iCalendar RFC5545) 解析器：
//   - 行折叠（续行以空格/TAB 开头）
//   - VEVENT 区块、属性参数（TZID/VALUE=DATE）
//   - DTSTART/DTEND/SUMMARY/LOCATION/DESCRIPTION/UID/STATUS
// 支持 ctx.opts.icsText 直接喂内存文本（冒烟测试用它验证解析器，不写任何文件）。
import {
  expandSimpleGlob, clampInt, note, oneLine, truncate, readTextSafe, statSafe,
} from './_util.mjs';

const NAME = 'calendar';

/* ------------------------------ ICS 解析 ------------------------------ */

function unfold(text) {
  const raw = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const out = [];
  for (const line of raw.split('\n')) {
    if (/^[ \t]/.test(line) && out.length > 0) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}

function splitProp(line) {
  const idx = line.indexOf(':');
  if (idx < 0) return null;
  const left = line.slice(0, idx);
  const value = line.slice(idx + 1);
  const parts = left.split(';');
  const name = (parts.shift() || '').toUpperCase();
  const params = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) { if (p) params[p.toUpperCase()] = true; continue; }
    params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  return { name, params, value };
}

function unescapeIcs(v) {
  return String(v)
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

/** ICS 时间 → { ms, allDay, dateOnly } */
function parseIcsDate(value, params = {}) {
  const v = String(value || '').trim();
  const valueType = String(params.VALUE || '').toUpperCase();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (m) {
    const [, Y, M, D, h, mi, s, z] = m;
    const ms = z
      ? Date.UTC(+Y, +M - 1, +D, +h, +mi, +s)
      : new Date(+Y, +M - 1, +D, +h, +mi, +s).getTime();
    return { ms, allDay: false };
  }
  m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) {
    const [, Y, M, D] = m;
    return { ms: new Date(+Y, +M - 1, +D).getTime(), allDay: true };
  }
  if (valueType === 'DATE') return null;
  const fallback = Date.parse(v);
  return Number.isFinite(fallback) ? { ms: fallback, allDay: false } : null;
}

/** 解析 ICS 文本 → 事件数组（不抛错，坏区块跳过） */
export function parseIcs(text, { fileName = null } = {}) {
  const events = [];
  if (!text) return events;
  const lines = unfold(text);
  let cur = null;
  let depth = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/^BEGIN:VEVENT$/i.test(t)) { cur = {}; depth++; continue; }
    if (/^END:VEVENT$/i.test(t)) {
      if (cur) events.push(cur);
      cur = null;
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (!cur) continue;
    const p = splitProp(t);
    if (!p) continue;
    switch (p.name) {
      case 'UID': cur.uid = p.value.trim(); break;
      case 'SUMMARY': cur.summary = unescapeIcs(p.value).trim(); break;
      case 'DESCRIPTION': cur.description = unescapeIcs(p.value); break;
      case 'LOCATION': cur.location = unescapeIcs(p.value).trim(); break;
      case 'STATUS': cur.status = p.value.trim().toUpperCase(); break;
      case 'DTSTART': cur.dtstart = parseIcsDate(p.value, p.params); cur.dtstartRaw = p.value; break;
      case 'DTEND': cur.dtend = parseIcsDate(p.value, p.params); cur.dtendRaw = p.value; break;
      case 'RRULE': cur.rrule = p.value.trim(); break;
      default: break;
    }
  }
  return events.map((e) => ({
    uid: e.uid || null,
    summary: e.summary || '（无标题）',
    description: e.description || '',
    location: e.location || '',
    status: e.status || null,
    rrule: e.rrule || null,
    startMs: e.dtstart ? e.dtstart.ms : null,
    endMs: e.dtend ? e.dtend.ms : (e.dtstart ? e.dtstart.ms + 3600_000 : null),
    allDay: !!(e.dtstart && e.dtstart.allDay),
    dtstartRaw: e.dtstartRaw || null,
    file: fileName,
  }));
}

/** 日历事件领域：只允许白名单值（会议类→work，其余→life） */
export function domainOfEvent(ev) {
  const t = `${ev.summary || ''} ${ev.description || ''} ${ev.location || ''}`;
  if (/会|评审|会议|周会|站会|review|sync|standup|deploy|上线|客户|汇报|面试/.test(t)) return 'work';
  if (/生日|家庭|孩子|家人|医院|看病|聚会|旅行|婚礼|纪念日/.test(t)) return 'family';
  return 'life';
}

/* ------------------------------ Sensor ------------------------------ */

export default {
  name: NAME,
  title: '日历（ICS）',
  enabled(cfg) {
    return !!(cfg?.sources?.calendar?.enabled);
  },

  async *scan(ctx) {
    const cfg = ctx?.cfg || {};
    const sc = cfg?.sources?.calendar || {};
    const opts = ctx?.opts || {};
    const patterns = Array.isArray(sc.icsPaths) && sc.icsPaths.length ? sc.icsPaths : ['data\\calendar\\*.ics'];
    const lookaheadHours = clampInt(sc.lookaheadHours, 1, 24 * 60, 72);
    const includeOngoing = opts.includeOngoing !== false;
    const maxItems = clampInt(opts.maxItems, 1, 500, 60);

    const t0 = Date.now();
    const now = ctx?.now instanceof Date ? ctx.now : new Date();
    const nowMs = now.getTime();
    const horizonMs = nowMs + lookaheadHours * 3600_000;

    // 1) 内存样例（测试用，不碰文件系统）
    const synthetic = typeof opts.icsText === 'string' && opts.icsText.trim() ? opts.icsText : null;
    let sources = [];
    if (synthetic) {
      sources = [{ file: 'inline:icsText', text: synthetic }];
    } else {
      const files = [];
      for (const pat of patterns) {
        for (const f of expandSimpleGlob(cfg, pat)) if (!files.includes(f)) files.push(f);
      }
      for (const f of files) {
        const st = statSafe(f);
        if (!st || !st.isFile()) continue;
        const text = readTextSafe(f, 2 * 1024 * 1024);
        if (text != null) sources.push({ file: f, text, mtimeMs: st.mtimeMs });
      }
    }

    if (sources.length === 0) {
      const hint = patterns.join(', ');
      note(ctx, NAME, {
        ok: true,
        count: 0,
        files: 0,
        note: `无 ICS 文件（查找：${hint}；本机未配置日历，data/calendar/ 不存在）→ 0 条属预期，非故障`,
      });
      ctx?.log?.('info', 'sensor:calendar', { files: 0, hint });
      return;
    }

    // 2) 解析 + 时间窗过滤
    let parsed = 0;
    let bad = 0;
    const out = [];
    for (const src of sources) {
      try {
        const evs = parseIcs(src.text, { fileName: src.file });
        parsed += evs.length;
        for (const ev of evs) {
          if (ev.startMs == null) { bad++; continue; }
          if (ev.status === 'CANCELLED') continue;
          const endMs = ev.endMs == null ? ev.startMs : ev.endMs;
          const isUpcoming = ev.startMs >= nowMs && ev.startMs <= horizonMs;
          const isOngoing = includeOngoing && ev.startMs < nowMs && endMs >= nowMs;
          if (!isUpcoming && !isOngoing) continue;
          out.push({ ...ev, ongoing: isOngoing });
        }
      } catch (e) {
        bad++;
        ctx?.log?.('warn', 'sensor:calendar 文件解析失败', { file: src.file, error: oneLine(e?.message || e, 100) });
      }
    }

    out.sort((a, b) => a.startMs - b.startMs);

    // 3) 产出
    let emitted = 0;
    for (const ev of out) {
      if (emitted >= maxItems) break;
      try {
        const startIso = new Date(ev.startMs).toISOString();
        const endIso = ev.endMs ? new Date(ev.endMs).toISOString() : null;
        const hoursTo = (ev.startMs - nowMs) / 3600_000;
        const when = ev.allDay
          ? `${startIso.slice(0, 10)}（全天）`
          : `${startIso.slice(0, 16).replace('T', ' ')} → ${endIso ? endIso.slice(11, 16) : '?'}${ev.ongoing ? '（进行中）' : ''}`;

        const body = [
          `时间：${when}`,
          ev.location ? `地点：${ev.location}` : null,
          ev.status ? `状态：${ev.status}` : null,
          ev.rrule ? `重复：${ev.rrule}` : null,
          ev.description ? '' : null,
          ev.description ? `详情：${truncate(ev.description, 1200)}` : null,
          ev.file ? `来源：${ev.file}` : null,
        ].filter((x) => x != null).join('\n');

        let urgency = 3;
        if (ev.ongoing) urgency = 5;
        else if (hoursTo <= 2) urgency = 5;
        else if (hoursTo <= 24) urgency = 4;
        else if (hoursTo <= 48) urgency = 3;
        else urgency = 2;

        emitted++;
        yield {
          source: NAME,
          source_ref: `cal:${ev.uid || `${ev.summary}@${ev.startMs}`}`,
          title: oneLine(`${ev.summary}${ev.allDay ? '（全天）' : ''}`, 160),
          body,
          ts: startIso,
          kind_hint: 'calendar_event',
          domain_hint: domainOfEvent(ev),
          urgency_hint: urgency,
          meta: {
            start: startIso,
            end: endIso,
            allDay: ev.allDay,
            location: ev.location || null,
            status: ev.status || null,
            rrule: ev.rrule || null,
            ongoing: ev.ongoing,
            hoursUntilStart: Number(hoursTo.toFixed(2)),
            file: ev.file,
            lookaheadHours,
            ...(synthetic ? { synthetic: true } : {}),
          },
        };
      } catch (e) {
        ctx?.log?.('warn', 'sensor:calendar 事件产出失败', { error: oneLine(e?.message || e, 100) });
      }
    }

    note(ctx, NAME, {
      ok: true,
      count: emitted,
      files: synthetic ? 0 : sources.length,
      parsedEvents: parsed,
      inWindow: out.length,
      bad,
      synthetic: !!synthetic,
      ms: Date.now() - t0,
      note: synthetic
        ? `内存样例：解析 ${parsed} 个事件，窗口内 ${out.length}，产出 ${emitted}`
        : `${sources.length} 个 ICS · 解析 ${parsed} 个事件 · 未来 ${lookaheadHours}h 内 ${emitted} 条`,
    });

    ctx?.log?.('info', 'sensor:calendar', { files: sources.length, parsed, inWindow: out.length, emitted });
  },
};

export const __internals = { parseIcs, parseIcsDate, unfold, splitProp, domainOfEvent };
