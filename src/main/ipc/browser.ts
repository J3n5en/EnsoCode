import type { BrowserAnnotationPinSpec, DesignXyRect } from '@shared/browser/designAnnotation';
import { parseBrowserViewport, viewportToDip } from '@shared/browser/viewport';
import { IPC_CHANNELS } from '@shared/types';
import type { BrowserDesignMoveDirection } from '@shared/types/browser';
import { ipcMain, type WebContents } from 'electron';
import { browserHost } from '../services/browserHost';
import { sendToAllWindows } from '../windows/createAppWindow';
import { isMainWebContents } from '../windows/MainWindow';

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const CLEAR_KINDS = new Set(['cookies', 'cache', 'all']);
const MOVE_DIRECTIONS = new Set<BrowserDesignMoveDirection>([
  'parent',
  'child',
  'next',
  'previous',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function parseCropRect(value: unknown): DesignXyRect | undefined {
  if (!isRecord(value)) return undefined;
  const { x, y, width, height } = value;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return undefined;
  }
  return { x, y, width, height };
}

function parsePinSpec(value: unknown): BrowserAnnotationPinSpec | null {
  if (!isRecord(value)) return null;
  const { id, number, comment, label, elements, region } = value;
  if (
    typeof id !== 'string' ||
    !id ||
    typeof number !== 'number' ||
    !Number.isFinite(number) ||
    typeof comment !== 'string' ||
    typeof label !== 'string' ||
    !Array.isArray(elements)
  ) {
    return null;
  }
  const parsedElements = elements
    .filter(
      (el): el is BrowserAnnotationPinSpec['elements'][number] =>
        isRecord(el) &&
        typeof el.uid === 'string' &&
        typeof el.tagName === 'string' &&
        typeof el.id === 'string' &&
        typeof el.className === 'string' &&
        typeof el.innerText === 'string'
    )
    .map((el) => ({
      uid: el.uid,
      tagName: el.tagName,
      id: el.id,
      className: el.className,
      innerText: el.innerText,
    }));
  let parsedRegion: BrowserAnnotationPinSpec['region'] = null;
  if (region !== null && region !== undefined) {
    if (
      !isRecord(region) ||
      typeof region.left !== 'number' ||
      typeof region.top !== 'number' ||
      typeof region.width !== 'number' ||
      typeof region.height !== 'number'
    ) {
      return null;
    }
    parsedRegion = {
      left: region.left,
      top: region.top,
      width: region.width,
      height: region.height,
    };
  }
  return {
    id,
    number,
    comment,
    label,
    elements: parsedElements,
    region: parsedRegion,
  };
}

const watchedReporters = new WeakSet<WebContents>();

/** 上报方没了 / 整页重载：不把上一代 renderer 的遮挡值永久闩住。 */
function watchOverlayReporter(sender: WebContents): void {
  if (watchedReporters.has(sender)) return;
  watchedReporters.add(sender);
  const reset = () => browserHost.resetOverlayReports();
  sender.on('destroyed', reset);
  sender.on('render-process-gone', reset);
  sender.on('did-start-navigation', (details: unknown) => {
    if (!isRecord(details)) return;
    if (details.isMainFrame === true && details.isSameDocument !== true) reset();
  });
}

/** 遮挡上报只信主窗口 renderer；共用 preload 的设置窗开 Dialog 不得把主窗 guest 沉下去。 */
const fromMainRenderer = (event: { sender: WebContents }): boolean => {
  if (!isMainWebContents(event.sender.id)) return false;
  watchOverlayReporter(event.sender);
  return true;
};

const readViewport = (sender: WebContents, raw: unknown) =>
  raw === null ? null : viewportToDip(parseBrowserViewport(raw), sender.getZoomFactor());

/** 右侧面板内嵌浏览器：矩形上报、地址栏动作、清数据。业务在 browserHost。 */
export function registerBrowserHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.BROWSER_SET_VIEWPORT,
    (event, tabId: unknown, conversationId: unknown, raw: unknown, covered: unknown) => {
      if (!isId(tabId) || !isId(conversationId) || !fromMainRenderer(event)) {
        return browserHost.state('');
      }
      return browserHost.setViewport(
        tabId,
        conversationId,
        readViewport(event.sender, raw),
        covered === true
      );
    }
  );
  ipcMain.on(IPC_CHANNELS.BROWSER_SET_OVERLAY_ACTIVE, (event, active: unknown) => {
    if (!fromMainRenderer(event)) return;
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
  ipcMain.handle(IPC_CHANNELS.BROWSER_CLOSE_SESSION, async (_event, conversationId: unknown) => {
    if (isId(conversationId)) await browserHost.closeSession(conversationId);
  });
  ipcMain.handle(IPC_CHANNELS.BROWSER_CLEAR_DATA, async (_event, kind: unknown) => {
    if (typeof kind !== 'string' || !CLEAR_KINDS.has(kind)) throw new Error('Invalid clear kind');
    await browserHost.clearData(kind as 'cookies' | 'cache' | 'all');
  });
  ipcMain.handle(IPC_CHANNELS.BROWSER_RESTORE_TABS, () => browserHost.restorePersistedTabs());
  ipcMain.handle(IPC_CHANNELS.BROWSER_LIST_SEARCHABLE_TABS, () => browserHost.listSearchableTabs());
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
    (event, tabId: unknown, conversationId: unknown, raw: unknown, covered: unknown) => {
      if (!isId(tabId) || !isId(conversationId) || !fromMainRenderer(event)) {
        return browserHost.state('');
      }
      return browserHost.setDevToolsViewport(
        tabId,
        conversationId,
        readViewport(event.sender, raw),
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
  ipcMain.handle(
    IPC_CHANNELS.BROWSER_DESCRIBE_SELECTION,
    async (_event, tabId: unknown, crop: unknown) => {
      if (!isId(tabId)) return { elements: [], image: null };
      return browserHost.describeSelection(tabId, parseCropRect(crop));
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.BROWSER_MOVE_SELECTION,
    async (_event, tabId: unknown, direction: unknown) => {
      if (
        !isId(tabId) ||
        typeof direction !== 'string' ||
        !MOVE_DIRECTIONS.has(direction as BrowserDesignMoveDirection)
      ) {
        return { elements: [], description: { elements: [], image: null } };
      }
      return browserHost.moveSelection(tabId, direction as BrowserDesignMoveDirection);
    }
  );
  ipcMain.handle(IPC_CHANNELS.BROWSER_CLEAR_SELECTION, async (_event, tabId: unknown) => {
    if (!isId(tabId)) return false;
    return browserHost.clearSelection(tabId);
  });
  ipcMain.handle(
    IPC_CHANNELS.BROWSER_SET_ANNOTATION_PINS,
    async (_event, tabId: unknown, pageKey: unknown, pins: unknown) => {
      if (!isId(tabId) || typeof pageKey !== 'string' || !Array.isArray(pins)) return false;
      const parsed = pins
        .map(parsePinSpec)
        .filter((pin): pin is BrowserAnnotationPinSpec => pin !== null);
      return browserHost.setAnnotationPins(tabId, pageKey, parsed);
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.BROWSER_OPEN_ANNOTATION_PIN,
    async (_event, tabId: unknown, pinId: unknown, reveal: unknown) => {
      if (!isId(tabId) || (pinId !== null && !isId(pinId))) return null;
      return browserHost.openAnnotationPin(tabId, pinId, reveal === true);
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.BROWSER_READ_DESIGN_CSS,
    async (_event, tabId: unknown, uid: unknown) => {
      if (!isId(tabId) || !isId(uid)) return null;
      return browserHost.readDesignCss(tabId, uid);
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.BROWSER_PREVIEW_DESIGN_CSS,
    async (_event, tabId: unknown, slot: unknown, spec: unknown) => {
      if (!isId(tabId) || (slot !== 'queue' && slot !== 'draft') || !isRecord(spec)) return null;
      const clean: Record<string, Record<string, string | null>> = {};
      for (const [uid, edits] of Object.entries(spec)) {
        if (!isRecord(edits)) continue;
        const entry: Record<string, string | null> = {};
        for (const [prop, val] of Object.entries(edits)) {
          if (typeof val === 'string' || val === null) entry[prop] = val;
        }
        clean[uid] = entry;
      }
      return browserHost.previewDesignCss(tabId, slot, clean);
    }
  );
  browserHost.onDesignMode((event) => {
    sendToAllWindows(IPC_CHANNELS.BROWSER_DESIGN_MODE_EVENT, event);
  });
}
