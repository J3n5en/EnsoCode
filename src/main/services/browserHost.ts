import { PAGE_SNAPSHOT_SCRIPT, pageClickScript, pageTypeScript } from '@shared/browser/pageScripts';
import {
  type BrowserSnapshot,
  isKnownRef,
  parseSnapshotEntries,
  renderSnapshot,
} from '@shared/browser/snapshot';
import { assertAllowedUrl } from '@shared/browser/urlPolicy';
import type { BrowserOp } from '@shared/types/agent';
import type { BrowserWindow, Session, WebContents } from 'electron';
import { app, session, WebContentsView } from 'electron';

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
 * 无头 tab 也要有 viewport，否则页面布局全是 0×0（快照抓不到块级元素、截图为空）。
 * `setVisible(false)` 或挪到窗口外都会让 macOS 把尺寸清零，所以放窗口内、
 * 插在子视图最底层——被 renderer 的 view 整个盖住，用户看不见。
 */
const HEADLESS_BOUNDS = { x: 0, y: 0, width: 1280, height: 800 };

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
}

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

  /** guest view 需要挂在某扇窗口上才有 viewport；由 main/index.ts 注入主窗口获取器。 */
  setHostWindow(provider: () => BrowserWindow | null): void {
    this.hostWindow = provider;
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
      case 'tabs':
      case 'lock':
        throw new Error(`browser ${op} is not available yet`);
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
    const dbg = tab.view.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    const { width, height } = tab.view.getBounds();
    const scale = width > SCREENSHOT_MAX_WIDTH ? SCREENSHOT_MAX_WIDTH / width : 1;
    const shot = (await dbg.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale },
    })) as { data?: unknown };
    if (typeof shot.data !== 'string' || !shot.data) {
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
    const tab: Tab = { id, view, ownerSessionId: sessionId, createdAt: Date.now() };
    const contents = view.webContents;
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
    });
    this.attach(view);
    this.tabs.set(id, tab);
    this.currentBySession.set(sessionId, id);
    return tab;
  }

  private attach(view: WebContentsView): void {
    const window = this.hostWindow();
    if (!window || window.isDestroyed()) return;
    window.contentView.addChildView(view, 0);
    view.setBounds(HEADLESS_BOUNDS);
  }

  private detach(view: WebContentsView): void {
    for (const window of [this.hostWindow()]) {
      if (!window || window.isDestroyed()) continue;
      if (window.contentView.children.includes(view)) window.contentView.removeChildView(view);
    }
  }

  private evictIfNeeded(): void {
    if (this.tabs.size < MAX_HEADLESS_TABS) return;
    const oldest = [...this.tabs.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) void this.destroyTab(oldest);
  }

  private async destroyTab(tab: Tab): Promise<void> {
    this.tabs.delete(tab.id);
    if (this.currentBySession.get(tab.ownerSessionId) === tab.id) {
      this.currentBySession.delete(tab.ownerSessionId);
    }
    await this.flush();
    this.detach(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  }

  async flush(): Promise<void> {
    if (!this.guestSession) return;
    await this.guestSession.cookies.flushStore().catch(() => {});
    await this.guestSession.flushStorageData();
  }

  async clearData(kind: 'cookies' | 'cache' | 'all'): Promise<void> {
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
