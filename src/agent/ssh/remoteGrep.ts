/**
 * 远程 grep:SDK 的 grep 工具搜索本体是本地 spawn ripgrep(GrepOperations 只覆盖
 * 辅助读文件),无法经 operations 注入远端——这里复用原厂 ToolDefinition 的
 * schema/渲染,仅替换 execute 为远端 rg/grep 脚本。
 */

import { createGrepToolDefinition, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { SshExecutor } from './executor';
import { buildRemoteGrepScript, type RemoteGrepParams } from './remoteOperations';

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
      const script = buildRemoteGrepScript(params as RemoteGrepParams, cwd, engine);
      const result = await executor.exec(script, { signal });
      // rg/grep 无命中退出码 1,不是错误;>1 才是真失败
      if (result.code > 1) {
        throw new Error(result.stderr.trim() || `remote grep failed (code ${result.code})`);
      }
      const text = result.stdout.replace(/\n+$/, '');
      return { content: [{ type: 'text', text: text || 'No matches found' }], details: undefined };
    },
  };
}
