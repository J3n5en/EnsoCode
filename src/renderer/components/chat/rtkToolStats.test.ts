import { describe, expect, it } from 'vitest';
import { rtkSavings } from './rtkToolStats';

describe('rtkSavings', () => {
  it('按 RTK 的输入/输出估算计算节省量与百分比', () => {
    expect(rtkSavings({ inputTokens: 1_000, outputTokens: 250 })).toEqual({
      tokens: 750,
      percent: 75,
    });
  });

  it('输出大于输入时节省量下限为零', () => {
    expect(rtkSavings({ inputTokens: 100, outputTokens: 120 })).toEqual({
      tokens: 0,
      percent: 0,
    });
  });

  it('任一计数未知时不伪装成零节省，输入为零时不伪造百分比', () => {
    expect(rtkSavings({ inputTokens: 1_000 })).toBeNull();
    expect(rtkSavings({ outputTokens: 250 })).toBeNull();
    expect(rtkSavings({ inputTokens: 0, outputTokens: 0 })).toEqual({
      tokens: 0,
      percent: null,
    });
  });
});
