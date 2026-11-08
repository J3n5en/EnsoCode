import { describe, expect, it } from 'vitest';
import { liveActivityFoldDelayMs, liveActivityFoldDelaySec } from './liveActivityFoldDelay';

describe('liveActivityFoldDelaySec', () => {
  it('缺省和脏值是 5 秒，过小过大收到 1 和 60', () => {
    expect(liveActivityFoldDelaySec(undefined)).toBe(5);
    expect(liveActivityFoldDelaySec(5.5)).toBe(5);
    expect(liveActivityFoldDelaySec(0)).toBe(1);
    expect(liveActivityFoldDelaySec(99)).toBe(60);
    expect(liveActivityFoldDelaySec(2)).toBe(2);
  });

  it('毫秒按收窄后的秒数换算', () => {
    expect(liveActivityFoldDelayMs(undefined)).toBe(5_000);
    expect(liveActivityFoldDelayMs(2)).toBe(2_000);
  });
});
