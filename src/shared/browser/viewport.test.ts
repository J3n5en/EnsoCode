import { describe, expect, it } from 'vitest';
import { parseBrowserViewport } from './viewport';

describe('parseBrowserViewport', () => {
  it('接受有限的正矩形，取整', () => {
    expect(parseBrowserViewport({ x: 10.4, y: 20.6, width: 300.2, height: 400 })).toEqual({
      x: 10,
      y: 21,
      width: 300,
      height: 400,
    });
  });
  it('拒绝 NaN / 负数 / 超大 / 多余字段 / 非对象', () => {
    expect(parseBrowserViewport(null)).toBeNull();
    expect(parseBrowserViewport({ x: Number.NaN, y: 0, width: 1, height: 1 })).toBeNull();
    expect(parseBrowserViewport({ x: -1, y: 0, width: 1, height: 1 })).toBeNull();
    expect(parseBrowserViewport({ x: 0, y: 0, width: 0, height: 1 })).toBeNull();
    expect(parseBrowserViewport({ x: 0, y: 0, width: 50000, height: 1 })).toBeNull();
    expect(parseBrowserViewport({ x: 0, y: 0, width: 1, height: 1, z: 1 })).toBeNull();
  });
});
