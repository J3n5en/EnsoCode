import { describe, expect, it } from 'vitest';
import { FrameError } from './errors';
import {
  captureSourceRect,
  mapScreenshotPoint,
  scaleCaptureSize,
  screenshotCaption,
} from './frame';

describe('mapScreenshotPoint', () => {
  it('没有该 target 的截图就拒绝猜坐标', () => {
    expect(() => mapScreenshotPoint(new Map(), 'w1', 10, 10)).toThrow(FrameError);
  });

  it('按截图缩放映回屏幕坐标', () => {
    const frames = new Map([
      [
        'w1',
        {
          target: 'w1',
          width: 100,
          height: 50,
          sourceWidth: 200,
          sourceHeight: 100,
          originX: 40,
          originY: 80,
        },
      ],
    ]);
    expect(mapScreenshotPoint(frames, 'w1', 10, 5)).toEqual({ screenX: 60, screenY: 90 });
  });

  const frame100x50 = () =>
    new Map([
      [
        'w1',
        {
          target: 'w1',
          width: 100,
          height: 50,
          sourceWidth: 200,
          sourceHeight: 100,
          originX: 40,
          originY: 80,
        },
      ],
    ]);

  // 审计发现：只检查是否为有限数，100000、1e9 这样的坐标原样映射到屏幕，
  // 后台拖拽按 12px 插值时点数和耗时随之暴涨（1e9 时主进程 OOM）
  it('坐标远离最近截图时拒绝，不把离谱的数映射到屏幕', () => {
    expect(() => mapScreenshotPoint(frame100x50(), 'w1', 100_000, 10)).toThrow(FrameError);
  });

  it('略出截图边缘的坐标照常映射：拖拽终点、拖窗口边缘可能落在目标窗口外', () => {
    expect(mapScreenshotPoint(frame100x50(), 'w1', -50, 75)).toEqual({
      screenX: -60,
      screenY: 230,
    });
  });
});

describe('scaleCaptureSize', () => {
  it('不超过上限时保持原尺寸', () => {
    expect(scaleCaptureSize(800, 600, 1280, 896)).toEqual({ width: 800, height: 600 });
  });

  it('按比例缩小到安全框', () => {
    expect(scaleCaptureSize(2560, 1792, 1280, 896)).toEqual({ width: 1280, height: 896 });
  });
});
describe('screenshotCaption', () => {
  it('写出截图像素、源尺寸和 scale，并说明 click 用截图坐标', () => {
    expect(
      screenshotCaption({
        target: 'w1',
        width: 100,
        height: 50,
        sourceWidth: 200,
        sourceHeight: 100,
      })
    ).toBe('w1 100×50 (source 200×100, scale 2.00). click(x,y) uses these screenshot pixels.');
  });
});

describe('captureSourceRect', () => {
  it('桌面截图用 display bounds，不用缩略图尺寸', () => {
    expect(
      captureSourceRect({
        target: 'desktop',
        thumbnailWidth: 1280,
        thumbnailHeight: 832,
        display: { x: 0, y: 0, width: 1470, height: 956 },
      })
    ).toEqual({ originX: 0, originY: 0, sourceWidth: 1470, sourceHeight: 956 });
  });
});
