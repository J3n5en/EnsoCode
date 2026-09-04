import { describe, expect, it } from 'vitest';
import { ensureAssistantUsage } from './assistantUsage';

describe('ensureAssistantUsage', () => {
  it('给缺 usage 的 assistant 补上空对象，避免读 totalTokens 崩', () => {
    const assistant = { role: 'assistant', content: [{ type: 'text', text: 'hi' }] };
    const patched = ensureAssistantUsage([{ role: 'user', content: 'q' }, assistant]);
    expect(patched).toBe(1);
    expect(assistant).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
  });

  it('usage 缺 totalTokens/cost 时补齐，不覆盖已有计数', () => {
    const assistant = {
      role: 'assistant',
      usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1 },
    };
    expect(ensureAssistantUsage([assistant])).toBe(1);
    expect(assistant.usage).toEqual({
      input: 10,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 17,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
  });

  it('完整 usage 不改动', () => {
    const usage = {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const assistant = { role: 'assistant', usage };
    expect(ensureAssistantUsage([assistant])).toBe(0);
    expect(assistant.usage).toBe(usage);
  });
});
