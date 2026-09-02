import { parseBrowserViewport } from '@shared/browser/viewport';
import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';
import { browserHost } from '../services/browserHost';
import { sendToAllWindows } from '../windows/createAppWindow';

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const CLEAR_KINDS = new Set(['cookies', 'cache', 'all']);

/** 右侧面板内嵌浏览器：矩形上报、地址栏动作、清数据。业务在 browserHost。 */
export function registerBrowserHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.BROWSER_SET_VIEWPORT,
    (_event, conversationId: unknown, raw: unknown) => {
      if (!isId(conversationId)) return browserHost.state('');
      browserHost.setViewport(conversationId, raw === null ? null : parseBrowserViewport(raw));
      return browserHost.state(conversationId);
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.BROWSER_NAVIGATE,
    async (_event, conversationId: unknown, url: unknown) => {
      if (!isId(conversationId) || typeof url !== 'string')
        return { ok: false, error: 'Invalid request' };
      try {
        await browserHost.userNavigate(conversationId, url);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  );
  ipcMain.handle(IPC_CHANNELS.BROWSER_GO_BACK, (_event, conversationId: unknown) => {
    if (isId(conversationId)) browserHost.goBack(conversationId);
  });
  ipcMain.handle(IPC_CHANNELS.BROWSER_GO_FORWARD, (_event, conversationId: unknown) => {
    if (isId(conversationId)) browserHost.goForward(conversationId);
  });
  ipcMain.handle(IPC_CHANNELS.BROWSER_RELOAD, (_event, conversationId: unknown) => {
    if (isId(conversationId)) browserHost.reload(conversationId);
  });
  ipcMain.handle(IPC_CHANNELS.BROWSER_CLEAR_DATA, async (_event, kind: unknown) => {
    if (typeof kind !== 'string' || !CLEAR_KINDS.has(kind)) throw new Error('Invalid clear kind');
    await browserHost.clearData(kind as 'cookies' | 'cache' | 'all');
  });
  ipcMain.handle(
    IPC_CHANNELS.BROWSER_SET_LOCKED,
    async (_event, conversationId: unknown, locked: unknown) => {
      if (!isId(conversationId) || typeof locked !== 'boolean') return;
      await browserHost.setLocked(conversationId, locked);
    }
  );
  browserHost.onState((conversationId, state) => {
    sendToAllWindows(IPC_CHANNELS.BROWSER_STATE, { conversationId, state });
  });
  browserHost.onReveal((conversationId) => {
    sendToAllWindows(IPC_CHANNELS.BROWSER_REVEAL, conversationId);
  });
}
