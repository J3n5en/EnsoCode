import type { BrowserWindow } from 'electron';
import { createAppWindow } from './createAppWindow';

let settingsWindow: BrowserWindow | null = null;

/** 设置窗口单例：已打开则聚焦，否则创建独立窗口 */
export function openSettingsWindow(): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.focus();
    return settingsWindow;
  }

  settingsWindow = createAppWindow({
    entry: 'settings',
    width: 960,
    height: 680,
    minWidth: 720,
    minHeight: 480,
    stateFile: 'settings-window-state.json',
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });

  return settingsWindow;
}

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow;
}
