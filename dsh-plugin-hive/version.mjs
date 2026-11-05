// dsh-plugin-hive/version.mjs — 版本管理：查版本、装、升、降、卸
//
// 设计原则：
//   · **永不自动改**。只提供信息与按钮，落不落地由用户点。
//   · 落地动作全部走宿主 `ctx.pluginManager`，与 `dsh plugin add` 同一条路径，
//     不自造一套包管理（否则 profiles 的 package.json / patch 会被写坏）。
//   · 拿不到版本源时**如实说**（本地目录安装 / 离线 / 仓库未发布），不编版本号。
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_REPO = 'Elohia/dsh-plugin-hive';
const PKG = 'dsh-plugin-hive';

export function createVersionManager({ ctx, pkgRoot, home, log = () => {} }) {
  const pkgJsonPath = path.join(pkgRoot, 'package.json');

  function readPkg() {
    try { return JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')); }
    catch { return { name: PKG, version: '0.0.0' }; }
  }

  function settings() {
    const f = path.join(home, 'version-settings.json');
    const base = { repo: DEFAULT_REPO, autoCheck: false, autoCheckHours: 24, lastCheckAt: null, lastResult: null };
    try { return { ...base, ...JSON.parse(fs.readFileSync(f, 'utf8')) }; }
    catch { return base; }
  }

  function saveSettings(patch) {
    const f = path.join(home, 'version-settings.json');
    const next = { ...settings(), ...patch };
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(next, null, 2), 'utf8');
    } catch (e) { log('warn', `写版本设置失败: ${e.message}`); }
    return next;
  }

  /** 当前安装信息（来自宿主 pluginManager.listBundles） */
  async function current() {
    const pkg = readPkg();
    let bundle = null;
    try {
      const list = await ctx.pluginManager?.listBundles?.();
      if (Array.isArray(list)) bundle = list.find((b) => b.name === pkg.name) ?? null;
    } catch (e) { log('warn', `listBundles 失败: ${e.message}`); }
    return {
      name: pkg.name,
      version: bundle?.version || pkg.version,
      manifestVersion: pkg.version,
      bundleVersion: bundle?.version ?? null,
      availability: bundle?.availability ?? 'unknown',
      source: bundle?.source ?? null,
      enabled: bundle?.enabled ?? null,
      installed: bundle?.installed ?? null,
      removable: bundle?.removable ?? null,
      readOnlyReason: bundle?.readOnlyReason ?? null,
      // 本地目录 link 安装时没有「版本源」可言，只能从仓库查
      installKind: bundle?.source?.startsWith('link:') ? 'path' : (bundle?.source ? 'registry-or-git' : 'unknown'),
    };
  }

  /** 拉可用版本（GitHub releases；失败则如实回报） */
  async function fetchVersions({ force = false } = {}) {
    const s = settings();
    const now = Date.now();
    if (!force && s.lastCheckAt && s.lastResult && (now - Date.parse(s.lastCheckAt)) < (s.autoCheckHours || 24) * 3600e3) {
      return { ...s.lastResult, cached: true, checkedAt: s.lastCheckAt };
    }
    const repo = s.repo || DEFAULT_REPO;
    const url = `https://api.github.com/repos/${repo}/releases?per_page=30`;
    let payload = null;
    let error = null;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 12000);
      const res = await fetch(url, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-plugin-hive' },
        signal: ac.signal,
      });
      clearTimeout(timer);
      if (res.status === 404) error = `仓库 ${repo} 不存在或没有 Releases`;
      else if (!res.ok) error = `GitHub 返回 HTTP ${res.status}`;
      else payload = await res.json();
    } catch (e) {
      error = `取版本失败：${e.message}`;
    }

    const versions = Array.isArray(payload)
      ? payload.map((r) => ({
          version: String(r.tag_name || '').replace(/^v/, ''),
          tag: r.tag_name,
          name: r.name || r.tag_name,
          publishedAt: r.published_at,
          prerelease: !!r.prerelease,
          draft: !!r.draft,
          notes: String(r.body || '').slice(0, 2000),
          spec: `github:${repo}#${r.tag_name}`,
          tarball: r.tarball_url,
        })).filter((v) => v.version)
      : [];

    versions.sort((a, b) => cmpVersion(b.version, a.version));
    const stable = versions.filter((v) => !v.prerelease && !v.draft);
    const latest = stable[0]?.version ?? versions[0]?.version ?? null;

    const result = { repo, versions, latest, error, sourceKind: 'github-releases' };
    saveSettings({ lastCheckAt: new Date().toISOString(), lastResult: result });
    return { ...result, cached: false, checkedAt: new Date().toISOString() };
  }

  function cmpVersion(a, b) {
    const pa = String(a).split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
    const pb = String(b).split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] ?? 0, y = pb[i] ?? 0;
      if (x === y) continue;
      if (typeof x === 'number' && typeof y === 'number') return x - y;
      return String(x) < String(y) ? -1 : 1;
    }
    return 0;
  }

  /** 汇总：当前 + 可用 + 有没有更新 / 能不能降级 */
  async function overview({ force = false } = {}) {
    const cur = await current();
    const v = await fetchVersions({ force });
    const list = v.versions || [];
    const hasUpdate = !!(v.latest && cmpVersion(v.latest, cur.version) > 0);
    const older = list.filter((x) => cmpVersion(x.version, cur.version) < 0);
    return {
      current: cur,
      repo: v.repo,
      latest: v.latest,
      hasUpdate,
      canDowngrade: older.length > 0,
      downgradeTargets: older.slice(0, 10),
      versions: list.slice(0, 30),
      error: v.error || null,
      cached: v.cached,
      checkedAt: v.checkedAt,
      settings: settings(),
      hint: cur.installKind === 'path'
        ? '当前是「本地目录」安装（link:）。升级/降级需要改成从 GitHub 或 registry 装，或用下面的自定义 spec 覆盖。'
        : null,
    };
  }

  /**
   * 落地一个动作
   * @param {{action:'install'|'update'|'downgrade'|'uninstall'|'enable'|'disable', version?:string, spec?:string}} req
   */
  async function apply(req) {
    const pm = ctx.pluginManager;
    if (!pm) return { ok: false, error: '宿主没有提供 pluginManager，无法在本进程内安装/卸载' };
    const cur = await current();
    const repo = settings().repo || DEFAULT_REPO;
    const action = req.action || 'install';

    if (action === 'uninstall') {
      if (!pm.removeBundle) return { ok: false, error: '宿主不支持 removeBundle' };
      const r = await pm.removeBundle(cur.name);
      return { ok: r?.application !== 'failed', action, result: r, note: '卸载后需要重启 DSH 才能完全生效' };
    }
    if (action === 'enable' || action === 'disable') {
      if (!pm.setBundleEnabled) return { ok: false, error: '宿主不支持 setBundleEnabled' };
      const r = await pm.setBundleEnabled(cur.name, action === 'enable');
      return { ok: r?.application !== 'failed', action, result: r };
    }

    // install / update / downgrade → 同一个 installBundle
    let spec = req.spec ? String(req.spec).trim() : '';
    if (!spec) {
      if (!req.version) return { ok: false, error: '缺少 version 或 spec' };
      spec = `github:${repo}#v${String(req.version).replace(/^v/, '')}`;
    }
    // 只有真的会动磁盘时才叫落单，先 inspect 一遍好给出可读的拒绝原因
    let inspect = null;
    try { inspect = await pm.inspect?.(spec); } catch { /* 忽略 */ }
    if (inspect && inspect.status === 'refused' && action !== 'install') {
      // 更新/降级被拒时把原因带回去
      return { ok: false, action, spec, inspect, error: `宿主拒绝该 spec：${inspect.reason}` };
    }
    const r = await pm.installBundle(spec, { enabled: true, saveExact: true });
    const ok = r?.application !== 'failed';
    return {
      ok, action, spec, inspect, result: r,
      note: r?.application === 'restart-required' ? '已安装，需要重启 DSH 生效' : (ok ? '已应用' : '失败，见 result.error'),
      pendingBuilds: r?.pendingBuilds ?? [],
    };
  }

  /** 自动检查：设置允许时，启动后延迟查一次，只写状态不落地任何动作 */
  function scheduleAutoCheck() {
    const s = settings();
    if (!s.autoCheck) return;
    setTimeout(async () => {
      try {
        const o = await overview({ force: false });
        if (o.hasUpdate) log('info', `发现新版本 ${o.latest}（当前 ${o.current.version}），等待用户决定`);
      } catch { /* 静默 */ }
    }, 20000).unref?.();
  }

  return { current, fetchVersions, overview, apply, settings, saveSettings, scheduleAutoCheck, cmpVersion, PKG };
}
