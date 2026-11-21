import type { BrowserWindow } from 'electron';

/**
 * computer 浮窗跨 Space、全屏之上也可见。
 * macOS 上不带 skipTransformProcessType 时 Electron 会把整个 App 转成 accessory：
 * Dock 图标消失、主窗口被压到别的 App 下面，托盘却仍以为窗口在前台。
 */
export function showOnAllSpaces(win: Pick<BrowserWindow, 'setVisibleOnAllWorkspaces'>): void {
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
}
