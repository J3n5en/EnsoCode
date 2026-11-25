import type { SettingsDeepLink, SettingsOpenRequest } from '@shared/settingsDeepLink';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { isServerMode, leaveServerMode } from '../services/appServerMode';
import { sendToWindow } from './createAppWindow';
import { focusMainWindow, getMainWindow } from './MainWindow';

let pending: SettingsOpenRequest | null = null;

/**
 * 本机所有「打开设置」入口（托盘、应用菜单、enso:// 深链）：唤起主窗口后在里面原地打开。
 * 托盘态先退出托盘，主窗口没有就新建。请求先暂存再推送：已挂载的渲染层收到推送来取，
 * 新建的渲染层挂载时取，两条路取的是同一份，只生效一次。
 */
export function openSettingsInMainWindow(link: SettingsDeepLink | null = null): void {
  pending = { link };
  if (isServerMode()) leaveServerMode();
  else focusMainWindow();
  const win = getMainWindow();
  if (win && !win.isDestroyed()) sendToWindow(win, IPC_CHANNELS.SETTINGS_DEEP_LINK);
}

export function takeSettingsOpenRequest(): SettingsOpenRequest | null {
  const request = pending;
  pending = null;
  return request;
}
