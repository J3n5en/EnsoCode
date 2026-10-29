import { describe, expect, it } from 'vitest';
import {
  COMPACT_RESERVE_TOKENS_MAX,
  COMPACT_RESERVE_TOKENS_MIN,
  parseCompactReserveTokens,
  parseCompactReserveTokensDraft,
} from './compactionSettings';

describe('parseCompactReserveTokens', () => {
  it('null 表示不写入，范围内整数原样接受', () => {
    expect(parseCompactReserveTokens(null)).toBeNull();
    expect(parseCompactReserveTokens(COMPACT_RESERVE_TOKENS_MIN)).toBe(COMPACT_RESERVE_TOKENS_MIN);
    expect(parseCompactReserveTokens(32768)).toBe(32768);
    expect(parseCompactReserveTokens(COMPACT_RESERVE_TOKENS_MAX)).toBe(COMPACT_RESERVE_TOKENS_MAX);
  });

  it('拒绝越界、非整数和非数字', () => {
    for (const bad of [
      COMPACT_RESERVE_TOKENS_MIN - 1,
      COMPACT_RESERVE_TOKENS_MAX + 1,
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '16384',
      undefined,
      {},
    ]) {
      expect(parseCompactReserveTokens(bad)).toBeUndefined();
    }
  });
});

describe('parseCompactReserveTokensDraft', () => {
  it('空白不写入，十进制整数按范围校验', () => {
    expect(parseCompactReserveTokensDraft('  ')).toBeNull();
    expect(parseCompactReserveTokensDraft(' 32768 ')).toBe(32768);
    for (const bad of ['1e5', '0x8000', '-4096', '4096.0', '3000', '70000', 'abc']) {
      expect(parseCompactReserveTokensDraft(bad)).toBeUndefined();
    }
  });
});
