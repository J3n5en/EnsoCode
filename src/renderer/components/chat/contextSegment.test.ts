import { describe, expect, it } from 'vitest';
import { contextSegmentUsed } from './contextSegment';

describe('contextSegmentUsed', () => {
  it('存在 occupancy 时读取其 used 字段', () => {
    expect(contextSegmentUsed({ used: 4200 })).toBe(4200);
  });

  it('used 为 0 时也如实返回 0（不当作缺失处理）', () => {
    expect(contextSegmentUsed({ used: 0 })).toBe(0);
  });

  it('occupancy 缺失（undefined）时返回 null，不回退到最近一次 assistant usage', () => {
    expect(contextSegmentUsed(undefined)).toBeNull();
  });

  it('occupancy 为 null 时返回 null', () => {
    expect(contextSegmentUsed(null)).toBeNull();
  });
});
