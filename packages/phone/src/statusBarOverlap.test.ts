import { describe, expect, it } from 'vitest';
import { isStatusBarOverlap, stripViewportFitCover } from './statusBarOverlap';

/** iPhone 17 Pro Max 竖屏独立 PWA 的真机测量值（iOS 27.2） */
const normal = {
  appleMobile: true,
  standalone: true,
  safeTop: 0,
  innerWidth: 440,
  innerHeight: 894,
  screenWidth: 440,
  screenHeight: 956,
};
const overlapped = { ...normal, safeTop: 62, innerHeight: 956 };

describe('isStatusBarOverlap', () => {
  it('正常态：页面在状态栏之下，不处理', () => {
    expect(isStatusBarOverlap(normal)).toBe(false);
  });

  it('异常态：顶部安全区非零且页面铺满整屏', () => {
    expect(isStatusBarOverlap(overlapped)).toBe(true);
  });

  it('允许亚像素误差', () => {
    expect(isStatusBarOverlap({ ...overlapped, innerHeight: 955.5 })).toBe(true);
  });

  it('键盘弹起时视口变矮，不误判', () => {
    expect(isStatusBarOverlap({ ...overlapped, innerHeight: 478 })).toBe(false);
  });

  it('普通浏览器标签页不处理', () => {
    expect(isStatusBarOverlap({ ...overlapped, standalone: false })).toBe(false);
  });

  it('非 iOS 设备不处理', () => {
    expect(isStatusBarOverlap({ ...overlapped, appleMobile: false })).toBe(false);
  });

  it('横屏不处理', () => {
    expect(
      isStatusBarOverlap({ ...overlapped, safeTop: 20, innerWidth: 956, innerHeight: 440 })
    ).toBe(false);
  });
});

describe('stripViewportFitCover', () => {
  it('去掉 viewport-fit，保留其余配置', () => {
    expect(
      stripViewportFitCover(
        'width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1'
      )
    ).toBe('width=device-width, initial-scale=1, maximum-scale=1');
  });

  it('大小写与空白不敏感', () => {
    expect(stripViewportFitCover('width=device-width,Viewport-Fit = cover')).toBe(
      'width=device-width'
    );
  });

  it('没有 viewport-fit 时保持原样', () => {
    expect(stripViewportFitCover('width=device-width, initial-scale=1')).toBe(
      'width=device-width, initial-scale=1'
    );
  });
});
