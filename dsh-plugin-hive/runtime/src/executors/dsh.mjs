// src/executors/dsh.mjs — DSH 无头执行器
//
// 命令：`dsh --profile headless "<prompt>"`（cwd = 任务工作区）
// 实测：冷启动约 53s，stdout 只打印最终回答，stderr 为空，退出码 0/非 0。
// 所以超时默认 900s（settings.defaultTimeoutSec），且必须容忍慢。

import { createCliExecutor } from './agent.mjs';

/** dsh headless 的 stdout 就是最终答案（没有 JSON 事件流），直接取全文 */
function parseDsh(stdout) {
  const text = String(stdout || '').trim();
  return {
    text,
    tokens: { in: 0, out: 0 }, // dsh 未向 stdout 输出 usage；成本按 0 记（见 README 说明）
    costCny: 0,
    result: { text },
    meta: { usage_unknown: true },
  };
}

export default createCliExecutor({
  name: 'dsh',
  command: 'dsh',
  args: ['--profile', 'headless'],
  versionArgs: ['--version'],
  timeoutSec: 900,
  parse: parseDsh,
});
