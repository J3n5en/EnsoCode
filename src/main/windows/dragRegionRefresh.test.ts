import { describe, expect, it } from 'vitest';
import { shouldRefreshDragRegions } from './dragRegionRefresh';

describe('shouldRefreshDragRegions', () => {
  it('macOS 上只放行该窗口工作区 renderer', () => {
    // 主窗口 pin 了 workbench：发起方是 workbench（7），不是窗口自己的 webContents（1）
    expect(shouldRefreshDragRegions('darwin', 7, 7)).toBe(true);
    expect(shouldRefreshDragRegions('darwin', 1, 7)).toBe(false);
    expect(shouldRefreshDragRegions('darwin', 7, null)).toBe(false);
  });

  it('其他平台不重算', () => {
    expect(shouldRefreshDragRegions('win32', 7, 7)).toBe(false);
    expect(shouldRefreshDragRegions('linux', 7, 7)).toBe(false);
  });
});
