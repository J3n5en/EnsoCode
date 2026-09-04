process.env.TZ = 'America/New_York';

import { describe, expect, it } from 'vitest';
import { aggregateUsage } from './aggregate';

// 2026-03-08 是美国东部时区当年的夏令时切换日（春季调快 1 小时），
// 只有在该时区、且 CI/开发机 ICU 数据支持时才有意义，否则跳过。
const dstActive =
  new Date(2026, 2, 8, 12).getTimezoneOffset() !== new Date(2026, 2, 7, 12).getTimezoneOffset();

describe.skipIf(!dstActive)('aggregateUsage — 跨夏令时的日边界（America/New_York）', () => {
  // now = 2026-03-09（切换日次日）本地 15:00
  const NOW = new Date(2026, 2, 9, 15, 0, 0, 0).getTime();

  it('rangeStart 按日历减 7 天取得，而不是用 7×24h 的毫秒数减出来的', () => {
    const summary = aggregateUsage([], [], {}, { days: 7, now: NOW });
    expect(summary.rangeStart).toBe(new Date(2026, 2, 3, 0, 0, 0, 0).getTime());
  });

  it('daily 恰好 7 个点，日期不重复，首尾正确覆盖切换日', () => {
    const summary = aggregateUsage([], [], {}, { days: 7, now: NOW });
    const days = summary.daily.map((point) => point.day);
    expect(days).toHaveLength(7);
    expect(new Set(days).size).toBe(7);
    expect(days[0]).toBe('2026-03-03');
    expect(days[days.length - 1]).toBe('2026-03-09');
  });

  it('切换日当天零点半的记录落在 daily 第一个点（跨切换不丢天/不错位）', () => {
    const ts = new Date(2026, 2, 3, 0, 30, 0, 0).getTime();
    const summary = aggregateUsage(
      [
        {
          id: 'e1',
          ts,
          model: 'claude-opus-5',
          provider: 'enso-anthropic',
          project: 'demo',
          sessionId: 's1',
          input: 100,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
        },
      ],
      [],
      {},
      { days: 7, now: NOW }
    );
    expect(summary.daily[0].input).toBe(100);
  });
});
