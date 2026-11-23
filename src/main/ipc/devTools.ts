import { ipcMain } from '@platform';
import { IPC_CHANNELS } from '@shared/types';
import type { OpenDevToolsResult } from '@shared/types/ipc';
import { getWindowWebContents } from '../windows/createAppWindow';
import { getMainWindow } from '../windows/MainWindow';

/** 主窗口 UI 的 webContents 打开独立 DevTools；已开着就提到前面 */
function openMainDevTools(): OpenDevToolsResult {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return { ok: false, error: 'main-window-unavailable' };
  const contents = getWindowWebContents(win);
  if (contents.isDestroyed()) return { ok: false, error: 'main-window-unavailable' };
  try {
    if (contents.isDevToolsOpened()) contents.devToolsWebContents?.focus();
    else contents.openDevTools({ mode: 'detach' });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function registerDevToolsHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.WINDOW_OPEN_DEV_TOOLS, (_event, ...args: unknown[]) =>
    args.length === 0 ? openMainDevTools() : { ok: false, error: 'invalid-arguments' }
  );
}
