// src/sensors/mail.mjs — 邮箱传感器（agently-cli / QQ 邮箱）
//
// 实测通道（2026-11 本机，账号 elohia@agent.qq.com）：
//   agently-cli +me
//   agently-cli message +list --dir inbox --limit N --is-unread [--cursor <next_cursor>]
//   agently-cli message +read --id <message_id>
//
// envelope 实测形状（注意 data.data 的**双层嵌套**）：
//   { "ok": true,
//     "data": { "data": [ { message_id, subject, snippet, from:{email,name},
//                           created_at, is_read, has_attachments, dir:{dir_name} } ],
//               "pagination": { has_more, next_cursor } },
//     "_notice": { "update": { ... } } }        ← 必须忽略
//   "tip:" 提示行走 stderr（stdout 是干净 JSON），safeJson 仍做了容错。
//
// ⚠ 已验证的副作用（重要）：
//   `message +read` **会把邮件标记为已读**（实测：读 1 封后未读数 13→12，
//   且 CLI 没有任何"标记未读"的回滚命令）。
//   因此本传感器**默认不抓正文**（fetchBody=false），只用 list 里的 snippet
//   ——感知层不该悄悄清掉用户的未读标记。
//   需要正文时显式开启：config `sources.mail.fetchBody=true` 或 `opts.withBody=true`，
//   开启即意味着接受"这些邮件会变成已读"。
//
// 噪声控制（2026-11 实测后补）：
//   1. **同轮聚合**：同一发件人 + 同一主题（主题做时间戳/编号归一）合并成 1 条 item，
//      否则一波 8 封完全相同的退信会刷 8 条。
//   2. **首轮年龄窗**：没有 cursor 时只取最近 lookbackHours（默认 48h），更早的旧邮件跳过
//      （仍记入 cursor，避免后续复扫再翻出来）。
//   3. **系统通知降级**：PostMaster / no-reply / mailer-daemon / 退信类 → kind_hint='fyi'、
//      urgency_hint=1。
//   4. 若窗口内没有新邮件、但收件箱有积压旧未读，只产 **1 条积压摘要**（fyi/1），
//      既不刷屏又让上层知道"收件箱堆着 N 封没人看"。
import {
  runCli, safeJson, truncate, oneLine, clip, stripHtml, normalizeText,
  clampInt, toIso, note, inferUrgency, hash, coerceDomain,
} from './_util.mjs';

const NAME = 'mail';

/* ------------------------------ 解析 ------------------------------ */

/** 从 list 结果里取出消息数组（容忍单层/双层结构） */
function extractList(json) {
  const d = json?.data;
  if (d && Array.isArray(d.data)) return { rows: d.data, pagination: d.pagination || null };
  if (Array.isArray(d)) return { rows: d, pagination: json?.pagination || null };
  if (Array.isArray(json?.items)) return { rows: json.items, pagination: null };
  return { rows: [], pagination: null };
}

function normalizeRow(row) {
  const from = row?.from && typeof row.from === 'object' ? row.from : {};
  return {
    id: row?.message_id || row?.id || null,
    subject: String(row?.subject || '').trim(),
    snippet: String(row?.snippet || '').trim(),
    fromName: String(from.name || '').trim(),
    fromEmail: String(from.email || '').trim(),
    ts: toIso(row?.created_at) || null,
    isRead: row?.is_read === true,
    hasAttachments: row?.has_attachments === true,
    dir: row?.dir?.dir_name || null,
  };
}

/* ------------------------------ 聚合与分类 ------------------------------ */

const SYSTEM_SENDER_RE = /(postmaster|mailer[-_]?daemon|no[-_]?reply|do[-_]?not[-_]?reply|notifications?@|bounce)/i;
const SYSTEM_SUBJECT_RE = /(退信|无法送达|投递失败|bounce|自动回复|auto[-_]?reply|系统通知|系统消息|undeliver)/i;

/** 主题归一：去掉 Re/Fwd、[标签]、(3)、日期、时间、编号，只留"同一类"的骨架 */
export function normalizeSubject(s) {
  return String(s || '')
    .replace(/^\s*(re|fw|fwd|回复|转发)\s*[:：]\s*/gi, '')
    .replace(/\[[^\]\n]{0,40}\]/g, ' ')              // [哨兵] [告警]
    .replace(/[(（]\s*\d{1,3}\s*[)）]/g, ' ')        // (3)
    .replace(/[0-9]{4}\s*[-/年.]\s*[0-9]{1,2}\s*[-/月.]\s*[0-9]{1,2}\s*日?/g, ' ') // 2026-10-30
    .replace(/[0-9]{1,2}\s*[:：]\s*[0-9]{2}(\s*[:：]\s*[0-9]{2})?/g, ' ')           // 00:01:02
    .replace(/[0-9]+/g, '#')                          // 其余数字归一（编号/计数）
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 系统通知类发件人/主题 */
export function isSystemMail(mail) {
  return SYSTEM_SENDER_RE.test(mail.fromEmail || '')
    || SYSTEM_SENDER_RE.test(mail.fromName || '')
    || SYSTEM_SUBJECT_RE.test(mail.subject || '');
}

/**
 * 同轮聚合：同一发件人 + 同一归一主题 → 一组。
 * 返回按"组内最新时间"倒序排列的组数组。
 */
export function groupMail(mails) {
  const map = new Map();
  for (const m of mails) {
    const sender = (m.fromEmail || m.fromName || '').toLowerCase();
    const key = `${sender}|${normalizeSubject(m.subject)}`;
    if (!map.has(key)) map.set(key, { key, list: [] });
    map.get(key).list.push(m);
  }
  const groups = [];
  for (const g of map.values()) {
    g.list.sort((a, b) => (Date.parse(b.ts || 0) || 0) - (Date.parse(a.ts || 0) || 0));
    groups.push({
      key: g.key,
      list: g.list,
      count: g.list.length,
      latest: g.list[0],
      earliest: g.list[g.list.length - 1],
      system: g.list.some(isSystemMail),
    });
  }
  groups.sort((a, b) => (Date.parse(b.latest.ts || 0) || 0) - (Date.parse(a.latest.ts || 0) || 0));
  return groups;
}

function domainOf(mail) {
  const t = `${mail.subject} ${mail.snippet}`;
  let d = 'comms';
  if (/退信|无法送达|投递失败|bounce|mailer-daemon/i.test(t)) d = 'ops';
  else if (/发票|对账|账单|付款|invoice|receipt|扣费/i.test(t)) d = 'finance';
  else if (/验证码|登录|安全提醒|设备|password|security/i.test(t)) d = 'security';
  else if (/会议|邀请|日程|calendar|invite/i.test(t)) d = 'calendar';
  return coerceDomain(d) || 'comms';
}

function senderLabel(mail) {
  return oneLine(mail.fromName || mail.fromEmail || '未知发件人', 40);
}

function titleOfGroup(group, fallback) {
  const m = group.latest;
  const subj = oneLine(m.subject || '（无主题）', 100);
  const who = senderLabel(m);
  const suffix = group.count > 1 ? `（${group.count} 封）` : '';
  return oneLine(`${who} · ${subj}${suffix}`, 160);
}

function buildGroupBody(group, bodyMeta, maxBodyChars) {
  const m = group.latest;
  const parts = [];
  parts.push(`发件人：${m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail || '未知'}`);
  if (m.dir) parts.push(`目录：${m.dir}`);
  if (group.count > 1) {
    parts.push(`⚠ 本轮聚合 ${group.count} 封同类邮件（同发件人 + 同主题）`);
    parts.push(`最近时间：${m.ts || '?'}`);
    parts.push(`最早时间：${group.earliest?.ts || '?'}`);
  } else if (m.ts) {
    parts.push(`时间：${m.ts}`);
  }
  if (group.list.some((x) => x.hasAttachments)) parts.push('附件：有');
  if (m.snippet) parts.push(`摘要：${truncate(m.snippet, 600)}`);
  if (bodyMeta?.fetched && bodyMeta.text) parts.push('', '正文：', truncate(bodyMeta.text, maxBodyChars));
  return parts.join('\n');
}

/* ------------------------------ 命令封装 ------------------------------ */

/** 读单封正文（失败返回 obj，绝不抛。注意：会标记已读） */
async function fetchBody(cmd, id, timeoutMs) {
  const res = await runCli(cmd, ['message', '+read', '--id', String(id)], { timeoutMs });
  if (!res.ok) return { ok: false, reason: res.timedOut ? 'timeout' : (res.error || `exit ${res.code}`) };
  const json = safeJson(res.stdout);
  const data = json?.ok === false ? null : json?.data;
  if (!data) return { ok: false, reason: 'bad-json' };
  const fmt = String(data.body_format || '').toUpperCase();
  const raw = typeof data.body === 'string' ? data.body : '';
  const text = fmt === 'HTML' || /<[a-z][\s\S]*>/i.test(raw) ? stripHtml(raw) : normalizeText(raw);
  return { ok: true, text, format: fmt || 'TEXT', attachments: data.attachment_count || 0 };
}

/** 拉一页列表（含失败归因） */
async function requestList(cmd, { dir, limit, unreadOnly, cursor, timeoutMs }) {
  const args = ['message', '+list', '--dir', dir, '--limit', String(limit)];
  if (unreadOnly) args.push('--is-unread');
  if (cursor) args.push('--cursor', String(cursor));
  const res = await runCli(cmd, args, { timeoutMs });
  if (!res.ok) {
    return { ok: false, rows: [], pagination: null, reason: res.timedOut ? `超时 ${timeoutMs}ms` : (res.error || `exit ${res.code}`) };
  }
  const json = safeJson(res.stdout);
  if (!json) return { ok: false, rows: [], pagination: null, reason: 'bad-json' };
  if (json.ok === false) {
    const msg = json?.error?.message || json?.error || 'ok=false';
    return { ok: false, rows: [], pagination: null, reason: oneLine(typeof msg === 'string' ? msg : JSON.stringify(msg), 200) };
  }
  const { rows, pagination } = extractList(json);
  return { ok: true, rows, pagination };
}

/* ------------------------------ Sensor ------------------------------ */

export default {
  name: NAME,
  title: '邮箱收件箱',
  enabled(cfg) {
    return !!(cfg?.sources?.mail?.enabled);
  },

  async *scan(ctx) {
    const cfg = ctx?.cfg || {};
    const sc = cfg?.sources?.mail || {};
    const command = sc.command || 'agently-cli';
    const dir = sc.dir || 'inbox';
    const limit = clampInt(sc.limit, 1, 50, 12);
    const unreadOnly = sc.unreadOnly !== false;
    const maxBodyChars = clampInt(sc.maxBodyChars, 200, 20_000, 2500);

    const opts = ctx?.opts || {};
    const now = ctx?.now instanceof Date ? ctx.now : new Date();
    const nowMs = now.getTime();
    const cmdTimeout = clampInt(opts.timeoutMs, 2_000, 60_000, 25_000);
    const bodyBudgetMs = clampInt(opts.bodyBudgetMs, 0, 120_000, 40_000);
    const maxBodies = clampInt(opts.maxBodies, 0, 50, 6);
    const maxPages = clampInt(opts.maxPages ?? sc.maxPages, 1, 10, 2);
    const lookbackHours = clampInt(opts.ageWindowHours ?? sc.lookbackHours, 1, 24 * 365, 48);
    const backlogSignal = opts.backlogSignal !== false && sc.backlogSignal !== false;
    // 默认不开：+read 会标记已读（见文件头）。显式 true 才抓正文。
    const fetchBodies = opts.withBody === true || sc.fetchBody === true;
    const wantFallback = opts.fallbackRecent !== false && sc.fallbackRecent !== false;

    const t0 = Date.now();
    const cursorKey = 'seen_message_ids';
    const backlogKey = 'backlog_ref';
    let seen = [];
    try {
      const raw = ctx?.cursor?.get(NAME, cursorKey);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) seen = parsed.map(String);
    } catch { seen = []; }
    const seenSet = new Set(seen);
    const isFirstRun = seen.length === 0;

    // ---- 1. 拉列表（有界分页） ----
    let pages = 0;
    let rows = [];
    let pageCursor = null;
    let firstFailure = null;
    const seenIds = new Set();

    while (pages < maxPages) {
      const page = await requestList(command, { dir, limit, unreadOnly, cursor: pageCursor, timeoutMs: cmdTimeout });
      if (!page.ok) { firstFailure = page.reason; break; }
      pages++;
      for (const r of page.rows) {
        const id = r?.message_id || r?.id;
        if (id && !seenIds.has(id)) { seenIds.add(id); rows.push(r); }
      }
      const more = page.pagination?.has_more && page.pagination?.next_cursor;
      if (!more) break;
      pageCursor = page.pagination.next_cursor;
    }

    let fallback = null;
    if (rows.length === 0 && !firstFailure && unreadOnly && wantFallback) {
      const fbLimit = clampInt(opts.fallbackLimit, 1, 20, Math.min(5, limit));
      const fb = await requestList(command, { dir, limit: fbLimit, unreadOnly: false, cursor: null, timeoutMs: cmdTimeout });
      if (fb.ok && fb.rows.length > 0) {
        rows = fb.rows;
        fallback = 'recent-read';
      }
    }

    if (firstFailure) {
      note(ctx, NAME, { ok: false, error: firstFailure, note: `agently-cli list 失败：${firstFailure}` });
      ctx?.log?.('warn', 'sensor:mail 列表失败', { reason: firstFailure });
      return;
    }

    const mails = rows.map(normalizeRow).filter((m) => m.id);

    // ---- 2. 年龄窗：首轮不许历史邮件全量涌入 ----
    const cutoffMs = nowMs - lookbackHours * 3600_000;
    const tooOld = [];
    const inWindow = [];
    for (const m of mails) {
      const ms = m.ts ? Date.parse(m.ts) : NaN;
      if (Number.isFinite(ms) && ms < cutoffMs) tooOld.push(m);
      else inWindow.push(m);
    }

    const fresh = inWindow.filter((m) => !seenSet.has(m.id));
    const emittedIds = [];
    const skippedOldUnseen = tooOld.filter((m) => !seenSet.has(m.id)).length;

    // ---- 3. 同轮聚合 + 逐组产出 ----
    const groups = groupMail(fresh);
    let bodiesOk = 0;
    let bodiesFail = 0;
    let aggregatedGroups = 0;
    let absorbedMails = 0;

    for (const group of groups) {
      const latest = group.latest;
      const system = group.system;

      let bodyMeta = { fetched: false, reason: 'snippet-only', text: '' };
      if (fetchBodies && !system) {
        const budgetLeft = bodyBudgetMs - (Date.now() - t0);
        if (maxBodies > 0 && bodiesOk + bodiesFail < maxBodies && budgetLeft > 3_000) {
          try {
            const r = await fetchBody(command, latest.id, Math.min(cmdTimeout, budgetLeft));
            if (r.ok) {
              bodiesOk++;
              bodyMeta = { fetched: true, format: r.format, attachmentCount: r.attachments, marksRead: true, text: r.text };
            } else {
              bodiesFail++;
              bodyMeta = { fetched: false, reason: r.reason, marksRead: true, text: '' };
            }
          } catch (e) {
            bodiesFail++;
            bodyMeta = { fetched: false, reason: oneLine(e?.message || e, 120), marksRead: true, text: '' };
          }
        } else {
          bodyMeta = { fetched: false, reason: 'skipped-by-budget', marksRead: true, text: '' };
        }
      }
      // 系统通知抓正文没价值（且会标记已读），直接跳过
      if (fetchBodies && system) bodyMeta = { fetched: false, reason: 'system-mail', text: '' };

      const urgency = system
        ? 1
        : Math.max(...group.list.map((m) => inferUrgency(`${m.subject} ${m.snippet}`, 3)));

      const latestDay = (latest.ts || new Date().toISOString()).slice(0, 10);
      const sourceRef = group.count > 1
        ? `mailgroup:${hash(group.key, 16)}:${latestDay}`
        : String(latest.id);

      for (const m of group.list) emittedIds.push(m.id);
      if (group.count > 1) { aggregatedGroups++; absorbedMails += group.count; }

      yield {
        source: NAME,
        source_ref: sourceRef,
        title: titleOfGroup(group, fallback),
        body: buildGroupBody(group, bodyMeta, maxBodyChars),
        ts: latest.ts || new Date().toISOString(),
        kind_hint: system ? 'fyi' : (fallback ? 'email_recent' : 'email'),
        domain_hint: domainOf(latest),
        urgency_hint: urgency,
        meta: {
          aggregated: group.count > 1,
          groupCount: group.count,
          system,
          from: latest.fromName || null,
          fromEmail: latest.fromEmail || null,
          isRead: group.list.every((m) => m.isRead),
          hasAttachments: group.list.some((m) => m.hasAttachments),
          mailboxDir: latest.dir,
          firstTs: group.earliest?.ts || null,
          lastTs: latest.ts || null,
          messageIds: group.list.slice(0, 10).map((m) => m.id),
          snippetChars: latest.snippet.length,
          bodyChars: bodyMeta.text ? bodyMeta.text.length : 0,
          body: bodyMeta.fetched ? bodyMeta : { fetched: false, reason: bodyMeta.reason },
          pages,
          lookbackHours,
          isFirstRun,
          ...(fallback ? { fallback } : {}),
        },
      };
    }

    // ---- 4. 积压摘要：窗口内没新邮件、但收件箱堆着旧未读时，只报 1 条 ----
    let backlogEmitted = false;
    if (backlogSignal && fresh.length === 0 && tooOld.length > 0) {
      const sorted = tooOld.slice().sort((a, b) => (Date.parse(b.ts || 0) || 0) - (Date.parse(a.ts || 0) || 0));
      const newest = sorted[0];
      const oldest = sorted[sorted.length - 1];
      const ref = `mail:backlog:${tooOld.length}:${(newest.ts || '').slice(0, 10)}`;
      const lastRef = (() => { try { return ctx?.cursor?.get(NAME, backlogKey) || null; } catch { return null; } })();
      if (ref !== lastRef) {
        backlogEmitted = true;
        const systemCount = tooOld.filter(isSystemMail).length;
        yield {
          source: NAME,
          source_ref: ref,
          title: oneLine(`收件箱积压：${tooOld.length} 封未读均早于 ${lookbackHours}h`, 160),
          body: [
            `本轮窗口（近 ${lookbackHours}h）内无新邮件。`,
            `收件箱仍有 ${tooOld.length} 封未读，全部早于窗口：`,
            `  最近：${newest.ts || '?'} · ${oneLine(newest.subject, 60)}`,
            `  最早：${oldest.ts || '?'} · ${oneLine(oldest.subject, 60)}`,
            systemCount ? `  其中系统/退信类 ${systemCount} 封（多为投递失败回执，建议清理）` : null,
            '',
            '这些旧邮件按"不要历史全量涌入"的约定不再逐封产出；仅在此提示积压。',
          ].filter((x) => x != null).join('\n'),
          ts: newest.ts || new Date().toISOString(),
          kind_hint: 'fyi',
          domain_hint: 'ops',
          urgency_hint: 1,
          meta: {
            backlog: tooOld.length,
            systemCount,
            newestTs: newest.ts || null,
            oldestTs: oldest.ts || null,
            lookbackHours,
          },
        };
        try { ctx?.cursor?.set?.(NAME, backlogKey, ref); } catch { /* ignore */ }
      }
    }

    // ---- 5. 推进 cursor：产出的 + 判定为过旧的都记上（后续不再翻旧账） ----
    const toRemember = [...emittedIds, ...tooOld.map((m) => m.id)];
    if (toRemember.length > 0) {
      const merged = [...toRemember, ...seen.filter((id) => !toRemember.includes(id))].slice(0, 800);
      try { ctx?.cursor?.set?.(NAME, cursorKey, JSON.stringify(merged)); } catch { /* ignore */ }
    }

    const emitted = groups.length + (backlogEmitted ? 1 : 0);
    const bodyMode = fetchBodies ? `正文抓取开（${bodiesOk} 成功/${bodiesFail} 失败，会标记已读）` : '正文=snippet（fetchBody 关：+read 会标记已读）';

    const noteText = [
      `窗口 ${lookbackHours}h 内 ${inWindow.length} 封 / 列到 ${mails.length} 封`,
      `${groups.length} 组 → ${emitted} 条`,
      aggregatedGroups > 0 ? `（${aggregatedGroups} 组聚合吸收 ${absorbedMails} 封）` : null,
      skippedOldUnseen > 0 ? `跳过早于窗口的旧邮件 ${skippedOldUnseen} 封` : null,
      backlogEmitted ? '含 1 条积压摘要' : null,
      bodyMode,
    ].filter(Boolean).join(' · ');

    note(ctx, NAME, {
      ok: true,
      count: emitted,
      listed: mails.length,
      inWindow: inWindow.length,
      freshMails: fresh.length,
      groups: groups.length,
      aggregated: aggregatedGroups,
      absorbedMails,
      skippedOld: tooOld.length,
      skippedOldUnseen,
      backlogEmitted,
      pages,
      isFirstRun,
      bodies: { ok: bodiesOk, fail: bodiesFail, enabled: fetchBodies },
      fallback,
      ms: Date.now() - t0,
      note: noteText,
    });

    ctx?.log?.('info', 'sensor:mail', {
      listed: mails.length,
      inWindow: inWindow.length,
      groups: groups.length,
      emitted,
      aggregated: aggregatedGroups,
      absorbed: absorbedMails,
      skippedOld: tooOld.length,
      backlog: backlogEmitted,
      pages,
      fallback,
      bodyMode,
      // 隐私：只打第一组标题前 60 字，绝不整篇正文
      first: groups.length > 0 ? clip(titleOfGroup(groups[0], fallback), 60) : '',
    });
  },
};

export const __internals = { extractList, normalizeRow, requestList, domainOf, titleOfGroup };
