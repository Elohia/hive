#!/usr/bin/env node
// scripts/sync-runtime.mjs — 把 D:\hive 的运行时（src/web/prompts/config）同步进插件包
// 用法：node scripts/sync-runtime.mjs
// 目的：插件可独立安装，不依赖用户机器上已有 D:\hive。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');            // dsh-plugin-hive/
const hiveRoot = path.resolve(pkgRoot, '..');        // D:\hive
const runtime = path.join(pkgRoot, 'runtime');

const COPY_DIRS = [
  ['src', 'src'],
  ['web', 'web'],
  ['prompts', 'prompts'],
];
const COPY_FILES = [
  ['config/hive.json', 'config-defaults/hive.json'],
  ['config/policies.json', 'config-defaults/policies.json'],
  ['VERSION', 'VERSION'],
];

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

function copyDir(from, to) {
  mkdirp(to);
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      copyDir(s, d);
    } else if (e.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

console.log('HIVE root   :', hiveRoot);
console.log('plugin root :', pkgRoot);
rmrf(runtime);
mkdirp(runtime);

let files = 0;
for (const [from, to] of COPY_DIRS) {
  const s = path.join(hiveRoot, from);
  if (!fs.existsSync(s)) { console.warn('  跳过（不存在）:', from); continue; }
  copyDir(s, path.join(runtime, to));
  files += countFiles(path.join(runtime, to));
  console.log('  ✓ 目录', from, '→ runtime/' + to);
}
for (const [from, to] of COPY_FILES) {
  const s = path.join(hiveRoot, from);
  if (!fs.existsSync(s)) { console.warn('  跳过（不存在）:', from); continue; }
  mkdirp(path.dirname(path.join(runtime, to)));
  const dst = path.join(runtime, to);
  fs.copyFileSync(s, dst);
  files++;
  console.log('  ✓ 文件', from, '→ runtime/' + to);
}

// —— 脱敏：写进包里的默认配置不能带我的个人路径/凭据位置 ——
function sanitizeConfigDefaults() {
  const cfgPath = path.join(runtime, 'config-defaults', 'hive.json');
  if (!fs.existsSync(cfgPath)) return;
  const j = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

  // 1) 凭据文件：不写死任何人的路径；插件模式本来就用宿主模型
  j.credentials = { file: '', keys: {} };

  // 2) 家目录：留空，运行时由插件注入 $DSH_HOME/hive
  j.home = '';

  // 3) 数据源里的绝对路径全部换成占位/空（新用户按自己的目录填）
  if (j.sources?.git) j.sources.git.repos = [];
  if (j.sources?.docs) j.sources.docs.roots = [];
  if (j.sources?.mail) j.sources.mail.enabled = false;
  if (j.sources?.calendar) j.sources.calendar.icsPaths = ['data/calendar/*.ics'];

  // 4) 凭据别名表里不要指向具体 ref 名以外的东西（refs 本机才有，这里留空）
  // 5) notify.mail.to 之类不能填
  if (j.notify?.mail) { j.notify.mail.to = ''; j.notify.mail.enabled = false; }

  // 6) llm 段：插件模式走宿主模型；独立模式需要用户自己填 provider/key
  if (j.llm) {
    j.llm.default = 'deepseek';
    for (const p of Object.values(j.llm.providers || {})) {
      if (p && 'keyRef' in p) p.keyRef = p.keyRef;
    }
  }

  // 6b) 执行器默认值：陌生人机器上不一定有 pwsh7 / pi / codex / claude，
  //     照搬作者本机的「全开」配置会让他们的自检一上来就一堆 WARN。
  //     默认只开「插件里一定能跑」的，其余留给用户在看板「Agent 依赖」里自己装、自己开。
  const isWin = process.platform === 'win32';
  j.executors = {
    llm: { enabled: true, kind: 'inline' },
    dsh: { enabled: true, kind: 'process', command: 'dsh', args: ['--profile', 'headless'] },
    pi: { enabled: false, kind: 'process', command: 'pi', note: '可选：装了 pi 后在看板「Agent 依赖」里开启' },
    codex: { enabled: false, kind: 'process', command: 'codex', note: '可选：装了 codex 后在看板「Agent 依赖」里开启' },
    claude: { enabled: false, kind: 'process', command: 'claude', note: '可选：装了 Claude Code 后在看板「Agent 依赖」里开启' },
    shell: { enabled: true, kind: 'process', command: isWin ? 'pwsh' : 'bash', args: isWin ? ['-NoProfile', '-Command'] : ['-lc'] },
    grok: { enabled: false, kind: 'http', bridgeUrl: 'http://127.0.0.1:8799', chat: '', note: '可选：本机装了 Grok Bot（D:\\bot\\bridge.mjs 消息桥）才开；它会在桌面会话里真的打字' },
    proc: { enabled: false, kind: 'process', command: '', note: '通用命令执行器：需要显式 command 再开启；自然语言任务不会被路由到这里' },
  };
  console.log('  ✓ 执行器默认值已收敛（开：llm/dsh/shell；关：pi/codex/claude/proc，由用户按需开启）');

  // 7) 抹掉任何残留的盘符路径
  const text = JSON.stringify(j, null, 2);
  if (/[A-Za-z]:\\\\/.test(text)) {
    console.warn('  ⚠ 脱敏后仍发现盘符路径，请人工检查 runtime/config-defaults/hive.json');
  }
  fs.writeFileSync(cfgPath, text, 'utf8');
  console.log('  ✓ 已脱敏 runtime/config-defaults/hive.json（去掉个人路径/凭据/收件人）');

  // policies：红线与白名单里的个人绝对路径也要中性化
  const polPath = path.join(runtime, 'config-defaults', 'policies.json');
  if (fs.existsSync(polPath)) {
    const p = JSON.parse(fs.readFileSync(polPath, 'utf8'));
    p.write_allowlist_dirs = [];
    p.never_touch = [];
    fs.writeFileSync(polPath, JSON.stringify(p, null, 2), 'utf8');
    console.log('  ✓ 已脱敏 runtime/config-defaults/policies.json（清空白名单/红线路径）');
  }
}
sanitizeConfigDefaults();

// —— 脱敏 2：源码里我本机的绝对路径换成中性占位（注释与默认值都换）——
// 这些路径指向的是「作者机器上的目录」，对使用者毫无意义且暴露个人目录结构。
// 换成不存在的占位路径后，相关传感器会因 fs.existsSync 失败而自然降级为「0 条信号」，
// 使用者可在自己的 config/hive.json 里填真实路径。
const PATH_TOKENS = [
  // 注意：替换值必须用正斜杠。JSON 里反斜杠是转义字符，写 C:\X 会变成非法 JSON。
  [/D:[\\/]+pi-agent/gi, 'C:/HIVE-SAMPLE/automations'],
  [/F:[\\/]+dsh-home/gi, 'C:/HIVE-SAMPLE/dsh-home'],
  [/D:[\\/]+elohia/gi, 'C:/HIVE-SAMPLE/workspace'],
  [/D:[\\/]+00-fish/gi, 'C:/HIVE-SAMPLE/misc'],
  [/D:[\\/]+dsh/gi, 'C:/HIVE-SAMPLE/dsh'],
];
function sanitizeSources() {
  let changed = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(mjs|js|json|md|yml|html|css)$/.test(e.name)) continue;
      let t = fs.readFileSync(p, 'utf8');
      const before = t;
      for (const [re, to] of PATH_TOKENS) t = t.replace(re, to);
      if (t !== before) { fs.writeFileSync(p, t, 'utf8'); changed++; }
    }
  };
  walk(path.join(runtime, 'src'));
  walk(path.join(runtime, 'config-defaults'));
  console.log(`  ✓ 源码脱敏：${changed} 个文件里的本机绝对路径已替换为中性占位`);
}
sanitizeSources();

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += countFiles(p);
    else n++;
  }
  return n;
}

console.log(`\n完成：runtime/ 共 ${files} 个文件，${(countBytes(runtime) / 1024).toFixed(1)} KB`);
function countBytes(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += countBytes(p);
    else n += fs.statSync(p).size;
  }
  return n;
}
