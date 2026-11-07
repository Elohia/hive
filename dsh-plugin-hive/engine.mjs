// dsh-plugin-hive/engine.mjs — 插件内置调度引擎
//
// 为什么单独一份：CLI 的守护进程（scripts/hive.mjs daemon）已经有同样的循环，
// 但那份和命令行参数解析绑在一起。插件要的是「进程内、可 start/stop、可观测」的版本。
// 两边共用同一个 runtime/（src 的拷贝）与同一张表，语义等价；差异只在驱动方式。
//
// 契约：createEngine({ log, emit }) → { start, stop, trigger, status, lastError }
import fs from 'node:fs';
import path from 'node:path';
import * as pulseMod from './runtime/src/task/pulse.mjs';
import * as watchdog from './runtime/src/task/watchdog.mjs';
import * as router from './runtime/src/task/router.mjs';
import * as worker from './runtime/src/task/worker.mjs';
import * as taskcenter from './runtime/src/task/taskcenter.mjs';
import { loadConfig } from './runtime/src/core/config.mjs';
import { cursorGet, cursorSet, q } from './runtime/src/core/db.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 与 CLI 守护进程同格式的锁文件：让看板「自动任务」页的守护进程 KPI 在插件模式下也显示正确 */
function lockPath() {
  return path.join(process.env.HIVE_HOME || process.cwd(), 'data', 'hive.lock');
}
function writeLock() {
  try {
    const p = lockPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), argv: ['plugin-engine'] }), 'utf8');
  } catch { /* 锁只是展示用途，失败不影响运行 */ }
}
function clearLock() {
  try {
    const p = lockPath();
    const cur = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (cur?.pid === process.pid) fs.unlinkSync(p);
  } catch { /* noop */ }
}

export function createEngine({ log = () => {}, onEvent = () => {} } = {}) {
  let sensors = null;
  let running = false;
  let timer = null;
  let draining = false;
  let lastWatchdog = 0;
  let lastBeat = 0;
  let lastError = null;
  let startedAt = null;
  let ticks = 0;
  // 关键：tick 必须互斥。之前用 setInterval 每 3s 起一次 tick 却不等待它结束，
  // 而一轮 triage 要调用多次模型、耗时以分钟计 → 十几轮并发抢同一个 LLM 服务
  // （正是用户会话在用的那个），表现为「切会话时 HIVE 像掉线、对话也变卡」。
  let ticking = false;

  const emit = (type, message, data, level = 'info') => {
    try { taskcenter; } catch { /* noop */ }
    onEvent({ type, message, data, level, at: new Date().toISOString() });
  };

  async function loadSensors() {
    if (sensors !== null) return sensors;
    try {
      const m = await import('./runtime/src/sensors/index.mjs');
      sensors = m?.scanAll ? m : null;
    } catch (e) {
      log('warn', `传感器层不可用: ${e.message}`);
      sensors = null;
    }
    return sensors;
  }

  async function doScan(only) {
    const s = await loadSensors();
    if (!s?.scanAll) throw new Error('传感器层不可用');
    const cfg = loadConfig();
    const ctx = {
      cfg,
      cursor: { get: cursorGet, set: cursorSet },
      log: (a, b) => log('info', b === undefined ? String(a) : `${a}: ${b}`),
      now: new Date(),
    };
    let seen = 0, created = 0;
    for await (const raw of s.scanAll(ctx, { only })) {
      seen++;
      try {
        const { created: isNew } = taskcenter.upsertItem({
          ...raw,
          kind: raw.kind || raw.kind_hint,
          domain: raw.domain || raw.domain_hint,
          urgency: raw.urgency ?? raw.urgency_hint,
        });
        if (isNew) created++;
      } catch (e) {
        log('warn', `写入失败: ${e.message}`);
      }
    }
    emit('scan', `[${only || 'all'}] 扫到 ${seen} 条 / 新增 ${created} 条`);
    return { seen, created };
  }

  async function doTriage() {
    // 插件模式一次只判 5 条：走的是宿主的模型链路，15 条会超过 240s 脉冲超时（实测踩过）
    const r = await router.triageInbox({ limit: 5 });
    emit('triage', `判定 ${r.length} 项`);
    return r;
  }

  async function doReap() {
    const { reap } = await import('./runtime/src/task/reap.mjs');
    const r = reap({ cfg: loadConfig() });
    const total = r.aged + r.overflow + r.folded;
    if (total) emit('reap', `收敛 ${total} 条：${r.before} → ${r.after}（老化 ${r.aged} / 超容 ${r.overflow} / 折叠 ${r.folded}）`);
    return r;
  }

  async function doWatchdog() {
    const a = await watchdog.tick();
    if (a.length) emit('watchdog', `回收/终止 ${a.length} 个任务`, a, 'warn');
    return a;
  }

  async function doDigest(slot) {
    const { dailyBrief } = await import('./runtime/src/context/profile.mjs');
    const { chat } = await import('./runtime/src/core/llm.mjs');
    const { stats, contextText } = dailyBrief();
    const r = await chat({
      tier: 'cheap', maxTokens: 900,
      messages: [
        { role: 'system', content: '你是 HIVE。写一份极简中文简报：①最该做的 3 件事 ②风险 ③一句建议。不要客套。' },
        { role: 'user', content: `待办 ${stats.inbox} / 待拍板 ${stats.outbox} / 运行中 ${stats.running} / 24h 完成 ${stats.done24h}\n\n${contextText}` },
      ],
    });
    const body = r.ok ? r.text : `今日：待办 ${stats.inbox}，待拍板 ${stats.outbox}。`;
    taskcenter.upsertItem({
      source: 'self',
      source_ref: `digest-${slot}-${new Date().toISOString().slice(0, 10)}`,
      title: `${slot === 'evening' ? '晚报' : '晨报'} ${new Date().toISOString().slice(0, 10)}`,
      body, kind: 'fyi', domain: 'life', urgency: 2, impact: 2,
    });
    emit('digest', `${slot} 已生成`);
    return body;
  }

  async function doContext() {
    const b = await import('./runtime/src/context/profile.mjs');
    b.upsertFact({ category: 'activity', key: 'by_source', value: JSON.stringify(b.recentActivity().bySource), evidence: 'sensors', confidence: 0.8 });
    return 'ok';
  }

  async function doSelfcheck() {
    const h = watchdog.health();
    const c = taskcenter.todayCost();
    emit('selfcheck', `运行 ${h.running} / 队列 ${h.queued} / 待拍板 ${h.pendingApprovals} / 今日 ¥${c.costCny}`,
      { ...h, cost: c }, h.errLastHour > 10 ? 'warn' : 'info');
    return h;
  }

  const HANDLERS = {
    scan: (p) => doScan(p.config?.source),
    triage: () => doTriage(),
    watchdog: () => doWatchdog(),
  reap: () => doReap(),
    digest: (p) => doDigest(p.config?.slot || 'morning'),
    context: () => doContext(),
    selfcheck: () => doSelfcheck(),
  };

  async function runPulse(p) {
    const fn = HANDLERS[p.config?.handler];
    if (!fn) { pulseMod.markPulseRun(p, 'skip'); return; }
    const t0 = Date.now();
    try {
      await Promise.race([
        fn(p),
        sleep((loadConfig().settings.pulseTimeoutSec || 240) * 1000).then(() => { throw new Error('脉冲超时'); }),
      ]);
      pulseMod.markPulseRun(p, 'ok');
      log('info', `pulse ${p.name} ok ${Date.now() - t0}ms`);
    } catch (e) {
      pulseMod.markPulseRun(p, 'fail');
      lastError = `${p.name}: ${e.message}`;
      log('error', `pulse ${p.name} 失败: ${e.message}`);
      emit('pulse.error', lastError, null, 'error');
    }
  }

  async function tick() {
    if (!running || ticking) return;   // 互斥：上一拍没跑完就跳过本拍，绝不并发
    ticking = true;
    ticks++;
    const now = Date.now();
    try {
      for (const p of pulseMod.duePulses(new Date())) {
        if (!running) break;
        await runPulse(p);
      }
      if (now - lastWatchdog >= 20000) {
        lastWatchdog = now;
        try { await doWatchdog(); } catch (e) { lastError = `watchdog: ${e.message}`; }
      }
      const qn = q.get("SELECT COUNT(*) n FROM tasks WHERE status='queued'")?.n ?? 0;
      if (qn > 0 && !draining) {
        const cost = taskcenter.todayCost();
        if (cost.ratio < 1) {
          draining = true;
          worker.drainQueue()
            .then((r) => { if (r?.length) emit('worker', `本轮执行 ${r.filter((x) => x.ok).length}/${r.length}`); })
            .catch((e) => { lastError = `drain: ${e.message}`; emit('drain.error', e.message, null, 'error'); })
            .finally(() => { draining = false; });
        }
      }
      lastError = null;
      if (now - lastBeat >= 5 * 60e3) {
        lastBeat = now;
        emit('heartbeat', `alive · 第 ${ticks} 拍`);
      }
    } catch (e) {
      lastError = `tick: ${e.message}`;
      log('error', lastError);
      emit('tick.error', lastError, null, 'error');
    } finally {
      ticking = false;   // 无论成败都释放互斥锁
    }
  }

  return {
    async start() {
      if (running) return { already: true };
      loadConfig();
      pulseMod.seedPulses();
      try { watchdog.recover(); } catch (e) { log('warn', `recover: ${e.message}`); }
      running = true;
      writeLock();
      startedAt = new Date().toISOString();
      lastWatchdog = 0; lastBeat = 0;
      // 自续期循环：上一拍跑完再排下一拍，天然不会重叠（配合 tick 里的互斥锁双保险）
      const loop = async () => {
        if (!running) return;
        try { await tick(); } catch { /* tick 内部已记 */ }
        if (!running) return;
        timer = setTimeout(loop, 3000);
        if (timer.unref) timer.unref();
      };
      timer = setTimeout(loop, 800);
      if (timer.unref) timer.unref();
      emit('engine.start', '调度引擎已启动');
      return { running: true, startedAt };
    },
    async stop() {
      running = false;
      clearLock();
      if (timer) { clearTimeout(timer); timer = null; }
      emit('engine.stop', '调度引擎已停止');
      return { running: false };
    },
    async restart() { await this.stop(); return this.start(); },
    async trigger(what = 'scan') {
      // 手动触发：scan / triage / watchdog
      if (what === 'scan') return doScan();
      if (what === 'triage') return doTriage();
      if (what === 'watchdog') return doWatchdog();
      if (what === 'digest') return doDigest('morning');
      if (what === 'selfcheck') return doSelfcheck();
      throw new Error(`未知触发: ${what}`);
    },
    async runPulseById(id) {
      const p = pulseMod.allPulses().find((x) => x.id === id);
      if (!p) throw new Error('脉冲不存在');
      await runPulse(p);
      return { ok: true };
    },
    status() {
      const cfg = loadConfig();
      return {
        running, startedAt, ticks, lastError,
        draining, ticking,
        tickSec: 3,
        pulseTimeoutSec: cfg.settings.pulseTimeoutSec,
        db: { items: q.get('SELECT COUNT(*) n FROM items')?.n ?? 0, tasks: q.get('SELECT COUNT(*) n FROM tasks')?.n ?? 0 },
      };
    },
    get isRunning() { return running; },
  };
}

