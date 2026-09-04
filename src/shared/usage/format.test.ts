import { describe, expect, it } from 'vitest';
import { formatCost, formatDelta, formatDurationMs, formatTokens } from './format';

describe('formatTokens', () => {
  it('小于 1000 原样返回', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
  });

  it('千级带 K 后缀，去掉多余的 .0', () => {
    expect(formatTokens(240_000)).toBe('240K');
    expect(formatTokens(1_000)).toBe('1K');
  });

  it('百万级带 M 后缀，保留一位小数', () => {
    expect(formatTokens(1_500_000)).toBe('1.5M');
    expect(formatTokens(1_000_000)).toBe('1M');
  });

  it('十亿级带 B 后缀，保留一位小数', () => {
    expect(formatTokens(3_100_000_000)).toBe('3.1B');
    expect(formatTokens(1_000_000_000)).toBe('1B');
  });

  it('临界值 999999 四舍五入后进位为 M', () => {
    expect(formatTokens(999_999)).toBe('1M');
  });

  it('四舍五入达到 1000K 时进位为 M', () => {
    expect(formatTokens(999_990)).toBe('1M');
  });

  it('四舍五入达到 1000M 时进位为 B', () => {
    expect(formatTokens(999_999_999)).toBe('1B');
  });
});

describe('formatCost', () => {
  it('null 显示为长横线', () => {
    expect(formatCost(null)).toBe('—');
  });

  it('小于 1000 保留两位小数', () => {
    expect(formatCost(12.345)).toBe('$12.35');
  });

  it('千以上用 k 缩写，避免统计卡溢出', () => {
    expect(formatCost(1911.876)).toBe('$1.9k');
    expect(formatCost(2312.36)).toBe('$2.3k');
  });

  it('百万以上用 M', () => {
    expect(formatCost(1_500_000)).toBe('$1.5M');
  });

  it('很小的费用四舍五入为 $0.00', () => {
    expect(formatCost(0.004)).toBe('$0.00');
  });

  it('0 显示为 $0.00', () => {
    expect(formatCost(0)).toBe('$0.00');
  });
});

describe('formatDurationMs', () => {
  it('0 显示为 0m', () => {
    expect(formatDurationMs(0)).toBe('0m');
  });

  it('不足 60 秒仍显示 0m', () => {
    expect(formatDurationMs(59_000)).toBe('0m');
  });

  it('小时与分钟组合', () => {
    expect(formatDurationMs(35_460_000)).toBe('9h 51m');
  });

  it('超过一天也只按小时累加，不折算成天', () => {
    expect(formatDurationMs(4_654_740_000)).toBe('1292h 59m');
  });
});

describe('formatDelta', () => {
  it('prev 为 null 或 undefined 时返回 null', () => {
    expect(formatDelta(null, 10)).toBeNull();
    expect(formatDelta(undefined, 10)).toBeNull();
  });

  it('两者皆为 0 时返回 null', () => {
    expect(formatDelta(0, 0)).toBeNull();
  });

  it('prev 为 0 且 cur 大于 0 时返回 new', () => {
    expect(formatDelta(0, 5)).toBe('new');
  });

  it('增长时带正号，保留一位小数', () => {
    expect(formatDelta(100, 186.4)).toBe('+86.4%');
  });

  it('下降时带负号，保留一位小数', () => {
    expect(formatDelta(100, 63.1)).toBe('-36.9%');
  });

  it('|变化幅度| < 0.05% 时不带符号', () => {
    expect(formatDelta(100, 99.96)).toBe('0.0%');
  });

  it('prev 与 cur 相等且都不为 0 时不带符号', () => {
    expect(formatDelta(100, 100)).toBe('0.0%');
  });
});
