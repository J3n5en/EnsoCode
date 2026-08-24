import type { ProjectedMessage } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import { computeStats, formatTokens } from './stats';

const assistant = (
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
  stopReason = 'stop'
): ProjectedMessage => ({ role: 'assistant', content: [], stopReason, usage });

describe('computeStats', () => {
  it('累计多条 assistant 的用量，缓存命中率按计费输入算', () => {
    const stats = computeStats(
      [
        { role: 'user', content: [] },
        assistant({ input: 10, output: 7, cacheRead: 90, cacheWrite: 100 }),
        assistant({ input: 0, output: 3, cacheRead: 100, cacheWrite: 0 }),
      ],
      10_000
    );
    expect(stats.turns).toBe(2);
    expect(stats.inputTokens).toBe(300);
    expect(stats.outputTokens).toBe(10);
    // (90 + 100) / 300
    expect(stats.cacheHitPercent).toBe(63);
    expect(stats.tokensPerSecond).toBe(1);
  });

  it('无计费输入时缓存命中率为 null，不显示 0%', () => {
    const stats = computeStats(
      [assistant({ input: 0, output: 7, cacheRead: 0, cacheWrite: 0 })],
      1000
    );
    expect(stats.cacheHitPercent).toBeNull();
  });

  it('无计时或无输出时吞吐为 null', () => {
    expect(
      computeStats([assistant({ input: 1, output: 5, cacheRead: 0, cacheWrite: 0 })], 0)
        .tokensPerSecond
    ).toBeNull();
    expect(computeStats([], 5000).tokensPerSecond).toBeNull();
  });

  it('流式中（无 stopReason）的消息不计入 turns，但用量照常累计', () => {
    const stats = computeStats(
      [
        {
          role: 'assistant',
          content: [],
          usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      1000
    );
    expect(stats.turns).toBe(0);
    expect(stats.outputTokens).toBe(2);
  });
});

describe('formatTokens', () => {
  it('按量级压缩显示', () => {
    expect(formatTokens(517)).toBe('517');
    expect(formatTokens(12_240)).toBe('12.2K');
    expect(formatTokens(517_000)).toBe('517K');
    expect(formatTokens(1_230_000)).toBe('1.2M');
  });
});
