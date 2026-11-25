import { describe, expect, it } from 'vitest';
import { liftsIntoTitleRow } from './sidePanelTitleRow';

describe('liftsIntoTitleRow', () => {
  it('桌面外壳顶栏态且非窄屏时升进顶栏行', () => {
    expect(liftsIntoTitleRow({ titleRow: true, isMobile: false, settingsOpen: false })).toBe(true);
  });

  it('非顶栏外壳不升', () => {
    expect(liftsIntoTitleRow({ titleRow: false, isMobile: false, settingsOpen: false })).toBe(
      false
    );
  });

  it('窄屏不升', () => {
    expect(liftsIntoTitleRow({ titleRow: true, isMobile: true, settingsOpen: false })).toBe(false);
  });

  it('设置打开时回落进工作区：升出的 tab 条在设置层覆盖范围之外，会从顶栏残留露出', () => {
    expect(liftsIntoTitleRow({ titleRow: true, isMobile: false, settingsOpen: true })).toBe(false);
  });
});
