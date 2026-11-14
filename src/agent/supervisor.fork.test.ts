import { describe, expect, it } from 'vitest';
import { forkRunnable } from './supervisor';

const child = (active: string[], callable: string[]) =>
  ({
    agent: { state: { tools: active.map((name) => ({ name })) } },
    getCallableToolNames: () => callable,
  }) as unknown as Parameters<typeof forkRunnable>[0];

describe('forkRunnable', () => {
  it('只放行子会话真有的只读工具', () => {
    expect([...forkRunnable(child(['read', 'grep', 'explore_mark'], ['read', 'grep']))]).toEqual([
      'read',
      'grep',
    ]);
  });

  it('codemode 脚本能调的全是只读工具（或脚本禁用的工具）时放行', () => {
    const tools = ['read', 'grep', 'find', 'ls', 'codemode', 'explore_mark', 'explore_fold'];
    expect(forkRunnable(child(tools, tools)).has('codemode')).toBe(true);
  });

  it('codemode 脚本能调到写入或命令工具时不放行', () => {
    expect(
      forkRunnable(child(['read', 'codemode'], ['read', 'codemode', 'bash'])).has('codemode')
    ).toBe(false);
    expect(forkRunnable(child(['read', 'codemode'], ['read', 'write'])).has('codemode')).toBe(
      false
    );
  });
});
