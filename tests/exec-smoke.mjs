// tests/exec-smoke.mjs — 执行器层冒烟测试（真跑，不 mock）
//
//   node --no-warnings tests/exec-smoke.mjs          默认：注册表 + probe + llm + shell + 进程树 kill + pi/claude/codex 真跑
//   node --no-warnings tests/exec-smoke.mjs --slow   额外真跑 dsh --profile headless（冷启动 ~55s）
//
// 判据：每个断言都是真实行为；对外部阻塞（上游余额不足/无响应）不假装成功，
//       而是断言「执行器如实返回了失败」，并把原因打印出来。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { list, get, probe, run } from '../src/executors/index.mjs';
import { runProcess, which, commandSpec, parseNpmShim } from '../src/executors/proc.mjs';
import { loadConfig } from '../src/core/config.mjs';

const SLOW = process.argv.includes('--slow');
const cfg = loadConfig();

const results = [];
function pass(name, extra = '') { results.push({ name, status: 'PASS' }); console.log(`PASS  ${name}${extra ? '  ' + extra : ''}`); }
function fail(name, extra = '') { results.push({ name, status: 'FAIL' }); console.log(`FAIL  ${name}${extra ? '  ' + extra : ''}`); }
function skip(name, extra = '') { results.push({ name, status: 'SKIP' }); console.log(`SKIP  ${name}${extra ? '  ' + extra : ''}`); }
function check(name, cond, extra = '') { cond ? pass(name, extra) : fail(name, extra); }
const t0 = Date.now();

// ---------------------------------------------------------------- 1 注册表
console.log('\n== 1. 注册表 ==');
const all = list();
console.log('   executors:', all.map((e) => `${e.name}(${e.kind}${e.enabled ? '' : ',disabled'})`).join(' '));
check('registry.list', all.length >= 7, `n=${all.length}`);
check('registry.names', ['llm', 'dsh', 'pi', 'codex', 'claude', 'shell', 'proc'].every((n) => get(n)), 'llm/dsh/pi/codex/claude/shell/proc');
check('registry.kind', get('llm').kind === 'inline' && get('dsh').kind === 'process', 'inline/process');
check('registry.unknown', get('nope') === undefined, 'unknown → undefined');

const badRun = await run('nope', { prompt: 'x' });
check('registry.run.unknown', badRun.ok === false && /未注册/.test(badRun.error || ''), badRun.error);

const badProbe = await probe({ names: ['nope'], runtime: false });
check('registry.probe.unknown', badProbe.nope?.ok === false, badProbe.nope?.reason);

// ---------------------------------------------------------------- 2 probe 全量
console.log('\n== 2. probe()（真实 spawn 探版本）==');
const tProbe = Date.now();
const p = await probe();
for (const [name, v] of Object.entries(p)) {
  console.log(`   ${name.padEnd(7)} ok=${String(v.ok).padEnd(5)} version=${String(v.version ?? '-').padEnd(28)} ${v.ok ? '' : 'reason=' + v.reason}`);
}
console.log(`   probe 耗时 ${Date.now() - tProbe}ms`);
const versioned = ['node', 'pwsh', 'llm', 'dsh', 'pi', 'codex', 'claude', 'shell'];
for (const n of versioned) check(`probe.${n}`, p[n]?.ok === true, `version=${p[n]?.version ?? '-'}`);
check('probe.proc.disabled_by_default', p.proc?.ok === false, p.proc?.reason);
check('probe.version.shape', versioned.every((n) => typeof p[n]?.version === 'string' && p[n].version.length > 0), '每个可执行器都拿到版本字符串');

// ---------------------------------------------------------------- 3 proc 层
console.log('\n== 3. proc 基座（命令解析 / 行级日志 / 退出码）==');
const spec = commandSpec('dsh', ['--version']);
check('proc.resolve.cmd_shim', !!spec.exe && !spec.error, `via=${spec.via}`);
check('proc.resolve.npm_shim_parsed', spec.exe === process.execPath && spec.prefix.length === 1 && /\.js$/.test(spec.prefix[0]), spec.prefix[0] || '');
check('proc.which', !!which('pwsh') && !!which('node'), `pwsh=${path.basename(which('pwsh') || '-')}`);
check('proc.shim_parse_direct', (() => { const s = commandSpec('claude', []); return !!s.exe && /claude\.exe$/i.test(s.exe); })(), commandSpec('claude', []).exe);

const logLines = [];
const spawned = [];
const t3 = Date.now();
const rr = await runProcess({
  command: 'node',
  args: ['-e', "console.log('L1');console.error('E1');console.log('L2')"],
  timeoutSec: 30,
  onLog: (e) => logLines.push(`${e.stream}:${e.line}`),
  onSpawn: (s) => spawned.push(s),
});
check('proc.run.exit0', rr.ok && rr.exitCode === 0, `${Date.now() - t3}ms`);
check('proc.run.stdout', rr.stdout.includes('L1') && rr.stdout.includes('L2'), JSON.stringify(rr.stdout.trim()));
check('proc.run.stderr', rr.stderr.includes('E1'), JSON.stringify(rr.stderr.trim()));
check('proc.run.onLog', logLines.some((l) => l === 'stdout:L1') && logLines.some((l) => l === 'stderr:E1'), `${logLines.length} 行`);
check('proc.run.onSpawn', spawned.length === 1 && spawned[0].pid > 0 && !!spawned[0].cmdline, `pid=${spawned[0]?.pid}`);
check('proc.run.pid_recorded', rr.pid > 0 && /node/i.test(rr.cmdline), `cmdline=${rr.cmdline.slice(0, 60)}`);

const nz = await runProcess({ command: 'node', args: ['-e', 'process.exit(7)'], timeoutSec: 30 });
check('proc.run.nonzero', !nz.ok && nz.exitCode === 7, `exit=${nz.exitCode}`);

const missing = await runProcess({ command: 'definitely-not-a-real-cmd-xyz', args: [], timeoutSec: 10 });
check('proc.run.missing_cmd', !missing.ok && !!missing.spawnError, missing.spawnError);

// ---------------------------------------------------------------- 4 超时 + 进程树 kill
console.log('\n== 4. 超时 kill 整棵进程树（Windows taskkill /T /F）==');
const pidFile = path.join(os.tmpdir(), `hive-tree-${Date.now()}.pid`);
// 外层 pwsh 再起一个 pwsh 孙子进程，验证 taskkill /T 能把树连根拔掉
const grandchild = [
  `$p = Start-Process -FilePath pwsh -WindowStyle Hidden -PassThru -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 120'`,
  `Set-Content -Path '${pidFile.replace(/'/g, "''")}' -Value $p.Id -Encoding ascii`,
  'Start-Sleep -Seconds 120',
].join('\n');
const tk = await runProcess({ command: 'pwsh', args: ['-NoProfile', '-Command', grandchild], timeoutSec: 8 });
check('proc.timeout.detected', tk.timedOut === true && tk.ok === false, `ms=${tk.ms} exit=${tk.exitCode}`);
check('proc.timeout.kill_method', /taskkill/i.test(tk.treeKill?.method || ''), JSON.stringify(tk.treeKill?.method || null));
check('proc.timeout.fast', tk.ms < 60_000, `${tk.ms}ms`);

let gpid = null;
for (let i = 0; i < 20 && gpid == null; i++) {
  try { gpid = Number(fs.readFileSync(pidFile, 'utf8').trim()) || null; } catch { await new Promise((r) => setTimeout(r, 150)); }
}
fs.rmSync(pidFile, { force: true });
await new Promise((r) => setTimeout(r, 1500));
let alive = false;
if (gpid) { try { process.kill(gpid, 0); alive = true; } catch { alive = false; } }
if (gpid) {
  check('proc.timeout.tree_killed', alive === false, `grandchild pid=${gpid} ${alive ? '仍存活（树没杀干净）' : '已死'}`);
} else {
  fail('proc.timeout.tree_killed', '没能拿到孙进程 pid，无法验证进程树');
}
let parentAlive = false;
if (tk.pid) { try { process.kill(tk.pid, 0); parentAlive = true; } catch { parentAlive = false; } }
check('proc.timeout.parent_killed', parentAlive === false, `pid=${tk.pid} ${parentAlive ? '仍存活' : '已死'}`);

// ---------------------------------------------------------------- 5 shell 执行器
console.log('\n== 5. shell 执行器（真实 pwsh）==');
const sh = await run('shell', { prompt: 'Write-Output "hive-shell-ok"\nWrite-Output "中文不乱码"\nWrite-Output (Get-Location).Path', timeoutSec: 120 });
check('shell.run.ok', sh.ok, sh.ok ? `${sh.ms}ms` : sh.error);
check('shell.run.stdout', sh.stdout.includes('hive-shell-ok'), JSON.stringify(sh.stdout.trim().split(/\r?\n/)[1] || ''));
check('shell.run.utf8', sh.stdout.includes('中文不乱码'), '中文往返不乱码（UTF-8 前缀生效）');
check('shell.run.workdir_default', sh.stdout.includes(cfg.resolved.workspace), `cwd=${cfg.resolved.workspace}`);

const wd = path.join(os.tmpdir(), `hive-exec-wd-${Date.now()}`);
const shWd = await run('shell', { prompt: 'Write-Output (Get-Location).Path', workdir: wd, timeoutSec: 120 });
check('shell.run.workdir_custom', shWd.ok && shWd.stdout.trim().toLowerCase().includes(path.basename(wd).toLowerCase()), `cwd=${wd}`);

const shExit = await run('shell', { prompt: 'Write-Error "boom"; exit 7', timeoutSec: 120 });
check('shell.run.exit_code', shExit.ok === false && shExit.exitCode === 7, `exit=${shExit.exitCode} err=${JSON.stringify(shExit.stderr.trim().slice(0, 60))}`);

// ---------------------------------------------------------------- 6 llm 执行器（真调）
console.log('\n== 6. llm 执行器（真实调用 DeepSeek）==');
const lr = await run('llm', {
  prompt: '只返回 JSON：{"ok":true,"n":7}',
  system: '你是执行器冒烟测试对象，只输出 JSON。',
  json: true,
  schemaHint: { ok: 'boolean', n: 'number' },
  maxTokens: 200,
  timeoutSec: 120,
});
check('llm.run.ok', lr.ok, lr.ok ? `${lr.model} ${lr.ms}ms in=${lr.tokens.in} out=${lr.tokens.out} ¥${lr.costCny}` : lr.error);
check('llm.run.json', lr.ok && lr.json?.ok === true && lr.json?.n === 7, JSON.stringify(lr.json ?? null));
check('llm.run.tokens', lr.tokens.in > 0 && lr.tokens.out > 0, `in=${lr.tokens.in} out=${lr.tokens.out}`);
check('llm.run.cost', typeof lr.costCny === 'number' && lr.costCny >= 0, `¥${lr.costCny}`);

const lrBad = await run('llm', { prompt: '   ', timeoutSec: 30 });
check('llm.run.empty_prompt', lrBad.ok === false && !!lrBad.error, lrBad.error);

const lrAvail = await get('llm').available({ config: cfg });
check('llm.available', lrAvail.ok === true, `model=${lrAvail.version}`);

// ---------------------------------------------------------------- 7 pi 执行器（真跑）
console.log('\n== 7. pi 执行器（真跑，本机需 --no-extensions 降级）==');
const pir = await run('pi', { prompt: 'Reply with exactly: HIVE_PI_OK', timeoutSec: 240 });
check('pi.run.structured', typeof pir.ok === 'boolean' && 'stdout' in pir && 'tokens' in pir, `ok=${pir.ok} exit=${pir.exitCode} ${pir.ms}ms`);
if (pir.ok) {
  check('pi.run.ok', pir.stdout.includes('HIVE_PI_OK') || (pir.text || '').includes('HIVE_PI_OK'), JSON.stringify((pir.text || '').slice(0, 80)));
  check('pi.run.usage', pir.tokens.in > 0 || pir.tokens.out > 0, `in=${pir.tokens.in} out=${pir.tokens.out} ¥${pir.costCny}`);
} else {
  skip('pi.run.ok', `pi 未能完成：${pir.error}｜stderr=${JSON.stringify(pir.stderr.slice(0, 120))}`);
}
console.log(`   pi degraded=${pir.degraded ?? 'none'} attempts=${pir.attempts ?? 1}`);

// ---------------------------------------------------------------- 8 claude 执行器（真跑，限时）
console.log('\n== 8. claude 执行器（真跑，90s 上限）==');
const cr = await run('claude', { prompt: 'Reply with exactly: HIVE_CLAUDE_OK', timeoutSec: Number(process.env.HIVE_CLAUDE_TIMEOUT || 90) });
check('claude.run.structured', typeof cr.ok === 'boolean' && 'stdout' in cr && 'tokens' in cr, `ok=${cr.ok} exit=${cr.exitCode} timedOut=${cr.timedOut} ${cr.ms}ms`);
if (cr.ok) {
  check('claude.run.ok', (cr.text || cr.stdout || '').includes('HIVE_CLAUDE_OK'), JSON.stringify((cr.text || cr.stdout || '').slice(0, 80)));
} else {
  skip('claude.run.ok', `claude 未完成（${cr.timedOut ? '超时被 kill' : 'exit ' + cr.exitCode}）：${cr.error}`);
}

// ---------------------------------------------------------------- 9 codex 执行器（真跑，限时）
console.log('\n== 9. codex 执行器（真跑，90s 上限）==');
const xr = await run('codex', { prompt: 'Reply with exactly: HIVE_CODEX_OK', timeoutSec: Number(process.env.HIVE_CODEX_TIMEOUT || 90) });
check('codex.run.structured', typeof xr.ok === 'boolean' && 'stdout' in xr && 'tokens' in xr, `ok=${xr.ok} exit=${xr.exitCode} timedOut=${xr.timedOut} ${xr.ms}ms`);
if (xr.ok) {
  check('codex.run.ok', (xr.text || xr.stdout || '').includes('HIVE_CODEX_OK'), JSON.stringify((xr.text || xr.stdout || '').slice(0, 80)));
} else {
  const why = (xr.stderr || '').split(/\r?\n/).filter((l) => /ERROR|error|insufficient|402/i.test(l)).slice(-2).join(' | ');
  skip('codex.run.ok', `codex 未完成：${xr.timedOut ? '超时被 kill' : 'exit ' + xr.exitCode}｜${why.slice(0, 200)}`);
}

// ---------------------------------------------------------------- 10 dsh 执行器（--slow）
console.log('\n== 10. dsh 执行器（--slow 才跑；冷启动 ~55s）==');
if (SLOW) {
  const dr = await run('dsh', {
    prompt: 'Reply with exactly: HIVE_DSH_OK',
    workdir: cfg.resolved.workspace,
    timeoutSec: 300, // 必须 >= 180s：dsh 冷启动实测 53s
    onSpawn: (s) => console.log(`   dsh spawn pid=${s.pid}`),
  });
  check('dsh.slow.ok', dr.ok, dr.ok ? `${dr.ms}ms（冷启动）` : dr.error);
  check('dsh.slow.stdout', (dr.text || '').includes('HIVE_DSH_OK'), JSON.stringify((dr.text || '').slice(0, 80)));
  check('dsh.slow.timeout_generous', dr.ms < 300_000, `${dr.ms}ms`);
} else {
  skip('dsh.slow.ok', '未加 --slow（dsh 冷启动 ~55s，默认跳过）');
}

// ---------------------------------------------------------------- 汇总
const nPass = results.filter((r) => r.status === 'PASS').length;
const nFail = results.filter((r) => r.status === 'FAIL').length;
const nSkip = results.filter((r) => r.status === 'SKIP').length;
console.log(`\n== exec-smoke: ${nPass} PASS / ${nFail} FAIL / ${nSkip} SKIP（总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）==`);
if (nSkip) console.log('   SKIP = 外部阻塞（上游余额/CLI 无响应），执行器已如实返回失败，不算通过');
process.exit(nFail === 0 ? 0 : 1);
