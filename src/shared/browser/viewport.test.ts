import { describe, expect, it } from 'vitest';
import { parseBrowserViewport, viewportToDip } from './viewport';

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
  it('可选圆角：取整收下，越界或非数整体拒绝', () => {
    expect(parseBrowserViewport({ x: 0, y: 0, width: 1, height: 1, radius: 9.6 })).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      radius: 10,
    });
    expect(parseBrowserViewport({ x: 0, y: 0, width: 1, height: 1, radius: -1 })).toBeNull();
    expect(parseBrowserViewport({ x: 0, y: 0, width: 1, height: 1, radius: 999 })).toBeNull();
    expect(parseBrowserViewport({ x: 0, y: 0, width: 1, height: 1, radius: '4' })).toBeNull();
  });
});

describe('viewportToDip', () => {
  it('按 renderer 缩放把 CSS px 换成窗口 DIP，四边各自取整不留缝', () => {
    const zoom = 1.2 ** -0.5;
    expect(viewportToDip({ x: 1160, y: 117, width: 450, height: 894 }, zoom)).toEqual({
      x: 1059,
      y: 107,
      width: 411,
      height: 816,
    });
    expect(viewportToDip({ x: 10, y: 20, width: 300, height: 400 }, 1.5)).toEqual({
      x: 15,
      y: 30,
      width: 450,
      height: 600,
    });
  });
  it('圆角随缩放换算', () => {
    expect(viewportToDip({ x: 0, y: 0, width: 10, height: 10, radius: 12 }, 1.5)).toEqual({
      x: 0,
      y: 0,
      width: 15,
      height: 15,
      radius: 18,
    });
  });
  it('缩放为 1 / 非法时原样返回；null 透传', () => {
    const rect = { x: 1, y: 2, width: 3, height: 4 };
    expect(viewportToDip(rect, 1)).toEqual(rect);
    expect(viewportToDip(rect, Number.NaN)).toEqual(rect);
    expect(viewportToDip(rect, 0)).toEqual(rect);
    expect(viewportToDip(null, 2)).toBeNull();
  });
});
