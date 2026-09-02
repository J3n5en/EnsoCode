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
    (_event, tabId: unknown, conversationId: unknown, raw: unknown) => {
      if (!isId(tabId) || !isId(conversationId)) return browserHost.state('');
      return browserHost.setViewport(
        tabId,
        conversationId,
        raw === null ? null : parseBrowserViewport(raw)
      );
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.BROWSER_NAVIGATE,
    async (_event, tabId: unknown, conversationId: unknown, url: unknown) => {
      if (!isId(tabId) || !isId(conversationId) || typeof url !== 'string') {
        return { ok: false, error: 'Invalid request' };
      }
      try {
        await browserHost.userNavigate(tabId, conversationId, url);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  );
  ipcMain.handle(IPC_CHANNELS.BROWSER_GO_BACK, (_event, tabId: unknown) => {
    if (isId(tabId)) browserHost.goBack(tabId);
  });
  ipcMain.handle(IPC_CHANNELS.BROWSER_GO_FORWARD, (_event, tabId: unknown) => {
    if (isId(tabId)) browserHost.goForward(tabId);
  });
  ipcMain.handle(IPC_CHANNELS.BROWSER_RELOAD, (_event, tabId: unknown) => {
    if (isId(tabId)) browserHost.reload(tabId);
  });
  ipcMain.handle(IPC_CHANNELS.BROWSER_CLOSE_TAB, async (_event, tabId: unknown) => {
    if (isId(tabId)) await browserHost.closeTab(tabId);
  });
  ipcMain.handle(IPC_CHANNELS.BROWSER_CLEAR_DATA, async (_event, kind: unknown) => {
    if (typeof kind !== 'string' || !CLEAR_KINDS.has(kind)) throw new Error('Invalid clear kind');
    await browserHost.clearData(kind as 'cookies' | 'cache' | 'all');
  });
  ipcMain.handle(IPC_CHANNELS.BROWSER_RESTORE_TABS, () => browserHost.restorePersistedTabs());
  ipcMain.handle(
    IPC_CHANNELS.BROWSER_SET_LOCKED,
    async (_event, conversationId: unknown, locked: unknown) => {
      if (!isId(conversationId) || typeof locked !== 'boolean') return;
      await browserHost.setLocked(conversationId, locked);
    }
  );
  browserHost.onState((conversationId, tabId, state) => {
    sendToAllWindows(IPC_CHANNELS.BROWSER_STATE, { conversationId, tabId, state });
  });
  browserHost.onReveal((conversationId, tabId) => {
    sendToAllWindows(IPC_CHANNELS.BROWSER_REVEAL, { conversationId, tabId });
  });
  browserHost.onTabClosed((conversationId, tabId) => {
    sendToAllWindows(IPC_CHANNELS.BROWSER_TAB_CLOSED, { conversationId, tabId });
  });
}
