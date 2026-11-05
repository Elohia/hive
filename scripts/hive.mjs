#!/usr/bin/env node
// scripts/hive.mjs — HIVE 命令行与常驻守护进程
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/core/config.mjs';
import { q, dbStats, kvSet, kvGet, getDb } from '../src/core/db.mjs';
import { emit, recent } from '../src/core/events.mjs';
import { logger, pruneLogs } from '../src/core/log.mjs';
import { keyStatus } from '../src/core/credentials.mjs';
import { todayCost } from '../src/task/taskcenter.mjs';

// 抑制 node:sqlite 的实验性告警（不影响功能）
const origEmit = process.emitWarning;
process.emitWarning = (w, ...rest) => {
  const msg = typeof w === 'string' ? w : w?.message || '';
  if (/SQLite is an experimental/i.test(msg)) return;
  return origEmit.call(process, w, ...rest);
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);

function flag(name, def = null) {
  const i = rest.indexOf('--' + name);
  if (i === -1) return def;
  const v = rest[i + 1];
  if (!v || v.startsWith('--')) return true;
  return v;
}
function posArgs() {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) { if (rest[i + 1] && !rest[i + 1].startsWith('--')) i++; continue; }
    out.push(rest[i]);
  }
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

function out(x) { console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2)); }
function table(rows, cols) {
  if (!rows?.length) { out('(空)'); return; }
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  out(cols.map((c, i) => c.padEnd(widths[i])).join('  '));
  out(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) out(cols.map((c, i) => String(r[c] ?? '').padEnd(widths[i])).join('  '));
}

// ---------- 单实例锁 ----------
function lockPath() { return path.join(loadConfig().home, 'data', 'hive.lock'); }
function readLock() {
  try { return JSON.parse(fs.readFileSync(lockPath(), 'utf8')); } catch { return null; }
}
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function acquireLock() {
  const cur = readLock();
  if (cur && cur.pid !== process.pid && isAlive(cur.pid)) return { ok: false, holder: cur };
  fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
  fs.writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, startedAt: nowIso(), argv }), 'utf8');
  return { ok: true };
}
function releaseLock() {
  const cur = readLock();
  if (cur?.pid === process.pid) { try { fs.unlinkSync(lockPath()); } catch {} }
}

// ---------- 懒加载（模块可能尚未就绪，全部降级） ----------
async function loadSensors() { try { return await import('../src/sensors/index.mjs'); } catch { return null; } }
async function loadExecutors() { try { return await import('../src/executors/index.mjs'); } catch { return null; } }
async function loadServer() { try { return await import('../src/server/http.mjs'); } catch { return null; } }

// ================= 命令：scan =================
async function cmdScan() {
  const only = flag('source');
  const mod = await loadSensors();
  if (!mod?.scanAll) { out('✗ 传感器层未就绪（src/sensors/index.mjs 缺失或导出不符）'); return 2; }

  const { cursorGet, cursorSet } = await import('../src/core/db.mjs');
  const { upsertItem } = await import('../src/task/taskcenter.mjs');
  const cfg = loadConfig();
  const ctx = {
    cfg,
    cursor: { get: cursorGet, set: cursorSet },
    // sensor 可能以 (msg) 或 (level, msg) 调用，两种都接
    log: (a, b) => {
      const m = b === undefined ? String(a) : `${a}: ${b}`;
      logger.info('[sensor] ' + m);
    },
    now: new Date(),
  };

  const stats = {};
  const t0 = Date.now();
  let total = 0, created = 0;
  try {
    for await (const raw of mod.scanAll(ctx, { only })) {
      total++;
      try {
        const { created: isNew } = upsertItem({
          ...raw,
          kind: raw.kind || raw.kind_hint,
          domain: raw.domain || raw.domain_hint,
          urgency: raw.urgency ?? raw.urgency_hint,
        });
        if (isNew) created++;
        stats[raw.source] = stats[raw.source] || { seen: 0, new: 0 };
        stats[raw.source].seen++;
        if (isNew) stats[raw.source].new++;
      } catch (e) {
        stats[raw.source] = stats[raw.source] || { seen: 0, new: 0 };
        stats[raw.source].err = String(e.message).slice(0, 120);
      }
    }
  } catch (e) {
    out(`✗ 扫描中断: ${e.message}`);
    return 1;
  }
  emit({ actor: 'sensor', type: 'scan.done', message: `扫到 ${total} 条 / 新增 ${created} 条`, data: { ms: Date.now() - t0, stats } });
  out(`扫描完成 ${Date.now() - t0}ms：共 ${total} 条，新增 ${created} 条`);
  table(Object.entries(stats).map(([s, v]) => ({ source: s, seen: v.seen, new: v.new, err: v.err || '' })), ['source', 'seen', 'new', 'err']);
  return 0;
}

// ================= 命令：run（手工投递） =================
async function cmdRun() {
  const text = posArgs().join(' ');
  if (!text) { out('用法: hive run "<一句话任务>" [--level 3] [--no-approval]'); return 1; }
  const { upsertItem } = await import('../src/task/taskcenter.mjs');
  const { processItem } = await import('../src/task/router.mjs');
  const { item } = upsertItem({
    source: 'manual', source_ref: 'cli-' + Date.now(), title: text.slice(0, 200), body: text,
    kind: 'todo', dedupe_key: 'manual|' + text.slice(0, 80) + '|' + Math.floor(Date.now() / 60000),
  });
  out(`→ 已建事项 ${item.id}`);
  const r = await processItem(item.id, { force: true, skipApproval: !!flag('no-approval') });
  out(`路由结果: ${r.route} ${r.ok ? '✓' : '✗'}`);
  if (r.triage) out(`判定: L${r.triage.level} (conf ${r.triage.confidence}) — ${r.triage.reason}`);
  if (r.text) out('\n' + r.text);
  if (r.approval) out(`\n待拍板: ${r.approval.id}\n  ${r.approval.title}`);
  if (r.tasks) out(`已派发 ${r.tasks.length} 个任务: ` + r.tasks.map((t) => t.key).join(' → '));
  if (flag('drain')) await drainAndReport();
  return 0;
}

/** 把队列跑空并打印每个任务结果 */
async function drainAndReport() {
  const { drainAll } = await import('../src/task/worker.mjs');
  out('… 开始执行队列');
  const res = await drainAll({
    onRound: ({ round, done }) => out(`  第 ${round} 轮：跑了 ${done} 个`),
  });
  for (const r of res) {
    out(`${r.ok ? '✓' : '✗'} ${r.status} ${r.runId || ''} ${r.error ? String(r.error).slice(0, 200) : ''}`);
  }
  out(`共执行 ${res.length} 个，成功 ${res.filter((x) => x.ok).length} 个`);
  return res;
}

// ================= 命令：list =================
async function cmdInbox() {
  const { listItems } = await import('../src/task/taskcenter.mjs');
  const items = listItems({ bucket: flag('bucket', 'inbox'), limit: Number(flag('limit', 30)) });
  if (!items.length) { out('Inbox 空。先跑 `hive scan`。'); return 0; }
  for (const it of items) {
    out(`${it.priority.toFixed(1).padStart(5)}  L${it.autonomy_level ?? '-'}  [${it.source}/${it.kind}]  ${it.title}`);
    out(`         ${it.id}  ${it.status}  ${it.domain || ''}`);
  }
  return 0;
}

async function cmdOutbox() {
  const { listApprovals } = await import('../src/task/taskcenter.mjs');
  const aps = listApprovals({ status: 'pending', limit: 50 });
  if (!aps.length) { out('Outbox 空：没有等你拍板的事。'); return 0; }
  for (const a of aps) {
    const opts = safeJson(a.options) || [];
    out(`● ${a.title}   [${a.risk}] ${a.id}`);
    if (a.summary) out(`  ${String(a.summary).slice(0, 200)}`);
    if (a.recommendation) out(`  建议: ${a.recommendation}`);
    if (opts.length) out(`  选项: ${opts.map((o) => o.id).join(' / ')}`);
    out(`  → hive approve ${a.id} --option approve|revise|reject [--note "..."]`);
  }
  return 0;
}

async function cmdTasks() {
  const { listTasks } = await import('../src/task/taskcenter.mjs');
  const ts = listTasks({ status: flag('status'), limit: Number(flag('limit', 30)) });
  table(ts.map((t) => ({
    id: t.id.slice(0, 14), st: t.status, L: t.autonomy_level, ex: t.executor || '-',
    att: `${t.attempt}/${t.max_attempts}`, cost: (t.cost_cny || 0).toFixed(3), title: String(t.title).slice(0, 40),
  })), ['id', 'st', 'L', 'ex', 'att', 'cost', 'title']);
  return 0;
}

// ================= 命令：approve / reject =================
async function cmdApprove() {
  const id = posArgs()[0];
  if (!id) { out('用法: hive approve <approval-id> --option approve|revise|reject [--note ...]'); return 1; }
  const { decideApproval, getApproval, getItem } = await import('../src/task/taskcenter.mjs');
  const decision = flag('option', 'approve') === 'reject' ? 'rejected' : 'approved';
  const ap = decideApproval(id, { decision, option: flag('option', 'approve'), note: flag('note', '') });
  out(`✓ ${ap.title} → ${decision}`);

  // 关键闭环：批准后真正继续推进
  if (decision === 'approved' && ap.item_id) {
    const { processItem } = await import('../src/task/router.mjs');
    const item = getItem(ap.item_id);
    if (item) {
      out('… 批准后继续执行');
      const r = await processItem(item.id, { force: true, skipApproval: true });
      out(`继续结果: ${r.route} ${r.ok ? '✓' : '✗'}`);
      if (r.tasks) out(`已派发 ${r.tasks.length} 个任务`);
      if (r.text) out('\n' + r.text);
      if (flag('drain')) await drainAndReport();
    }
  }
  return 0;
}

async function cmdRetry() {
  const id = posArgs()[0];
  if (!id) { out('用法: hive retry <task-id>'); return 1; }
  const { getTask, updateTask } = await import('../src/task/taskcenter.mjs');
  const t = getTask(id);
  if (!t) { out('✗ 任务不存在'); return 1; }
  updateTask(id, { status: 'queued', attempt: 0, last_error: null, lease_until: null });
  emit({ actor: 'human', type: 'task.manual_retry', task_id: id, message: '人工重试' });
  out(`✓ ${id} 已重排（attempt 重置为 0）`);
  const { dispatchTask } = await import('../src/task/worker.mjs');
  if (flag('now')) { const r = await dispatchTask(id); out(`执行: ${r.ok ? '✓ 成功' : '✗ ' + r.error}`); }
  return 0;
}

// ================= 命令：doctor =================
async function cmdDoctor() {
  const cfg = loadConfig();
  const rows = [];
  const add = (name, status, detail) => rows.push({ 检查项: name, 结果: status, 说明: detail });

  // DB
  try { const s = dbStats(); add('数据库', 'PASS', cfg.resolved.db + ' ' + JSON.stringify(s)); }
  catch (e) { add('数据库', 'FAIL', e.message); }

  // 凭据
  const ks = keyStatus();
  const anyKey = Object.values(ks).some((v) => v.present);
  add('LLM 凭据', anyKey ? 'PASS' : 'FAIL', Object.entries(ks).map(([k, v]) => `${k}:${v.present ? 'ok' : 'no'}`).join(' '));

  // 执行器
  const ex = await loadExecutors();
  if (!ex?.probe) add('执行器层', 'WARN', 'src/executors/index.mjs 未就绪');
  else {
    try {
      const p = await ex.probe();
      for (const [n, v] of Object.entries(p)) add(`执行器·${n}`, v.ok ? 'PASS' : 'WARN', v.version || v.reason || '');
    } catch (e) { add('执行器层', 'FAIL', e.message); }
  }

  // 传感器
  const se = await loadSensors();
  add('传感器层', se?.scanAll ? 'PASS' : 'WARN', se?.scanAll ? (se.list?.().map?.((x) => x.name || x).join(',') || 'ok') : 'src/sensors/index.mjs 未就绪');

  // 服务
  add('HTTP 服务', (await loadServer())?.startServer ? 'PASS' : 'WARN', 'src/server/http.mjs');

  // 通道：Windows 下 agently-cli 是 .cmd shim，必须经 cmd.exe 调用
  try {
    const { execFileSync } = await import('node:child_process');
    const o = execFileSync('cmd.exe', ['/c', 'agently-cli', 'auth', 'status'], { timeout: 25000, windowsHide: true }).toString();
    add('邮件通道', /"logged_in":\s*true/.test(o) ? 'PASS' : 'WARN', 'agently-cli 已授权');
  } catch (e) {
    try {
      const { execFileSync } = await import('node:child_process');
      const o2 = execFileSync('agently-cli', ['auth', 'status'], { timeout: 25000, windowsHide: true, shell: true }).toString();
      add('邮件通道', /"logged_in":\s*true/.test(o2) ? 'PASS' : 'WARN', 'agently-cli（shell 回退）');
    } catch (e2) { add('邮件通道', 'FAIL', String(e2.message).slice(0, 80)); }
  }

  // 预算
  const c = todayCost();
  add('今日预算', c.ratio < 0.8 ? 'PASS' : c.ratio < 1 ? 'WARN' : 'FAIL', `¥${c.costCny} / ¥${c.budget} (${(c.ratio * 100).toFixed(0)}%)`);

  // 锁
  const lk = readLock();
  add('守护进程', lk && isAlive(lk.pid) ? 'PASS' : 'WARN', lk ? `pid=${lk.pid} alive=${isAlive(lk.pid)}` : '未运行');

  table(rows, ['检查项', '结果', '说明']);
  const fail = rows.filter((r) => r.结果 === 'FAIL').length;
  const warn = rows.filter((r) => r.结果 === 'WARN').length;
  out(`\n合计: ${rows.length - fail - warn} PASS / ${warn} WARN / ${fail} FAIL`);
  return fail ? 1 : 0;
}

// ================= 命令：daemon =================
async function cmdDaemon() {
  const cfg = loadConfig();
  const lock = acquireLock();
  if (!lock.ok) {
    out(`✗ 已有守护进程在跑 (pid=${lock.holder.pid}, since ${lock.holder.startedAt})`);
    return 3;
  }
  process.on('exit', releaseLock);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { out(`\n收到 ${sig}，正在退出…`); releaseLock(); process.exit(0); });
  }

  logger.info(`HIVE daemon 启动 pid=${process.pid} home=${cfg.home}`);
  emit({ actor: 'system', type: 'daemon.start', message: `pid=${process.pid} v${safeVersion()}` });

  const { seedPulses, duePulses, markPulseRun, allPulses } = await import('../src/task/pulse.mjs');
  const watchdog = await import('../src/task/watchdog.mjs');
  const router = await import('../src/task/router.mjs');
  const worker = await import('../src/task/worker.mjs');
  const { upsertItem, listApprovals, pendingWork, todayCost: tc } = await import('../src/task/taskcenter.mjs');
  const { notify, approvalMessage } = await import('../src/hitl/notify.mjs');
  const { cursorGet, cursorSet } = await import('../src/core/db.mjs');

  seedPulses();
  const rec = watchdog.recover();
  if (rec.length) logger.warn(`启动恢复 ${rec.length} 个任务`);

  // HTTP 服务
  const srv = await loadServer();
  let serverHandle = null;
  const port = Number(flag('port', cfg.server.port));
  if (srv?.startServer) {
    try { serverHandle = await srv.startServer({ port }); logger.info(`看板: http://127.0.0.1:${port}`); }
    catch (e) { logger.error(`HTTP 启动失败: ${e.message}`); }
  } else {
    logger.warn('HTTP 服务未就绪（src/server/http.mjs），本次仅跑后台逻辑');
  }

  const sensors = await loadSensors();
  let stopping = false;
  const handlers = {
    async scan(pulse) {
      if (!sensors?.scanAll) throw new Error('传感器层未就绪');
      const source = pulse.config?.source;
      const ctx = { cfg: loadConfig(), cursor: { get: cursorGet, set: cursorSet }, log: (m) => logger.info('[sensor] ' + m), now: new Date() };
      let n = 0, created = 0;
      for await (const raw of sensors.scanAll(ctx, { only: source })) {
        n++;
        const { created: isNew } = upsertItem({
          ...raw, kind: raw.kind || raw.kind_hint, domain: raw.domain || raw.domain_hint,
          urgency: raw.urgency ?? raw.urgency_hint,
        });
        if (isNew) created++;
      }
      emit({ actor: 'sensor', type: 'scan.done', message: `[${source}] ${n} 条 / 新增 ${created}` });
      return `${n}/${created}`;
    },
    async triage() {
      const r = await router.triageInbox({ limit: 15 });
      return `${r.length} 项`;
    },
    async watchdog() {
      const a = await watchdog.tick();
      return `${a.length} 动作`;
    },
    async digest(pulse) {
      const { dailyBrief } = await import('../src/context/profile.mjs');
      const { chat } = await import('../src/core/llm.mjs');
      const { stats, contextText } = dailyBrief();
      const r = await chat({
        tier: 'cheap', maxTokens: 900,
        messages: [
          { role: 'system', content: '你是 HIVE，用户的主动助理。写一份极简中文简报：①现在最该做的 3 件事 ②需要注意的风险 ③一句建议。不要客套。' },
          { role: 'user', content: `待办 ${stats.inbox} / 待拍板 ${stats.outbox} / 运行中 ${stats.running} / 24h 完成 ${stats.done24h}\n\n${contextText}` },
        ],
      });
      const body = r.ok ? r.text : `今日：待办 ${stats.inbox}，待拍板 ${stats.outbox}，运行中 ${stats.running}。`;
      const { item } = upsertItem({
        source: 'self', source_ref: `digest-${pulse.config?.slot || 'now'}-${new Date().toISOString().slice(0, 10)}`,
        title: `${pulse.config?.slot === 'evening' ? '晚报' : '晨报'} ${new Date().toISOString().slice(0, 10)}`,
        body, kind: 'fyi', domain: 'life', urgency: 2, impact: 2,
      });
      await notify({ title: item.title, body: String(body).slice(0, 300), level: 'info', force: true });
      return 'ok';
    },
    async context() {
      const { buildContextText, recentActivity, upsertFact } = await import('../src/context/profile.mjs');
      const a = recentActivity();
      upsertFact({ category: 'activity', key: 'by_source', value: JSON.stringify(a.bySource), evidence: 'sensors', confidence: 0.8 });
      return `${a.bySource.length} 源`;
    },
    async selfcheck() {
      const h = watchdog.health();
      const c = tc();
      emit({ actor: 'watchdog', type: 'health.report', message: '定时自检', data: { ...h, cost: c } });
      if (h.errLastHour > 10) await notify({ title: 'HIVE 告警：错误偏多', body: `近 1 小时 ${h.errLastHour} 条 error，卡住 ${h.stalled} 个任务`, level: 'error' });
      if (c.ratio > 0.8) await notify({ title: 'HIVE 告警：预算', body: `今日已用 ¥${c.costCny}/¥${c.budget}`, level: 'warn' });
      return JSON.stringify(h);
    },
  };

  async function runPulse(p) {
    const h = p.config?.handler;
    const fn = handlers[h];
    if (!fn) { markPulseRun(p, 'skip'); return; }
    const t0 = Date.now();
    try {
      const r = await fn(p);
      markPulseRun(p, 'ok');
      logger.info(`pulse ${p.name} ok ${Date.now() - t0}ms ${r ?? ''}`);
    } catch (e) {
      markPulseRun(p, 'fail');
      logger.error(`pulse ${p.name} 失败: ${e.message}`);
      emit({ actor: 'pulse', type: 'pulse.error', level: 'error', message: `${p.name}: ${String(e.message).slice(0, 300)}` });
    }
  }

  // 主循环
  let lastWatchdog = 0, lastNotify = 0, lastPrune = 0;
  const tickMs = Math.max(1000, (cfg.settings.tickSec || 20) * 1000);

  while (!stopping) {
    try {
      const now = Date.now();

      // 1) 脉冲
      for (const p of duePulses(new Date())) {
        if (stopping) break;
        await runPulse(p);
      }

      // 2) 看门狗（每 tickSec）
      if (now - lastWatchdog >= tickMs) {
        lastWatchdog = now;
        await watchdog.tick();
      }

      // 3) 派发队列
      const qn = q.get("SELECT COUNT(*) n FROM tasks WHERE status='queued'")?.n ?? 0;
      if (qn > 0) {
        const c = tc();
        if (c.ratio < 1) await worker.drainQueue();
        else emit({ actor: 'router', type: 'budget.blocked', level: 'warn', message: '预算耗尽，暂停派发' });
      }

      // 4) 待拍板提醒（最多每 10 分钟一次）
      if (now - lastNotify >= 10 * 60e3) {
        lastNotify = now;
        const pend = listApprovals({ status: 'pending', limit: 5 })
          .filter((a) => !a.notified_count || !a.last_notified_at);
        for (const ap of pend) {
          const { title, body } = approvalMessage(ap);
          await notify({ title, body, level: 'warn' });
          q.run('UPDATE approvals SET notified_count=COALESCE(notified_count,0)+1, last_notified_at=? WHERE id=?', nowIso(), ap.id);
        }
      }

      // 5) 每天清理一次
      if (now - lastPrune > 6 * 3600e3) {
        lastPrune = now;
        pruneLogs(14);
        q.run("DELETE FROM events WHERE ts < ?", new Date(Date.now() - 30 * 86400e3).toISOString());
      }

      await sleep(3000);
    } catch (e) {
      logger.error(`主循环异常: ${e.message}`);
      emit({ actor: 'system', type: 'daemon.error', level: 'error', message: String(e.message).slice(0, 400) });
      await sleep(5000);
    }
  }

  if (serverHandle?.close) try { await serverHandle.close(); } catch {}
  emit({ actor: 'system', type: 'daemon.stop', message: 'normal' });
  releaseLock();
  return 0;
}

// ================= 命令：serve（只起看板） =================
async function cmdServe() {
  const srv = await loadServer();
  if (!srv?.startServer) { out('✗ HTTP 服务未就绪'); return 2; }
  const port = Number(flag('port', loadConfig().server.port));
  await srv.startServer({ port });
  out(`看板: http://127.0.0.1:${port}`);
  return new Promise(() => {});
}

// ================= 命令：stats =================
async function cmdStats() {
  const s = dbStats();
  const c = todayCost();
  const { pendingWork } = await import('../src/task/taskcenter.mjs');
  out({ db: s, pending: pendingWork(), cost: c, lock: readLock(), version: safeVersion() });
  return 0;
}

function safeVersion() { try { return fs.readFileSync(path.join(loadConfig().home, 'VERSION'), 'utf8').trim(); } catch { return '?'; } }
function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

async function cmdEvents() {
  const rows = recent({ limit: Number(flag('limit', 40)), level: flag('level') });
  for (const e of rows) out(`${e.ts.slice(11, 19)} ${e.level.padEnd(5)} ${e.actor.padEnd(9)} ${e.type.padEnd(22)} ${e.message || ''}`);
  return 0;
}

function usage() {
  console.log(`HIVE v${safeVersion()} — 主动服务型超级智能体

用法: node scripts/hive.mjs <命令> [参数]

  daemon [--port 8787]      常驻主进程（巡检 + 判定 + 派发 + 看门狗 + 看板）
  serve  [--port 8787]      只起看板
  scan   [--source mail]    立即跑一轮感知
  run    "<一句话任务>"      手工投递并立刻路由
  inbox  [--limit 30]       看待办
  outbox                    看待你拍板的事
  approve <id> --option approve|revise|reject [--note "..."]
  reject  <id> [--note "..."]
  tasks  [--status running] 看任务
  work                      把队列跑空（不等守护进程）
  retry  <task-id> [--now]  重试任务
  events [--limit 40]       看事件流
  doctor                    环境自检
  stats                     汇总
  seed                      重建脉冲表
`);
}

// ---------- 分发 ----------
const COMMANDS = {
  daemon: cmdDaemon, serve: cmdServe, scan: cmdScan, run: cmdRun,
  inbox: cmdInbox, outbox: cmdOutbox, tasks: cmdTasks, events: cmdEvents,
  approve: cmdApprove,
  reject: async () => { const id = posArgs()[0]; if (!id) { out('用法: hive reject <id>'); return 1; }
    const { decideApproval } = await import('../src/task/taskcenter.mjs');
    decideApproval(id, { decision: 'rejected', note: flag('note', ''), by: 'human' });
    out('✓ 已拒绝并归档'); return 0; },
  retry: cmdRetry, doctor: cmdDoctor, stats: cmdStats,
  work: async () => { await drainAndReport(); return 0; },
  seed: async () => { const { seedPulses, allPulses } = await import('../src/task/pulse.mjs'); seedPulses();
    table(allPulses().map((p) => ({ id: p.id, spec: p.spec, next: p.next_run_at || '', last: p.last_status || '' })), ['id', 'spec', 'next', 'last']); return 0; },
};

getDb();
const fn = COMMANDS[cmd];
if (!fn) { usage(); process.exit(cmd ? 1 : 0); }
process.on('unhandledRejection', (e) => { logger.error('unhandledRejection: ' + (e?.stack || e)); });
fn().then((code) => { if (typeof code === 'number') process.exitCode = code; })
  .catch((e) => { logger.error('CLI 失败: ' + (e?.stack || e)); console.error(e); process.exit(1); });
