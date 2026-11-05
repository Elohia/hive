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
  fs.copyFileSync(s, path.join(runtime, to));
  files++;
  console.log('  ✓ 文件', from, '→ runtime/' + to);
}

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
