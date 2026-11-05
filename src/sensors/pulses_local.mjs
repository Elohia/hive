// src/sensors/pulses_local.mjs — 本机既有自动化的"进展信号"（只读）
//
// 不重写任何既有自动化，只读它们的产物来判断"昨夜跑了什么 / 有没有失败"：
//   D:\pi-agent\automations\*.memory.md          —— 各自动化的执行记忆（成果/经验/改进）
//   D:\pi-agent\automations\memory\*.md          —— 精简摘要
//   D:\pi-agent\reports\*                        —— 最新报告产出（判断产出是否停滞）
//   F:\dsh-home\{x-duty,bili-duty,xhs-duty}\state.json —— 值守状态（含投递是否失败）
//   F:\dsh-home\{x-duty,bili-duty,xhs-duty}\seen.md    —— 判重表（收录条数）
//
// 路径可用 cfg.sources.pulses_local.{automationsDir,reportsDir,dutyDirs} 覆盖（不写死）。
import fs from 'node:fs';
import path from 'node:path';
import {
  clampInt, note, oneLine, truncate, readTextSafe, readJsonSafe, statSafe,
  walkFilesSync, isDir, hash,
} from './_util.mjs';

const NAME = 'pulses_local';

const DEFAULTS = {
  automationsDir: 'D:\\pi-agent\\automations',
  reportsDir: 'D:\\pi-agent\\reports',
  dutyDirs: ['F:\\dsh-home\\x-duty', 'F:\\dsh-home\\bili-duty', 'F:\\dsh-home\\xhs-duty'],
};

const FAIL_RE = /失败|报错|异常|error|failed|timeout|超时|中断|拒绝|denied/i;
const DONE_RE = /成果|完成|成功|sent|已发送|已生成|done|ok/i;

function pickDir(sc, key) {
  const v = sc?.[key];
  return typeof v === 'string' && v.trim() ? v : DEFAULTS[key];
}

function pickDutyDirs(sc) {
  const v = sc?.dutyDirs;
  return Array.isArray(v) && v.length ? v.filter(Boolean) : DEFAULTS.dutyDirs;
}

/** 从记忆文件里抽"最后一条有内容的记录" */
function lastMemoryLine(text) {
  if (!text) return null;
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^#{1,6}\s/.test(l) && !/^---+$/.test(l));
  if (lines.length === 0) return null;
  return lines[lines.length - 1];
}

/** 记忆行里的日期（2026-09-07 形式） */
function dateOf(text) {
  const m = String(text || '').match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** 解析 `日期 | 成果：… | 经验：… | 改进：…` 形式的记忆 */
function splitMemory(line) {
  const segs = String(line).split(/\s*\|\s*/).filter(Boolean);
  const out = { date: dateOf(line), parts: [], raw: line };
  for (const s of segs) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) continue;
    out.parts.push(s);
  }
  return out;
}

function ageHoursOf(ms, nowMs) {
  return Math.max(0, (nowMs - ms) / 3600_000);
}

function fmtAge(h) {
  if (h < 1) return '不到 1 小时前';
  if (h < 24) return `${h.toFixed(1)} 小时前`;
  return `${(h / 24).toFixed(1)} 天前`;
}

export default {
  name: NAME,
  title: '本机自动化进展',
  enabled(cfg) {
    return !!(cfg?.sources?.pulses_local?.enabled);
  },

  async *scan(ctx) {
    const cfg = ctx?.cfg || {};
    const sc = cfg?.sources?.pulses_local || {};
    const opts = ctx?.opts || {};
    const now = ctx?.now instanceof Date ? ctx.now : new Date();
    const nowMs = now.getTime();
    const automationsDir = pickDir(sc, 'automationsDir');
    const reportsDir = pickDir(sc, 'reportsDir');
    const dutyDirs = pickDutyDirs(sc);

    const staleDutyHours = clampInt(opts.staleDutyHours ?? sc.staleDutyHours, 1, 24 * 30, 26);
    const staleReportsHours = clampInt(opts.staleReportsHours ?? sc.staleReportsHours, 1, 24 * 30, 12);
    const maxMemoryItems = clampInt(opts.maxMemoryItems, 1, 50, 4);
    const memoryLookbackDays = clampInt(opts.memoryLookbackDays, 1, 3650, 120);
    const t0 = Date.now();

    const produced = [];
    const skipped = [];

    /* ---------- 1. 值守状态（state.json + seen.md） ---------- */
    for (const dir of dutyDirs) {
      const name = path.basename(dir);
      if (!isDir(dir)) { skipped.push({ dir, reason: 'missing' }); continue; }
      try {
        const statePath = path.join(dir, 'state.json');
        const state = readJsonSafe(statePath, null);
        const seenPath = path.join(dir, 'seen.md');
        const seenText = readTextSafe(seenPath, 256 * 1024);
        const stState = statSafe(statePath);

        const lastRunAt = state?.lastRunAt || state?.finishedAt || null;
        const lastMs = Number.isFinite(Date.parse(lastRunAt)) ? Date.parse(lastRunAt) : (stState ? stState.mtimeMs : null);
        const ageH = lastMs != null ? ageHoursOf(lastMs, nowMs) : null;
        const stale = ageH != null && ageH > staleDutyHours;

        const delivery = state?.lastDelivery || null;
        const deliveryFailed = delivery && delivery.ok === false;
        const lastExit = state?.lastExit;
        const exitFailed = typeof lastExit === 'number' && lastExit !== 0;

        const seenLines = seenText
          ? seenText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^#/.test(l))
          : [];
        const seenLastDate = seenLines.length ? dateOf(seenLines[0]) : null;

        if (!state && !seenText) { skipped.push({ dir, reason: 'no-state-no-seen' }); continue; }

        const flags = [];
        if (stale) flags.push(`已 ${fmtAge(ageH)} 未运行`);
        if (exitFailed) flags.push(`上次退出码 ${lastExit}`);
        if (deliveryFailed) flags.push(`投递未完成：${delivery.skipped || delivery.reason || 'ok=false'}`);

        const bodyLines = [
          `值守：${name}（${dir}）`,
          lastRunAt ? `上次运行：${lastRunAt}（${ageH != null ? fmtAge(ageH) : '?'}）` : '上次运行：未知',
          state?.lastWhy ? `触发原因：${state.lastWhy}` : null,
          state?.lastRunDay || state?.day ? `运行日：${state.lastRunDay || state.day}` : null,
          typeof lastExit === 'number' ? `退出码：${lastExit}` : null,
          typeof state?.pickedToday === 'number' ? `今日挑选：${state.pickedToday}` : null,
          typeof state?.picked === 'number' ? `已挑选：${state.picked}` : null,
          typeof state?.count === 'number' ? `计数：${state.count}` : null,
          seenLines.length ? `判重表：${seenLines.length} 条，最新 ${seenLastDate || '?'}` : null,
          delivery ? `投递：ok=${delivery.ok}${delivery.skipped ? ` · ${delivery.skipped}` : ''}${delivery.at ? ` · ${delivery.at}` : ''}` : null,
          flags.length ? '' : null,
          flags.length ? `⚠ ${flags.join('；')}` : null,
        ].filter((x) => x != null);

        let urgency = 2;
        if (stale) urgency = 4;
        else if (exitFailed || deliveryFailed) urgency = 3;

        produced.push({
          source: NAME,
          source_ref: `pulse:duty:${name}:${lastRunAt || (lastMs ? Math.round(lastMs) : 'na')}`,
          title: oneLine(
            `${name} 值守：${state?.lastRunDay || state?.day || '?'}${stale ? ` · ${fmtAge(ageH)}未运行` : ''}${deliveryFailed ? ' · 投递未完成' : ''}`,
            160,
          ),
          body: bodyLines.join('\n'),
          ts: lastMs ? new Date(lastMs).toISOString() : new Date().toISOString(),
          kind_hint: stale || exitFailed || deliveryFailed ? 'pulse_duty_issue' : 'pulse_duty',
          domain_hint: 'ops',
          urgency_hint: urgency,
          meta: {
            duty: name, dir, lastRunAt, ageHours: ageH == null ? null : Number(ageH.toFixed(2)),
            stale, lastExit: typeof lastExit === 'number' ? lastExit : null,
            delivery: delivery ? { ok: delivery.ok, skipped: delivery.skipped || null, at: delivery.at || null } : null,
            seenEntries: seenLines.length, seenLastDate,
          },
        });
      } catch (e) {
        skipped.push({ dir, reason: oneLine(e?.message || e, 100) });
      }
    }

    /* ---------- 2. 自动化执行记忆（.memory.md） ---------- */
    try {
      const cands = [];
      const top = statSafe(automationsDir);
      if (top && top.isDirectory()) {
        for (const ent of fs.readdirSync(automationsDir, { withFileTypes: true })) {
          if (!ent.isFile() || !/\.memory\.md$/i.test(ent.name)) continue;
          const full = path.join(automationsDir, ent.name);
          const st = statSafe(full);
          if (st) cands.push({ file: full, name: ent.name.replace(/\.memory\.md$/i, ''), mtimeMs: st.mtimeMs, size: st.size });
        }
        const memDir = path.join(automationsDir, 'memory');
        if (isDir(memDir)) {
          for (const ent of fs.readdirSync(memDir, { withFileTypes: true })) {
            if (!ent.isFile() || !/\.md$/i.test(ent.name)) continue;
            const full = path.join(memDir, ent.name);
            const st = statSafe(full);
            if (st) cands.push({ file: full, name: ent.name.replace(/\.md$/i, ''), mtimeMs: st.mtimeMs, size: st.size, digest: true });
          }
        }
      }

      cands.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const cutoff = nowMs - memoryLookbackDays * 86400_000;
      let memEmitted = 0;

      for (const c of cands) {
        if (memEmitted >= maxMemoryItems) break;
        if (c.mtimeMs < cutoff) { skipped.push({ file: c.file, reason: `早于 ${memoryLookbackDays} 天` }); continue; }
        try {
          const text = readTextSafe(c.file, 256 * 1024);
          const line = lastMemoryLine(text);
          if (!line) { skipped.push({ file: c.file, reason: '空记忆' }); continue; }
          const mem = splitMemory(line);
          const ageH = ageHoursOf(c.mtimeMs, nowMs);
          const failed = FAIL_RE.test(line);
          const done = DONE_RE.test(line);

          memEmitted++;
          produced.push({
            source: NAME,
            source_ref: `pulse:automation:${c.name}:${hash(line, 12)}`,
            title: oneLine(`${c.name} 最近执行 ${mem.date || new Date(c.mtimeMs).toISOString().slice(0, 10)}${failed ? ' · 含失败' : ''}`, 160),
            body: [
              `自动化：${c.name}`,
              `记忆文件：${c.file}`,
              `更新于：${new Date(c.mtimeMs).toISOString()}（${fmtAge(ageH)}）`,
              '',
              `最近一条：${truncate(mem.parts.join(' | '), 900) || truncate(line, 900)}`,
            ].join('\n'),
            ts: new Date(c.mtimeMs).toISOString(),
            kind_hint: failed ? 'pulse_failed' : 'pulse_memory',
            domain_hint: 'ops',
            urgency_hint: failed ? 4 : 2,
            meta: {
              automation: c.name, file: c.file, ageHours: Number(ageH.toFixed(2)),
              date: mem.date, failed, done, digest: !!c.digest,
            },
          });
        } catch (e) {
          skipped.push({ file: c.file, reason: oneLine(e?.message || e, 100) });
        }
      }
    } catch (e) {
      skipped.push({ dir: automationsDir, reason: oneLine(e?.message || e, 100) });
    }

    /* ---------- 3. 最新报告产出（判断是否停滞） ---------- */
    try {
      if (isDir(reportsDir)) {
        const walked = walkFilesSync(reportsDir, {
          maxDepth: 3,
          skipDirs: new Set(['node_modules', '.git', 'logs', 'tmp', '__pycache__']),
          maxFiles: 8_000,
          deadlineMs: clampInt(opts.deadlineMs, 1_000, 20_000, 6_000),
        });
        const files = walked.files.slice().sort((a, b) => b.mtimeMs - a.mtimeMs);
        const newest = files[0];
        if (newest) {
          const ageH = ageHoursOf(newest.mtimeMs, nowMs);
          const stale = ageH > staleReportsHours;
          const recent = files.slice(0, 6);
          produced.push({
            source: NAME,
            source_ref: `pulse:reports:${newest.name}:${Math.round(newest.mtimeMs)}`,
            title: oneLine(`pi-agent 报告：最新 ${newest.name}（${fmtAge(ageH)}）${stale ? ' · 产出停滞' : ''}`, 160),
            body: [
              `目录：${reportsDir}`,
              `最新产出：${newest.name}`,
              `更新时间：${new Date(newest.mtimeMs).toISOString()}（${fmtAge(ageH)}）`,
              `扫描到文件：${walked.files.length}${walked.truncated ? '（已达预算上限，可能未扫全）' : ''}`,
              stale ? `⚠ 超过 ${staleReportsHours}h 无新产出` : null,
              '',
              '最近 6 个：',
              ...recent.map((f) => `- ${new Date(f.mtimeMs).toISOString().slice(5, 16).replace('T', ' ')} ${f.name}`),
            ].filter((x) => x != null).join('\n'),
            ts: new Date(newest.mtimeMs).toISOString(),
            kind_hint: stale ? 'pulse_reports_stale' : 'pulse_reports',
            domain_hint: 'ops',
            urgency_hint: stale ? 3 : 1,
            meta: {
              reportsDir, newest: newest.name, ageHours: Number(ageH.toFixed(2)),
              scanned: walked.files.length, truncated: walked.truncated, stale,
            },
          });
        } else {
          skipped.push({ dir: reportsDir, reason: '空目录' });
        }
      } else {
        skipped.push({ dir: reportsDir, reason: 'missing' });
      }
    } catch (e) {
      skipped.push({ dir: reportsDir, reason: oneLine(e?.message || e, 100) });
    }

    // 产出（单条失败不影响其它；这里已全部构造完成，直接逐条 yield）
    let emitted = 0;
    for (const item of produced) {
      try {
        emitted++;
        yield item;
      } catch (e) {
        ctx?.log?.('warn', 'sensor:pulses_local 产出失败', { error: oneLine(e?.message || e, 100) });
      }
    }

    const issues = produced.filter((p) => p.kind_hint === 'pulse_duty_issue' || p.kind_hint === 'pulse_failed' || p.kind_hint === 'pulse_reports_stale').length;
    note(ctx, NAME, {
      ok: true,
      count: emitted,
      issues,
      duties: dutyDirs.length,
      automationsDir, reportsDir,
      skipped,
      ms: Date.now() - t0,
      note: `${dutyDirs.length} 个值守 + 自动化记忆 + 报告产出 → ${emitted} 条（其中异常 ${issues} 条）`,
    });

    ctx?.log?.('info', 'sensor:pulses_local', { emitted, issues, skipped: skipped.length });
  },
};

export const __internals = { lastMemoryLine, splitMemory, dateOf, FAIL_RE, DONE_RE };
