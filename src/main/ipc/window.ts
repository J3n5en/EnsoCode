import { IPC_CHANNELS } from '@shared/types';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { TRAFFIC_LIGHT_POSITION } from '../windows/createAppWindow';
import { openSettingsWindow } from '../windows/SettingsWindow';

/** 窗口控制：所有 handler 作用于发起 IPC 的窗口，天然支持多窗口 */
export function registerWindowHandlers(): void {
  const senderWindow = (event: Electron.IpcMainInvokeEvent): BrowserWindow | null => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win && !win.isDestroyed() ? win : null;
  };

  ipcMain.handle(IPC_CHANNELS.DIALOG_SELECT_DIRECTORY, async (event): Promise<string | null> => {
    const win = senderWindow(event);
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW_MINIMIZE, (event) => {
    senderWindow(event)?.minimize();
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW_MAXIMIZE, (event) => {
    const win = senderWindow(event);
    if (!win) return;
    if (win.isMaximized()) {
      win.restore();
    } else {
      win.maximize();
    }
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW_CLOSE, (event) => {
    senderWindow(event)?.close();
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW_IS_MAXIMIZED, (event) => {
    return senderWindow(event)?.isMaximized() ?? false;
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW_IS_FULLSCREEN, (event) => {
    return senderWindow(event)?.isFullScreen() ?? false;
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW_SET_TRAFFIC_LIGHTS_VISIBLE, (event, visible: unknown) => {
    if (typeof visible !== 'boolean' || process.platform !== 'darwin') return;
    const win = senderWindow(event);
    if (!win) return;
    win.setWindowButtonVisibility(visible);
    // setWindowButtonVisibility 会把按钮位置重置为系统默认，恢复显示时需要重新设置
    if (visible) {
      win.setWindowButtonPosition(TRAFFIC_LIGHT_POSITION);
    }
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW_OPEN_SETTINGS, () => {
    openSettingsWindow();
  });
}

/** 向渲染层同步窗口最大化/全屏状态变化 */
export function attachWindowStateEvents(win: BrowserWindow): void {
  const send = (channel: string, value: boolean) => {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, value);
    }
  };

  win.on('maximize', () => send(IPC_CHANNELS.WINDOW_MAXIMIZED_CHANGED, true));
  win.on('unmaximize', () => send(IPC_CHANNELS.WINDOW_MAXIMIZED_CHANGED, false));
  win.on('enter-full-screen', () => send(IPC_CHANNELS.WINDOW_FULLSCREEN_CHANGED, true));
  win.on('leave-full-screen', () => send(IPC_CHANNELS.WINDOW_FULLSCREEN_CHANGED, false));
}
