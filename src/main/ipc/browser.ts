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
    (_event, tabId: unknown, conversationId: unknown, raw: unknown, covered: unknown) => {
      if (!isId(tabId) || !isId(conversationId)) return browserHost.state('');
      return browserHost.setViewport(
        tabId,
        conversationId,
        raw === null ? null : parseBrowserViewport(raw),
        covered === true
      );
    }
  );
  ipcMain.on(IPC_CHANNELS.BROWSER_SET_OVERLAY_ACTIVE, (_event, active: unknown) => {
    browserHost.setOverlayActive(active === true);
  });
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
  ipcMain.handle(IPC_CHANNELS.BROWSER_SET_DEVTOOLS, (_event, tabId: unknown, open: unknown) => {
    if (!isId(tabId) || typeof open !== 'boolean') return browserHost.state('');
    return browserHost.setDevTools(tabId, open);
  });
  ipcMain.handle(
    IPC_CHANNELS.BROWSER_SET_DEVTOOLS_VIEWPORT,
    (_event, tabId: unknown, conversationId: unknown, raw: unknown, covered: unknown) => {
      if (!isId(tabId) || !isId(conversationId)) return browserHost.state('');
      return browserHost.setDevToolsViewport(
        tabId,
        conversationId,
        raw === null ? null : parseBrowserViewport(raw),
        covered === true
      );
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
  ipcMain.handle(
    IPC_CHANNELS.BROWSER_SET_DESIGN_MODE,
    async (_event, tabId: unknown, enabled: unknown) => {
      if (!isId(tabId) || typeof enabled !== 'boolean') return browserHost.state('');
      return browserHost.setDesignMode(tabId, enabled);
    }
  );
  browserHost.onDesignMode((event) => {
    sendToAllWindows(IPC_CHANNELS.BROWSER_DESIGN_MODE_EVENT, event);
  });
}
