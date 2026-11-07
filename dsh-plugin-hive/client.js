/**
 * dsh-plugin-hive —— 浏览器半端（左侧栏入口 + 主面板）
 * ============================================================================
 * client bundle 是**自注册脚本**（不是被 import 的 ESM 模块）：
 *   window.__ModuleLoader__.load({ id: 'dsh-plugin-hive', factory: (require) => ({ inject, apply }) })
 * factory 里只能 require('react')，不能引 npm 包、不能引 CDN。
 *
 * 注册两个槽位：
 *   sidebar.panellist  id  = 'hive'  → 左侧栏那颗六边形蜂巢图标（id 同时指向 main 面板）
 *   main               key = 'hive'  → 主区：48px 控制条 + iframe 看板 + 设置抽屉
 *
 * 控制条按钮（7 个，窄栏可横向滚动）：启动 / 停止 / 立即巡检 / 环境自检 / Agent 依赖 / 版本 / 刷新
 * 抽屉只有一个，内部三个横向标签：
 *   ① 自检   —— 逐项 PASS/WARN/FAIL + 修复建议 + 一键安装缺失项
 *   ② 依赖   —— 可选 Agent CLI（codex / claude / pi / agently…）：安装 / 更新 / 降级▾ / 卸载，
 *               装不装完全由用户决定（不装也能用内置 llm + dsh 执行器）
 *   ③ 版本   —— HIVE 插件自身版本：检查更新 / 更新 / 降级▾ / 卸载（后端报错就原文显示并禁用按钮）
 *
 * 所有数据走 Host 半端的同源接口（浏览器不跨域）：
 *   GET  /hive/api/health            引擎健康（node/db/executors/sensors）
 *   GET  /hive/api/overview          看板汇总（待办 / 待拍板 / 在跑）
 *   GET  /hive/api/plugin/status     插件状态（phase / engine / model）—— 插件自有，最可靠
 *   GET  /hive/api/plugin/doctor     插件自检（rows: {id,name,status,detail,fix}）
 *   GET  /hive/api/plugin/version    插件版本（current/latest/hasUpdate/versions/error）
 *   POST /hive/api/plugin/version/apply  { action:'update'|'downgrade'|'install'|'uninstall'|'enable'|'disable', version? }
 *   GET  /hive/api/setup/doctor      完整自检（items + summary + installable）
 *   POST /hive/api/setup/install     { id } 安装一个缺失依赖
 *   GET  /hive/api/deps              可选 Agent CLI 清单（current/latest/versions/installed）
 *   POST /hive/api/deps/check        让后端重新探测依赖
 *   POST /hive/api/deps/{id}/install|update|uninstall   单个 Agent CLI 的动作（body 可带 {version}）
 *   POST /hive/api/control/start     启动引擎
 *   POST /hive/api/control/stop      停止引擎
 *   POST /hive/api/control/scan      触发一次巡检
 *   GET  /hive/api/doctor            旧接口（嵌套结构），作为自检的第三级兜底
 *
 * 设计三条硬约束（面向「傻瓜式」）：
 *   1) 任何状态都有文案解释：加载中 / 正常 / 降级 / 异常 / 未初始化，各自说人话。
 *   2) 任何按钮都有反馈：点下去立刻变「处理中…」，回来变成 topbar 下面的提示条；
 *      失败必须把**原因**（HTTP 状态、返回体、异常信息）原样显示，绝不吞掉。
 *   3) 任何接口挂掉都不白屏：看板 iframe 永远挂着，上面再叠引导卡片 / 抽屉；
 *      某个接口 404 就只显示「该接口未就绪」，不猜、不编、不崩。
 *
 * 窄栏（面板可能只有 400px）：控制条固定 48px 高、按钮横排可横向滚动，不换行、
 * 不挤压 iframe 高度；抽屉在窄栏下自动变成整宽而不是侧滑半屏。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-hive',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /* ───────────────────────────── 常量 ───────────────────────────── */

    const API = '/hive/api' // Host 半端挂载前缀（同源）
    const DASHBOARD = '/hive/' // 看板页面（iframe 内嵌，宿主已允许同源 frame）
    const BAR_H = 48 // 控制条高度，与 iframe 的 calc(100% - 48px) 严格对应
    const POLL_MS = 20000 // 状态轮询间隔

// 跨挂载状态缓存：DSH 的 main 面板是按 id 挂载的，切到会话再切回来会**卸载重建**。
// 如果状态只存在组件里，回来就是 loading → 首轮请求稍慢或失败一次就显示红点，
// 看起来跟「掉线」一样。这里把最近一次成功读数留在模块作用域，重建时立刻还原。
const LAST = { phase: 'loading', reason: '', detail: '', counts: null, engineRun: null, at: 0 }

// 单次请求失败后先重试一次再判死：切面板时偶发一次 abort/超时不该变成红色状态
async function requestRetry(path, opts) {
  try {
    return await request(path, opts)
  } catch (e) {
    await new Promise((r) => setTimeout(r, 700))
    return request(path, opts)
  }
}
    const TOAST_MS = 6000 // 提示条自动消失时间（失败留 9s）
    const STOP_ARM_MS = 6000 // 「停止」二次确认的窗口

    // 允许自动安装的依赖 id（与 Host 的 setup/install 白名单一致）
    const INSTALLABLE_IDS = ['nodejs', 'dsh-cli', 'pi-cli', 'codex-cli', 'claude-cli', 'agently-cli']

    /* ───────────────────────────── 文案 ───────────────────────────── */

    const DICT = {
      zh: {
        title: 'HIVE',
        subtitle: '主动服务',
        frameTitle: 'HIVE 看板',

        statusLoading: '检测中…',
        statusReady: '正常',
        statusDegraded: '降级',
        statusError: '异常',
        statusUninit: '未初始化',
        statusTab: '状态',

        btnStart: '启动',
        btnStop: '停止',
        btnStopConfirm: '确认停止？',
        btnScan: '立即巡检',
        btnDoctor: '环境自检',
        btnRefresh: '刷新',
        working: '处理中…',

        close: '关闭',
        retry: '重试',
        stillOpen: '仍然打开看板',

        started: '已启动',
        startFailed: '启动失败',
        stopped: '已停止',
        stopFailed: '停止失败',
        stopConfirm: '再点一次「确认停止」才会真的停；6 秒不点自动取消。',
        scanStarted: '巡检已触发',
        scanFailed: '巡检失败',
        refreshFailed: '刷新失败',
        refreshed: '已刷新',
        healthFailed: '读不到服务状态',

        doctorTitle: '环境自检',
        doctorLoading: '正在探测（可能要几秒）…',
        doctorDone: '自检完成',
        doctorFailed: '自检失败',
        rerunDoctor: '重新自检',
        oneKeyInstall: '一键安装缺失项',
        nothingToInstall: '当前没有可自动安装的缺失项',
        install: '安装',
        installRunning: '安装中…',
        installDone: '安装完成',
        installFailed: '安装失败',
        installNeedManual: '需手动安装',
        installGuide: '手动安装步骤',
        fixHint: '修复建议',
        levelPass: 'PASS',
        levelWarn: 'WARN',
        levelFail: 'FAIL',
        levelUnknown: '未知',
        emptyRows: '没有可显示的检查项。',
        endpointLabel: '接口',
        checkedAt: '检测时间',
        summaryLabel: '自检结果',

        guideTitle: 'HIVE 还没接上',
        guideReason: '原因',
        guideReasonEmpty: '后端暂时没有回应（可能插件刚启动、或调度引擎还没起来）。',
        guideStep1: '① 自检：确认 Node、数据库、执行器、外部通道是否就绪',
        guideStep2: '②（可选）安装缺失依赖：只装检测不过的命令行工具',
        guideStep3: '③ 启动：打开调度引擎，接上看板，开始主动服务',
        oneKeyStart: '一键开始',
        oneKeyWorking: '正在按 ①→②→③ 顺序走一遍…',
        oneKeyNeedsInstall: '检测到 {n} 项可自动安装的缺失依赖，已经列在抽屉里；点「一键安装缺失项」即可。',
        oneKeyStarted: '自检通过，已启动调度引擎',

        pendingApprovals: '待拍板',
        runningTasks: '在跑',
        inboxCount: '待办',
        barHint: '每个按钮都会回显结果；失败原因会显示在下面这条提示里。',
        notePrefix: '说明',
        tipBody: '上面是快捷入口，下面 iframe 里是同一套数据的完整看板。',
        statusUnknownDetail: '状态未知，点「环境自检」看具体哪一项没过。',

        /* ── 抽屉：三个标签 ── */
        btnDeps: 'Agent 依赖',
        btnVersion: '版本',
        tabDoctor: '自检',
        tabDeps: '依赖',
        tabVersion: '版本',
        drawerTitle: 'HIVE 设置',
        endpointNotReady: '该接口未就绪',
        endpointNotReadyHint: 'Host 半端还没提供这个接口（可能是版本较旧）。其余功能不受影响。',
        retryLoad: '重新读取',

        /* ── 依赖：说明与操作 ── */
        depsNote:
          '这些是可选的执行器。不装也能用（内置 llm 执行器 + dsh 执行器），装了能多几种干活的「手」。',
        depsSection: '可选 Agent 依赖',
        depsLoading: '正在读取依赖列表…',
        depsRecheck: '重新检查',
        depsChecking: '检查中…',
        depsEmpty: '后端没有返回任何依赖项。',
        depsFailed: '读取依赖列表失败',
        depsNotReady: '依赖接口未就绪',
        depNotInstalled: '未安装',
        depRequired: '必需',
        depFallbackPrefix: '卸载后：',
        versionsTruncated: '后端只回了最近 {n} 个版本（共 {t} 个），这段里没有低于当前的；要降级得让后端返回更早的版本。',
        depPurposeFallback: '（后端没给用途说明）',
        currentVersion: '当前',
        latestVersion: '最新',
        versionsAvailable: '可选版本',
        noLowerVersions: '没有更低的版本可选',
        actionInstall: '安装',
        actionUpdate: '更新',
        actionDowngrade: '降级',
        actionUninstall: '卸载',
        actionEnable: '启用',
        actionDisable: '停用',
        confirmUninstall: '确认卸载？',
        alreadyInstalledHint: '已经装了；要换版本用「更新」或「降级」',
        noUpdateHint: '已经是最新版本（或后端没给最新版本号）',
        notInstalledHint: '还没装，先点「安装」',
        workingOn: '{action}中…',
        resultDone: '完成',
        resultFailed: '失败',
        versionArrow: '{a} → {b}',

        /* ── 版本 ── */
        versionSection: 'HIVE 插件版本',
        versionLoading: '正在读取版本信息…',
        versionNotReady: '版本接口未就绪',
        versionFailed: '版本操作失败',
        checkUpdate: '检查更新',
        updateNow: '更新',
        hasUpdateBadge: '有可用更新',
        noUpdateBadge: '已是最新',
        enablePlugin: '启用',
        disablePlugin: '停用',
        reloadHint: '插件版本变了以后，建议刷新整个页面（Ctrl+R）让新的客户端代码生效。',
        versionErrorHint: '后端报了错误，下面原文照录；版本相关按钮已禁用，避免瞎猜版本号。',
        unremovableHint: '宿主说这个插件不可卸载（read-only / 本地 link 安装），所以按钮禁用。',
      },
      en: {
        title: 'HIVE',
        subtitle: 'Proactive service',
        frameTitle: 'HIVE dashboard',

        statusLoading: 'Checking…',
        statusReady: 'Healthy',
        statusDegraded: 'Degraded',
        statusError: 'Down',
        statusUninit: 'Not initialized',
        statusTab: 'Status',

        btnStart: 'Start',
        btnStop: 'Stop',
        btnStopConfirm: 'Confirm stop?',
        btnScan: 'Scan now',
        btnDoctor: 'Doctor',
        btnRefresh: 'Refresh',
        working: 'Working…',

        close: 'Close',
        retry: 'Retry',
        stillOpen: 'Open dashboard anyway',

        started: 'Started',
        startFailed: 'Start failed',
        stopped: 'Stopped',
        stopFailed: 'Stop failed',
        stopConfirm: 'Click “Confirm stop?” again within 6s to really stop.',
        scanStarted: 'Scan triggered',
        scanFailed: 'Scan failed',
        refreshFailed: 'Refresh failed',
        refreshed: 'Refreshed',
        healthFailed: 'Cannot read service status',

        doctorTitle: 'Environment check',
        doctorLoading: 'Probing (may take a few seconds)…',
        doctorDone: 'Check complete',
        doctorFailed: 'Check failed',
        rerunDoctor: 'Re-check',
        oneKeyInstall: 'Install all missing',
        nothingToInstall: 'Nothing installable is missing',
        install: 'Install',
        installRunning: 'Installing…',
        installDone: 'Installed',
        installFailed: 'Install failed',
        installNeedManual: 'Manual install required',
        installGuide: 'Manual steps',
        fixHint: 'Suggested fix',
        levelPass: 'PASS',
        levelWarn: 'WARN',
        levelFail: 'FAIL',
        levelUnknown: 'UNKNOWN',
        emptyRows: 'No check items returned.',
        endpointLabel: 'Endpoint',
        checkedAt: 'Checked at',
        summaryLabel: 'Result',

        guideTitle: 'HIVE is not connected yet',
        guideReason: 'Reason',
        guideReasonEmpty: 'The backend did not answer (plugin may still be booting, or the engine is down).',
        guideStep1: '① Check: Node, database, executors and external channels',
        guideStep2: '② (Optional) Install missing dependencies: only CLI tools that fail detection',
        guideStep3: '③ Start: bring the scheduler engine up and load the dashboard',
        oneKeyStart: 'One-click start',
        oneKeyWorking: 'Walking through ①→②→③…',
        oneKeyNeedsInstall: 'Found {n} installable missing dependencies — listed in the drawer; click “Install all missing”.',
        oneKeyStarted: 'Check passed, scheduler engine started',

        pendingApprovals: 'Approvals',
        runningTasks: 'Running',
        inboxCount: 'Inbox',
        barHint: 'Every action reports back; failure reasons show in the strip below.',
        notePrefix: 'Note',
        tipBody: 'Shortcuts above; the iframe below is the full dashboard over the same data.',
        statusUnknownDetail: 'Status unknown — run “Doctor” to see which check failed.',

        /* ── drawer: three tabs ── */
        btnDeps: 'Agent deps',
        btnVersion: 'Version',
        tabDoctor: 'Check',
        tabDeps: 'Deps',
        tabVersion: 'Version',
        drawerTitle: 'HIVE settings',
        endpointNotReady: 'Endpoint not ready',
        endpointNotReadyHint: 'The host half does not serve this endpoint yet (older build). Everything else still works.',
        retryLoad: 'Reload',

        /* ── deps ── */
        depsNote:
          'These are optional executors. HIVE works without them (built-in llm executor + dsh executor); installing them just gives it a few more hands.',
        depsSection: 'Optional agent CLIs',
        depsLoading: 'Loading dependency list…',
        depsRecheck: 'Re-check',
        depsChecking: 'Checking…',
        depsEmpty: 'The backend returned no dependencies.',
        depsFailed: 'Failed to load dependencies',
        depsNotReady: 'Dependency endpoint not ready',
        depNotInstalled: 'not installed',
        depRequired: 'required',
        depFallbackPrefix: 'If removed: ',
        versionsTruncated: 'Backend returned only the newest {n} versions ({t} total); none is lower than current. Downgrade needs older versions from the backend.',
        depPurposeFallback: '(no description provided)',
        currentVersion: 'current',
        latestVersion: 'latest',
        versionsAvailable: 'versions',
        noLowerVersions: 'No lower version available',
        actionInstall: 'Install',
        actionUpdate: 'Update',
        actionDowngrade: 'Downgrade',
        actionUninstall: 'Uninstall',
        actionEnable: 'Enable',
        actionDisable: 'Disable',
        confirmUninstall: 'Confirm uninstall?',
        alreadyInstalledHint: 'Already installed — use Update or Downgrade to change version',
        noUpdateHint: 'Already the latest (or backend gave no latest version)',
        notInstalledHint: 'Not installed yet — click Install',
        workingOn: '{action}…',
        resultDone: 'done',
        resultFailed: 'failed',
        versionArrow: '{a} → {b}',

        /* ── version ── */
        versionSection: 'HIVE plugin version',
        versionLoading: 'Loading version info…',
        versionNotReady: 'Version endpoint not ready',
        versionFailed: 'Version action failed',
        checkUpdate: 'Check for updates',
        updateNow: 'Update',
        hasUpdateBadge: 'Update available',
        noUpdateBadge: 'Up to date',
        enablePlugin: 'Enable',
        disablePlugin: 'Disable',
        reloadHint: 'After the plugin version changes, reload the page (Ctrl+R) so the new client bundle takes effect.',
        versionErrorHint: 'The backend reported an error (quoted below). Version buttons are disabled so no version is invented.',
        unremovableHint: 'The host says this bundle is not removable (read-only / local link install), so the button is disabled.',
      },
    }

    /* ───────────────────────────── 样式 ───────────────────────────── */
    // 全部选择器都挂在 [data-hive-*] 上，绝不碰宿主的全局标签/类名。
    // 面板内部允许深色；颜色在 var(--dsw-alias-*) 上取，取不到时用后面的兜底值。

    const CSS = [
      // 骨架：铺满宿主主区，列布局（控制条 48 + iframe 其余），深色底
      '[data-hive-page]{position:relative;display:flex;flex-direction:column;height:100%;min-height:220px;box-sizing:border-box;background:#0f0f12;color:#e9eaee;overflow:hidden;font-family:inherit;}',

      // ── 顶部控制条：固定 48px，横排可滚动（窄到 400px 也不换行）──
      '[data-hive-bar]{flex:0 0 48px;height:48px;box-sizing:border-box;display:flex;align-items:center;gap:10px;padding:0 10px;',
      '  background:linear-gradient(180deg,#1a1b21,#111216);border-bottom:1px solid #272931;',
      '  overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;scrollbar-color:#3a3d46 transparent;}',
      '[data-hive-bar]::-webkit-scrollbar{height:6px;}',
      '[data-hive-bar]::-webkit-scrollbar-thumb{background:#3a3d46;border-radius:3px;}',
      '[data-hive-brand]{display:flex;align-items:center;gap:7px;flex:0 0 auto;min-width:0;}',
      '[data-hive-dot]{width:8px;height:8px;border-radius:50%;flex:none;background:#8a8f98;box-shadow:0 0 0 3px rgba(138,143,152,.16);}',
      '[data-hive-dot][data-phase="loading"]{background:#8a8f98;animation:hive-pulse 1.4s ease-in-out infinite;}',
      '[data-hive-dot][data-phase="ready"]{background:#35c46a;box-shadow:0 0 0 3px rgba(53,196,106,.18);}',
      '[data-hive-dot][data-phase="degraded"]{background:#f0b429;box-shadow:0 0 0 3px rgba(240,180,41,.18);}',
      '[data-hive-dot][data-phase="error"]{background:#ef4f4f;box-shadow:0 0 0 3px rgba(239,79,79,.18);}',
      '[data-hive-dot][data-phase="uninit"]{background:#ef4f4f;box-shadow:0 0 0 3px rgba(239,79,79,.18);}',
      '@keyframes hive-pulse{0%,100%{opacity:1;}50%{opacity:.35;}}',
      '[data-hive-name]{font-size:13px;font-weight:700;letter-spacing:.06em;color:#f4f0e6;white-space:nowrap;}',
      '[data-hive-sub]{font-size:11px;color:#9aa0aa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:132px;}',
      '[data-hive-counts]{flex:0 0 auto;font-size:11px;line-height:18px;padding:1px 8px;border-radius:999px;border:1px solid #343742;color:#c3c7d0;white-space:nowrap;font-variant-numeric:tabular-nums;}',
      '[data-hive-actions]{display:flex;align-items:center;gap:6px;flex:0 0 auto;margin-left:auto;}',

      // ── 按钮 ──
      '[data-hive-btn]{appearance:none;flex:0 0 auto;border:1px solid #3a3d46;background:#1c1e25;color:#dfe2e8;font:inherit;font-size:12px;line-height:24px;padding:0 10px;border-radius:7px;cursor:pointer;white-space:nowrap;transition:background .12s,border-color .12s,transform .06s;}',
      '[data-hive-btn]:hover:not([disabled]){background:#262932;border-color:#4a4e59;}',
      '[data-hive-btn]:active:not([disabled]){transform:translateY(1px);}',
      '[data-hive-btn]:focus-visible{outline:2px solid #ffb648;outline-offset:1px;}',
      '[data-hive-btn][data-primary]{background:linear-gradient(180deg,#ffb648,#f2701f);border-color:transparent;color:#221302;font-weight:600;}',
      '[data-hive-btn][data-primary]:hover:not([disabled]){filter:brightness(1.07);background:linear-gradient(180deg,#ffc266,#f57a2a);}',
      '[data-hive-btn][data-danger]{border-color:#ef4f4f;color:#ff8f8f;background:#2a1517;}',
      '[data-hive-btn][data-mini]{line-height:20px;font-size:11px;padding:0 8px;border-radius:6px;}',
      '[data-hive-btn][disabled]{opacity:.45;cursor:default;}',
      '[data-hive-btn][data-busy="1"]{opacity:1;border-color:#ffb648;color:#ffcf7a;}',

      // ── 看板 iframe：高度严格 = 100% - 48px（控制条固定 48）──
      '[data-hive-frame]{display:block;flex:0 0 auto;width:100%;height:calc(100% - 48px);border:0;background:#0f0f12;}',

      // ── 提示条（浮在 iframe 顶部，不占布局，避免破坏 48px 的算术）──
      '[data-hive-toast]{position:absolute;left:10px;right:10px;top:56px;z-index:30;display:flex;align-items:flex-start;gap:8px;padding:7px 10px;border-radius:8px;font-size:12px;line-height:1.6;color:#c9ced8;background:#1b1d23;border:1px solid #343742;box-shadow:0 6px 18px rgba(0,0,0,.45);}',
      '[data-hive-toast][data-tone="good"]{border-color:#2f7f4f;color:#8fe3ac;}',
      '[data-hive-toast][data-tone="bad"]{border-color:#8c3a3a;color:#ffa3a3;}',
      '[data-hive-toast][data-tone="info"]{border-color:#4a5a86;color:#b8c8ef;}',
      '[data-hive-toast-text]{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;white-space:pre-wrap;}',
      '[data-hive-toast-x]{flex:none;appearance:none;border:0;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;opacity:.7;padding:0 2px;}',
      '[data-hive-toast-x]:hover{opacity:1;}',

      // ── 引导卡片（后端没接上时）──
      '[data-hive-guide]{position:absolute;inset:48px 0 0 0;z-index:25;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(9,10,13,.92);overflow:auto;}',
      '[data-hive-guide-card]{width:min(460px,100%);max-height:100%;overflow:auto;box-sizing:border-box;padding:18px 18px 16px;border-radius:14px;background:#16181e;border:1px solid #2e313a;box-shadow:0 14px 40px rgba(0,0,0,.5);}',
      '[data-hive-guide-title]{font-size:15px;font-weight:700;color:#f4f0e6;margin-bottom:8px;}',
      '[data-hive-guide-reason]{font-size:12px;line-height:1.7;color:#9aa0aa;margin-bottom:12px;overflow-wrap:anywhere;}',
      '[data-hive-guide-steps]{margin:0 0 14px;padding-left:18px;font-size:12.5px;line-height:1.9;color:#cfd3db;}',
      '[data-hive-guide-steps] li{margin-bottom:2px;}',
      '[data-hive-guide-actions]{display:flex;flex-wrap:wrap;gap:8px;}',

      // ── 抽屉（自检 / 安装）── 覆盖层，非 iframe
      '[data-hive-drawer]{position:absolute;inset:48px 0 0 0;z-index:40;display:flex;justify-content:flex-end;}',
      '[data-hive-drawer-veil]{position:absolute;inset:0;background:rgba(6,7,9,.55);}',
      '[data-hive-drawer-panel]{position:relative;display:flex;flex-direction:column;width:min(560px,100%);height:100%;box-sizing:border-box;background:#14161b;border-left:1px solid #2b2e37;box-shadow:-14px 0 40px rgba(0,0,0,.5);}',
      '[data-hive-drawer-head]{flex:none;display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #262931;background:#181a20;}',
      '[data-hive-drawer-title]{flex:1 1 auto;font-size:13px;font-weight:650;color:#f0ece2;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '[data-hive-drawer-body]{flex:1 1 auto;min-height:0;overflow:auto;padding:10px 12px 14px;display:flex;flex-direction:column;gap:8px;}',
      '[data-hive-drawer-foot]{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 12px;border-top:1px solid #262931;background:#181a20;}',

      // ── 抽屉内的横向标签（自检 / 依赖 / 版本）──
      '[data-hive-tabs]{flex:none;display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid #262931;background:#16181e;overflow-x:auto;scrollbar-width:thin;}',
      '[data-hive-tab]{appearance:none;flex:0 0 auto;border:1px solid #343742;background:transparent;color:#aab0bb;font:inherit;font-size:12px;line-height:22px;padding:0 12px;border-radius:999px;cursor:pointer;white-space:nowrap;}',
      '[data-hive-tab]:hover{background:#22252d;color:#dfe2e8;}',
      '[data-hive-tab][data-active]{background:rgba(255,182,72,.14);border-color:#ffb648;color:#ffcf7a;font-weight:600;}',
      '[data-hive-tab][data-badge]::after{content:attr(data-badge);margin-left:5px;font-size:10px;opacity:.85;}',

      // ── 依赖卡片 ──
      '[data-hive-note-box]{padding:8px 10px;border-radius:8px;font-size:11.5px;line-height:1.7;color:#c8d2e6;background:#171c26;border:1px solid #2c3a52;overflow-wrap:anywhere;}',
      '[data-hive-drawer-note]{margin:8px 12px 0;}',
      '[data-hive-section-title]{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:650;color:#dfe3ea;margin-top:2px;}',
      '[data-hive-dep]{display:flex;flex-direction:column;gap:6px;padding:9px 10px;border-radius:9px;background:#191b21;border:1px solid #262931;}',
      '[data-hive-dep][data-installed="0"]{border-style:dashed;}',
      '[data-hive-dep-head]{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;min-width:0;}',
      '[data-hive-dep-name]{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;color:#e6e9ef;overflow-wrap:anywhere;min-width:0;}',
      '[data-hive-tag]{font-size:10px;line-height:16px;padding:0 6px;border-radius:999px;border:1px solid #4a4e59;color:#9aa0aa;font-weight:400;}',
      '[data-hive-dep-ver]{margin-left:auto;font-size:11px;color:#9aa0aa;font-variant-numeric:tabular-nums;white-space:nowrap;}',
      '[data-hive-dep-use]{font-size:11.5px;line-height:1.65;color:#a7adb8;overflow-wrap:anywhere;}',
      '[data-hive-dep-actions]{display:flex;flex-wrap:wrap;align-items:center;gap:6px;}',
      '[data-hive-versions]{display:flex;flex-wrap:wrap;gap:6px;padding:6px 0 2px;}',
      '[data-hive-ver-btn]{appearance:none;border:1px solid #3a3d46;background:#101216;color:#c9ced8;font:inherit;font-size:11px;line-height:20px;padding:0 9px;border-radius:6px;cursor:pointer;font-variant-numeric:tabular-nums;}',
      '[data-hive-ver-btn]:hover:not([disabled]){border-color:#ffb648;color:#ffcf7a;}',
      '[data-hive-ver-btn][disabled]{opacity:.45;cursor:default;}',
      '[data-hive-ver-badge]{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;line-height:18px;padding:0 7px;border-radius:999px;border:1px solid currentColor;}',
      '[data-hive-ver-badge][data-kind="update"]{color:#f0b429;}',
      '[data-hive-ver-badge][data-kind="latest"]{color:#5fd08a;}',

      // 汇总芯片
      '[data-hive-summary]{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:11px;color:#9aa0aa;}',
      '[data-hive-chip]{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:999px;border:1px solid currentColor;line-height:18px;font-variant-numeric:tabular-nums;}',
      '[data-hive-chip][data-level="pass"]{color:#5fd08a;}',
      '[data-hive-chip][data-level="warn"]{color:#f0b429;}',
      '[data-hive-chip][data-level="fail"]{color:#ef6a6a;}',
      '[data-hive-chip][data-level="unknown"]{color:#8a8f98;}',

      // 检查项：两列（名称/详情 + 等级/安装），窄栏自动变一列
      '[data-hive-check]{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 10px;padding:9px 10px;border-radius:9px;background:#191b21;border:1px solid #262931;}',
      '[data-hive-check][data-level="fail"]{border-color:#5c2b2b;background:#1e1719;}',
      '[data-hive-check][data-level="warn"]{border-color:#5b4a1f;background:#1e1c15;}',
      '[data-hive-check-main]{min-width:0;display:flex;flex-direction:column;gap:3px;}',
      '[data-hive-check-name]{font-size:12.5px;font-weight:600;color:#e6e9ef;overflow-wrap:anywhere;}',
      '[data-hive-check-detail]{font-size:11.5px;line-height:1.6;color:#9aa0aa;overflow-wrap:anywhere;white-space:pre-wrap;}',
      '[data-hive-check-fix]{font-size:11.5px;line-height:1.6;color:#d8b46a;overflow-wrap:anywhere;}',
      '[data-hive-check-side]{display:flex;align-items:center;gap:6px;flex:none;flex-wrap:wrap;justify-content:flex-end;}',
      '[data-hive-level]{font-size:10.5px;font-weight:700;letter-spacing:.04em;line-height:18px;padding:0 7px;border-radius:5px;border:1px solid currentColor;color:#8a8f98;}',
      '[data-hive-level][data-level="pass"]{color:#5fd08a;}',
      '[data-hive-level][data-level="warn"]{color:#f0b429;}',
      '[data-hive-level][data-level="fail"]{color:#ef6a6a;}',
      '[data-hive-install]{margin:0;font-size:11px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;padding:6px 8px;border-radius:6px;background:#101216;border:1px solid #262931;color:#a9b0bd;}',
      '[data-hive-install][data-state="fail"]{border-color:#5c2b2b;color:#ffa3a3;}',
      '[data-hive-install][data-state="done"]{border-color:#2f7f4f;color:#9fe0b6;}',

      '[data-hive-empty]{padding:14px 10px;font-size:12px;line-height:1.7;color:#9aa0aa;}',
      '[data-hive-error]{padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.65;color:#ffa3a3;background:#1e1719;border:1px solid #5c2b2b;overflow-wrap:anywhere;}',
      '[data-hive-note]{font-size:11px;line-height:1.6;color:#8a8f98;overflow-wrap:anywhere;min-width:0;}',
      '[data-hive-grow]{flex:1 1 auto;min-width:0;}',

      // 窄屏（手机上侧栏变抽屉、主区满宽）时再收紧一点
      '@media (max-width:560px){',
      '  [data-hive-bar]{gap:7px;padding:0 8px;}',
      '  [data-hive-sub]{display:none;}',
      '  [data-hive-counts]{display:none;}',
      '  [data-hive-btn]{font-size:11.5px;padding:0 8px;}',
      '  [data-hive-check]{grid-template-columns:minmax(0,1fr);}',
      '  [data-hive-check-side]{justify-content:flex-start;}',
      '}',
    ].join('\n')

    /* ───────────────────────────── 小工具 ───────────────────────────── */

    /** 把任意异常压成一行可读文本（绝不返回空串）。 */
    function short(err) {
      if (!err) return '未知错误'
      const msg = err && err.message ? err.message : String(err)
      return msg.length > 300 ? msg.slice(0, 300) + '…' : msg
    }

    /** 任意值转可读字符串；空值返回 ''。 */
    function str(v) {
      if (v === null || v === undefined || v === false) return ''
      if (typeof v === 'string') return v
      if (typeof v === 'number' || typeof v === 'boolean') return String(v)
      if (Array.isArray(v)) return v.map(str).filter(Boolean).join(' · ')
      try {
        return JSON.stringify(v).slice(0, 400)
      } catch {
        return String(v)
      }
    }

    /** 取数字：数字直接用，数组用长度，其他 null。 */
    function numOf(v) {
      if (typeof v === 'number' && Number.isFinite(v)) return v
      if (Array.isArray(v)) return v.length
      if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v)
      return null
    }

    /** id 兜底：没有 id 时从名字生成一个稳定 slug，避免 key 重复。 */
    function slug(v) {
      return String(v || 'row')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'row'
    }

    /**
     * 同源请求封装。**永不抛**，永远返回 { ok, status, data, error }：
     *   ok     —— HTTP 2xx 且返回体是 JSON
     *   status —— HTTP 状态码；网络失败为 0
     *   data   —— 解析后的 JSON（解析失败为 null）
     *   error  —— 人话原因（网络异常 / HTTP 4xx-5xx + 后端 error 字段 / 非 JSON 响应）
     */
    async function request(path, options = {}) {
      const init = { credentials: 'same-origin', cache: 'no-store', method: options.method || 'GET' }
      if (options.body !== undefined) {
        init.headers = { 'content-type': 'application/json' }
        try {
          init.body = JSON.stringify(options.body)
        } catch (e) {
          return { ok: false, status: 0, data: null, error: '请求体无法序列化：' + short(e) }
        }
      }

      let res
      try {
        res = await fetch(API + path, init)
      } catch (e) {
        // 常见于后端没起来 / 被浏览器拦掉（同一源一般不会 CORS，但代理/离线会）
        return { ok: false, status: 0, data: null, error: '请求没发出去：' + short(e) }
      }

      let text = ''
      try {
        text = await res.text()
      } catch (e) {
        return { ok: false, status: res.status, data: null, error: '读响应失败：' + short(e) }
      }

      let data = null
      if (text) {
        try {
          data = JSON.parse(text)
        } catch {
          data = null
        }
      }

      if (!res.ok) {
        const back = data && (data.error || data.message || data.reason)
        return {
          ok: false,
          status: res.status,
          data: data,
          error: 'HTTP ' + res.status + (back ? '：' + str(back) : text ? '：' + text.slice(0, 200) : ''),
        }
      }
      if (text && data === null) {
        return {
          ok: false,
          status: res.status,
          data: null,
          error: '返回不是 JSON（可能是看板页面/网关错误页）：' + text.slice(0, 160).replace(/\s+/g, ' '),
        }
      }
      return { ok: true, status: res.status, data: data, error: '' }
    }

    /* ─────────────────── 自检结果归一化（防白屏核心） ─────────────────── */

    const LEVEL_PASS = 'pass'
    const LEVEL_WARN = 'warn'
    const LEVEL_FAIL = 'fail'
    const LEVEL_UNKNOWN = 'unknown'

    /** 各种后端的等级写法 → 统一的 pass / warn / fail / unknown。 */
    function normLevel(v) {
      const s = String(v === undefined || v === null ? '' : v).trim().toLowerCase()
      if (['pass', 'passed', 'ok', 'true', 'up', 'ready', 'good', 'success', 'healthy'].indexOf(s) >= 0) return LEVEL_PASS
      if (['warn', 'warning', 'degraded', 'partial', 'slow', 'notice'].indexOf(s) >= 0) return LEVEL_WARN
      if (['fail', 'failed', 'error', 'err', 'false', 'down', 'missing', 'bad', 'broken', 'unavailable'].indexOf(s) >= 0) return LEVEL_FAIL
      return LEVEL_UNKNOWN
    }

    function isPass(row) {
      return !!row && row.level === LEVEL_PASS
    }

    /** 这一项能不能点「安装」：id 在白名单里，或后端明确标了 installable。 */
    function isInstallable(raw, allowed) {
      if (!raw) return false
      const id = String(raw.id || raw.key || '')
      if (raw.installable === true) return true
      if (Array.isArray(allowed) && allowed.indexOf(id) >= 0) return true
      if (raw.manual === true) return false
      return INSTALLABLE_IDS.indexOf(id) >= 0
    }

    /**
     * 把三种可能的自检返回体归一成同一张表：
     *   A) /hive/api/setup/doctor : { items:[{id,title,status,detail,fix,installable}], summary, installable[] }
     *   B) /hive/api/plugin/doctor: { rows:[{id,name,status,detail,fix}] }
     *   C) /hive/api/doctor（旧）  : { node, db, executors, sensors, channels, budget, warnings }
     * 任何情况下都返回 { rows, summary, source, error }，不会抛、不会返回 undefined。
     */
    function normalizeDoctor(payload) {
      const out = { rows: [], summary: { pass: 0, warn: 0, fail: 0, unknown: 0, total: 0 }, raw: payload || null, error: '' }
      if (!payload || typeof payload !== 'object') {
        out.error = ''
        return out
      }

      const allowed = Array.isArray(payload.installable) ? payload.installable.map(String) : []

      const push = (id, name, level, detail, fix, installable) => {
        out.rows.push({
          id: String(id || slug(name)),
          name: String(name || '检查项'),
          level: level,
          detail: str(detail),
          fix: str(fix),
          installable: installable !== undefined ? !!installable : false,
        })
      }

      // A / B：本身就是数组（items / rows / checks / probes / results）
      let list = null
      if (Array.isArray(payload.items)) list = payload.items
      else if (Array.isArray(payload.rows)) list = payload.rows
      else if (Array.isArray(payload.checks)) list = payload.checks
      else if (Array.isArray(payload.results)) list = payload.results
      else if (Array.isArray(payload.probes)) list = payload.probes

      if (list) {
        for (const raw of list) {
          if (!raw) continue
          if (typeof raw === 'string') {
            push(slug(raw), raw, LEVEL_UNKNOWN, '', '', false)
            continue
          }
          if (typeof raw !== 'object') continue
          const name = str(raw.title || raw.name || raw.label || raw.id) || '检查项'
          const level = normLevel(
            raw.status !== undefined
              ? raw.status
              : raw.level !== undefined
                ? raw.level
                : raw.ok === true
                  ? LEVEL_PASS
                  : raw.ok === false
                    ? LEVEL_FAIL
                    : '',
          )
          push(
            raw.id || raw.key || slug(name),
            name,
            level,
            raw.detail !== undefined ? raw.detail : raw.message !== undefined ? raw.message : raw.reason,
            raw.fix !== undefined ? raw.fix : raw.hint !== undefined ? raw.hint : raw.suggestion !== undefined ? raw.suggestion : raw.guide,
            isInstallable(raw, allowed),
          )
        }
      } else {
        // C：旧嵌套结构，逐块合成
        if (payload.node && typeof payload.node === 'object') {
          const n = payload.node
          push('node', 'Node 运行时', normLevel(n.ok), [n.version, n.platform, n.arch].map(str).filter(Boolean).join(' · '), '', false)
        }
        if (payload.db && typeof payload.db === 'object') {
          const d = payload.db
          push('db', '数据库', normLevel(d.ok), d.error ? str(d.error) : d.path || '', d.ok ? '' : '检查数据目录权限', false)
        }
        if (payload.executors && typeof payload.executors === 'object') {
          const e = payload.executors
          const probes = e.probes && typeof e.probes === 'object' ? Object.entries(e.probes) : []
          const detail =
            probes.map(([k, v]) => k + '=' + (v && v.ok ? 'ok' : str((v && (v.reason || v.error)) || '未就绪'))).join(' · ') ||
            str(e.reason || '')
          push('executors', '执行器', e.ready ? LEVEL_PASS : LEVEL_WARN, detail, e.ready ? '' : '安装 dsh / pi / codex / claude 中至少一个', false)
        }
        if (payload.sensors && typeof payload.sensors === 'object') {
          const s = payload.sensors
          push('sensors', '传感器', s.ready ? LEVEL_PASS : LEVEL_WARN, str(s.reason || (Array.isArray(s.names) ? s.names.join(' · ') : '')), '', false)
        }
        if (payload.channels && typeof payload.channels === 'object') {
          for (const [k, v] of Object.entries(payload.channels)) {
            push('channel-' + k, '通道 · ' + k, v && v.ok ? LEVEL_PASS : LEVEL_WARN, str((v && (v.detail || v.reason || v.version)) || ''), '', false)
          }
        }
        if (payload.budget && typeof payload.budget === 'object') {
          const b = payload.budget
          const used = numOf(b.costCny !== undefined ? b.costCny : b.usedCny)
          const cap = numOf(b.dailyBudgetCny !== undefined ? b.dailyBudgetCny : b.limitCny)
          push('budget', '今日预算', cap !== null && used !== null && used > cap ? LEVEL_WARN : LEVEL_PASS, (used !== null ? '已用 ¥' + used.toFixed(2) : '') + (cap !== null ? ' / 上限 ¥' + cap.toFixed(2) : ''), '', false)
        }
        if (Array.isArray(payload.warnings)) {
          for (let i = 0; i < payload.warnings.length; i++) {
            const w = payload.warnings[i]
            push('warning-' + i, '告警', LEVEL_WARN, str(w), '', false)
          }
        }
      }

      // summary：后端给了就用后端的（更权威），否则按归一后的表自己数
      const s = payload.summary && typeof payload.summary === 'object' ? payload.summary : null
      if (s) {
        out.summary.pass = numOf(s.pass) ?? 0
        out.summary.warn = numOf(s.warn) ?? 0
        out.summary.fail = numOf(s.fail) ?? 0
        out.summary.unknown = numOf(s.unknown) ?? 0
        out.summary.total = numOf(s.total) ?? out.rows.length
      } else {
        for (const row of out.rows) {
          if (row.level === LEVEL_PASS) out.summary.pass++
          else if (row.level === LEVEL_WARN) out.summary.warn++
          else if (row.level === LEVEL_FAIL) out.summary.fail++
          else out.summary.unknown++
        }
        out.summary.total = out.rows.length
      }

      return out
    }

    /** 一次自检：优先新接口，逐级降级，永不抛。 */
    async function fetchDoctor() {
      const primary = await request('/setup/doctor')
      if (primary.ok) {
        const n = normalizeDoctor(primary.data)
        return { ...n, source: API + '/setup/doctor', at: Date.now() }
      }

      // 插件自有自检（只要插件挂上就一定有）
      const plugin = await request('/plugin/doctor')
      if (plugin.ok) {
        const n = normalizeDoctor(plugin.data)
        return { ...n, source: API + '/plugin/doctor', at: Date.now(), degradedFrom: primary.error }
      }

      // 最后的旧接口
      const legacy = await request('/doctor')
      if (legacy.ok) {
        const n = normalizeDoctor(legacy.data)
        return { ...n, source: API + '/doctor', at: Date.now(), degradedFrom: primary.error }
      }

      return {
        rows: [],
        summary: { pass: 0, warn: 0, fail: 0, unknown: 0, total: 0 },
        raw: null,
        source: '',
        at: Date.now(),
        error: primary.error || legacy.error || '自检接口不可用',
      }
    }

    /* ─────────────────── 版本 / 依赖（用户自己决定装不装） ─────────────────── */

    /**
     * 语义化版本比较（保守版）：只比数字段，非数字段（beta / rc / latest…）直接跳过。
     * 返回 -1 / 0 / 1。两边都没有数字段时返回 0 —— 宁可当「一样」，也不误判「有更新」。
     */
    function cmpVersion(a, b) {
      const pa = String(a === undefined || a === null ? '' : a).replace(/^v/i, '').trim()
      const pb = String(b === undefined || b === null ? '' : b).replace(/^v/i, '').trim()
      if (!pa || !pb) return 0
      const sa = pa.split(/[.+-]/)
      const sb = pb.split(/[.+-]/)
      const n = Math.max(sa.length, sb.length)
      for (let i = 0; i < n; i++) {
        const xa = sa[i] === undefined ? '0' : sa[i]
        const xb = sb[i] === undefined ? '0' : sb[i]
        if (!/^\d+$/.test(xa) || !/^\d+$/.test(xb)) continue // 非数字段不参与比较
        const na = Number(xa)
        const nb = Number(xb)
        if (na !== nb) return na < nb ? -1 : 1
      }
      return 0
    }

    /** 版本数组归一化：允许 ['1.2.3'] 或 [{version:'1.2.3'}]。 */
    function normVersionList(v) {
      if (!Array.isArray(v)) return []
      const out = []
      for (const item of v) {
        const s = typeof item === 'string' ? item : str(item && (item.version || item.tag || item.name || item.id))
        if (s && out.indexOf(s) < 0) out.push(s)
      }
      return out
    }

    /**
     * GET /hive/api/deps 的归一化：
     *   { deps|items|rows|[…] : [{ id, name|label, purpose|description, current|version,
     *                              latest, versions[], installed, installable }] }
     * 无论后端长什么样都返回 { rows, note, error }，不抛。
     */
    function normalizeDeps(payload) {
      const out = { rows: [], note: '', raw: payload || null }
      if (!payload) return out
      if (Array.isArray(payload)) {
        out.rows = payload.map((r) => normalizeDepRow(r)).filter(Boolean)
        return out
      }
      if (typeof payload !== 'object') return out
      out.note = str(payload.note || payload.message || payload.hint)
      let list = null
      for (const key of ['deps', 'dependencies', 'items', 'rows', 'list']) {
        if (Array.isArray(payload[key])) {
          list = payload[key]
          break
        }
      }
      if (!list) return out
      out.rows = list.map((r) => normalizeDepRow(r)).filter(Boolean)
      return out
    }

    function normalizeDepRow(raw) {
      if (!raw || typeof raw !== 'object') return null
      const id = str(raw.id || raw.key || raw.name || '')
      if (!id) return null
      const current = str(raw.current || raw.currentVersion || raw.installedVersion || raw.version)
      const latest = str(raw.latest || raw.latestVersion || raw.availableVersion || raw.newest)
      const versions = normVersionList(raw.versions)
      const total = numOf(raw.totalVersions !== undefined ? raw.totalVersions : raw.versionCount)
      return {
        id: id,
        name: str(raw.label || raw.title || raw.name || id),
        purpose: str(raw.purpose || raw.description || raw.desc || raw.use || raw.usage || raw.note),
        // 「卸载/缺失会怎样」—— 后端给了就照抄，不自己编后果
        fallback: str(raw.fallback || raw.ifRemoved || raw.consequence),
        required: raw.required === true,
        current: current,
        latest: latest,
        versions: versions,
        // 后端常常只回最近 N 个版本；用 totalVersions 判断是否被截断，好如实提示
        totalVersions: total === null ? versions.length : total,
        versionSource: str(raw.versionSource || raw.source || ''),
        // 没给 installed 字段时：有当前版本就当作已装
        installed: raw.installed === undefined ? Boolean(current) : raw.installed === true,
        installable: raw.installable !== false,
        uninstallable: raw.uninstallable !== false && raw.canUninstall !== false,
        error: str(raw.error || raw.reason),
        raw: raw,
      }
    }

    /**
     * GET /hive/api/plugin/version 的归一化——**只用后端给的版本号，绝不自己编**。
     * 兼容两种真实形态：
     *   A) 扁平：{ current:'0.1.0', latest:'0.2.0', hasUpdate, versions:[], error }
     *   B) Host 现在的：{ current:{version,name,enabled,removable,installKind,…}, latest,
     *                     hasUpdate, canDowngrade, downgradeTargets:[{version}], versions:[{version}], error, hint }
     */
    function normalizeVersion(payload) {
      const out = {
        ok: false,
        current: '',
        name: '',
        latest: '',
        versions: [],
        downgradeTargets: [],
        hasUpdate: false,
        canDowngrade: false,
        enabled: undefined,
        removable: undefined,
        installKind: '',
        hint: '',
        error: '',
        note: '',
        raw: payload || null,
      }
      if (!payload || typeof payload !== 'object') {
        out.error = '版本接口返回空'
        return out
      }
      out.ok = payload.ok !== false

      const curObj = payload.current && typeof payload.current === 'object' ? payload.current : null
      out.current = curObj
        ? str(curObj.version || curObj.manifestVersion || curObj.bundleVersion)
        : str(payload.current || payload.currentVersion || payload.version || payload.installed)
      out.name = curObj ? str(curObj.name) : ''
      out.installKind = curObj ? str(curObj.installKind) : str(payload.installKind)
      out.latest = str(payload.latest || payload.latestVersion || payload.available || payload.newest)
      out.versions = normVersionList(payload.versions)
      // Host 会直接把「可降级目标」算好（downgradeTargets），优先用它
      out.downgradeTargets = normVersionList(payload.downgradeTargets)
      out.hasUpdate =
        typeof payload.hasUpdate === 'boolean'
          ? payload.hasUpdate
          : Boolean(out.current && out.latest && cmpVersion(out.latest, out.current) > 0)
      out.canDowngrade =
        typeof payload.canDowngrade === 'boolean'
          ? payload.canDowngrade
          : out.downgradeTargets.length > 0

      const enabled = curObj && typeof curObj.enabled === 'boolean' ? curObj.enabled : payload.enabled
      if (typeof enabled === 'boolean') out.enabled = enabled
      const removable = curObj && typeof curObj.removable === 'boolean' ? curObj.removable : payload.removable
      if (typeof removable === 'boolean') out.removable = removable

      out.hint = str(payload.hint)
      out.error = str(payload.error || payload.reason)
      out.note = str(payload.note || payload.message)
      return out
    }

    /** 低于当前版本的版本列表（降级用），从高到低。 */
    function lowerVersions(versions, current) {
      if (!Array.isArray(versions) || !current) return []
      return versions
        .filter((v) => cmpVersion(v, current) < 0)
        .sort((a, b) => cmpVersion(b, a))
    }

    /** 降级候选：优先用后端算好的 downgradeTargets，再兜底从 versions 里筛。 */
    function downgradeOptions(v) {
      if (!v) return []
      const fromTargets = lowerVersions(v.downgradeTargets, v.current)
      if (fromTargets.length) return fromTargets
      return lowerVersions(v.versions, v.current)
    }

    /* ─────────────────── 状态判定（插件 + 引擎双源） ─────────────────── */

    /**
     * 综合 /plugin/status 与 /health 判断面板状态：
     *   ready    —— 插件在、引擎健康
     *   degraded —— 插件在，但引擎报错 / 模型没就绪 / 巡检停摆
     *   uninit   —— 插件在，但还没初始化完（phase 不是 ready）
     *   error    —— 插件后端根本不通（最常见：DSH 刚启动，路由还没注册）
     */
    function readPhase(pluginRes, healthRes) {
      if (!pluginRes.ok) {
        const st = pluginRes.status
        const why =
          st === 404
            ? '插件接口 404：Host 半端还没挂上 /hive 路由（DSH 重启后插件会自动挂载）'
            : pluginRes.error || '插件接口不可用'
        return { phase: 'error', reason: why, plugin: null, health: null }
      }

      const p = pluginRes.data && typeof pluginRes.data === 'object' ? pluginRes.data : {}
      const health = healthRes && healthRes.ok && healthRes.data && typeof healthRes.data === 'object' ? healthRes.data : null

      if (p.phase === 'error') {
        return { phase: 'error', reason: str(p.error) || '插件启动失败', plugin: p, health: health }
      }
      if (p.phase && p.phase !== 'ready') {
        return { phase: 'uninit', reason: '插件状态：' + str(p.phase), plugin: p, health: health }
      }
      if (!health) {
        const why = healthRes && healthRes.error ? healthRes.error : '引擎健康接口没有返回'
        return { phase: 'degraded', reason: '看板接口没通：' + why, plugin: p, health: null }
      }
      if (health.ok === false) {
        return { phase: 'degraded', reason: str(health.error) || '引擎自报不健康（db 或执行器有问题）', plugin: p, health: health }
      }

      const model = p.model && typeof p.model === 'object' ? p.model : null
      if (model && model.ready === false) {
        return { phase: 'degraded', reason: 'LLM 通道没就绪：' + (str(model.error) || '在 DSH 设置里配一个模型'), plugin: p, health: health }
      }

      return { phase: 'ready', reason: '', plugin: p, health: health }
    }

    /** 从 overview 里挑出「待办 / 待拍板 / 在跑」三个数，缺一个就跳过。 */
    function pickCounts(overview) {
      const out = { inbox: null, approvals: null, running: null }
      if (!overview || typeof overview !== 'object') return out

      const groups = [overview.counts, overview.stats, overview.summary, overview].filter((g) => g && typeof g === 'object')
      const take = (keys, field) => {
        for (const g of groups) {
          for (const k of keys) {
            const v = numOf(g[k])
            if (v !== null) {
              out[field] = v
              return
            }
          }
        }
      }
      take(['inbox', 'inboxCount', 'items'], 'inbox')
      take(['outbox', 'pendingApprovals', 'approvals'], 'approvals')
      take(['running', 'runningTasks', 'runningCount'], 'running')
      return out
    }

    /* ───────────────────────────── 侧栏图标 ───────────────────────────── */

    // 每个实例一个渐变 id，避免多个 <defs> 撞 id
    let iconSeq = 0

    const HEX_OUTER = 'M12 2.5 L20.23 7.25 L20.23 16.75 L12 21.5 L3.77 16.75 L3.77 7.25 Z'
    const HEX_INNER = 'M12 7.1 L16.24 9.55 L16.24 14.45 L12 16.9 L7.76 14.45 L7.76 9.55 Z'

    /**
     * 六边形蜂巢图标（amber #ffb648 → #f2701f 渐变）。
     * props: { size:number, active:boolean } —— active 时加一圈高亮描边。
     * 纯内联 SVG，不依赖任何外部图片。
     */
    function HiveIcon(props) {
      const size = Number(props && props.size) || 20
      const active = Boolean(props && props.active)
      const gid = 'hive-hex-' + ++iconSeq

      const children = [
        h(
          'defs',
          { key: 'defs' },
          h(
            'linearGradient',
            { id: gid, x1: '0', y1: '0', x2: '1', y2: '1' },
            h('stop', { offset: '0%', stopColor: '#ffb648' }),
            h('stop', { offset: '100%', stopColor: '#f2701f' }),
          ),
        ),
        // 外壳：active 时描边 = 渐变；不 active 时只留细描边，保持安静
        h('path', {
          key: 'outer',
          d: HEX_OUTER,
          fill: active ? 'url(#' + gid + ')' : 'none',
          stroke: 'url(#' + gid + ')',
          strokeWidth: active ? 0 : 1.7,
          strokeLinejoin: 'round',
        }),
        // 内部小六边形（蜂室）
        h('path', {
          key: 'inner',
          d: HEX_INNER,
          fill: 'none',
          stroke: active ? '#2a1602' : 'url(#' + gid + ')',
          strokeWidth: active ? 1.3 : 1.2,
          strokeLinejoin: 'round',
          opacity: active ? 0.85 : 0.95,
        }),
      ]

      // active：外圈高亮描边（这一条只在 active 时渲染 —— 也是自检脚本的断言点）
      if (active) {
        children.push(
          h('path', {
            key: 'ring',
            d: HEX_OUTER,
            fill: 'none',
            stroke: '#ffcf7a',
            strokeWidth: 2.1,
            strokeLinejoin: 'round',
            opacity: 0.95,
          }),
        )
      }

      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          'aria-hidden': true,
          focusable: false,
          style: { display: 'block' },
        },
        children,
      )
    }

    /* ───────────────────────────── 主面板 ───────────────────────────── */

    /**
     * makePanel(t) —— 用文案函数 t 造出面板组件（注册时传 t，组件里不必再管语言）。
     * 只用 useState / useEffect / useRef；所有子块都是普通渲染函数（不是子组件），
     * 这样 hook 顺序恒定，也不会因为子组件重挂丢状态。
     */
    function makePanel(t) {
      /** 小工具：带占位符的文案 —— tf('oneKeyNeedsInstall', { n: 2 }) */
      const tf = (key, vars) => {
        let s = t(key)
        for (const k of Object.keys(vars || {})) s = s.split('{' + k + '}').join(String(vars[k]))
        return s
      }

      const levelText = (level) =>
        level === LEVEL_PASS
          ? t('levelPass')
          : level === LEVEL_WARN
            ? t('levelWarn')
            : level === LEVEL_FAIL
              ? t('levelFail')
              : t('levelUnknown')

      return function HivePanel() {
        /* ── 状态：初始值取上次挂载的读数，切面板回来不闪 loading ── */
        const [phase, setPhase] = React.useState(LAST.phase)
        const [reason, setReason] = React.useState(LAST.reason)
        const [detail, setDetail] = React.useState(LAST.detail) // 弹窗里的补充：engine / model
        const [counts, setCounts] = React.useState(LAST.counts)
        const [busy, setBusy] = React.useState('') // 正在跑的按钮 tag
        const [toast, setToast] = React.useState(null) // { tone, text }

        /* 抽屉：一个抽屉 + 三个标签（自检 / 依赖 / 版本），不再开三个抽屉 */
        const [drawerOpen, setDrawerOpen] = React.useState(false)
        const [tab, setTab] = React.useState('doctor') // 'doctor' | 'deps' | 'version'

        /* 标签 1：环境自检 */
        const [doctor, setDoctor] = React.useState(null)
        const [doctorBusy, setDoctorBusy] = React.useState(false)
        const [installLog, setInstallLog] = React.useState({}) // { [id]: { state, text, at } }
        const [installBusy, setInstallBusy] = React.useState(false)

        /* 标签 2：可选 Agent 依赖（用户自己决定装/更新/降级/卸载） */
        const [deps, setDeps] = React.useState(null) // { rows, note, error, notReady, at }
        const [depsBusy, setDepsBusy] = React.useState(false)
        const [depsLog, setDepsLog] = React.useState({}) // { [id]: { state, text, at } }
        const [depAction, setDepAction] = React.useState('') // `${id}:${action}` 正在跑
        const [openVersions, setOpenVersions] = React.useState('') // 展开了版本列表的行 id

        /* 标签 3：HIVE 插件自身版本 */
        const [version, setVersion] = React.useState(null)
        const [versionBusy, setVersionBusy] = React.useState(false)
        const [versionLog, setVersionLog] = React.useState(null) // { state, text }
        const [openPluginVersions, setOpenPluginVersions] = React.useState(false)

        const [frameKey, setFrameKey] = React.useState(0)
        const [stopArmed, setStopArmed] = React.useState(false)
        const [armedKey, setArmedKey] = React.useState('') // 卸载这类破坏性操作的二次确认
        const [frameOn, setFrameOn] = React.useState(false) // 引导卡片里点「仍然打开看板」

        /* ── 引用：定时器 + 存活标记（异步回来时别写已卸载的组件）── */
        const alive = React.useRef(true)
        const toastTimer = React.useRef(0)
        const stopTimer = React.useRef(0)
        const armTimer = React.useRef(0)

        React.useEffect(() => {
          alive.current = true
          return () => {
            alive.current = false
            if (toastTimer.current) clearTimeout(toastTimer.current)
            if (stopTimer.current) clearTimeout(stopTimer.current)
            if (armTimer.current) clearTimeout(armTimer.current)
            toastTimer.current = 0
            stopTimer.current = 0
            armTimer.current = 0
          }
        }, [])

        /* ── 提示条 ── */
        const say = (tone, text) => {
          const msg = String(text === undefined || text === null ? '' : text)
          if (!msg) return
          if (toastTimer.current) clearTimeout(toastTimer.current)
          setToast({ tone: tone || 'info', text: msg })
          toastTimer.current = setTimeout(() => {
            if (alive.current) setToast(null)
          }, tone === 'bad' ? 9000 : TOAST_MS)
        }

        /* ── 读状态 ── */
        const refresh = async (opts = {}) => {
          // 失败先重试一次：切面板/系统繁忙时的偶发失败不该直接把状态点打成红色
          let pluginRes
          try {
            pluginRes = await requestRetry('/plugin/status')
          } catch (e) {
            pluginRes = { ok: false, status: 0, data: null, error: short(e) }
          }
          if (!alive.current) return
          let healthRes = { ok: false, status: 0, data: null, error: '' }
          if (pluginRes.ok) {
            try { healthRes = await requestRetry('/health') } catch { /* 保持空 */ }
          }
          if (!alive.current) return

          const read = readPhase(pluginRes, healthRes)
          setPhase(read.phase)
          setReason(read.reason)
          LAST.phase = read.phase
          LAST.reason = read.reason
          LAST.at = Date.now()

          const eng = read.plugin && read.plugin.engine && typeof read.plugin.engine === 'object' ? read.plugin.engine : null
          const mod = read.plugin && read.plugin.model && typeof read.plugin.model === 'object' ? read.plugin.model : null
          const bits = []
          if (eng) {
            const run = eng.running === true || eng.isRunning === true
            bits.push('引擎：' + (run ? '运行中' : '已停止') + (eng.pid ? '（pid ' + str(eng.pid) + '）' : ''))
          }
          if (mod) bits.push('LLM：' + (mod.ready ? '就绪' : '未就绪') + (mod.current ? '（' + str(mod.current) + '）' : ''))
          setDetail(bits.join(' · '))
          LAST.detail = bits.join(' · ')

          // 引擎没跑时，可能还在引导阶段；顺便把 overview 拉一下（拿不到也不报错）
          const ov = read.phase === 'ready' || read.phase === 'degraded' ? await request('/overview').catch(() => ({ ok: false })) : { ok: false }
          if (!alive.current) return
          const nextCounts = ov.ok ? pickCounts(ov.data) : null
          setCounts(nextCounts)
          if (nextCounts) LAST.counts = nextCounts

          if (read.phase === 'error' && !opts.silent) say('bad', t('healthFailed') + '：' + read.reason)
        }

        /* ── 初始化 + 轮询 ── */
        React.useEffect(() => {
          let stopped = false
          const run = async () => {
            if (stopped) return
            await refresh({})
          }
          run()
          const timer = setInterval(() => {
            if (stopped) return
            // 页面在后台时不用轮询，省电也省日志
            if (typeof document !== 'undefined' && document.hidden) return
            refresh({ silent: true })
          }, POLL_MS)
          return () => {
            stopped = true
            clearInterval(timer)
          }
        }, [])

        /* ── 按钮通用执行器：置 busy、抓异常、回提示 ── */
        const act = async (tag, fn) => {
          if (busy) return // 同一时刻只允许一个动作，防连点
          setBusy(tag)
          try {
            await fn()
          } catch (e) {
            if (alive.current) say('bad', short(e))
          } finally {
            if (alive.current) setBusy('')
          }
        }

        /* ── 启动 / 停止 / 巡检 ── */
        const onStart = () =>
          act('start', async () => {
            const res = await request('/control/start', { method: 'POST', body: {} })
            if (!alive.current) return
            const d = res.data && typeof res.data === 'object' ? res.data : {}
            if (!res.ok || d.ok === false) {
              // Host 会很诚实地返回 note（例如「守护进程由 DSH 插件托管」），一并显示
              say('bad', t('startFailed') + '：' + (res.error || str(d.error || d.note) || '未知原因'))
              return
            }
            const note = str(d.note || d.message || d.reason)
            say('good', t('started') + (note ? '：' + note : ''))
            setFrameKey((k) => k + 1) // 重新载入看板，避免看到旧的停止态
            await refresh({ silent: true })
          })

        const onStop = () => {
          // 两步确认：防止手滑把正在干活的引擎停掉
          if (!stopArmed) {
            setStopArmed(true)
            say('info', t('stopConfirm'))
            if (stopTimer.current) clearTimeout(stopTimer.current)
            stopTimer.current = setTimeout(() => {
              if (alive.current) setStopArmed(false)
            }, STOP_ARM_MS)
            return
          }
          setStopArmed(false)
          if (stopTimer.current) clearTimeout(stopTimer.current)
          act('stop', async () => {
            const res = await request('/control/stop', { method: 'POST', body: {} })
            if (!alive.current) return
            const d = res.data && typeof res.data === 'object' ? res.data : {}
            if (!res.ok || d.ok === false) {
              say('bad', t('stopFailed') + '：' + (res.error || str(d.error || d.note) || '未知原因'))
              return
            }
            say('good', t('stopped'))
            await refresh({ silent: true })
          })
        }

        const onScan = () =>
          act('scan', async () => {
            const res = await request('/control/scan', { method: 'POST', body: {} })
            if (!alive.current) return
            const d = res.data && typeof res.data === 'object' ? res.data : {}
            if (!res.ok || d.ok === false) {
              say('bad', t('scanFailed') + '：' + (res.error || str(d.error || d.note) || '未知原因'))
              return
            }
            const r = d.result && typeof d.result === 'object' ? d.result : null
            const tail = r ? [numOf(r.items) !== null ? '发现 ' + r.items + ' 条' : '', numOf(r.routed) !== null ? '派发 ' + r.routed : ''].filter(Boolean).join(' · ') : ''
            say('good', t('scanStarted') + (tail ? '：' + tail : ''))
            await refresh({ silent: true })
          })

        const onRefresh = () =>
          act('refresh', async () => {
            await refresh({})
            if (!alive.current) return
            setFrameKey((k) => k + 1)
            say('good', t('refreshed'))
          })

        /* ── 自检 ── */
        const runDoctor = async () => {
          setDoctorBusy(true)
          try {
            const out = await fetchDoctor()
            if (!alive.current) return
            setDoctor(out)
            if (out.error) say('bad', t('doctorFailed') + '：' + out.error)
            else {
              const s = out.summary
              say(
                s.fail > 0 ? 'bad' : s.warn > 0 ? 'info' : 'good',
                t('doctorDone') + '：PASS ' + s.pass + ' · WARN ' + s.warn + ' · FAIL ' + s.fail,
              )
            }
          } catch (e) {
            if (alive.current) say('bad', t('doctorFailed') + '：' + short(e))
          } finally {
            if (alive.current) setDoctorBusy(false)
          }
        }

        /* ── 抽屉 / 标签切换 ── */

        /** 打开抽屉并切到某个标签（该标签第一次打开时才拉数据）。 */
        const openTab = (which) => {
          setDrawerOpen(true)
          setTab(which)
          ensureTab(which)
        }

        /** 当前标签的数据还没拉过就拉一次（打开抽屉 / 点标签时调用）。 */
        const ensureTab = (which) => {
          if (which === 'doctor') {
            if ((!doctor || doctor.error) && !doctorBusy) runDoctor()
            return
          }
          if (which === 'deps') {
            if (!deps && !depsBusy) runDeps()
            return
          }
          if (which === 'version') {
            if (!version && !versionBusy) runVersion()
          }
        }

        /* ── 依赖：读取 / 检查 / 动作 ── */

        const runDeps = async () => {
          setDepsBusy(true)
          try {
            const res = await request('/deps')
            if (!alive.current) return
            if (res.status === 404) {
              // 接口还没就绪：如实说，不猜、不崩
              setDeps({ rows: [], notReady: true, error: res.error, at: Date.now() })
              say('info', t('depsNotReady'))
              return
            }
            if (!res.ok) {
              setDeps({ rows: [], error: res.error, at: Date.now() })
              say('bad', t('depsFailed') + '：' + res.error)
              return
            }
            const n = normalizeDeps(res.data)
            setDeps({ rows: n.rows, note: n.note, at: Date.now() })
            if (!n.rows.length) say('info', t('depsEmpty'))
          } catch (e) {
            if (alive.current) {
              setDeps({ rows: [], error: short(e), at: Date.now() })
              say('bad', t('depsFailed') + '：' + short(e))
            }
          } finally {
            if (alive.current) setDepsBusy(false)
          }
        }

        /** 「重新检查」：先让后端重新探测（POST /deps/check），再读一次列表。 */
        const runDepsCheck = () =>
          act('depsCheck', async () => {
            setDepsBusy(true)
            try {
              const res = await request('/deps/check', { method: 'POST', body: {} })
              if (!alive.current) return
              if (res.status === 404) {
                setDeps({ rows: [], notReady: true, error: res.error, at: Date.now() })
                say('info', t('depsNotReady'))
                return
              }
              if (!res.ok) say('bad', t('depsFailed') + '：' + res.error)
            } finally {
              if (alive.current) setDepsBusy(false)
            }
            await runDeps()
          })

        /**
         * 对一个 Agent CLI 做 install / update / uninstall（降级也走 install + version）。
         * row 是当前行（拿来显示 before 版本），version 只对降级/指定版本用。
         */
        const runDepAction = async (row, action, version) => {
          if (!row || !row.id) return
          const key = row.id + ':' + action
          if (depAction) return // 同一时刻只跑一个依赖动作
          setDepAction(key)
          setOpenVersions('')
          const logFor = (patch) => setDepsLog((prev) => ({ ...prev, [row.id]: { ...patch, at: Date.now() } }))
          logFor({ state: 'running', text: tf('workingOn', { action: actionText(action) }) })

          try {
            const body = {}
            if (version) body.version = version
            const res = await request(
              '/deps/' + encodeURIComponent(row.id) + '/' + action,
              { method: 'POST', body: body },
            )
            if (!alive.current) return

            if (res.status === 404 && !res.data) {
              logFor({ state: 'fail', text: t('endpointNotReady') + '：' + res.error })
              say('bad', t('endpointNotReady') + '：' + res.error)
              return
            }

            const d = res.data && typeof res.data === 'object' ? res.data : {}
            const ok = res.ok && d.ok !== false
            const before = str(d.before || d.from || d.current || d.previous) || str(version || row.current) || t('depNotInstalled')
            const after = str(d.after || d.to || d.newVersion || d.installedVersion) || str(d.version) || ''
            const lines = []
            if (ok) {
              lines.push(tf('versionArrow', { a: before, b: after || '—' }))
            } else {
              lines.push(t('resultFailed'))
            }
            if (d.note || d.reason || d.error) lines.push(str(d.note || d.reason || d.error))
            if (d.cmd) lines.push('$ ' + str(d.cmd))
            if (d.stdout) lines.push(String(d.stdout).slice(-1200))
            if (d.stderr) lines.push('[stderr]\n' + String(d.stderr).slice(-900))
            if (res.error) lines.push(res.error)

            logFor({ state: ok ? 'done' : 'fail', text: lines.filter(Boolean).join('\n') })
            if (ok) {
              say('good', actionText(action) + '：' + row.name + (after ? ' → ' + after : ''))
              await runDeps() // 动作完立刻重读，让版本号与按钮状态都是真的
            } else {
              say('bad', t('resultFailed') + '：' + (res.error || str(d.reason || d.error) || row.id))
            }
          } catch (e) {
            if (alive.current) {
              logFor({ state: 'fail', text: short(e) })
              say('bad', t('resultFailed') + '：' + short(e))
            }
          } finally {
            if (alive.current) setDepAction('')
          }
        }

        /** 二次确认（卸载这种破坏性动作）：第一次只是上膛。 */
        const arm = (key) => {
          if (armedKey === key) return true
          setArmedKey(key)
          if (armTimer.current) clearTimeout(armTimer.current)
          armTimer.current = setTimeout(() => {
            if (alive.current) setArmedKey('')
          }, STOP_ARM_MS)
          return false
        }

        const disarm = () => {
          setArmedKey('')
          if (armTimer.current) clearTimeout(armTimer.current)
        }

        /* ── 版本 ── */

        /**
         * 读版本信息。force=true 时走 POST /plugin/version/check（Host 会强制重新查一次仓库），
         * 否则 GET /plugin/version（用后端缓存，快）。404 → 老实说「该接口未就绪」。
         */
        const runVersion = async (force) => {
          setVersionBusy(true)
          try {
            const res = force
              ? await request('/plugin/version/check', { method: 'POST', body: {} })
              : await request('/plugin/version')
            if (!alive.current) return
            if (res.status === 404) {
              setVersion({ notReady: true, error: res.error })
              say('info', t('versionNotReady'))
              return
            }
            if (!res.ok) {
              setVersion({ notReady: false, error: res.error })
              say('bad', t('versionFailed') + '：' + res.error)
              return
            }
            const v = normalizeVersion(res.data)
            setVersion(v)
            if (v.error) say('info', t('versionErrorHint'))
            else if (force) say('good', t('checkUpdate') + '：' + (v.hasUpdate ? t('hasUpdateBadge') + ' ' + v.latest : t('noUpdateBadge')))
          } catch (e) {
            if (alive.current) setVersion({ notReady: false, error: short(e) })
          } finally {
            if (alive.current) setVersionBusy(false)
          }
        }

        const runVersionAction = async (action, ver) => {
          if (versionBusy) return
          const label = ver ? t(action === 'install' ? 'actionInstall' : 'actionDowngrade') : actionText(action)
          setVersionBusy(true)
          setVersionLog({ state: 'running', text: tf('workingOn', { action: label }) })
          try {
            const body = { action: action }
            if (ver) body.version = ver
            const res = await request('/plugin/version/apply', { method: 'POST', body: body })
            if (!alive.current) return
            if (res.status === 404 && !res.data) {
              setVersionLog({ state: 'fail', text: t('endpointNotReady') + '：' + res.error })
              say('bad', t('endpointNotReady') + '：' + res.error)
              return
            }
            const d = res.data && typeof res.data === 'object' ? res.data : {}
            const ok = res.ok && d.ok !== false
            const before = str(d.before || d.from || (version && version.current)) || '—'
            const after = str(d.after || d.to || d.version) || ''
            const lines = [ok ? tf('versionArrow', { a: before, b: after || '—' }) : t('resultFailed')]
            if (d.note || d.reason || d.error) lines.push(str(d.note || d.reason || d.error))
            if (d.cmd) lines.push('$ ' + str(d.cmd))
            if (d.stdout) lines.push(String(d.stdout).slice(-1200))
            if (d.stderr) lines.push('[stderr]\n' + String(d.stderr).slice(-900))
            if (res.error) lines.push(res.error)
            if (ok) lines.push(t('reloadHint'))
            setVersionLog({ state: ok ? 'done' : 'fail', text: lines.filter(Boolean).join('\n') })
            if (ok) say('good', label + (after ? '：' + before + ' → ' + after : '：' + t('resultDone')))
            else say('bad', t('versionFailed') + '：' + (res.error || str(d.reason || d.error) || action))
            setOpenPluginVersions(false)
            await runVersion()
          } catch (e) {
            if (alive.current) {
              setVersionLog({ state: 'fail', text: short(e) })
              say('bad', t('versionFailed') + '：' + short(e))
            }
          } finally {
            if (alive.current) setVersionBusy(false)
          }
        }

        /** 动作 → 文案（install/update/uninstall/enable/disable/…）。 */
        const actionText = (action) =>
          action === 'install'
            ? t('actionInstall')
            : action === 'update'
              ? t('actionUpdate')
              : action === 'uninstall'
                ? t('actionUninstall')
                : action === 'downgrade'
                  ? t('actionDowngrade')
                  : action === 'enable'
                    ? t('actionEnable')
                    : action === 'disable'
                      ? t('actionDisable')
                      : action

        /* ── 安装（自检标签里的缺失依赖） ── */
        const runInstall = async (id) => {
          const target = String(id || '').trim()
          if (!target) {
            say('bad', t('installFailed') + '：没有拿到要安装的依赖 id')
            return
          }
          const logFor = (patch) => setInstallLog((prev) => ({ ...prev, [target]: { ...patch, at: Date.now() } }))
          setInstallBusy(true)
          logFor({ state: 'running', text: t('installRunning') })
          try {
            const res = await request('/setup/install', { method: 'POST', body: { id: target } })
            if (!alive.current) return
            const d = res.data && typeof res.data === 'object' ? res.data : {}
            const lines = []
            if (d.cmd) lines.push('$ ' + str(d.cmd))
            if (d.note || d.reason) lines.push(str(d.note || d.reason))
            if (d.needManual) lines.push(t('installNeedManual'))
            if (Array.isArray(d.guide) && d.guide.length) lines.push(t('installGuide') + '：\n' + d.guide.map((g) => '· ' + str(g)).join('\n'))
            if (d.stdout) lines.push(String(d.stdout).slice(-1500))
            if (d.stderr) lines.push('[stderr]\n' + String(d.stderr).slice(-1200))
            if (res.error) lines.push(res.error)
            const body = lines.filter(Boolean).join('\n') || t('installDone')

            const ok = res.ok && d.ok !== false
            logFor({ state: ok ? 'done' : 'fail', text: body })
            if (ok) {
              say('good', t('installDone') + '：' + target + (d.already ? '（本来就装了）' : ''))
              await runDoctor() // 装完立刻复检，让用户看到 PASS
            } else {
              say('bad', t('installFailed') + '：' + (res.error || str(d.reason || d.note) || target))
            }
          } catch (e) {
            if (alive.current) {
              logFor({ state: 'fail', text: short(e) })
              say('bad', t('installFailed') + '：' + short(e))
            }
          } finally {
            if (alive.current) setInstallBusy(false)
          }
        }

        /** 只挑「没 PASS + 可安装」的项，按顺序一个个装，避免并发打 npm 全局锁。 */
        const installAll = () => {
          const rows = (doctor && Array.isArray(doctor.rows) ? doctor.rows : []).filter((r) => !isPass(r) && r.installable)
          if (!rows.length) {
            say('info', t('nothingToInstall'))
            return
          }
          act('installAll', async () => {
            for (const row of rows) {
              if (!alive.current) return
              await runInstall(row.id)
            }
          })
        }

        /* ── 一键开始：① 自检 → ②（必要时）引导安装 → ③ 启动 ── */
        const oneKeyStart = () =>
          act('onekey', async () => {
            say('info', t('oneKeyWorking'))
            const out = await fetchDoctor().catch(() => null)
            if (!alive.current) return
            if (!out) {
              say('bad', t('doctorFailed') + '：自检请求异常')
              return
            }
            setDoctor(out)
            setDrawerOpen(true)
            setTab('doctor')

            const missing = (out.rows || []).filter((r) => !isPass(r) && r.installable)
            if (out.error && !out.rows.length) {
              setDrawerOpen(true)
              setTab('doctor')
              say('bad', t('doctorFailed') + '：' + out.error)
              return
            }
            if (missing.length) {
              setDrawerOpen(true)
              setTab('doctor')
              say('info', tf('oneKeyNeedsInstall', { n: missing.length }))
              return
            }

            const res = await request('/control/start', { method: 'POST', body: {} })
            if (!alive.current) return
            const d = res.data && typeof res.data === 'object' ? res.data : {}
            if (!res.ok || d.ok === false) {
              say('bad', t('startFailed') + '：' + (res.error || str(d.error || d.note) || '未知原因'))
              return
            }
            say('good', t('oneKeyStarted') + (str(d.note) ? '：' + str(d.note) : ''))
            setFrameKey((k) => k + 1)
            await refresh({ silent: true })
          })

        /* ── 渲染：控制条按钮 ── */
        const btn = (tag, labelKey, onClick, opts = {}) =>
          h(
            'button',
            {
              type: 'button',
              'data-hive-btn': '',
              'data-primary': opts.primary ? '' : undefined,
              'data-danger': opts.danger ? '' : undefined,
              'data-mini': opts.mini ? '' : undefined,
              'data-busy': busy === tag ? '1' : undefined,
              disabled: Boolean(busy) && busy !== tag,
              title: t(labelKey),
              'aria-label': t(labelKey),
              onClick: onClick,
            },
            busy === tag ? t('working') : t(labelKey),
          )

        const statusText =
          phase === 'ready'
            ? t('statusReady')
            : phase === 'degraded'
              ? t('statusDegraded')
              : phase === 'error'
                ? t('statusError')
                : phase === 'uninit'
                  ? t('statusUninit')
                  : t('statusLoading')

        const countsText = (() => {
          if (!counts) return ''
          const bits = []
          if (counts.approvals !== null) bits.push(t('pendingApprovals') + ' ' + counts.approvals)
          if (counts.running !== null) bits.push(t('runningTasks') + ' ' + counts.running)
          if (!bits.length && counts.inbox !== null) bits.push(t('inboxCount') + ' ' + counts.inbox)
          return bits.join(' · ')
        })()

        /* ── 渲染：一条检查项 ── */
        const renderCheck = (row) => {
          const canInstall = row.installable && !isPass(row)
          const log = installLog[row.id] || null
          return h(
            'div',
            { key: 'chk-' + row.id, 'data-hive-check': '', 'data-level': row.level },
            h(
              'div',
              { 'data-hive-check-main': '' },
              h('div', { 'data-hive-check-name': '' }, row.name),
              row.detail ? h('div', { 'data-hive-check-detail': '' }, row.detail) : null,
              row.fix ? h('div', { 'data-hive-check-fix': '' }, t('fixHint') + '：' + row.fix) : null,
              log
                ? h(
                    'pre',
                    { 'data-hive-install': '', 'data-state': log.state },
                    (log.state === 'running' ? t('installRunning') + '\n' : '') + log.text,
                  )
                : null,
            ),
            h(
              'div',
              { 'data-hive-check-side': '' },
              h('span', { 'data-hive-level': '', 'data-level': row.level }, levelText(row.level)),
              canInstall
                ? h(
                    'button',
                    {
                      type: 'button',
                      'data-hive-btn': '',
                      'data-mini': '',
                      disabled: installBusy,
                      title: t('install') + '：' + row.id,
                      onClick: () => runInstall(row.id),
                    },
                    installBusy && log && log.state === 'running' ? t('installRunning') : t('install'),
                  )
                : null,
            ),
          )
        }

        /* ── 渲染：抽屉里的三个标签 ── */

        const TAB_LABELS = () => [
          ['doctor', t('tabDoctor')],
          ['deps', t('tabDeps')],
          ['version', t('tabVersion')],
        ]

        const renderTabs = () =>
          h(
            'div',
            { 'data-hive-tabs': '', role: 'tablist' },
            TAB_LABELS().map(([key, label]) =>
              h(
                'button',
                {
                  key: 'tab-' + key,
                  type: 'button',
                  role: 'tab',
                  'data-hive-tab': '',
                  'data-active': tab === key ? '' : undefined,
                  'aria-selected': tab === key ? 'true' : 'false',
                  onClick: () => openTab(key),
                },
                label,
              ),
            ),
          )

        /** 标签 1：环境自检（原有设计保留） */
        const renderDoctorTab = () => {
          const s = doctor && doctor.summary ? doctor.summary : { pass: 0, warn: 0, fail: 0, unknown: 0, total: 0 }
          return [
            h(
              'div',
              { key: 'sum', 'data-hive-summary': '' },
              h('span', null, t('summaryLabel') + '：'),
              h('span', { 'data-hive-chip': '', 'data-level': 'pass' }, t('levelPass') + ' ' + s.pass),
              h('span', { 'data-hive-chip': '', 'data-level': 'warn' }, t('levelWarn') + ' ' + s.warn),
              h('span', { 'data-hive-chip': '', 'data-level': 'fail' }, t('levelFail') + ' ' + s.fail),
              s.unknown ? h('span', { 'data-hive-chip': '', 'data-level': 'unknown' }, t('levelUnknown') + ' ' + s.unknown) : null,
              doctor && doctor.at ? h('span', null, t('checkedAt') + ' ' + new Date(doctor.at).toLocaleTimeString()) : null,
            ),
            doctor && doctor.error ? h('div', { key: 'err', 'data-hive-error': '' }, t('doctorFailed') + '：' + doctor.error) : null,
            doctorBusy && !doctor
              ? h('div', { key: 'load', 'data-hive-empty': '' }, t('doctorLoading'))
              : doctor && doctor.rows && doctor.rows.length
                ? doctor.rows.map(renderCheck)
                : doctor
                  ? h('div', { key: 'empty', 'data-hive-empty': '' }, t('emptyRows'))
                  : h('div', { key: 'loading', 'data-hive-empty': '' }, t('doctorLoading')),
            doctor && doctor.source
              ? h(
                  'div',
                  { key: 'src', 'data-hive-note': '' },
                  t('endpointLabel') + '：' + doctor.source + (doctor.degradedFrom ? '（降级：' + doctor.degradedFrom + '）' : ''),
                )
              : null,
            h('div', { key: 'tip', 'data-hive-note': '' }, t('tipBody')),
          ]
        }

        /** 依赖行：名称 / 用途 / 当前 / 最新 + 四个动作按钮 + 降级版本列表 */
        const renderDep = (row) => {
          const log = depsLog[row.id] || null
          const running = depAction.indexOf(row.id + ':') === 0
          const blocked = Boolean(depAction) && !running
          const lower = lowerVersions(row.versions, row.current)
          // 后端通常只回最近 N 个版本；被截断时降级要如实解释，不能假装「没有更低的」
          const truncated = row.totalVersions > row.versions.length
          const canInstall = !row.installed
          const canUpdate = Boolean(row.latest) && cmpVersion(row.latest, row.current) > 0
          const canUninstall = row.installed && row.uninstallable
          const uninstallKey = row.id + ':uninstall'

          const actionBtn = (action, labelKey, enabled, hint, extra) =>
            h(
              'button',
              {
                type: 'button',
                'data-hive-btn': '',
                'data-mini': '',
                'data-danger': action === 'uninstall' ? '' : undefined,
                disabled: !enabled || blocked || running,
                title: enabled
                  ? actionText(action) + ' ' + row.name + (extra ? ' → ' + extra : '')
                  : hint || actionText(action),
                onClick: () => {
                  if (action === 'uninstall') {
                    if (!arm(uninstallKey)) return
                    disarm()
                  }
                  runDepAction(row, action, extra)
                },
              },
              action === 'uninstall' && armedKey === uninstallKey ? t('confirmUninstall') : t(labelKey),
            )

          return h(
            'div',
            {
              key: 'dep-' + row.id,
              'data-hive-dep': '',
              'data-installed': row.installed ? '1' : '0',
              'data-state': log ? log.state : undefined,
            },
            h(
              'div',
              { 'data-hive-dep-head': '' },
              h(
                'div',
                { 'data-hive-dep-name': '' },
                row.name,
                row.required ? h('span', { 'data-hive-tag': '', 'data-required': '' }, t('depRequired')) : null,
                row.installed ? null : h('span', { 'data-hive-tag': '' }, t('depNotInstalled')),
                row.error ? h('span', { 'data-hive-tag': '' }, row.error) : null,
              ),
              h(
                'div',
                { 'data-hive-dep-ver': '' },
                t('currentVersion') + ' ' + (row.current || '—') + (row.latest ? ' · ' + t('latestVersion') + ' ' + row.latest : ''),
              ),
            ),
            h('div', { 'data-hive-dep-use': '' }, row.purpose || t('depPurposeFallback')),
            // 后端给「卸载/缺失会怎样」就原样转述（我不编后果）
            row.fallback ? h('div', { 'data-hive-check-fix': '' }, t('depFallbackPrefix') + row.fallback) : null,
            h(
              'div',
              { 'data-hive-dep-actions': '' },
              actionBtn('install', 'actionInstall', canInstall, t('alreadyInstalledHint')),
              actionBtn('update', 'actionUpdate', canUpdate, t('noUpdateHint')),
              // 降级：展开版本列表，不直接执行
              h(
                'button',
                {
                  type: 'button',
                  'data-hive-btn': '',
                  'data-mini': '',
                  // 被截断时也允许点开：好让用户看到「后端只回了最近 N 个版本」的解释
                  disabled: (!lower.length && !truncated) || blocked || running,
                  title: lower.length
                    ? t('versionsAvailable')
                    : truncated
                      ? tf('versionsTruncated', { n: row.versions.length, t: row.totalVersions })
                      : t('noLowerVersions'),
                  onClick: () => setOpenVersions(openVersions === row.id ? '' : row.id),
                },
                t('actionDowngrade') + (lower.length || truncated ? ' ▾' : ''),
              ),
              actionBtn('uninstall', 'actionUninstall', canUninstall, row.installed ? '' : t('notInstalledHint')),
            ),
            openVersions === row.id
              ? h(
                  'div',
                  { 'data-hive-versions': '' },
                  lower.length
                    ? lower.map((v) =>
                        h(
                          'button',
                          {
                            key: 'ver-' + row.id + '-' + v,
                            type: 'button',
                            'data-hive-ver-btn': '',
                            disabled: blocked || running,
                            title: t('actionDowngrade') + ' → ' + v,
                            onClick: () => runDepAction(row, 'install', v),
                          },
                          v,
                        ),
                      )
                    : h(
                        'div',
                        { 'data-hive-note': '' },
                        truncated ? tf('versionsTruncated', { n: row.versions.length, t: row.totalVersions }) : t('noLowerVersions'),
                      ),
                )
              : null,
            log ? h('pre', { 'data-hive-install': '', 'data-state': log.state }, log.text) : null,
          )
        }

        /** 标签 2：可选 Agent 依赖 */
        const renderDepsTab = () => {
          const rows = deps && Array.isArray(deps.rows) ? deps.rows : []
          return [
            h('div', { key: 'title', 'data-hive-section-title': '' }, t('depsSection')),
            deps && deps.notReady
              ? h(
                  'div',
                  { key: 'notready', 'data-hive-error': '' },
                  t('endpointNotReady') + '（' + API + '/deps）\n' + t('endpointNotReadyHint') + (deps.error ? '\n' + deps.error : ''),
                )
              : null,
            deps && deps.error && !deps.notReady ? h('div', { key: 'err', 'data-hive-error': '' }, t('depsFailed') + '：' + deps.error) : null,
            depsBusy && !deps ? h('div', { key: 'load', 'data-hive-empty': '' }, t('depsLoading')) : null,
            !deps && !depsBusy ? h('div', { key: 'idle', 'data-hive-empty': '' }, t('depsLoading')) : null,
            deps && !depsBusy && !rows.length && !deps.notReady && !deps.error
              ? h('div', { key: 'empty', 'data-hive-empty': '' }, t('depsEmpty'))
              : null,
            rows.length ? rows.map(renderDep) : null,
            deps && deps.note ? h('div', { key: 'bnote', 'data-hive-note': '' }, deps.note) : null,
          ]
        }

        /** 标签 3：插件自身版本 */
        const renderVersionTab = () => {
          if (!version) return h('div', { 'data-hive-empty': '' }, t('versionLoading'))

          if (version.notReady) {
            return h(
              'div',
              { 'data-hive-error': '' },
              t('versionNotReady') + '（' + API + '/plugin/version）\n' + t('endpointNotReadyHint') + (version.error ? '\n' + version.error : ''),
            )
          }

          const cur = version.current || '—'
          const latest = version.latest || ''
          const blocked = Boolean(version.error)
          const lower = downgradeOptions(version)
          const unremovable = version.removable === false

          return [
            h(
              'div',
              { key: 'head', 'data-hive-summary': '' },
              h('span', { 'data-hive-chip': '', 'data-level': 'unknown' }, t('versionSection') + ' ' + cur),
              latest
                ? h(
                    'span',
                    { 'data-hive-ver-badge': '', 'data-kind': version.hasUpdate ? 'update' : 'latest' },
                    (version.hasUpdate ? t('hasUpdateBadge') : t('noUpdateBadge')) + ' · ' + t('latestVersion') + ' ' + latest,
                  )
                : null,
            ),
            // Host 的诚实提示（例如「本地目录安装，升级要换安装方式」）原样显示
            version.hint ? h('div', { key: 'hint', 'data-hive-note-box': '' }, version.hint) : null,
            version.error
              ? h('div', { key: 'err', 'data-hive-error': '' }, t('versionErrorHint') + '\n' + version.error)
              : null,
            version.note ? h('div', { key: 'note', 'data-hive-note': '' }, version.note) : null,
            h(
              'div',
              { key: 'actions', 'data-hive-dep-actions': '' },
              h(
                'button',
                { type: 'button', 'data-hive-btn': '', 'data-mini': '', disabled: versionBusy, onClick: () => runVersion(true) },
                versionBusy ? t('versionLoading') : t('checkUpdate'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  'data-hive-btn': '',
                  'data-mini': '',
                  disabled: versionBusy || blocked || !version.hasUpdate,
                  title: blocked ? t('versionErrorHint') : version.hasUpdate ? t('actionUpdate') : t('noUpdateHint'),
                  onClick: () => runVersionAction('update'),
                },
                t('updateNow'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  'data-hive-btn': '',
                  'data-mini': '',
                  disabled: versionBusy || blocked || !lower.length,
                  title: lower.length ? t('versionsAvailable') : t('noLowerVersions'),
                  onClick: () => setOpenPluginVersions(!openPluginVersions),
                },
                t('actionDowngrade') + (lower.length ? ' ▾' : ''),
              ),
              h(
                'button',
                {
                  type: 'button',
                  'data-hive-btn': '',
                  'data-mini': '',
                  'data-danger': '',
                  disabled: versionBusy || blocked || unremovable,
                  title: blocked ? t('versionErrorHint') : unremovable ? t('unremovableHint') : t('actionUninstall'),
                  onClick: () => {
                    if (!arm('plugin:uninstall')) return
                    disarm()
                    runVersionAction('uninstall')
                  },
                },
                armedKey === 'plugin:uninstall' ? t('confirmUninstall') : t('actionUninstall'),
              ),
              typeof version.enabled === 'boolean'
                ? h(
                    'button',
                    {
                      type: 'button',
                      'data-hive-btn': '',
                      'data-mini': '',
                      disabled: versionBusy || blocked,
                      onClick: () => runVersionAction(version.enabled ? 'disable' : 'enable'),
                    },
                    version.enabled ? t('disablePlugin') : t('enablePlugin'),
                  )
                : null,
            ),
            openPluginVersions
              ? h(
                  'div',
                  { 'data-hive-versions': '' },
                  lower.length
                    ? lower.map((v) =>
                        h(
                          'button',
                          {
                            key: 'pver-' + v,
                            type: 'button',
                            'data-hive-ver-btn': '',
                            disabled: versionBusy,
                            onClick: () => runVersionAction('downgrade', v),
                          },
                          v,
                        ),
                      )
                    : h('div', { 'data-hive-note': '' }, t('noLowerVersions')),
                )
              : null,
            versionLog ? h('pre', { key: 'vlog', 'data-hive-install': '', 'data-state': versionLog.state }, versionLog.text) : null,
            h('div', { key: 'reload', 'data-hive-note': '' }, t('reloadHint')),
          ]
        }

        /* ── 渲染：抽屉（一个抽屉，三个标签） ── */
        const renderDrawer = () => {
          if (!drawerOpen) return null
          return h(
            'div',
            { 'data-hive-drawer': '' },
            h('div', { 'data-hive-drawer-veil': '', onClick: () => setDrawerOpen(false) }),
            h(
              'div',
              { 'data-hive-drawer-panel': '', role: 'dialog', 'aria-label': t('drawerTitle') },
              h(
                'div',
                { 'data-hive-drawer-head': '' },
                h('div', { 'data-hive-drawer-title': '' }, t('drawerTitle')),
                h('button', { type: 'button', 'data-hive-btn': '', 'data-mini': '', onClick: () => setDrawerOpen(false), title: t('close') }, '✕'),
              ),
              renderTabs(),
              // 抽屉顶部固定一行定位说明（三个标签都看得到）：装不装由用户决定
              h('div', { 'data-hive-note-box': '', 'data-hive-drawer-note': '' }, t('depsNote')),
              h(
                'div',
                { 'data-hive-drawer-body': '' },
                tab === 'doctor' ? renderDoctorTab() : tab === 'deps' ? renderDepsTab() : renderVersionTab(),
              ),
              h(
                'div',
                { 'data-hive-drawer-foot': '' },
                // 底部按钮跟着标签走：自检=一键安装缺失项；依赖=重新检查；版本=检查更新
                tab === 'doctor'
                  ? h(
                      'button',
                      {
                        type: 'button',
                        'data-hive-btn': '',
                        'data-primary': '',
                        disabled: doctorBusy || installBusy || Boolean(busy),
                        title: t('oneKeyInstall'),
                        onClick: installAll,
                      },
                      installBusy ? t('installRunning') : t('oneKeyInstall'),
                    )
                  : tab === 'deps'
                    ? h(
                        'button',
                        {
                          type: 'button',
                          'data-hive-btn': '',
                          'data-primary': '',
                          disabled: depsBusy || Boolean(depAction),
                          title: t('depsRecheck'),
                          onClick: runDepsCheck,
                        },
                        depsBusy ? t('depsChecking') : t('depsRecheck'),
                      )
                    : h(
                        'button',
                        {
                          type: 'button',
                          'data-hive-btn': '',
                          'data-primary': '',
                          disabled: versionBusy,
                          title: t('checkUpdate'),
                          onClick: () => runVersion(true),
                        },
                        versionBusy ? t('versionLoading') : t('checkUpdate'),
                      ),
                h(
                  'button',
                  {
                    type: 'button',
                    'data-hive-btn': '',
                    disabled: tab === 'doctor' ? doctorBusy : tab === 'deps' ? depsBusy : versionBusy,
                    onClick: () => (tab === 'doctor' ? runDoctor() : tab === 'deps' ? runDeps() : runVersion()),
                  },
                  tab === 'doctor' ? (doctorBusy ? t('doctorLoading') : t('rerunDoctor')) : t('retryLoad'),
                ),
                h('div', { 'data-hive-grow': '' }),
                h('button', { type: 'button', 'data-hive-btn': '', onClick: () => setDrawerOpen(false) }, t('close')),
              ),
            ),
          )
        }

        /* ── 渲染：引导卡片（后端没接上时） ── */
        const renderGuide = () => {
          if (frameOn) return null
          if (phase !== 'error' && phase !== 'uninit') return null
          return h(
            'div',
            { 'data-hive-guide': '' },
            h(
              'div',
              { 'data-hive-guide-card': '' },
              h('div', { 'data-hive-guide-title': '' }, t('guideTitle')),
              h(
                'div',
                { 'data-hive-guide-reason': '' },
                (reason ? t('guideReason') + '：' + reason : t('guideReasonEmpty')) + (detail ? '\n' + detail : ''),
              ),
              h(
                'ol',
                { 'data-hive-guide-steps': '' },
                h('li', null, t('guideStep1')),
                h('li', null, t('guideStep2')),
                h('li', null, t('guideStep3')),
              ),
              h(
                'div',
                { 'data-hive-guide-actions': '' },
                btn('onekey', 'oneKeyStart', oneKeyStart, { primary: true }),
                btn('refresh', 'retry', () => act('refresh', async () => { await refresh({}); setFrameKey((k) => k + 1) })),
                h('button', { type: 'button', 'data-hive-btn': '', onClick: () => openTab('doctor') }, t('btnDoctor')),
                h('button', { type: 'button', 'data-hive-btn': '', onClick: () => setFrameOn(true) }, t('stillOpen')),
              ),
            ),
          )
        }

        /* ── 渲染：主结构 ── */
        return h(
          'section',
          { 'data-hive-page': '' },
          // 控制条：固定 48px
          h(
            'div',
            { 'data-hive-bar': '', role: 'toolbar' },
            h(
              'div',
              { 'data-hive-brand': '', title: t('subtitle') + ' · ' + statusText + (reason ? '（' + reason + '）' : '') },
              h('span', { 'data-hive-dot': '', 'data-phase': phase, 'aria-label': statusText }),
              h('span', { 'data-hive-name': '' }, t('title')),
              h('span', { 'data-hive-sub': '' }, t('subtitle')),
            ),
            countsText ? h('span', { 'data-hive-counts': '' }, countsText) : null,
            h(
              'div',
              { 'data-hive-actions': '' },
              btn('start', 'btnStart', onStart, { primary: true }),
              btn('stop', stopArmed ? 'btnStopConfirm' : 'btnStop', onStop, { danger: stopArmed }),
              btn('scan', 'btnScan', onScan),
              btn('doctor', 'btnDoctor', () => openTab('doctor')),
              btn('deps', 'btnDeps', () => openTab('deps')),
              btn('version', 'btnVersion', () => openTab('version')),
              btn('refresh', 'btnRefresh', onRefresh),
            ),
          ),

          // 看板 iframe —— 永远挂着（就算后端挂了也不白屏，上面会叠引导卡片）
          h('iframe', {
            key: 'hive-frame-' + frameKey,
            'data-hive-frame': '',
            src: DASHBOARD,
            title: t('frameTitle'),
            style: { width: '100%', height: 'calc(100% - 48px)', border: 0, background: '#0f0f12' },
          }),

          // 提示条（浮层，不影响 48px 的算术）
          toast
            ? h(
                'div',
                { 'data-hive-toast': '', 'data-tone': toast.tone, role: 'status' },
                h('span', { 'data-hive-toast-text': '' }, toast.text),
                h('button', { type: 'button', 'data-hive-toast-x': '', onClick: () => setToast(null), title: t('close') }, '✕'),
              )
            : null,

          renderGuide(),
          renderDrawer(),
        )
      }
    }

    /* ───────────────────────────── 注册 ───────────────────────────── */

    return {
      inject: ['slots'],
      apply(ctx) {
        /* 1) 样式：挂载时插入，卸载时移除（只加这一块，不动宿主任何东西） */
        let styleEl = null
        try {
          styleEl = document.createElement('style')
          styleEl.setAttribute('data-plugin-css', 'dsh-plugin-hive')
          styleEl.textContent = CSS
          document.head.appendChild(styleEl)
        } catch (e) {
          console.error('[hive] 样式注入失败：' + short(e))
          styleEl = null
        }
        const dropStyle = () => {
          try {
            if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl)
          } catch {
            /* 已被宿主清理，忽略 */
          }
          styleEl = null
        }
        if (typeof ctx.effect === 'function') ctx.effect(() => dropStyle, 'dsh-plugin-hive: 面板样式')
        else dropStyle() // 没有 effect 服务时至少别泄漏（调用方自己管生命周期的情况）

        /* 2) 文案：优先 DSH locale；拿不到就内置中文兜底 */
        const dicts = DICT
        let translate = null
        try {
          const locale = typeof ctx.get === 'function' ? ctx.get('locale') : ctx.locale
          if (locale && typeof locale.register === 'function') {
            const reg = (lang) => () => {
              try {
                return locale.register('hive', lang, dicts[lang])
              } catch (e) {
                console.error('[hive] 文案注册失败（' + lang + '）：' + short(e))
                return undefined
              }
            }
            if (typeof ctx.effect === 'function') {
              ctx.effect(reg('zh'), 'dsh-plugin-hive: 中文文案')
              ctx.effect(reg('en'), 'dsh-plugin-hive: 英文文案')
            } else {
              reg('zh')()
              reg('en')()
            }
            if (typeof locale.bind === 'function') translate = locale.bind('hive')
          }
        } catch (e) {
          console.error('[hive] locale 服务不可用，用内置中文：' + short(e))
        }

        const fallback = (key) => {
          const zh = dicts.zh && dicts.zh[key]
          if (zh !== undefined && zh !== null && zh !== '') return zh
          const en = dicts.en && dicts.en[key]
          if (en !== undefined && en !== null && en !== '') return en
          return key
        }
        const t = (key) => {
          if (translate) {
            try {
              const v = translate(key)
              if (v !== undefined && v !== null && v !== '' && v !== key) return String(v)
            } catch {
              /* 回落到内置文案 */
            }
          }
          return fallback(key)
        }

        /* 3) 两个槽位 */
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots || typeof slots.register !== 'function') {
          console.error('[hive] 拿不到 slots 服务，侧栏入口与面板都没注册')
          return
        }

        const Panel = makePanel(t)

        // 用 ctx.effect 包住 inject：槽位释放交给宿主统一回收，避免重复注册
        const injectSlot = (name, registerFn) => {
          const run = () => slots.inject(name, registerFn)
          if (typeof ctx.effect === 'function') {
            try {
              return ctx.effect(run, 'dsh-plugin-hive: ' + name)
            } catch (e) {
              console.error('[hive] 注册槽位失败（' + name + '）：' + short(e))
              return undefined
            }
          }
          try {
            return run()
          } catch (e) {
            console.error('[hive] 注册槽位失败（' + name + '）：' + short(e))
            return undefined
          }
        }

        // 侧栏入口：id 与 main 的 key 同名 → 点图标切到我们的面板
        injectSlot('sidebar.panellist', () =>
          slots.register({ name: 'sidebar.panellist', id: 'hive', order: 30, label: () => t('title') }, (props) => h(HiveIcon, props)),
        )

        // 主面板
        injectSlot('main', () => slots.register({ name: 'main', key: 'hive' }, () => h(Panel)))
      },

      // 测试挂点：check-client.mjs 用它验证「自检结果归一化」和「请求失败原因」，
      // 运行时不会被 DSH 调用（模块只需要 inject + apply）。
      __test: {
        normalizeDoctor,
        normalizeDeps,
        normalizeVersion,
        cmpVersion,
        lowerVersions,
        downgradeOptions,
        request,
        pickCounts,
        readPhase,
        DICT,
        CSS,
        INSTALLABLE_IDS,
        API,
        DASHBOARD,
      },
    }
  },
})
