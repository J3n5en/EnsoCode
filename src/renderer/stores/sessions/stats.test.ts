import type { MessageTiming, ProjectedMessage } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import { computeStats, formatDuration, formatTokens } from './stats';

const assistant = (
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
  stopReason = 'stop',
  timing?: MessageTiming
): ProjectedMessage => ({ role: 'assistant', content: [], stopReason, usage, ...(timing ? { timing } : {}) });

const user = (): ProjectedMessage => ({ role: 'user', content: [] });

describe('computeStats', () => {
  it('轮=user 数，步=assistant 数，用量累计，缓存命中率按计费输入算', () => {
    const stats = computeStats([
      user(),
      assistant({ input: 10, output: 7, cacheRead: 90, cacheWrite: 100 }, 'tool_use'),
      assistant({ input: 0, output: 3, cacheRead: 100, cacheWrite: 0 }),
    ]);
    expect(stats.turns).toBe(1);
    expect(stats.steps).toBe(2);
    expect(stats.inputTokens).toBe(300);
    expect(stats.outputTokens).toBe(10);
    // (90 + 100) / 300
    expect(stats.cacheHitPercent).toBe(63);
  });

  it('无计费输入时缓存命中率为 null，不显示 0%', () => {
    const stats = computeStats([assistant({ input: 0, output: 7, cacheRead: 0, cacheWrite: 0 })]);
    expect(stats.cacheHitPercent).toBeNull();
  });

  it('从 timing 聚合 LLM/TTFT/吞吐；无 timing 时相关字段为 0/null', () => {
    const noTiming = computeStats([assistant({ input: 1, output: 5, cacheRead: 0, cacheWrite: 0 })]);
    expect(noTiming.llmMs).toBe(0);
    expect(noTiming.ttftAvgMs).toBeNull();
    expect(noTiming.tokensPerSecond).toBeNull();

    const withTiming = computeStats([
      assistant({ input: 1, output: 10, cacheRead: 0, cacheWrite: 0 }, 'stop', {
        stepStartMs: 1000,
        firstTokenMs: 1200,
        completedMs: 3000,
      }),
    ]);
    expect(withTiming.llmMs).toBe(2000);
    expect(withTiming.ttftAvgMs).toBe(200);
    // 10 tok / ((3000-1200)/1000)s = 5.56
    expect(withTiming.tokensPerSecond).toBe(5.6);
  });

  it('工具墙钟 = 同一轮内相邻 step 的间隙，跨轮尾不计', () => {
    const stats = computeStats([
      user(),
      // 第 1 步（非轮尾），完成于 2000
      assistant({ input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }, 'tool_use', {
        stepStartMs: 1000,
        firstTokenMs: 1100,
        completedMs: 2000,
      }),
      // 第 2 步开始于 2500 → 工具间隙 500；轮尾
      assistant({ input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }, 'stop', {
        stepStartMs: 2500,
        firstTokenMs: 2600,
        completedMs: 3000,
      }),
      user(),
      // 新一轮开始于 9000 → 与上一轮尾的间隙(6000)是用户等待，不计
      assistant({ input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }, 'stop', {
        stepStartMs: 9000,
        firstTokenMs: 9100,
        completedMs: 9500,
      }),
    ]);
    expect(stats.turns).toBe(2);
    expect(stats.steps).toBe(3);
    expect(stats.toolMs).toBe(500);
  });

  it('流式中（无 stopReason）的消息计入步数与用量', () => {
    const stats = computeStats([
      { role: 'assistant', content: [], usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0 } },
    ]);
    expect(stats.steps).toBe(1);
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

describe('formatDuration', () => {
  it('不足一分钟带一位小数的秒，其后分秒', () => {
    expect(formatDuration(1200)).toBe('1.2s');
    expect(formatDuration(45_200)).toBe('45.2s');
    expect(formatDuration(162_000)).toBe('2m42s');
  });
});
