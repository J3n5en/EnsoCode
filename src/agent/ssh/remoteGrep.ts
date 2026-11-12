/**
 * 远程 grep:SDK 的 grep 工具搜索本体是本地 spawn ripgrep(GrepOperations 只覆盖
 * 辅助读文件),无法经 operations 注入远端——这里复用原厂 ToolDefinition 的
 * schema/渲染,仅替换 execute 为远端 rg/grep 脚本。
 */

import { createGrepToolDefinition, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { SshExecutor } from './executor';
import {
  buildRemoteGrepScript,
  REMOTE_GREP_DEFAULT_LIMIT,
  type RemoteGrepParams,
} from './remoteOperations';

/** 报错只带 stderr 摘要:grep -r 遇到大量不可读文件时 stderr 可能很长,不能整段塞给模型 */
const STDERR_SUMMARY_CHARS = 2000;

function stderrSummary(stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed.length <= STDERR_SUMMARY_CHARS) return trimmed;
  return `${trimmed.slice(0, STDERR_SUMMARY_CHARS)}\n…(stderr truncated)`;
}

export function createRemoteGrepToolDefinition(cwd: string, executor: SshExecutor): ToolDefinition {
  const base = createGrepToolDefinition(cwd) as unknown as ToolDefinition;
  let enginePromise: Promise<'rg' | 'grep'> | undefined;
  const detectEngine = (): Promise<'rg' | 'grep'> => {
    enginePromise ??= executor
      .exec('command -v rg')
      .then((result): 'rg' | 'grep' => (result.code === 0 ? 'rg' : 'grep'));
    return enginePromise;
  };

  return {
    ...base,
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const engine = await detectEngine();
      const grepParams = params as RemoteGrepParams;
      const script = buildRemoteGrepScript(grepParams, cwd, engine);
      const result = await executor.exec(script, { signal });
      // rg/grep 无命中退出码 1,不是错误;>1 才是真失败。例外:输出已满 limit 行说明 head 先退出了,
      // 之后 grep 再写会被 SIGPIPE 杀掉(141),远端忽略 SIGPIPE 时则以 EPIPE 退出 2,结果仍有效
      const lines = result.stdout.match(/\n/g)?.length ?? 0;
      const cutByHead = lines >= (grepParams.limit ?? REMOTE_GREP_DEFAULT_LIMIT);
      const text = result.stdout.replace(/\n+$/, '');
      // 退出码 2 且已有命中：有文件不可读，但已搜到的行仍然有效。无输出的 2（正则非法、路径不存在）仍报错。
      const partial = result.code === 2 && text.length > 0 && !cutByHead;
      if (result.code > 1 && !cutByHead && !partial) {
        const summary = stderrSummary(result.stderr);
        throw new Error(summary || `remote grep failed (code ${result.code})`);
      }
      const warning = partial ? stderrSummary(result.stderr) : '';
      const body = warning
        ? `${text}\n\n[remote grep: some paths were unreadable]\n${warning}`
        : text || 'No matches found';
      return { content: [{ type: 'text', text: body }], details: undefined };
    },
  };
}
