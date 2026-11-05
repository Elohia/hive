// src/task/worker.mjs — 派发并执行一个 task（唯一真正“动手”的地方）
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../core/config.mjs';
import { chat } from '../core/llm.mjs';
import { emit } from '../core/events.mjs';
import { logger } from '../core/log.mjs';
import { getTask, updateTask, openRun, finishRun, attachRunPid, addArtifact, getItem, updateItem } from './taskcenter.mjs';
import { buildContextText, systemPreamble } from '../context/profile.mjs';

async function loadExecutors() {
  try { return await import('../executors/index.mjs'); } catch { return null; }
}

function buildPrompt(task, item, prevResults = {}) {
  const plan = safeParse(task.plan) || null;
  const ctx = buildContextText({ budgetChars: 2500 });
  const lvl = task.autonomy_level || 3;
  const guard = lvl <= 2
    ? '【只读约束】这是 L1/L2 调查任务：只允许读取与检索，禁止修改/删除/新建任何文件，禁止执行有副作用的命令（发信/发布/安装/提交/推送）。'
    : lvl === 3
      ? '【写入约束】这是 L3 任务：可以在工作区产出文件，但不要对外发送/发布/删除，也不要提交到远端仓库。'
      : '';

  const prev = Object.entries(prevResults || {});
  const prevBlock = prev.length
    ? '【前置步骤的实际产出（必须基于它继续，不要再重复取证）】\n' +
      prev.map(([tid, r]) => `### ${r.title || tid}\n${String(r.text || '').slice(0, 4000)}`).join('\n\n')
    : '';

  const parts = [
    systemPreamble(),
    guard,
    `你要完成的任务：${task.title}`,
    task.goal ? `目标/背景：\n${String(task.goal).slice(0, 3000)}` : '',
    plan?.goal ? `本步目标：${plan.goal}` : '',
    plan?.deliverable ? `期望产出：${plan.deliverable}` : '',
    prevBlock,
    item?.body ? `原始信息：\n${String(item.body).slice(0, 2000)}` : '',
    ctx ? `我的上下文：\n${ctx}` : '',
    `工作目录：${process.cwd()}`,
    '完成标准：产出可验证的结果（文件或明确结论），最后用一段话总结「做了什么、产出在哪、还有什么风险」。',
  ].filter(Boolean);
  return parts.join('\n\n');
}

function safeParse(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

/**
 * 执行一个 task。
 * @returns {{ok:boolean, status:string, runId:string, result?:any, error?:string}}
 */
export async function dispatchTask(taskId) {
  const cfg = loadConfig();
  let task = getTask(taskId);
  if (!task) return { ok: false, status: 'missing', error: 'task 不存在' };
  const item = task.item_id ? getItem(task.item_id) : null;

  const attempt = (task.attempt || 0) + 1;
  const timeoutSec = task.timeout_sec || cfg.settings.defaultTimeoutSec;
  const budgetTokens = task.budget_tokens || cfg.settings.defaultBudgetTokens;

  // 租约：到期未续 = 卡死，watchdog 会回收
  const leaseUntil = new Date(Date.now() + timeoutSec * 1000 + 60000).toISOString();
  updateTask(task.id, { status: 'running', attempt, lease_until: leaseUntil, started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString() });

  const run = openRun({ task_id: task.id, attempt, executor: task.executor || 'llm', command: task.executor });

  // 依赖链：把前置任务的实际产出带进 prompt（DAG 的上下文传递）
  const prevResults = {};
  try {
    const deps = JSON.parse(task.depends_on || '[]');
    for (const d of deps) {
      const pt = getTask(d);
      if (!pt) continue;
      let txt = '';
      try { txt = JSON.parse(pt.result || '{}')?.text || ''; } catch { txt = pt.result || ''; }
      prevResults[d] = { title: pt.title, text: txt || pt.last_error || '(无产出)' };
    }
  } catch {}

  const prompt = buildPrompt(task, item, prevResults);
  fs.writeFileSync(path.join(run.dir, 'prompt.txt'), prompt, 'utf8');
  fs.writeFileSync(path.join(run.dir, 'meta.json'), JSON.stringify({
    task: { id: task.id, title: task.title, executor: task.executor, level: task.autonomy_level },
    item: item ? { id: item.id, source: item.source, title: item.title } : null,
    timeoutSec, budgetTokens, startedAt: new Date().toISOString(),
  }, null, 2), 'utf8');

  emit({ actor: 'worker', type: 'task.derived', task_id: task.id, run_id: run.id, message: `prompt ${prompt.length} 字 → ${task.executor || 'llm'}` });

  let out = { ok: false, status: 'failed', error: '未执行' };
  try {
    const ex = await loadExecutors();
    const name = task.executor || 'llm';
    if (ex?.run) {
      const res = await ex.run(name, {
        task, item, prompt,
        workdir: cfg.resolved.workspace,
        timeoutSec, budgetTokens,
        runDir: run.dir,
        onSpawn: (pid) => {
          // 只登记 pid；绝不能在这里 finishRun（否则 run 立刻被标 ok，
          // 看门狗会认为「领了却没在跑」→ 按孤儿回收 → 无限重跑。实测踩过）
          try { attachRunPid(run.id, pid); } catch {}
          updateTask(task.id, { heartbeat_at: new Date().toISOString() });
        },
        onLog: (line) => {
          // 执行器的 onLog 有时给对象（结构化事件），有时给字符串
          const text = typeof line === 'string' ? line : (() => { try { return JSON.stringify(line); } catch { return String(line); } })();
          if (/error|fail|exception|denied/i.test(text)) {
            emit({ actor: 'worker', type: 'worker.stderr', task_id: task.id, run_id: run.id, level: 'warn', message: text.slice(0, 300) });
          }
          try { fs.appendFileSync(path.join(run.dir, 'output.log'), text.slice(0, 4000) + '\n'); } catch {}
        },
      });
      out = { ok: !!res.ok, status: res.ok ? 'succeeded' : (res.timeout ? 'timeout' : 'failed'), error: res.error, res };
    } else {
      // 执行器层未就绪 → 退化为纯 LLM
      emit({ actor: 'worker', type: 'worker.degraded', task_id: task.id, level: 'warn', message: '执行器层不可用，退化为纯 LLM' });
      const r = await chat({
        tier: task.autonomy_level >= 4 ? 'strong' : 'cheap',
        maxTokens: 2000,
        messages: [{ role: 'system', content: systemPreamble() }, { role: 'user', content: prompt }],
        retries: 1,
      });
      out = r.ok
        ? { ok: true, status: 'succeeded', res: { stdout: r.text, stderr: '', exitCode: 0, tokens: r.usage, costCny: r.costCny, result: { text: r.text } } }
        : { ok: false, status: 'failed', error: r.error };
    }
  } catch (e) {
    out = { ok: false, status: 'failed', error: String(e.message || e) };
    emit({ actor: 'worker', type: 'worker.exception', task_id: task.id, run_id: run.id, level: 'error', message: String(e.message).slice(0, 400) });
  }

  const res = out.res || {};
  const stdout = String(res.stdout || '');
  const stderr = String(res.stderr || '');
  fs.writeFileSync(path.join(run.dir, 'stdout.txt'), stdout, 'utf8');
  fs.writeFileSync(path.join(run.dir, 'stderr.txt'), stderr, 'utf8');
  fs.writeFileSync(path.join(run.dir, 'result.json'), JSON.stringify({ ok: out.ok, status: out.status, error: out.error || null, result: res.result ?? null, tokens: res.tokens ?? null, costCny: res.costCny ?? null }, null, 2), 'utf8');

  finishRun(run.id, {
    status: out.ok ? 'ok' : (out.status === 'timeout' ? 'timeout' : 'failed'),
    exit_code: res.exitCode ?? null,
    tokens_in: res.tokens?.in ?? 0,
    tokens_out: res.tokens?.out ?? 0,
    cost_cny: res.costCny ?? 0,
    error: out.error ?? null,
  });

  // 产物登记（执行器报的 + 输出目录里新出现的文件）
  for (const a of res.artifacts || []) {
    try { addArtifact({ task_id: task.id, item_id: task.item_id, kind: a.kind || 'file', title: a.title || a.path, filePath: a.path }); } catch {}
  }

  const tokensIn = res.tokens?.in ?? 0, tokensOut = res.tokens?.out ?? 0;
  const cost = res.costCny ?? 0;

  if (out.ok) {
    updateTask(task.id, {
      status: 'succeeded', finished_at: new Date().toISOString(), lease_until: null,
      tokens_in: (task.tokens_in || 0) + tokensIn, tokens_out: (task.tokens_out || 0) + tokensOut,
      cost_cny: (task.cost_cny || 0) + cost,
      result: JSON.stringify({ text: stdout.slice(0, 6000), runDir: run.dir, artifacts: res.artifacts || [] }).slice(0, 20000),
      last_error: null, output_dir: run.dir,
    });
    emit({ actor: 'worker', type: 'task.succeeded', task_id: task.id, run_id: run.id, message: `${task.title} 完成 ¥${cost.toFixed(4)}`, data: { tokens: { in: tokensIn, out: tokensOut } } });
    // 父任务完成 → item 完成
    const others = (await import('./taskcenter.mjs')).listTasks({ item_id: task.item_id, limit: 50 })
      .filter((t) => t.status !== 'succeeded' && t.id !== task.id);
    if (task.item_id && others.length === 0) {
      try {
        const it = getItem(task.item_id);
        const meta = { ...(it?.meta ? safeParse(it.meta) : {}), finalResult: stdout.slice(0, 3000), runDir: run.dir };
        updateItem(task.item_id, { status: 'done', bucket: 'active', meta }, { event: { type: 'item.done', actor: 'worker', message: '全部子任务完成' } });
      } catch {}
    }
  } else {
    const attemptNow = attempt;
    const canRetry = attemptNow < (task.max_attempts || cfg.settings.maxAttempts);
    // 指数退避：重排时用 lease_until 兼作「最早可跑时间」，避免失败任务立刻再撞墙
    const backoff = cfg.settings.retryBackoffSec || [60, 300, 900];
    const delaySec = canRetry ? (backoff[Math.min(attemptNow - 1, backoff.length - 1)] || 60) : 0;
    const notBefore = canRetry ? new Date(Date.now() + delaySec * 1000).toISOString() : null;
    updateTask(task.id, {
      status: canRetry ? 'queued' : 'failed',
      lease_until: notBefore,
      last_error: String(out.error || 'unknown').slice(0, 1000),
      tokens_in: (task.tokens_in || 0) + tokensIn, tokens_out: (task.tokens_out || 0) + tokensOut,
      cost_cny: (task.cost_cny || 0) + cost,
    });
    emit({
      actor: 'worker', type: `task.${canRetry ? 'retry' : 'failed'}`, task_id: task.id, run_id: run.id,
      level: canRetry ? 'warn' : 'error',
      message: `${task.title} ${out.status}${canRetry ? ` (第 ${attemptNow} 次失败，${delaySec}s 后重试)` : ' (最终失败)'}`,
      data: { error: String(out.error || '').slice(0, 400), notBefore },
    });
  }

  return { ok: out.ok, status: out.status, runId: run.id, error: out.error, result: res.result };
}

/** 并发执行若干个可跑的 task（受 maxConcurrentWorkers 限制） */
export async function drainQueue({ max = null } = {}) {
  const cfg = loadConfig();
  const limit = max ?? cfg.settings.maxConcurrentWorkers;
  const { claimNextTask } = await import('./taskcenter.mjs');
  const started = [];
  // 串行领，并行跑
  const tasks = [];
  for (let i = 0; i < limit; i++) {
    const t = claimNextTask(limit);
    if (!t) break;
    tasks.push(t);
  }
  if (!tasks.length) return started;
  await Promise.all(tasks.map(async (t) => {
    try { started.push(await dispatchTask(t.id)); }
    catch (e) { logger.error(`dispatch ${t.id} 失败: ${e.message}`); started.push({ ok: false, status: 'failed', error: e.message }); }
  }));
  return started;
}

/** 一直跑到队列空（有依赖链时需要多轮），供 CLI 单次调用使用 */
export async function drainAll({ maxRounds = 20, onRound } = {}) {
  const { q } = await import('../core/db.mjs');
  const results = [];
  for (let i = 0; i < maxRounds; i++) {
    const pending = q.get("SELECT COUNT(*) n FROM tasks WHERE status='queued'")?.n ?? 0;
    if (!pending) break;
    const r = await drainQueue();
    if (!r.length) break;
    results.push(...r);
    onRound?.({ round: i + 1, done: r.length });
  }
  return results;
}
