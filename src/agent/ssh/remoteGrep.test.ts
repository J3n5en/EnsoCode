import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import type { SshExecutor } from './executor';
import { createRemoteGrepToolDefinition } from './remoteGrep';

const ctx = undefined as unknown as ExtensionContext;

function fakeExecutor(handler: (command: string[] | string) => { stdout?: string; code?: number }) {
  const calls: (string[] | string)[] = [];
  const executor = {
    host: 'h',
    async exec(command: string[] | string) {
      calls.push(command);
      const r = handler(command);
      return { stdout: r.stdout ?? '', stderr: '', code: r.code ?? 0 };
    },
    async execRaw() {
      throw new Error('unused');
    },
    async execStream() {
      throw new Error('unused');
    },
  } as unknown as SshExecutor;
  return { calls, executor };
}

describe('createRemoteGrepToolDefinition', () => {
  it('保留原厂 schema/name;首次执行探测 rg 并缓存;输出透传', async () => {
    const { calls, executor } = fakeExecutor((cmd) => {
      if (typeof cmd === 'string' && cmd.includes('command -v rg'))
        return { stdout: '/usr/bin/rg' };
      return { stdout: 'src/a.ts:3:match line\n' };
    });
    const tool = createRemoteGrepToolDefinition('/srv/app', executor);
    expect(tool.name).toBe('grep');
    expect(tool.parameters).toBeDefined();

    const result = await tool.execute('t1', { pattern: 'match' }, undefined, undefined, ctx);
    expect(result.content).toEqual([{ type: 'text', text: 'src/a.ts:3:match line' }]);
    expect(calls.some((c) => typeof c === 'string' && c.includes('rg -n'))).toBe(true);

    await tool.execute('t2', { pattern: 'again' }, undefined, undefined, ctx);
    // rg 探测只发生一次
    expect(calls.filter((c) => typeof c === 'string' && c.includes('command -v rg'))).toHaveLength(
      1
    );
  });

  it('无 rg 时降级 grep;无命中输出 No matches', async () => {
    const { calls, executor } = fakeExecutor((cmd) => {
      if (typeof cmd === 'string' && cmd.includes('command -v rg')) return { code: 1 };
      return { stdout: '', code: 1 };
    });
    const tool = createRemoteGrepToolDefinition('/srv/app', executor);
    const result = await tool.execute('t1', { pattern: 'x' }, undefined, undefined, ctx);
    expect(calls.some((c) => typeof c === 'string' && c.includes('grep -rn'))).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringMatching(/no matches/i),
    });
  });
});
