// src/executors/shell.mjs — PowerShell 执行器
//
// 命令：`pwsh -NoProfile -Command "<script>"`（cwd = 任务工作区）
// 用途：确定性收尾动作（git status / 列目录 / 跑测试 / 写文件…），不经过 LLM。
//
// 本机坑：控制台代码页是 936，pwsh 直接输出中文会变成 UTF-8 解码乱码。
// 所以脚本前面拼一段固定前缀，把 OutputEncoding 强制成 UTF-8（可用 ctx.utf8=false 关掉）。

import { createCliExecutor } from './agent.mjs';

const UTF8_PREFIX = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8;';

function transformPrompt(prompt, { ctx }) {
  if (ctx?.utf8 === false) return prompt;
  // 已经自己设过编码就不重复拼
  if (/Console\]::OutputEncoding/i.test(prompt)) return prompt;
  return `${UTF8_PREFIX}\n${prompt}`;
}

export default createCliExecutor({
  name: 'shell',
  command: 'pwsh',
  args: ['-NoProfile', '-Command'],
  // PowerShell 没有 --version，跑一段小脚本取版本
  versionArgs: ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'],
  timeoutSec: 300,
  transformPrompt,
  parse(stdout) {
    const text = String(stdout || '').trim();
    return { text, tokens: { in: 0, out: 0 }, costCny: 0, result: { text } };
  },
});
