import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertAllowedCdpMethod } from '@shared/browser/cdpPolicy';
import { parseDesignBinding, sanitizeUiElementPayload } from '@shared/browser/designMode';
import { assertDevtoolsIdle } from '@shared/browser/devtools';
import { pickFaviconUrl } from '@shared/browser/favicon';
import {
  DESIGN_MODE_BINDING,
  PAGE_DESIGN_MODE_COMPOSE_SCRIPT,
  PAGE_DESIGN_MODE_DISABLE_SCRIPT,
  PAGE_DESIGN_MODE_ENABLE_SCRIPT,
  PAGE_DESIGN_MODE_HIDE_SCRIPT,
  PAGE_LOCK_OVERLAY_SCRIPT,
  PAGE_SNAPSHOT_SCRIPT,
  PAGE_UNLOCK_OVERLAY_SCRIPT,
  pageBoundingBoxScript,
  pageClickScript,
  pageClickXyScript,
  pageDesignModeShowFrozenScript,
  pageDragScript,
  pageHighlightScript,
  pagePressKeyScript,
  pageScrollScript,
  pageSelectOptionScript,
  pageTypeScript,
} from '@shared/browser/pageScripts';
import {
  type BrowserSnapshot,
  isKnownRef,
  parseSnapshotEntries,
  renderSnapshot,
} from '@shared/browser/snapshot';
import {
  type PersistedBrowserTab,
  parsePersistedBrowserTabs,
  serializePersistedBrowserTabs,
} from '@shared/browser/tabPersist';
import { assertAllowedUrl } from '@shared/browser/urlPolicy';
import type { BrowserViewport } from '@shared/browser/viewport';
import type { BrowserOp } from '@shared/types/agent';
import type {
  BrowserClearKind,
  BrowserDesignModeEvent,
  BrowserTabState,
} from '@shared/types/browser';
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
/** 会话不在看的 Browser 进程，闲置这么久就卸掉（URL 仍落盘） */
const IDLE_MS = 5 * 60 * 1000;
const IDLE_TICK_MS = 30_000;
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
  /** 官方 DevTools 前端；懒创建 */
  devtools?: WebContentsView;
  ownerSessionId: string;
  createdAt: number;
  lastSnapshot?: BrowserSnapshot;
  locked: boolean;
  /** webContents 首次 dom-ready 前 debugger.attach 会让 Main 段错误 */
  ready: boolean;
  devtoolsOpen: boolean;
  designMode: boolean;
  favicon: string | null;
  designBinding?: boolean;
  pickSeq: number;
}

const EMPTY_STATE: BrowserTabState = {
  tabId: null,
  url: '',
  title: '',
  favicon: null,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  locked: false,
  devtoolsOpen: false,
  designMode: false,
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

  /** 渲染层当前展示的 dock tab 与面板矩形 */
  /** covered：renderer 有浮层压在网页上，guest 要沉到 workbench 之下透洞显示 */
  private shown: {
    tabId: string;
    sessionId: string;
    viewport: BrowserViewport;
    covered: boolean;
  } | null = null;
  private shownDevtools: {
    tabId: string;
    sessionId: string;
    viewport: BrowserViewport;
    covered: boolean;
  } | null = null;
  private readonly stateListeners = new Set<
    (sessionId: string, tabId: string, state: BrowserTabState) => void
  >();
  private readonly revealListeners = new Set<(sessionId: string, tabId: string) => void>();
  private readonly closeListeners = new Set<(sessionId: string, tabId: string) => void>();
  private readonly designListeners = new Set<(event: BrowserDesignModeEvent) => void>();
  /** renderer 还没报矩形前先不关 tab，避免回合结束跑赢面板挂载 */
  private readonly pendingReveal = new Set<string>();
  /** 用户见过的 tab：切走 Terminal / 重启后仍恢复 */
  private readonly userTabs = new Set<string>();
  private persisted: Record<string, PersistedBrowserTab> = {};
  private persistedLoaded = false;
  private disposing = false;
  private readonly lastSeen = new Map<string, number>();
  private idleTimer: ReturnType<typeof setInterval> | undefined;

  /** guest view 需要挂在某扇窗口上才有 viewport；由 main/index.ts 注入主窗口获取器。 */
  setHostWindow(provider: () => BrowserWindow | null): void {
    this.hostWindow = provider;
  }

  onState(
    listener: (sessionId: string, tabId: string, state: BrowserTabState) => void
  ): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onReveal(listener: (sessionId: string, tabId: string) => void): () => void {
    this.revealListeners.add(listener);
    return () => this.revealListeners.delete(listener);
  }

  onTabClosed(listener: (sessionId: string, tabId: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onDesignMode(listener: (event: BrowserDesignModeEvent) => void): () => void {
    this.designListeners.add(listener);
    return () => this.designListeners.delete(listener);
  }

  private requestReveal(sessionId: string, tabId?: string): void {
    const tab =
      (tabId ? this.tabs.get(tabId) : this.tabFor(sessionId)) ?? this.createTab(sessionId);
    this.pendingReveal.add(sessionId);
    this.userTabs.add(tab.id);
    for (const listener of this.revealListeners) listener(sessionId, tab.id);
  }

  state(tabId: string): BrowserTabState {
    const tab = this.tabs.get(tabId) ?? this.tabFor(tabId);
    if (!tab) return EMPTY_STATE;
    return this.stateOf(tab);
  }

  private stateOf(tab: Tab): BrowserTabState {
    const contents = tab.view.webContents;
    return {
      tabId: tab.id,
      url: contents.getURL(),
      title: contents.getTitle(),
      favicon: tab.favicon,
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      locked: tab.locked,
      devtoolsOpen: tab.devtoolsOpen,
      designMode: tab.designMode,
    };
  }

  private emitState(sessionId: string, tabId?: string): void {
    const tab = (tabId ? this.tabs.get(tabId) : undefined) ?? this.tabFor(sessionId);
    const state = tab ? this.stateOf(tab) : EMPTY_STATE;
    if (tab && this.userTabs.has(tab.id) && state.url.startsWith('http')) {
      this.rememberTab(tab.id, {
        url: state.url,
        title: state.title,
        conversationId: tab.ownerSessionId,
        at: Date.now(),
      });
    }
    for (const listener of this.stateListeners) listener(sessionId, tab?.id ?? '', state);
  }

  /** 渲染层：某个 dock tab 可见时报矩形；null = 该 tab 隐藏 */
  setViewport(
    tabId: string,
    sessionId: string,
    viewport: BrowserViewport | null,
    covered = false
  ): BrowserTabState {
    if (viewport) {
      if (!this.tabs.has(tabId)) void this.restoreTab(tabId, sessionId);
      this.currentBySession.set(sessionId, tabId);
      this.userTabs.add(tabId);
      this.pendingReveal.delete(sessionId);
      this.shown = { tabId, sessionId, viewport, covered };
      this.touch(tabId);
    } else if (this.shown?.tabId === tabId) {
      this.shown = null;
    }
    this.layout();
    return this.state(tabId);
  }

  setDevTools(tabId: string, open: boolean): BrowserTabState {
    const tab = this.tabs.get(tabId);
    if (!tab) return EMPTY_STATE;
    if (open && tab.designMode) void this.setDesignMode(tabId, false);
    tab.devtoolsOpen = open;
    if (open) {
      this.detachDebugger(tab);
      this.ensureDevTools(tab);
    } else {
      this.teardownDevTools(tab);
      this.shownDevtools = null;
    }
    this.layout();
    this.emitState(tab.ownerSessionId, tab.id);
    return this.stateOf(tab);
  }

  setDevToolsViewport(
    tabId: string,
    sessionId: string,
    viewport: BrowserViewport | null,
    covered = false
  ): BrowserTabState {
    const tab = this.tabs.get(tabId);
    if (viewport && tab?.devtoolsOpen) {
      this.shownDevtools = { tabId, sessionId, viewport, covered };
    } else if (this.shownDevtools?.tabId === tabId) {
      this.shownDevtools = null;
    }
    this.layout();
    return this.state(tabId);
  }

  private ensureWorkbenchOnTop(window: BrowserWindow): void {
    const workbench = getWorkbenchView(window);
    if (!workbench) return;
    const { width, height } = window.getContentBounds();
    workbench.setBounds({ x: 0, y: 0, width, height });
    window.contentView.addChildView(workbench);
  }

  /**
   * 层级：workbench（renderer）是一整块 NSView，透明像素照样吃掉 hit-test，
   * 所以 guest 平时必须叠在 workbench 之上才能被用户点；只有 renderer 浮层
   * 压到网页区域时才沉到 index 0，让菜单 / Dialog 透洞盖在网页上。
   */
  private layout(): void {
    const window = this.hostWindow();
    if (!window || window.isDestroyed()) return;
    const { contentView } = window;
    const raise: WebContentsView[] = [];
    for (const tab of this.tabs.values()) {
      const onTop = Boolean(this.shown && tab.id === this.shown.tabId);
      if (!contentView.children.includes(tab.view)) contentView.addChildView(tab.view, 0);
      if (tab.devtools && !contentView.children.includes(tab.devtools)) {
        contentView.addChildView(tab.devtools, 0);
      }
      if (onTop && this.shown) {
        tab.view.setBounds(this.shown.viewport);
        tab.view.setVisible(true);
        if (!this.shown.covered) raise.push(tab.view);
        if (!tab.devtoolsOpen) void this.cdp(tab, 'Emulation.clearDeviceMetricsOverride', {});
      } else {
        tab.view.setVisible(false);
        if (!tab.devtoolsOpen) {
          void this.cdp(tab, 'Emulation.setDeviceMetricsOverride', {
            width: HEADLESS_BOUNDS.width,
            height: HEADLESS_BOUNDS.height,
            deviceScaleFactor: 0,
            mobile: false,
          });
        }
      }
      const dtOnTop = Boolean(
        tab.devtools && tab.devtoolsOpen && this.shownDevtools?.tabId === tab.id
      );
      if (tab.devtools) {
        if (dtOnTop && this.shownDevtools) {
          tab.devtools.setBounds(this.shownDevtools.viewport);
          tab.devtools.setVisible(true);
          if (!this.shownDevtools.covered) raise.push(tab.devtools);
        } else {
          tab.devtools.setVisible(false);
        }
      }
    }
    this.ensureWorkbenchOnTop(window);
    for (const view of raise) contentView.addChildView(view);
  }

  /** host 内白名单 CDP；模型永远摸不到 */
  private detachDebugger(tab: Tab): void {
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) return;
    const dbg = contents.debugger;
    if (dbg.isAttached()) {
      try {
        dbg.detach();
      } catch {}
    }
    tab.designBinding = false;
  }

  private ensureDevTools(tab: Tab): void {
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) return;
    if (!tab.devtools) {
      tab.devtools = new WebContentsView({
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      tab.devtools.setBackgroundColor('#202124');
    }
    const dt = tab.devtools.webContents;
    if (dt.isDestroyed()) return;
    try {
      contents.setDevToolsWebContents(dt);
    } catch {}
    // detach：不在 guest 自己身上再拆一条 dock，前端只画在我们给的 view 里
    contents.openDevTools({ mode: 'detach', activate: false });
  }

  private teardownDevTools(tab: Tab): void {
    const contents = tab.view.webContents;
    if (!contents.isDestroyed() && contents.isDevToolsOpened()) contents.closeDevTools();
    if (tab.devtools) {
      this.detach(tab.devtools);
      tab.devtools.setVisible(false);
    }
  }

  private async cdp(tab: Tab, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (tab.devtoolsOpen) return undefined;
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
  async userNavigate(tabId: string, sessionId: string, raw: string): Promise<void> {
    if (!this.tabs.has(tabId)) this.createTab(sessionId, tabId);
    this.currentBySession.set(sessionId, tabId);
    this.userTabs.add(tabId);
    const url = assertAllowedUrl(raw);
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    tab.lastSnapshot = undefined;
    await Promise.race([
      tab.view.webContents.loadURL(url.href),
      sleep(NAVIGATE_TIMEOUT_MS).then(() => {
        throw new Error(`Navigation to ${url.href} timed out`);
      }),
    ]);
  }

  goBack(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (tab?.view.webContents.navigationHistory.canGoBack()) {
      tab.view.webContents.navigationHistory.goBack();
    }
  }

  goForward(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (tab?.view.webContents.navigationHistory.canGoForward()) {
      tab.view.webContents.navigationHistory.goForward();
    }
  }

  reload(tabId: string): void {
    this.tabs.get(tabId)?.view.webContents.reload();
  }

  async closeTab(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.userTabs.delete(tabId);
    this.forgetTab(tabId);
    await this.destroyTab(tab);
    for (const listener of this.closeListeners) listener(tab.ownerSessionId, tabId);
  }

  async setLocked(sessionId: string, locked: boolean): Promise<void> {
    const tab = this.mustTab(sessionId);
    if (locked && tab.designMode) await this.setDesignMode(tab.id, false);
    tab.locked = locked;
    await this.syncLockOverlay(tab);
    this.emitState(sessionId, tab.id);
  }

  async setDesignMode(tabId: string, enabled: boolean): Promise<BrowserTabState> {
    const tab = this.tabs.get(tabId);
    if (!tab) return EMPTY_STATE;
    if (enabled && (tab.locked || tab.devtoolsOpen)) return this.stateOf(tab);
    if (!enabled) {
      tab.designMode = false;
      tab.pickSeq += 1;
      await this.runGuest(tab, PAGE_DESIGN_MODE_DISABLE_SCRIPT);
      this.emitState(tab.ownerSessionId, tab.id);
      return this.stateOf(tab);
    }
    await this.ensureDesignBinding(tab);
    await this.runGuest(tab, PAGE_DESIGN_MODE_ENABLE_SCRIPT);
    tab.designMode = true;
    this.emitState(tab.ownerSessionId, tab.id);
    return this.stateOf(tab);
  }

  private emitDesign(event: BrowserDesignModeEvent): void {
    for (const listener of this.designListeners) listener(event);
  }

  private async runGuest(tab: Tab, script: string): Promise<unknown> {
    const contents = tab.view.webContents;
    if (contents.isDestroyed() || !tab.ready) return undefined;
    return contents.executeJavaScript(script, true).catch(() => undefined);
  }

  private async ensureDesignBinding(tab: Tab): Promise<void> {
    if (tab.designBinding && tab.view.webContents.debugger.isAttached()) return;
    const contents = tab.view.webContents;
    if (contents.isDestroyed() || !tab.ready) return;
    const dbg = contents.debugger;
    if (!dbg.isAttached()) {
      try {
        dbg.attach('1.3');
      } catch {
        return;
      }
    }
    dbg.on('message', (_event, method, params) => {
      if (method !== 'Runtime.bindingCalled') return;
      const name = isRecord(params) ? params.name : undefined;
      const payload = isRecord(params) ? params.payload : undefined;
      if (name !== DESIGN_MODE_BINDING || typeof payload !== 'string') return;
      void this.onDesignBinding(tab, payload);
    });
    await this.cdp(tab, 'Runtime.addBinding', { name: DESIGN_MODE_BINDING });
    tab.designBinding = true;
  }

  private async onDesignBinding(tab: Tab, raw: string): Promise<void> {
    if (!tab.designMode) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const msg = parseDesignBinding(parsed);
    if (!msg) return;
    if (msg.type === 'cancelled') {
      await this.setDesignMode(tab.id, false);
      this.emitDesign({ type: 'cancelled', conversationId: tab.ownerSessionId, tabId: tab.id });
      return;
    }
    if (msg.type === 'freeze-request') {
      await this.runGuest(tab, PAGE_DESIGN_MODE_HIDE_SCRIPT);
      try {
        const shot = await this.screenshot(tab);
        await this.runGuest(tab, pageDesignModeShowFrozenScript(shot.data));
      } catch {
        await this.runGuest(tab, pageDesignModeShowFrozenScript(''));
      }
      return;
    }
    if (msg.type === 'annotated') {
      const seq = ++tab.pickSeq;
      const composed = await this.runGuest(tab, PAGE_DESIGN_MODE_COMPOSE_SCRIPT);
      if (seq !== tab.pickSeq) return;
      const data = typeof composed === 'string' ? composed : '';
      if (!data) return;
      await this.setDesignMode(tab.id, false);
      this.emitDesign({
        type: 'annotated',
        conversationId: tab.ownerSessionId,
        tabId: tab.id,
        payload: { label: 'annotation', path: 'scribble', text: '' },
        image: { data, mimeType: 'image/png' },
      });
      return;
    }
    if (msg.type !== 'picked') return;
    const payload = sanitizeUiElementPayload(msg.payload);
    if (!payload) return;
    const seq = ++tab.pickSeq;
    await this.runGuest(tab, PAGE_DESIGN_MODE_HIDE_SCRIPT);
    let image: { data: string; mimeType: string } | undefined;
    try {
      image = await this.screenshotRect(tab, payload.rect);
    } catch {}
    if (seq !== tab.pickSeq) return;
    await this.setDesignMode(tab.id, false);
    this.emitDesign({
      type: 'picked',
      conversationId: tab.ownerSessionId,
      tabId: tab.id,
      payload,
      ...(image ? { image } : {}),
    });
  }

  private async screenshotRect(
    tab: Tab,
    rect?: { x: number; y: number; width: number; height: number }
  ): Promise<{ data: string; mimeType: string }> {
    if (
      rect &&
      Number.isFinite(rect.width) &&
      Number.isFinite(rect.height) &&
      rect.width >= 1 &&
      rect.height >= 1
    ) {
      return this.screenshotClip(tab, {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        scale: 1,
      });
    }
    return this.screenshot(tab);
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
      void import('./proxyConfig').then(({ getProxyConfig }) =>
        getProxyConfig().attachSession(this.guestSession as Session)
      );
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
        return this.navigate(
          sessionId,
          paramString(params, 'url'),
          isRecord(params) && params.newTab === true
        );
      case 'snapshot':
        return this.snapshot(this.mustTab(sessionId));
      case 'click':
        return this.click(this.mustTab(sessionId), paramString(params, 'ref'));
      case 'type': {
        const text = isRecord(params) && typeof params.text === 'string' ? params.text : '';
        const submit = isRecord(params) && params.submit === true;
        return this.type(this.mustTab(sessionId), paramString(params, 'ref'), text, submit);
      }
      case 'fill':
        return this.type(
          this.mustTab(sessionId),
          paramString(params, 'ref'),
          isRecord(params) && typeof params.value === 'string'
            ? params.value
            : isRecord(params) && typeof params.text === 'string'
              ? params.text
              : '',
          false
        );
      case 'press_key':
        return this.runPage(
          this.mustTab(sessionId),
          pagePressKeyScript(paramString(params, 'key'))
        );
      case 'scroll':
        return this.runPage(
          this.mustTab(sessionId),
          pageScrollScript({
            ...(isRecord(params) && typeof params.ref === 'string' ? { ref: params.ref } : {}),
            ...(isRecord(params) && typeof params.direction === 'string'
              ? { direction: params.direction }
              : {}),
            ...(isRecord(params) && typeof params.amount === 'number'
              ? { amount: params.amount }
              : {}),
          })
        );
      case 'select_option': {
        const values =
          isRecord(params) && Array.isArray(params.values)
            ? params.values.filter((v): v is string => typeof v === 'string')
            : isRecord(params) && typeof params.value === 'string'
              ? [params.value]
              : [];
        return this.selectOption(this.mustTab(sessionId), paramString(params, 'ref'), values);
      }
      case 'click_xy': {
        const x = isRecord(params) ? Number(params.x) : Number.NaN;
        const y = isRecord(params) ? Number(params.y) : Number.NaN;
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x and y are required');
        return this.runPage(this.mustTab(sessionId), pageClickXyScript(x, y));
      }
      case 'drag':
        return this.drag(this.mustTab(sessionId), params);
      case 'highlight':
        return this.runPage(
          this.mustTab(sessionId),
          pageHighlightScript(paramString(params, 'ref')),
          paramString(params, 'ref')
        );
      case 'bounding_box':
        return this.boundingBox(this.mustTab(sessionId), paramString(params, 'ref'));
      case 'screenshot':
        return this.screenshot(
          this.mustTab(sessionId),
          isRecord(params) && typeof params.ref === 'string' ? params.ref : undefined
        );
      case 'cdp':
        return this.cdpCommand(
          this.mustTab(sessionId),
          paramString(params, 'method'),
          isRecord(params) && isRecord(params.params) ? params.params : {}
        );
      case 'close': {
        const tab = this.mustTab(sessionId);
        await this.destroyTab(tab);
        return { closed: tab.id };
      }
      case 'tabs':
        return this.handleTabs(
          sessionId,
          isRecord(params) && typeof params.action === 'string' ? params.action : 'list',
          isRecord(params) && typeof params.index === 'number' ? params.index : undefined
        );
      case 'lock': {
        const locked = !(isRecord(params) && params.release === true);
        await this.setLocked(sessionId, locked);
        return { locked };
      }
    }
  }

  private tabsForSession(sessionId: string): Tab[] {
    return [...this.tabs.values()]
      .filter((tab) => tab.ownerSessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  private async handleTabs(sessionId: string, action: string, index?: number): Promise<unknown> {
    const list = () => {
      const current = this.currentBySession.get(sessionId);
      return this.tabsForSession(sessionId).map((tab, tabIndex) => ({
        index: tabIndex,
        ...this.stateOf(tab),
        active: tab.id === current,
      }));
    };
    if (action === 'new') {
      const tab = this.createTab(sessionId);
      this.userTabs.add(tab.id);
      this.requestReveal(sessionId, tab.id);
      return { opened: tab.id, tabs: list() };
    }
    if (action === 'select') {
      if (index === undefined || !Number.isInteger(index)) {
        throw new Error('index is required for select');
      }
      const tab = this.tabsForSession(sessionId)[index];
      if (!tab) throw new Error(`No browser tab at index ${index}`);
      this.currentBySession.set(sessionId, tab.id);
      this.requestReveal(sessionId, tab.id);
      return { selected: tab.id, tabs: list() };
    }
    if (action === 'close') {
      const tabs = this.tabsForSession(sessionId);
      const tab = index === undefined ? this.tabFor(sessionId) : tabs[index];
      if (!tab) throw new Error('No browser tab to close');
      await this.closeTab(tab.id);
      return { closed: tab.id, tabs: list() };
    }
    return { tabs: list() };
  }

  async navigate(sessionId: string, raw: string, newTab = false): Promise<PageInfo> {
    const url = assertAllowedUrl(raw);
    const tab = newTab
      ? this.createTab(sessionId)
      : (this.tabFor(sessionId) ?? this.createTab(sessionId));
    const contents = tab.view.webContents;
    tab.lastSnapshot = undefined;
    await Promise.race([
      contents.loadURL(url.href),
      sleep(NAVIGATE_TIMEOUT_MS).then(() => {
        throw new Error(`Navigation to ${url.href} timed out`);
      }),
    ]);
    this.requestReveal(sessionId, tab.id);
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

  private async runPage(tab: Tab, script: string, ref?: string): Promise<PageInfo> {
    if (ref) this.assertRef(tab, ref);
    const outcome: unknown = await tab.view.webContents.executeJavaScript(script, true);
    if (outcome === 'stale') throw staleRef(ref ?? '');
    if (typeof outcome === 'string' && outcome !== 'ok') {
      throw new Error(`browser action failed: ${outcome}`);
    }
    await sleep(SETTLE_MS);
    return this.pageInfo(tab.view.webContents);
  }

  private async selectOption(tab: Tab, ref: string, values: string[]): Promise<PageInfo> {
    this.assertRef(tab, ref);
    const outcome: unknown = await tab.view.webContents.executeJavaScript(
      pageSelectOptionScript(ref, values),
      true
    );
    if (outcome === 'stale') throw staleRef(ref);
    if (outcome !== 'ok') throw new Error(`Could not select option on ${ref}`);
    await sleep(SETTLE_MS);
    return this.pageInfo(tab.view.webContents);
  }

  private async boundingBox(tab: Tab, ref: string): Promise<unknown> {
    this.assertRef(tab, ref);
    const box: unknown = await tab.view.webContents.executeJavaScript(
      pageBoundingBoxScript(ref),
      true
    );
    if (!box) throw staleRef(ref);
    return box;
  }

  private async drag(tab: Tab, params: unknown): Promise<PageInfo> {
    const fromRef =
      isRecord(params) && typeof params.fromRef === 'string' ? params.fromRef : undefined;
    const toRef = isRecord(params) && typeof params.toRef === 'string' ? params.toRef : undefined;
    const fromX = isRecord(params) ? Number(params.fromX) : Number.NaN;
    const fromY = isRecord(params) ? Number(params.fromY) : Number.NaN;
    const toX = isRecord(params) ? Number(params.toX) : Number.NaN;
    const toY = isRecord(params) ? Number(params.toY) : Number.NaN;
    const from = fromRef ? { ref: fromRef } : { x: fromX, y: fromY };
    const to = toRef ? { ref: toRef } : { x: toX, y: toY };
    if (fromRef) this.assertRef(tab, fromRef);
    if (toRef) this.assertRef(tab, toRef);
    const outcome: unknown = await tab.view.webContents.executeJavaScript(
      pageDragScript(from, to),
      true
    );
    if (outcome === 'stale') throw new Error('Drag source or target ref is stale.');
    if (outcome !== 'ok') throw new Error('Drag failed.');
    await sleep(SETTLE_MS);
    return this.pageInfo(tab.view.webContents);
  }

  private async cdpCommand(
    tab: Tab,
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    assertDevtoolsIdle(tab.devtoolsOpen);
    assertAllowedCdpMethod(method);
    return this.cdp(tab, method, params);
  }

  /**
   * 被 renderer 盖住的 view `capturePage` 会报 UnknownVizError（合成器不出帧）。
   * 走 CDP `Page.captureScreenshot` + captureBeyondViewport 强制 Blink 离屏渲染。
   * debugger 只在 host 内用，模型摸不到。
   */
  private async screenshot(tab: Tab, ref?: string): Promise<{ data: string; mimeType: string }> {
    assertDevtoolsIdle(tab.devtoolsOpen);
    let clip: { x: number; y: number; width: number; height: number; scale: number };
    if (ref) {
      this.assertRef(tab, ref);
      const box = (await tab.view.webContents.executeJavaScript(
        pageBoundingBoxScript(ref),
        true
      )) as { x: number; y: number; width: number; height: number } | null;
      if (!box) throw staleRef(ref);
      clip = {
        x: box.x,
        y: box.y,
        width: Math.max(1, box.width),
        height: Math.max(1, box.height),
        scale: 1,
      };
    } else {
      const bounds = tab.view.getBounds();
      const width = bounds.width || HEADLESS_BOUNDS.width;
      const height = bounds.height || HEADLESS_BOUNDS.height;
      const scale = width > SCREENSHOT_MAX_WIDTH ? SCREENSHOT_MAX_WIDTH / width : 1;
      clip = { x: 0, y: 0, width, height, scale };
    }
    return this.screenshotClip(tab, clip);
  }

  private async screenshotClip(
    tab: Tab,
    clip: { x: number; y: number; width: number; height: number; scale: number }
  ): Promise<{ data: string; mimeType: string }> {
    assertDevtoolsIdle(tab.devtoolsOpen);
    const shot = (await this.cdp(tab, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip,
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

  private createTab(sessionId: string, tabId?: string): Tab {
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
    // 默认透明会透过无边框窗口看到桌面；导航空白帧要垫一层不透明底
    view.setBackgroundColor('#ffffff');
    const id = tabId ?? `browser:${++this.counter}-${Date.now().toString(36)}`;
    const tab: Tab = {
      id,
      view,
      ownerSessionId: sessionId,
      createdAt: Date.now(),
      locked: false,
      ready: false,
      devtoolsOpen: false,
      designMode: false,
      favicon: null,
      pickSeq: 0,
    };
    const contents = view.webContents;
    const push = () => this.emitState(sessionId, id);
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
    contents.on('page-favicon-updated', (_event, urls) => {
      tab.favicon = pickFaviconUrl(urls);
      push();
    });
    contents.on('did-navigate', () => {
      tab.lastSnapshot = undefined;
      tab.favicon = null;
      push();
    });
    contents.on('did-finish-load', () => {
      if (tab.locked) void this.syncLockOverlay(tab);
      if (tab.designMode) void this.runGuest(tab, PAGE_DESIGN_MODE_ENABLE_SCRIPT);
    });
    contents.once('dom-ready', () => {
      tab.ready = true;
      this.layout();
      if (tab.designMode) void this.runGuest(tab, PAGE_DESIGN_MODE_ENABLE_SCRIPT);
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
      this.emitState(sessionId, id);
    });
    this.tabs.set(id, tab);
    this.currentBySession.set(sessionId, id);
    this.layout();
    this.emitState(sessionId, id);
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
      .filter((tab) => !tab.locked && tab.id !== this.shown?.tabId && !this.userTabs.has(tab.id))
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) void this.destroyTab(oldest);
  }

  /** 回合结束：未锁、用户没在看的 tab 关掉（页面不留后台） */
  async closeForSession(sessionId: string, opts: { force?: boolean } = {}): Promise<void> {
    const tab = this.tabFor(sessionId);
    if (!tab) return;
    if (
      !opts.force &&
      (tab.locked ||
        this.shown?.sessionId === sessionId ||
        this.pendingReveal.has(sessionId) ||
        (tab && this.userTabs.has(tab.id)))
    ) {
      return;
    }
    await this.destroyTab(tab);
  }

  private async destroyTab(tab: Tab, opts?: { keepPersist?: boolean }): Promise<void> {
    this.tabs.delete(tab.id);
    if (this.currentBySession.get(tab.ownerSessionId) === tab.id) {
      this.currentBySession.delete(tab.ownerSessionId);
    }
    if (!this.disposing && !opts?.keepPersist && !this.userTabs.has(tab.id)) {
      this.forgetTab(tab.id);
    }
    await this.flush();
    this.teardownDevTools(tab);
    if (this.shownDevtools?.tabId === tab.id) this.shownDevtools = null;
    if (tab.devtools) {
      this.detach(tab.devtools);
      if (!tab.devtools.webContents.isDestroyed()) tab.devtools.webContents.close();
      tab.devtools = undefined;
    }
    this.detach(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    this.emitState(tab.ownerSessionId, tab.id);
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

  private persistPath(): string {
    return join(app.getPath('userData'), 'browser-tabs.json');
  }

  private loadPersisted(): void {
    if (this.persistedLoaded) return;
    this.persistedLoaded = true;
    try {
      if (!existsSync(this.persistPath())) return;
      this.persisted = parsePersistedBrowserTabs(
        JSON.parse(readFileSync(this.persistPath(), 'utf8')) as unknown
      );
    } catch {
      this.persisted = {};
    }
  }

  private writePersisted(): void {
    try {
      writeFileSync(this.persistPath(), serializePersistedBrowserTabs(this.persisted));
    } catch {}
  }

  private rememberTab(sessionId: string, tab: PersistedBrowserTab): void {
    this.loadPersisted();
    this.persisted[sessionId] = tab;
    this.writePersisted();
  }

  private forgetTab(sessionId: string): void {
    this.loadPersisted();
    if (!(sessionId in this.persisted)) return;
    delete this.persisted[sessionId];
    this.writePersisted();
  }

  private touch(tabId: string): void {
    this.lastSeen.set(tabId, Date.now());
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => void this.hibernateIdleTabs(), IDLE_TICK_MS);
  }

  private async hibernateIdleTabs(): Promise<void> {
    const now = Date.now();
    for (const tab of [...this.tabs.values()]) {
      if (tab.locked || tab.id === this.shown?.tabId) continue;
      const seen = this.lastSeen.get(tab.id) ?? tab.createdAt;
      if (now - seen < IDLE_MS) continue;
      const state = this.stateOf(tab);
      if (state.url.startsWith('http')) {
        this.rememberTab(tab.id, {
          url: state.url,
          title: state.title,
          conversationId: tab.ownerSessionId,
          at: seen,
        });
      }
      await this.destroyTab(tab, { keepPersist: true });
    }
    if (this.tabs.size === 0 && this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private async restoreTab(tabId: string, sessionId?: string): Promise<void> {
    this.loadPersisted();
    if (this.tabs.has(tabId)) return;
    const saved = this.persisted[tabId];
    const owner = saved?.conversationId ?? sessionId ?? tabId;
    const tab = this.createTab(owner, tabId);
    this.userTabs.add(tab.id);
    if (!saved?.url) return;
    try {
      assertAllowedUrl(saved.url);
    } catch {
      return;
    }
    await tab.view.webContents.loadURL(saved.url).catch(() => {});
  }

  async restorePersistedTabs(): Promise<void> {
    this.loadPersisted();
  }

  /** 退出前：flush 后关掉全部 tab。 */
  async dispose(): Promise<void> {
    this.disposing = true;
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }
    for (const tab of [...this.tabs.values()]) await this.destroyTab(tab);
  }
}

const staleRef = (ref: string) =>
  new Error(`Ref ${ref} is stale or unknown. Call browser_snapshot again and use a fresh ref.`);

export const browserHost = new BrowserHost();
