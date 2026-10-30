import { describe, expect, it } from 'vitest';
import { PREVIEW_BAR, PREVIEW_MIN_WIDTH, placePreview, previewSize } from './appPreviewLayout';

describe('previewSize', () => {
  it('按目标窗口比例缩进上限，底部留标题栏', () => {
    expect(previewSize({ width: 1600, height: 1000 })).toEqual({
      width: 320,
      height: 200 + PREVIEW_BAR,
    });
    expect(previewSize({ width: 600, height: 1200 })).toEqual({
      width: 120,
      height: 240 + PREVIEW_BAR,
    });
  });

  it('拿不到尺寸或尺寸异常时用 16:10 默认', () => {
    expect(previewSize(undefined)).toEqual({ width: 320, height: 200 + PREVIEW_BAR });
    expect(previewSize({ width: 0, height: 0 })).toEqual({ width: 320, height: 200 + PREVIEW_BAR });
  });

  it('极窄的窗口也不小于最小宽度', () => {
    expect(previewSize({ width: 100, height: 2000 }).width).toBe(PREVIEW_MIN_WIDTH);
  });
});

describe('placePreview', () => {
  const area = { x: 0, y: 25, width: 1440, height: 875 };
  const size = { width: 320, height: 228 };

  it('默认贴在工作区右下角', () => {
    expect(placePreview(area, size)).toEqual({ x: 1440 - 16 - 320, y: 900 - 16 - 228, ...size });
  });

  it('用户拖过后按右下角锚点保持位置，尺寸变化时向左上长', () => {
    expect(placePreview(area, size, { right: 1000, bottom: 600 })).toEqual({
      x: 680,
      y: 372,
      ...size,
    });
  });

  it('锚点超出工作区时收回屏内', () => {
    expect(placePreview(area, size, { right: 5000, bottom: -100 })).toEqual({
      x: 1440 - 320,
      y: 25,
      ...size,
    });
  });
});
