import { IPC_CHANNELS } from '@shared/types';
import { parseAgentSummonRequest } from '@shared/types/mentions';
import { BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { agentTypeRegistrySnapshot } from '../services/agentHost';
import { sendToWindow, TRAFFIC_LIGHT_POSITION } from '../windows/createAppWindow';
import { focusMainWindow } from '../windows/MainWindow';
import { openSettingsWindow } from '../windows/SettingsWindow';
import { parseOpenSettingsRequest } from './searchAnything';

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

  // 选单个文件；可选扩展名过滤（不带点，如 ['png','jpg']）
  ipcMain.handle(
    IPC_CHANNELS.DIALOG_SELECT_FILE,
    async (event, extensions: unknown): Promise<string | null> => {
      const win = senderWindow(event);
      if (!win) return null;
      const exts = Array.isArray(extensions)
        ? extensions.filter((ext): ext is string => typeof ext === 'string' && ext.length > 0)
        : [];
      const result = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: exts.length > 0 ? [{ name: 'Media', extensions: exts }] : undefined,
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    }
  );

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

  let pendingDeepLink: ReturnType<typeof parseOpenSettingsRequest> = null;

  ipcMain.handle(IPC_CHANNELS.WINDOW_OPEN_SETTINGS, (_event, raw: unknown) => {
    const link = parseOpenSettingsRequest(raw);
    const win = openSettingsWindow();
    if (!link) return;
    pendingDeepLink = link;
    sendToWindow(win, IPC_CHANNELS.SETTINGS_DEEP_LINK, link);
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_DEEP_LINK_CONSUME, () => {
    const link = pendingDeepLink;
    pendingDeepLink = null;
    return link;
  });

  ipcMain.handle(
    IPC_CHANNELS.WINDOW_POPUP_MENU,
    async (event, rawItems: unknown, x: unknown, y: unknown) => {
      const win = senderWindow(event);
      if (!win || !Array.isArray(rawItems)) return null;
      const items = rawItems.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const rec = item as Record<string, unknown>;
        if (typeof rec.id !== 'string' || typeof rec.label !== 'string' || !rec.id || !rec.label) {
          return [];
        }
        return [{ id: rec.id, label: rec.label }];
      });
      if (items.length === 0) return null;
      const px = typeof x === 'number' && Number.isFinite(x) ? Math.round(x) : undefined;
      const py = typeof y === 'number' && Number.isFinite(y) ? Math.round(y) : undefined;
      return await new Promise<string | null>((resolve) => {
        let chosen: string | null = null;
        const menu = Menu.buildFromTemplate(
          items.map((item) => ({
            label: item.label,
            click: () => {
              chosen = item.id;
            },
          }))
        );
        menu.popup({
          window: win,
          ...(px !== undefined && py !== undefined ? { x: px, y: py } : {}),
          callback: () => resolve(chosen),
        });
      });
    }
  );

  ipcMain.handle(IPC_CHANNELS.AGENT_SUMMON, (_event, request: unknown) => {
    const snapshot = agentTypeRegistrySnapshot();
    const parsed = parseAgentSummonRequest(
      request,
      new Set(snapshot.candidates.map((candidate) => candidate.typeKey))
    );
    if (!parsed) return { ok: false, error: 'invalid Agent summon request' };
    const window = focusMainWindow();
    sendToWindow(window, IPC_CHANNELS.AGENT_COMPOSER_PREFILL, {
      typeKey: parsed.typeKey,
      ...(parsed.prompt ? { prompt: parsed.prompt } : {}),
    });
    return { ok: true };
  });
}

/** 向渲染层同步窗口最大化/全屏状态变化 */
export function attachWindowStateEvents(win: BrowserWindow): void {
  const send = (channel: string, value: boolean) => {
    sendToWindow(win, channel, value);
  };

  win.on('maximize', () => send(IPC_CHANNELS.WINDOW_MAXIMIZED_CHANGED, true));
  win.on('unmaximize', () => send(IPC_CHANNELS.WINDOW_MAXIMIZED_CHANGED, false));
  win.on('enter-full-screen', () => send(IPC_CHANNELS.WINDOW_FULLSCREEN_CHANGED, true));
  win.on('leave-full-screen', () => send(IPC_CHANNELS.WINDOW_FULLSCREEN_CHANGED, false));
}
