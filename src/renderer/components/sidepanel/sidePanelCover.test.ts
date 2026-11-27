import { describe, expect, it } from 'vitest';
import { sidePanelCoversMain } from './sidePanelCover';

describe('sidePanelCoversMain', () => {
  it('面板关闭时不覆盖主内容区', () => {
    expect(sidePanelCoversMain({ open: false, fullscreen: false, isMobile: false })).toBe(false);
    expect(sidePanelCoversMain({ open: false, fullscreen: true, isMobile: false })).toBe(false);
    expect(sidePanelCoversMain({ open: false, fullscreen: false, isMobile: true })).toBe(false);
  });

  it('桌面端并排打开时不覆盖主内容区', () => {
    expect(sidePanelCoversMain({ open: true, fullscreen: false, isMobile: false })).toBe(false);
  });

  it('桌面端全屏打开时覆盖主内容区', () => {
    expect(sidePanelCoversMain({ open: true, fullscreen: true, isMobile: false })).toBe(true);
  });

  it('手机端只要打开右侧栏就全宽覆盖主内容区，即使未显式切全屏', () => {
    expect(sidePanelCoversMain({ open: true, fullscreen: false, isMobile: true })).toBe(true);
    expect(sidePanelCoversMain({ open: true, isMobile: true })).toBe(true);
  });
});
