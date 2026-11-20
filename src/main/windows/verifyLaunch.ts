import { app, type BrowserWindow } from 'electron';

/**
 * 验收脚本拉起的实例（ENSO_VERIFY=1，仅未打包）：不进 Dock、不激活、窗口始终不显示。
 * 隐藏窗口里的页面照样能被 CDP 读写、点击、截图；脚本连上后开
 * Emulation.setFocusEmulationEnabled，页面才按可见且聚焦运行（否则 rAF 停摆）。
 */
export function isVerifyLaunch(): boolean {
  return !app.isPackaged && process.env.ENSO_VERIFY === '1';
}

export function showWindow(win: Pick<BrowserWindow, 'show'>): void {
  if (!isVerifyLaunch()) win.show();
}

/** 把窗口唤到前台 */
export function presentWindow(
  win: Pick<BrowserWindow, 'isMinimized' | 'restore' | 'show' | 'focus'>
): void {
  if (isVerifyLaunch()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
