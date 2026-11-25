import { ipcMain } from '@platform';
import { IPC_CHANNELS, type OpenDevToolsResult } from '@shared/types/ipc';
import { getWindowWebContents } from '../windows/createAppWindow';
import { getMainWindow } from '../windows/MainWindow';
import { isVerifyLaunch } from '../windows/verifyLaunch';

/** 仅允许本机主窗口 UI 触发，拒绝内嵌网页、远程节点窗口等其他调用者 */
function isAllowedSender(senderId: unknown): boolean {
  if (typeof senderId !== 'number') return false;
  const main = getMainWindow();
  if (main && !main.isDestroyed()) {
    const mainContents = getWindowWebContents(main);
    if (!mainContents.isDestroyed() && mainContents.id === senderId) return true;
  }
  return false;
}

/** 主窗口 UI 的 webContents 打开独立 DevTools；已开着就提到前面 */
function openMainDevTools(): OpenDevToolsResult {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return { ok: false, error: 'main-window-unavailable' };
  const contents = getWindowWebContents(win);
  if (contents.isDestroyed()) return { ok: false, error: 'main-window-unavailable' };
  const verify = isVerifyLaunch();
  try {
    if (contents.isDevToolsOpened()) {
      if (!verify) contents.devToolsWebContents?.focus();
    } else {
      contents.openDevTools(verify ? { mode: 'detach', activate: false } : { mode: 'detach' });
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function registerDevToolsHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.WINDOW_OPEN_DEV_TOOLS, (event, ...args: unknown[]) => {
    if (!isAllowedSender(event?.sender?.id)) return { ok: false, error: 'forbidden' };
    return args.length === 0 ? openMainDevTools() : { ok: false, error: 'invalid-arguments' };
  });
}
