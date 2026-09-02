import {
  PAGE_LOCK_OVERLAY_SCRIPT,
  PAGE_SNAPSHOT_SCRIPT,
  PAGE_UNLOCK_OVERLAY_SCRIPT,
  pageClickScript,
  pageTypeScript,
} from '@shared/browser/pageScripts';
import {
  type BrowserSnapshot,
  isKnownRef,
  parseSnapshotEntries,
  renderSnapshot,
} from '@shared/browser/snapshot';
import { assertAllowedUrl } from '@shared/browser/urlPolicy';
import type { BrowserViewport } from '@shared/browser/viewport';
import type { BrowserOp } from '@shared/types/agent';
import type { BrowserClearKind, BrowserTabState } from '@shared/types/browser';
import type { BrowserWindow, Session, WebContents } from 'electron';
import { app, session, WebContentsView } from 'electron';
import { getWorkbenchView } from '../windows/createAppWindow';

/**
 * 内嵌浏览器宿主：guest 页只活在 Main。独立 persist session，与编辑器 defaultSession 切开。
 * 第一刀无头：view 不挂窗口，导航 / 快照 / 点 / 填 / 截图全走 webContents。
 * 不 import ipcMain；协议入口在 ipc/agent.ts。
 */

const PARTITION_SUFFIX = '-browser';
const NAVIGATE_TIMEOUT_MS = 30_000;
const SETTLE_MS = 300;
const MAX_HEADLESS_TABS = 4;
const SCREENSHOT_MAX_WIDTH = 1280;
/**
 * 无头 tab 的布局 viewport。contentView 的子视图全画在 renderer 之上，无头只能
 * `setVisible(false)`；但隐藏后 view 尺寸归零，页面布局全是 0×0（快照抓不到块级
 * 元素、截图为空），所以再用 CDP `Emulation.setDeviceMetricsOverride` 撑出尺寸。
 */
const HEADLESS_BOUNDS = { width: 1280, height: 800 };

export function partitionName(isPackaged: boolean): string {
  return `persist:${isPackaged ? 'enso' : 'enso-dev'}${PARTITION_SUFFIX}`;
}

/** clear* 前再校验一遍：只准动我们自己的罐。 */
export function isBrowserPartition(name: string): boolean {
  return name.startsWith('persist:') && name.endsWith(PARTITION_SUFFIX);
}

interface Tab {
  id: string;
  view: WebContentsView;
  ownerSessionId: string;
  createdAt: number;
  lastSnapshot?: BrowserSnapshot;
  locked: boolean;
  /** webContents 首次 dom-ready 前 debugger.attach 会让 Main 段错误 */
  ready: boolean;
}

const EMPTY_STATE: BrowserTabState = {
  tabId: null,
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  locked: false,
};

interface PageInfo {
  url: string;
  title: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const paramString = (params: unknown, key: string): string => {
  const value = isRecord(params) ? params[key] : undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`);
  return value;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class BrowserHost {
  private readonly tabs = new Map<string, Tab>();
  private readonly currentBySession = new Map<string, string>();
  private counter = 0;
  private guestSession?: Session;
  private hostWindow: () => BrowserWindow | null = () => null;

  /** 渲染层当前展示的会话与面板矩形；null = 面板不可见，全部 tab 压底无头 */
  private shown: { sessionId: string; viewport: BrowserViewport } | null = null;
  private readonly stateListeners = new Set<(sessionId: string, state: BrowserTabState) => void>();
  private readonly revealListeners = new Set<(sessionId: string) => void>();
  /** renderer 还没报矩形前先不关 tab，避免回合结束跑赢面板挂载 */
  private readonly pendingReveal = new Set<string>();

  /** guest view 需要挂在某扇窗口上才有 viewport；由 main/index.ts 注入主窗口获取器。 */
  setHostWindow(provider: () => BrowserWindow | null): void {
    this.hostWindow = provider;
  }

  onState(listener: (sessionId: string, state: BrowserTabState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onReveal(listener: (sessionId: string) => void): () => void {
    this.revealListeners.add(listener);
    return () => this.revealListeners.delete(listener);
  }

  private requestReveal(sessionId: string): void {
    this.pendingReveal.add(sessionId);
    for (const listener of this.revealListeners) listener(sessionId);
  }

  state(sessionId: string): BrowserTabState {
    const tab = this.tabFor(sessionId);
    if (!tab) return EMPTY_STATE;
    const contents = tab.view.webContents;
    return {
      tabId: tab.id,
      url: contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      locked: tab.locked,
    };
  }

  private emitState(sessionId: string): void {
    const state = this.state(sessionId);
    for (const listener of this.stateListeners) listener(sessionId, state);
  }

  /** 渲染层：面板可见且矩形已知 → 该会话 tab 叠到矩形上；viewport 为 null → 隐藏 */
  setViewport(sessionId: string, viewport: BrowserViewport | null): void {
    this.shown = viewport ? { sessionId, viewport } : null;
    if (viewport) this.pendingReveal.delete(sessionId);
    this.layout();
  }

  private ensureWorkbenchOnTop(window: BrowserWindow): void {
    const workbench = getWorkbenchView(window);
    if (!workbench) return;
    const { width, height } = window.getContentBounds();
    workbench.setBounds({ x: 0, y: 0, width, height });
    window.contentView.addChildView(workbench);
  }

  private layout(): void {
    const window = this.hostWindow();
    if (!window || window.isDestroyed()) return;
    const { contentView } = window;
    for (const tab of this.tabs.values()) {
      const onTop = Boolean(this.shown && tab.ownerSessionId === this.shown.sessionId);
      if (!contentView.children.includes(tab.view)) contentView.addChildView(tab.view, 0);
      if (onTop && this.shown) {
        tab.view.setBounds(this.shown.viewport);
        tab.view.setVisible(true);
        void this.cdp(tab, 'Emulation.clearDeviceMetricsOverride', {});
      } else {
        tab.view.setVisible(false);
        void this.cdp(tab, 'Emulation.setDeviceMetricsOverride', {
          width: HEADLESS_BOUNDS.width,
          height: HEADLESS_BOUNDS.height,
          deviceScaleFactor: 0,
          mobile: false,
        });
      }
    }
    this.ensureWorkbenchOnTop(window);
  }

  /** host 内白名单 CDP；模型永远摸不到 */
  private async cdp(tab: Tab, method: string, params: Record<string, unknown>): Promise<unknown> {
    const contents = tab.view.webContents;
    if (!tab.ready || contents.isDestroyed()) return undefined;
    const dbg = contents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    return dbg.sendCommand(method, params).catch((error: unknown) => {
      console.warn(`[browser] ${method} failed: ${error instanceof Error ? error.message : error}`);
      return undefined;
    });
  }

  /** 面板地址栏 / 按钮 */
  async userNavigate(sessionId: string, raw: string): Promise<void> {
    await this.navigate(sessionId, raw);
  }

  goBack(sessionId: string): void {
    const tab = this.tabFor(sessionId);
    if (tab?.view.webContents.navigationHistory.canGoBack()) {
      tab.view.webContents.navigationHistory.goBack();
    }
  }

  goForward(sessionId: string): void {
    const tab = this.tabFor(sessionId);
    if (tab?.view.webContents.navigationHistory.canGoForward()) {
      tab.view.webContents.navigationHistory.goForward();
    }
  }

  reload(sessionId: string): void {
    this.tabFor(sessionId)?.view.webContents.reload();
  }

  async setLocked(sessionId: string, locked: boolean): Promise<void> {
    const tab = this.mustTab(sessionId);
    tab.locked = locked;
    await this.syncLockOverlay(tab);
    this.emitState(sessionId);
  }

  private async syncLockOverlay(tab: Tab): Promise<void> {
    const contents = tab.view.webContents;
    if (contents.isDestroyed() || !tab.ready) return;
    const script = tab.locked ? PAGE_LOCK_OVERLAY_SCRIPT : PAGE_UNLOCK_OVERLAY_SCRIPT;
    await contents.executeJavaScript(script, true).catch(() => {});
  }

  getSession(): Session {
    if (!this.guestSession) {
      const name = partitionName(app.isPackaged);
      this.guestSession = session.fromPartition(name);
      // guest 页拿不到摄像头 / 通知 / 地理位置等；只放剪贴板写
      this.guestSession.setPermissionRequestHandler((_wc, permission, callback) =>
        callback(permission === 'clipboard-sanitized-write')
      );
      this.guestSession.setPermissionCheckHandler(
        (_wc, permission) => permission === 'clipboard-sanitized-write'
      );
    }
    return this.guestSession;
  }

  async invoke(sessionId: string, op: BrowserOp, params: unknown): Promise<unknown> {
    switch (op) {
      case 'navigate':
        return this.navigate(sessionId, paramString(params, 'url'));
      case 'snapshot':
        return this.snapshot(this.mustTab(sessionId));
      case 'click':
        return this.click(this.mustTab(sessionId), paramString(params, 'ref'));
      case 'type': {
        const text = isRecord(params) && typeof params.text === 'string' ? params.text : '';
        const submit = isRecord(params) && params.submit === true;
        return this.type(this.mustTab(sessionId), paramString(params, 'ref'), text, submit);
      }
      case 'screenshot':
        return this.screenshot(this.mustTab(sessionId));
      case 'close': {
        const tab = this.mustTab(sessionId);
        await this.destroyTab(tab);
        return { closed: tab.id };
      }
      case 'tabs': {
        const tab = this.tabFor(sessionId);
        return tab ? [this.state(sessionId)] : [];
      }
      case 'lock': {
        const locked = !(isRecord(params) && params.release === true);
        await this.setLocked(sessionId, locked);
        return { locked };
      }
    }
  }

  async navigate(sessionId: string, raw: string): Promise<PageInfo> {
    const url = assertAllowedUrl(raw);
    const tab = this.tabFor(sessionId) ?? this.createTab(sessionId);
    const contents = tab.view.webContents;
    tab.lastSnapshot = undefined;
    await Promise.race([
      contents.loadURL(url.href),
      sleep(NAVIGATE_TIMEOUT_MS).then(() => {
        throw new Error(`Navigation to ${url.href} timed out`);
      }),
    ]);
    this.requestReveal(sessionId);
    return this.pageInfo(contents);
  }

  private async snapshot(tab: Tab): Promise<string> {
    const contents = tab.view.webContents;
    const raw: unknown = await contents.executeJavaScript(PAGE_SNAPSHOT_SCRIPT, true);
    const entries = parseSnapshotEntries(raw);
    if (!entries) throw new Error('Page snapshot returned an unexpected shape.');
    tab.lastSnapshot = renderSnapshot(this.pageInfo(contents), entries);
    return tab.lastSnapshot.text;
  }

  private async click(tab: Tab, ref: string): Promise<PageInfo> {
    this.assertRef(tab, ref);
    const outcome: unknown = await tab.view.webContents.executeJavaScript(
      pageClickScript(ref),
      true
    );
    if (outcome !== 'ok') throw staleRef(ref);
    await sleep(SETTLE_MS);
    return this.pageInfo(tab.view.webContents);
  }

  private async type(tab: Tab, ref: string, text: string, submit: boolean): Promise<PageInfo> {
    this.assertRef(tab, ref);
    const outcome: unknown = await tab.view.webContents.executeJavaScript(
      pageTypeScript(ref, text, submit),
      true
    );
    if (outcome === 'stale') throw staleRef(ref);
    if (outcome !== 'ok') throw new Error(`Element ${ref} is not editable.`);
    await sleep(SETTLE_MS);
    return this.pageInfo(tab.view.webContents);
  }

  /**
   * 被 renderer 盖住的 view `capturePage` 会报 UnknownVizError（合成器不出帧）。
   * 走 CDP `Page.captureScreenshot` + captureBeyondViewport 强制 Blink 离屏渲染。
   * debugger 只在 host 内用，模型摸不到。
   */
  private async screenshot(tab: Tab): Promise<{ data: string; mimeType: string }> {
    const bounds = tab.view.getBounds();
    const width = bounds.width || HEADLESS_BOUNDS.width;
    const height = bounds.height || HEADLESS_BOUNDS.height;
    const scale = width > SCREENSHOT_MAX_WIDTH ? SCREENSHOT_MAX_WIDTH / width : 1;
    const shot = (await this.cdp(tab, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale },
    })) as { data?: unknown } | undefined;
    if (typeof shot?.data !== 'string' || !shot.data) {
      throw new Error('Screenshot is empty; the page has not painted yet.');
    }
    return { data: shot.data, mimeType: 'image/png' };
  }

  private assertRef(tab: Tab, ref: string): void {
    if (!isKnownRef(tab.lastSnapshot, ref)) throw staleRef(ref);
  }

  private pageInfo(contents: WebContents): PageInfo {
    return { url: contents.getURL(), title: contents.getTitle() };
  }

  private tabFor(sessionId: string): Tab | undefined {
    const id = this.currentBySession.get(sessionId);
    return id ? this.tabs.get(id) : undefined;
  }

  private mustTab(sessionId: string): Tab {
    const tab = this.tabFor(sessionId);
    if (!tab) throw new Error('No browser tab is open. Call browser_navigate first.');
    return tab;
  }

  private createTab(sessionId: string): Tab {
    this.evictIfNeeded();
    const view = new WebContentsView({
      webPreferences: {
        session: this.getSession(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    const id = `tab-${++this.counter}`;
    const tab: Tab = {
      id,
      view,
      ownerSessionId: sessionId,
      createdAt: Date.now(),
      locked: false,
      ready: false,
    };
    const contents = view.webContents;
    const push = () => this.emitState(sessionId);
    contents.on('did-start-loading', push);
    contents.on('did-stop-loading', push);
    contents.on('did-navigate-in-page', push);
    contents.on('page-title-updated', push);
    // 页内链接 / 重定向也过同一道 URL 门
    const guard = (event: { preventDefault(): void }, url: string) => {
      try {
        assertAllowedUrl(url);
      } catch {
        event.preventDefault();
      }
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.on('did-navigate', () => {
      tab.lastSnapshot = undefined;
      push();
    });
    contents.on('did-finish-load', () => {
      if (tab.locked) void this.syncLockOverlay(tab);
    });
    contents.once('dom-ready', () => {
      tab.ready = true;
      this.layout();
    });
    // window.open / target=_blank：本 tab 内导航，不弹系统浏览器
    contents.setWindowOpenHandler(({ url }) => {
      try {
        void contents.loadURL(assertAllowedUrl(url).href);
      } catch {}
      return { action: 'deny' };
    });
    contents.on('destroyed', () => {
      this.tabs.delete(id);
      if (this.currentBySession.get(sessionId) === id) this.currentBySession.delete(sessionId);
      this.emitState(sessionId);
    });
    this.tabs.set(id, tab);
    this.currentBySession.set(sessionId, id);
    this.layout();
    this.emitState(sessionId);
    return tab;
  }

  private detach(view: WebContentsView): void {
    const window = this.hostWindow();
    if (!window || window.isDestroyed()) return;
    if (window.contentView.children.includes(view)) window.contentView.removeChildView(view);
  }

  private evictIfNeeded(): void {
    if (this.tabs.size < MAX_HEADLESS_TABS) return;
    const oldest = [...this.tabs.values()]
      .filter((tab) => !tab.locked && tab.ownerSessionId !== this.shown?.sessionId)
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) void this.destroyTab(oldest);
  }

  /** 回合结束：未锁、用户没在看的 tab 关掉（页面不留后台） */
  async closeForSession(sessionId: string, opts: { force?: boolean } = {}): Promise<void> {
    const tab = this.tabFor(sessionId);
    if (!tab) return;
    if (
      !opts.force &&
      (tab.locked || this.shown?.sessionId === sessionId || this.pendingReveal.has(sessionId))
    ) {
      return;
    }
    await this.destroyTab(tab);
  }

  private async destroyTab(tab: Tab): Promise<void> {
    this.tabs.delete(tab.id);
    if (this.currentBySession.get(tab.ownerSessionId) === tab.id) {
      this.currentBySession.delete(tab.ownerSessionId);
    }
    await this.flush();
    this.detach(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    this.emitState(tab.ownerSessionId);
  }

  async flush(): Promise<void> {
    if (!this.guestSession) return;
    await this.guestSession.cookies.flushStore().catch(() => {});
    await this.guestSession.flushStorageData();
  }

  async clearData(kind: BrowserClearKind): Promise<void> {
    const guest = this.getSession();
    if (!isBrowserPartition(partitionName(app.isPackaged))) throw new Error('Refusing to clear');
    if (kind === 'cookies' || kind === 'all') {
      await guest.clearStorageData({ storages: ['cookies'] });
    }
    if (kind === 'cache' || kind === 'all') await guest.clearCache();
    if (kind === 'all') {
      await guest.clearStorageData({
        storages: ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'filesystem'],
      });
    }
  }

  /** 退出前：flush 后关掉全部 tab。 */
  async dispose(): Promise<void> {
    for (const tab of [...this.tabs.values()]) await this.destroyTab(tab);
  }
}

const staleRef = (ref: string) =>
  new Error(`Ref ${ref} is stale or unknown. Call browser_snapshot again and use a fresh ref.`);

export const browserHost = new BrowserHost();
