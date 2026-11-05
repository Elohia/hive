// src/sensors/git.mjs — 代码仓库活动传感器（只读）
//
// 产出三类信号：
//   1. git_activity  —— 近 N 小时提交（有人在推进）
//   2. git_wip       —— 未提交变更（"有半成品工作"的最强信号）
//   3. git_unpushed  —— 未推送提交（本地领先远端）
//
// 本机实测（2026-11）：config.sources.git.repos 里 6 个路径**只有 D:\evo 是仓库根**，
// 其余是"项目父目录"。因此对非仓库路径做**有界嵌套发现**（深度≤3，跳过 node_modules 等），
// 找到 C:/HIVE-SAMPLE/workspace\.dsh\skills\author-voice-distill、C:/HIVE-SAMPLE/automations\deploy\*、C:/HIVE-SAMPLE/misc\MiroFish。
// 发现到的仓库在 meta.discovered=true 里标注，可关（cfg.sources.git.discover=false）。
//
// 只读保障：所有 git 调用都带 GIT_OPTIONAL_LOCKS=0（避免 status 写 index.lock），
// 不做 fetch/checkout/commit，不修改任何工作区。
import path from 'node:path';
import {
  runCli, clampInt, toIso, note, oneLine, hash,
  statSafe, findGitRoots,
} from './_util.mjs';

const NAME = 'git';

const GIT_ENV = {
  GIT_OPTIONAL_LOCKS: '0',   // 只读：不抢 index 锁
  GIT_TERMINAL_PROMPT: '0',  // 不发交互提示（否则卡死）
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  LC_ALL: 'C',
};

const UNIT = '\u001f';
const REC = '\u001e';

/** git 仓库名（取目录名） */
function repoName(root) {
  return path.basename(root.replace(/[\\/]+$/, '')) || root;
}

async function git(root, args, timeoutMs) {
  return runCli('git', ['-C', root, ...args], { timeoutMs, env: GIT_ENV });
}

/** 判定一个路径能否作为 git 仓库使用；能则返回仓库根 */
async function resolveRepo(p, timeoutMs) {
  const st = statSafe(p);
  if (!st || !st.isDirectory()) return { ok: false, reason: 'path-missing' };
  const r = await git(p, ['rev-parse', '--is-inside-work-tree'], timeoutMs);
  if (!r.ok) return { ok: false, reason: r.timedOut ? 'timeout' : 'not-a-repo' };
  if (!/true/i.test(r.stdout.trim())) return { ok: false, reason: 'not-a-worktree' };
  const top = await git(p, ['rev-parse', '--show-toplevel'], timeoutMs);
  const root = top.ok && top.stdout.trim() ? top.stdout.trim() : path.resolve(p);
  return { ok: true, root };
}

/** 近 N 小时提交 */
async function readCommits(root, sinceIso, timeoutMs, maxCommits) {
  const fmt = `%H${UNIT}%aI${UNIT}%an${UNIT}%s${REC}`;
  const r = await git(
    root,
    ['log', `--since=${sinceIso}`, `--max-count=${maxCommits}`, `--no-color`, `--pretty=format:${fmt}`],
    timeoutMs,
  );
  if (!r.ok) return { ok: false, commits: [], reason: r.timedOut ? 'timeout' : (r.error || `exit ${r.code}`) };
  const raw = r.stdout.replace(/\n+$/g, '');
  if (!raw.trim()) return { ok: true, commits: [] };
  const commits = [];
  for (const rec of raw.split(REC)) {
    const t = rec.trim();
    if (!t) continue;
    const [sha, at, author, subject] = t.split(UNIT);
    if (!sha) continue;
    commits.push({
      sha: String(sha).trim(),
      short: String(sha).trim().slice(0, 8),
      at: toIso(at) || null,
      author: (author || '').trim() || null,
      subject: oneLine(subject || '', 200),
    });
  }
  return { ok: true, commits };
}

/** 未提交变更（含未跟踪） */
async function readDirty(root, timeoutMs, maxFiles) {
  const r = await git(root, ['status', '--porcelain=v1', '-uall', '--no-renames'], timeoutMs);
  if (!r.ok) return { ok: false, files: [], total: 0, reason: r.timedOut ? 'timeout' : (r.error || `exit ${r.code}`) };
  const lines = r.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const files = lines.slice(0, maxFiles).map((l) => {
    const code = l.slice(0, 2);
    const p = l.slice(3).trim();
    return { code, path: p };
  });
  return { ok: true, files, total: lines.length };
}

/** 未推送提交（本地分支有、远端没有）。无 remote 的仓库不适用，直接跳过。 */
async function readUnpushed(root, timeoutMs, maxCommits) {
  const remotes = await git(root, ['remote'], timeoutMs);
  if (remotes.ok && remotes.stdout.trim() === '') {
    return { ok: true, lines: [], reason: 'no-remote' };
  }
  const r = await git(root, ['log', '--branches', '--not', '--remotes', '--no-color', '--oneline', '-n', String(maxCommits)], timeoutMs);
  if (!r.ok) {
    // 没有 upstream 时 git 也可能返回非 0 —— 属于正常态而非错误
    return { ok: false, lines: [], reason: r.timedOut ? 'timeout' : (r.error || `exit ${r.code}`) };
  }
  const lines = r.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return { ok: true, lines };
}

/** 当前分支 + 上游 */
async function readBranch(root, timeoutMs) {
  const r = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], timeoutMs);
  const branch = r.ok ? r.stdout.trim() : null;
  const up = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], timeoutMs);
  return { branch: branch && branch !== 'HEAD' ? branch : branch, upstream: up.ok ? up.stdout.trim() : null };
}

export default {
  name: NAME,
  title: '代码仓库活动',
  enabled(cfg) {
    return !!(cfg?.sources?.git?.enabled);
  },

  async *scan(ctx) {
    const cfg = ctx?.cfg || {};
    const sc = cfg?.sources?.git || {};
    const opts = ctx?.opts || {};
    const repos = Array.isArray(sc.repos) ? sc.repos.filter(Boolean) : [];
    const lookbackHours = clampInt(sc.lookbackHours, 1, 24 * 30, 48);
    const discover = sc.discover !== false && opts.discover !== false;
    const maxCommits = clampInt(opts.maxCommits, 1, 200, 30);
    const maxFiles = clampInt(opts.maxFiles, 1, 500, 40);
    const cmdTimeout = clampInt(opts.timeoutMs, 2_000, 60_000, 20_000);
    const totalBudgetMs = clampInt(opts.budgetMs, 5_000, 180_000, 60_000);

    const t0 = Date.now();
    const now = ctx?.now instanceof Date ? ctx.now : new Date();
    const sinceIso = new Date(now.getTime() - lookbackHours * 3600_000).toISOString();

    if (repos.length === 0) {
      note(ctx, NAME, { ok: true, count: 0, note: 'config.sources.git.repos 为空' });
      return;
    }

    // ---- 1. 解析仓库根（非仓库则做有界嵌套发现） ----
    const resolved = [];      // { root, configuredAs, discovered }
    const seenRoots = new Set();
    const skipped = [];

    for (const p of repos) {
      if (Date.now() - t0 > totalBudgetMs) { skipped.push({ path: p, reason: 'budget' }); continue; }
      try {
        const r = await resolveRepo(p, cmdTimeout);
        if (r.ok) {
          const key = path.resolve(r.root).toLowerCase();
          if (!seenRoots.has(key)) {
            seenRoots.add(key);
            resolved.push({ root: path.resolve(r.root), configuredAs: p, discovered: false });
          }
          continue;
        }
        if (!discover) { skipped.push({ path: p, reason: r.reason }); continue; }
        const found = findGitRoots(p, {
          maxDepth: clampInt(sc.discoverDepth, 1, 6, 3),
          maxRepos: clampInt(sc.discoverMaxRepos, 1, 30, 8),
        });
        let added = 0;
        for (const root of found.roots) {
          const key = path.resolve(root).toLowerCase();
          if (seenRoots.has(key)) continue;
          seenRoots.add(key);
          resolved.push({ root: path.resolve(root), configuredAs: p, discovered: true });
          added++;
        }
        if (added === 0) skipped.push({ path: p, reason: r.reason });
      } catch (e) {
        skipped.push({ path: p, reason: oneLine(e?.message || e, 80) });
      }
    }

    // ---- 2. 逐仓库采集 & 产出 ----
    let emitted = 0;
    const perRepo = [];

    for (const entry of resolved) {
      if (Date.now() - t0 > totalBudgetMs) break;
      const root = entry.root;
      const name = repoName(root);

      try {
        const [branchInfo, commitsRes, dirtyRes, unpushedRes] = await Promise.all([
          readBranch(root, cmdTimeout),
          readCommits(root, sinceIso, cmdTimeout, maxCommits),
          readDirty(root, cmdTimeout, maxFiles),
          readUnpushed(root, cmdTimeout, 20),
        ]);

        const commits = commitsRes.ok ? commitsRes.commits : [];
        const dirty = dirtyRes.ok ? dirtyRes : { files: [], total: 0 };
        const unpushed = unpushedRes.ok ? unpushedRes.lines : [];

        perRepo.push({
          repo: name, root, configuredAs: entry.configuredAs, discovered: entry.discovered,
          branch: branchInfo.branch, commits: commits.length, dirty: dirty.total, unpushed: unpushed.length,
          errors: [commitsRes, dirtyRes, unpushedRes].filter((x) => !x.ok).map((x) => x.reason),
        });

        const baseMeta = {
          repo: name,
          root,
          configuredAs: entry.configuredAs,
          discovered: entry.discovered,
          branch: branchInfo.branch,
          upstream: branchInfo.upstream,
          lookbackHours,
        };

        // 2.1 近期提交 → 一条"仓库活动"摘要
        if (commits.length > 0) {
          const newest = commits[0];
          const authors = [...new Set(commits.map((c) => c.author).filter(Boolean))].slice(0, 3);
          const shown = commits.slice(0, 10);
          const body = [
            `仓库：${name}（${root}）`,
            `分支：${branchInfo.branch || '?'}${branchInfo.upstream ? ` → ${branchInfo.upstream}` : ''}`,
            `窗口：近 ${lookbackHours}h，共 ${commits.length} 次提交`,
            authors.length ? `作者：${authors.join('、')}` : null,
            '',
            '最近提交：',
            ...shown.map((c) => `- ${c.short} ${c.at ? c.at.slice(0, 16).replace('T', ' ') : ''} ${c.subject}`),
            commits.length > shown.length ? `…（另有 ${commits.length - shown.length} 次）` : null,
          ].filter((x) => x != null).join('\n');

          emitted++;
          yield {
            source: NAME,
            source_ref: `git:activity:${root}:${newest.sha}`,
            title: oneLine(`${name}：近 ${lookbackHours}h ${commits.length} 次提交（${newest.subject}）`, 160),
            body,
            ts: newest.at || new Date().toISOString(),
            kind_hint: 'git_activity',
            domain_hint: 'code',
            urgency_hint: 2,
            meta: { ...baseMeta, commitCount: commits.length, commits: shown },
          };
        }

        // 2.2 未提交变更 → "可能有半成品工作"
        if (dirty.total > 0) {
          const shown = dirty.files.slice(0, 15);
          const fingerprint = hash(shortedDirty(dirty.files, dirty.total), 12);
          const body = [
            `仓库：${name}（${root}）`,
            `分支：${branchInfo.branch || '?'}`,
            `未提交：${dirty.total} 处变更（可能是半成品工作）`,
            '',
            ...shown.map((f) => `- ${f.code.trim() || '?'} ${f.path}`),
            dirty.total > shown.length ? `…（另有 ${dirty.total - shown.length} 处）` : null,
          ].filter((x) => x != null).join('\n');

          emitted++;
          yield {
            source: NAME,
            source_ref: `git:wip:${root}:${fingerprint}`,
            title: oneLine(`${name}：${dirty.total} 处未提交变更 · ${shown[0]?.path || ''}`, 160),
            body,
            ts: mtimeOf(root),
            kind_hint: 'git_wip',
            domain_hint: 'code',
            urgency_hint: 3,
            meta: { ...baseMeta, dirtyTotal: dirty.total, dirtyFiles: shown },
          };
        }

        // 2.3 未推送
        if (unpushed.length > 0) {
          const shown = unpushed.slice(0, 10);
          const fingerprint = hash(unpushed.join('|'), 12);
          emitted++;
          yield {
            source: NAME,
            source_ref: `git:unpushed:${root}:${fingerprint}`,
            title: oneLine(`${name}：${unpushed.length} 条未推送提交`, 160),
            body: [
              `仓库：${name}（${root}）`,
              `分支：${branchInfo.branch || '?'}${branchInfo.upstream ? ` → ${branchInfo.upstream}` : '（无上游）'}`,
              `未推送：${unpushed.length} 条`,
              '',
              ...shown.map((l) => `- ${l}`),
            ].join('\n'),
            ts: new Date().toISOString(),
            kind_hint: 'git_unpushed',
            domain_hint: 'code',
            urgency_hint: 2,
            meta: { ...baseMeta, unpushed: unpushed.length },
          };
        }
      } catch (e) {
        // 单个仓库失败不中断其它仓库
        perRepo.push({ repo: name, root, error: oneLine(e?.message || e, 160) });
        ctx?.log?.('warn', 'sensor:git 仓库失败', { root, error: oneLine(e?.message || e, 120) });
      }
    }

    const totalCommits = perRepo.reduce((a, r) => a + (r.commits || 0), 0);
    const dirtyRepos = perRepo.filter((r) => (r.dirty || 0) > 0).length;
    const discoveredCount = resolved.filter((r) => r.discovered).length;

    note(ctx, NAME, {
      ok: true,
      count: emitted,
      configured: repos.length,
      repos: resolved.length,
      discovered: discoveredCount,
      skipped,
      commits: totalCommits,
      dirtyRepos,
      perRepo,
      ms: Date.now() - t0,
      note: resolved.length === 0
        ? `配置的 ${repos.length} 个路径都不是 git 仓库`
        : `${resolved.length} 个仓库（发现 ${discoveredCount}）· 近 ${lookbackHours}h 提交 ${totalCommits} 次 · ${dirtyRepos} 个仓库有未提交变更`,
    });

    ctx?.log?.('info', 'sensor:git', {
      repos: resolved.length, discovered: discoveredCount, emitted, totalCommits, dirtyRepos,
    });
  },
};

/** 目录 mtime 作为未提交变更的时间锚（无提交可依时用） */
function mtimeOf(root) {
  const st = statSafe(path.join(root, '.git'));
  const st2 = st || statSafe(root);
  return st2 ? new Date(st2.mtimeMs).toISOString() : new Date().toISOString();
}

function shortedDirty(files, total) {
  return files.map((f) => `${f.code}:${f.path}`).join('\n') + `#${total}`;
}

export const __internals = { resolveRepo, readCommits, readDirty, readUnpushed, repoName };
