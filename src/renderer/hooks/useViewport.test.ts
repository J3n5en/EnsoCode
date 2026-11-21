import { describe, expect, it } from 'vitest';
import { isMobileLayout, isMobileWidth, MOBILE_MAX_WIDTH } from './useViewport';

describe('isMobileWidth', () => {
  it('treats widths up to the md breakpoint as mobile', () => {
    expect(MOBILE_MAX_WIDTH).toBe(767);
    expect(isMobileWidth(375)).toBe(true);
    expect(isMobileWidth(767)).toBe(true);
  });

  it('keeps desktop widths (main window minWidth 800) non-mobile', () => {
    expect(isMobileWidth(768)).toBe(false);
    expect(isMobileWidth(800)).toBe(false);
    expect(isMobileWidth(1440)).toBe(false);
  });
});

describe('isMobileLayout', () => {
  it('触屏横屏仍用手机布局，直到比手机宽很多', () => {
    expect(isMobileLayout(844, true)).toBe(true);
    expect(isMobileLayout(1024, true)).toBe(true);
    expect(isMobileLayout(1025, true)).toBe(false);
  });

  it('鼠标指针按原断点，桌面窗口不受影响', () => {
    expect(isMobileLayout(767, false)).toBe(true);
    expect(isMobileLayout(800, false)).toBe(false);
  });
});
