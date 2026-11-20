import { join } from 'node:path';
import { type IpcInvokeEvent, ipcMain } from '@platform';
import {
  NODE_SETTINGS_SCHEME,
  type NodeShellPage,
  nodeShellUrl,
  parseNodeSettingsUrl,
} from '@shared/nodeSettings';
import { parseSettingsDeepLink, type SettingsDeepLink } from '@shared/settingsDeepLink';
import { IPC_CHANNELS } from '@shared/types';
import type { NodeActionResult } from '@shared/types/nodes';
import { BrowserWindow, protocol, type WebContents, WebContentsView } from 'electron';
import { attachNavigationGuard, openExternalWebUrl } from '../../windows/appNavigation';
import {
  attachEditContextMenu,
  getWindowWebContents,
  setWindowCover,
  TRAFFIC_LIGHT_POSITION,
} from '../../windows/createAppWindow';
import { focusMainWindow, getMainWindow } from '../../windows/MainWindow';
import { presentWindow, showWindow } from '../../windows/verifyLaunch';
import { attachPinnedWorkbenchBoundsSync, pinnedWorkbenchBounds } from '../../windows/win32Restore';
import { loadNodes } from '../nodeStore';
import { notifyFromNode, setLocalLayerVisible } from '../notifications';
import { isNodeHostOnline, sendRemoteToNode, setNodeRemoteHooks } from '../pairGuest';
import { registeredHandler } from '../remoteRenderer/ipcRegistry';
import { broadcastToRenderers, isMainRenderer, sendToLocalMain } from '../renderers';
import { waitUntil } from './boot';
import { isNodePageUrl, type LocalCall, parseHostNotification, parseLocalCall } from './boundary';
import { type ActiveNode, NodeLayers } from './layers';
import { type NodeAsset, NodeRemoteTunnel } from './tunnel';

/**
 * 在本机跑宿主（对方桌面）的 renderer：
 * - 主窗口节点层：WebContentsView 盖在本机 workbench 上，壳页确认节点在线后整页跳到 r/index.html；
 * - 节点设置窗口：壳页里 iframe 加载 r/settings.html。
 * nodeRemote preload 挂 `__ensoRemote`，web-preload 经它走 main 侧 rpc 隧道；资源经 enso-node:// 向宿主取。
 * 主界面里本机窗口、节点切换与系统通知的调用经 local 通道回到本机 main（boundary.ts 白名单）。
 */

interface Surface {
  nodeId: string;
  page: NodeShellPage;
  contents: WebContents;
  /** 该页面 attach 的 cid */
  cids: Set<string>;
  /** 主界面上报的正在查看的会话：本机弹该节点通知时按它抑制 */
  viewed: string | null;
  /** 主界面没能在本页跑起来（宿主 renderer 不支持顶层运行）；壳页停在版本过旧提示，节点重连后重试 */
  bootFailed: boolean;
}

const tunnels = new Map<string, NodeRemoteTunnel>();
const windows = new Map<string, BrowserWindow>();
/** webContents.id → 节点设置窗口或主窗口节点层 */
const surfaces = new Map<number, Surface>();
/** 节点设置窗口新开时带的深链，壳页 init 时取走 */
const pendingLinks = new Map<string, SettingsDeepLink>();

const ASSET_TIMEOUT_MS = 60_000;
/** 带内容 hash 的构建产物不会变，按节点缓存在内存，再次打开窗口免下载 */
const IMMUTABLE_ASSET = /^r\/assets\/[^/]+-[\w-]{8}\.\w+$/;
const assetCache = new Map<string, Map<string, NodeAsset>>();

function tunnelFor(nodeId: string): NodeRemoteTunnel {
  let tunnel = tunnels.get(nodeId);
  if (!tunnel) {
    tunnel = new NodeRemoteTunnel((frame) => sendRemoteToNode(nodeId, frame));
    tunnel.setOnline(isNodeHostOnline(nodeId));
    tunnels.set(nodeId, tunnel);
  }
  return tunnel;
}

function dropTunnel(nodeId: string): void {
  tunnels.get(nodeId)?.close();
  tunnels.delete(nodeId);
  assetCache.delete(nodeId);
}

async function fetchCachedAsset(nodeId: string, path: string): Promise<NodeAsset> {
  const cached = assetCache.get(nodeId)?.get(path);
  if (cached) return cached;
  const asset = await fetchAsset(nodeId, path);
  if (asset.status === 200 && IMMUTABLE_ASSET.test(path)) {
    let cache = assetCache.get(nodeId);
    if (!cache) {
      cache = new Map();
      assetCache.set(nodeId, cache);
    }
    cache.set(path, asset);
  }
  return asset;
}

function fetchAsset(nodeId: string, path: string): Promise<NodeAsset> {
  // 超时交给 tunnel：它会同时撤掉在途条目，节点重新上线时不再补发已放弃的请求
  return tunnelFor(nodeId).fetchAsset(path, ASSET_TIMEOUT_MS);
}

const SHELL_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<style>html,body{margin:0;height:100%;overflow:hidden;font:13px system-ui;color:#888;background:Canvas}
iframe{position:absolute;inset:0;border:0;width:100%;height:100%;opacity:0;transition:opacity .2s}
iframe.on{opacity:1}
#s{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px}
#s i{width:20px;height:20px;border:2px solid #8884;border-top-color:#888;border-radius:50%;animation:r .8s linear infinite}
#s.err i{display:none}
#b{font:inherit;padding:4px 12px;border-radius:6px;border:1px solid #8886;background:transparent;color:CanvasText;-webkit-app-region:no-drag}
html.drag{-webkit-app-region:drag}
@keyframes r{to{transform:rotate(360deg)}}</style></head>
<body><div id="s"><i></i><span></span><button id="b" hidden></button></div></body></html>`;

/** scheme 特权与 local-image 在 localImageScheme.ts 一次登记（registerSchemesAsPrivileged 后调用会覆盖前者） */
export function registerNodeSettingsProtocolHandler(): void {
  protocol.handle(NODE_SETTINGS_SCHEME, async (request) => {
    const parsed = parseNodeSettingsUrl(request.url);
    // 只为已打开的节点界面服务
    if (!parsed || !isSurfaceOpen(parsed.nodeId)) return new Response(null, { status: 404 });
    const { nodeId, path } = parsed;
    if (path === 'shell.html') {
      return new Response(SHELL_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    // web-preload 在非 /desk/r/ 路径下的本地图片前缀
    const remotePath = path.startsWith('r/')
      ? path
      : path.startsWith('desk/li/_/')
        ? `li/${path.slice('desk/li/_/'.length)}`
        : null;
    if (!remotePath) return new Response(null, { status: 404 });
    const asset = await fetchCachedAsset(nodeId, remotePath);
    return new Response(asset.status === 204 ? null : (asset.body as Uint8Array<ArrayBuffer>), {
      status: asset.status,
      headers: { 'content-type': asset.mime },
    });
  });
}

const isSurfaceOpen = (nodeId: string): boolean =>
  [...surfaces.values()].some((surface) => surface.nodeId === nodeId);

function shellPreferences(): Electron.WebPreferences {
  return {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: false,
    preload: join(import.meta.dirname, '../preload/nodeRemote.mjs'),
  };
}

/** 登记节点界面并收紧导航 */
function attachSurface(contents: WebContents, nodeId: string, page: NodeShellPage): void {
  const id = contents.id;
  surfaces.set(id, { nodeId, page, contents, cids: new Set(), viewed: null, bootFailed: false });
  contents.setWindowOpenHandler(({ url }) => {
    openExternalWebUrl(url);
    return { action: 'deny' };
  });
  attachNavigationGuard(contents, (url) => isNodePageUrl(url, nodeId));
  contents.once('destroyed', () => {
    const entry = surfaces.get(id);
    surfaces.delete(id);
    for (const cid of entry?.cids ?? []) tunnels.get(nodeId)?.detach(cid);
  });
}

export function openNodeSettingsWindow(
  nodeId: string,
  link: SettingsDeepLink | null = null
): boolean {
  const node = loadNodes().find((n) => n.nodeId === nodeId);
  if (!node) return false;
  const existing = windows.get(nodeId);
  if (existing && !existing.isDestroyed()) {
    presentWindow(existing);
    if (link) sendSettingsLink(nodeId, link);
    return true;
  }
  if (link) pendingLinks.set(nodeId, link);
  else pendingLinks.delete(nodeId);
  const win = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 720,
    minHeight: 480,
    title: node.label,
    show: false,
    webPreferences: shellPreferences(),
  });
  windows.set(nodeId, win);
  attachSurface(win.webContents, nodeId, 'settings');
  win.on('page-title-updated', (event) => event.preventDefault());
  win.once('ready-to-show', () => showWindow(win));
  win.on('closed', () => windows.delete(nodeId));
  void win.loadURL(nodeShellUrl(nodeId, 'settings'));
  return true;
}

export function closeNodeSettingsWindows(): void {
  for (const win of [...windows.values()]) if (!win.isDestroyed()) win.close();
}

/** 设置页已开：按宿主事件的形状把深链交给它（web-preload 订阅的 settings:deep-link） */
function sendSettingsLink(nodeId: string, link: SettingsDeepLink): void {
  for (const surface of surfaces.values()) {
    if (surface.nodeId !== nodeId || surface.page !== 'settings') continue;
    for (const cid of surface.cids) {
      surface.contents.send(
        IPC_CHANNELS.NODE_REMOTE_EVENT,
        cid,
        IPC_CHANNELS.SETTINGS_DEEP_LINK,
        JSON.stringify([link])
      );
    }
  }
}

// ── 主界面 ↔ 本机 main ────────────────────────────────────────────────

function sendToNodeView(surface: Surface, channel: string, ...args: unknown[]): void {
  if (surface.page !== 'main' || surface.contents.isDestroyed()) return;
  surface.contents.send(IPC_CHANNELS.NODE_REMOTE_LOCAL_EVENT, channel, JSON.stringify(args));
}

/** 本机状态推给各节点主界面（节点列表、可见层、窗口最大化/全屏） */
export function sendToNodeViews(channel: string, ...args: unknown[]): void {
  for (const surface of surfaces.values()) sendToNodeView(surface, channel, ...args);
}

async function runLocalCall(surface: Surface, call: LocalCall): Promise<unknown> {
  switch (call.channel) {
    case IPC_CHANNELS.WINDOW_OPEN_SETTINGS:
      openNodeSettingsWindow(surface.nodeId, parseSettingsDeepLink(call.args[0]));
      return undefined;
    case IPC_CHANNELS.NOTIFICATION_ACTIVE_SESSION:
      surface.viewed = call.args[0] as string | null;
      return undefined;
    default: {
      // 其余与本机窗口同一批 handler：sender 是节点层，窗口控件作用于它所在的主窗口
      const handler = registeredHandler(call.channel);
      if (!handler) throw new Error(`No handler registered for '${call.channel}'`);
      return handler({ sender: surface.contents } as unknown as IpcInvokeEvent, ...call.args);
    }
  }
}

function notifyFromHost(surface: Surface, payload: string): void {
  const content = parseHostNotification(payload);
  if (!content) return;
  const win = layersWindow;
  const watching =
    win !== null &&
    !win.isDestroyed() &&
    win.isFocused() &&
    layers.active === surface.nodeId &&
    surface.viewed === content.sessionId;
  if (watching) return;
  const label = loadNodes().find((node) => node.nodeId === surface.nodeId)?.label ?? '';
  notifyFromNode(label, content, () => {
    focusMainWindow();
    if (switchNode(surface.nodeId).ok) {
      sendToNodeView(surface, IPC_CHANNELS.NOTIFICATION_FOCUS_SESSION, content.sessionId);
    }
  });
}

// ── 主窗口节点层 ──────────────────────────────────────────────────────

/** 节点层所在的主窗口；主窗口关掉（进托盘）时各层随之销毁，重建后从本机开始 */
let layersWindow: BrowserWindow | null = null;

const layers = new NodeLayers<WebContentsView>(
  { create: createNodeView, show: showNodeView, destroy: destroyNodeView },
  (active) => {
    setLocalLayerVisible(active === 'local');
    broadcastToRenderers(IPC_CHANNELS.NODES_ACTIVE_CHANGED, active);
    sendToNodeViews(IPC_CHANNELS.NODES_ACTIVE_CHANGED, active);
  }
);

function layerWindow(): BrowserWindow | null {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return null;
  if (layersWindow === win) return win;
  layersWindow = win;
  attachPinnedWorkbenchBoundsSync(win, {
    setBounds: (bounds) => {
      for (const view of layers.all()) view.setBounds(bounds);
    },
  });
  win.once('closed', () => {
    if (layersWindow === win) layersWindow = null;
    layers.reset();
  });
  return win;
}

function createNodeView(nodeId: string): WebContentsView {
  const win = layersWindow as BrowserWindow;
  const view = new WebContentsView({ webPreferences: shellPreferences() });
  view.setBackgroundColor('#00000000');
  const bounds = pinnedWorkbenchBounds(win);
  if (bounds) view.setBounds(bounds);
  const contents = view.webContents;
  attachSurface(contents, nodeId, 'main');
  attachEditContextMenu(win, contents);
  contents.on('render-process-gone', () => {
    if (!contents.isDestroyed()) void contents.loadURL(nodeShellUrl(nodeId, 'main'));
  });
  contents.on('did-finish-load', () => void watchMainBoot(nodeId, contents));
  void contents.loadURL(nodeShellUrl(nodeId, 'main'));
  return view;
}

const BOOT_TIMEOUT_MS = 5_000;
const BOOT_PROBE = `!!window.electronAPI && (document.getElementById('root')?.childElementCount ?? 0) > 0`;

/**
 * 旧宿主（或残留旧构建）的 web-preload 要求在 iframe 里运行，顶层文档里直接抛错：
 * 页面透明、#root 为空，看到的是底下的本机界面却全被盖层吃掉点击。没挂上就退回壳页给出返回按钮。
 */
async function watchMainBoot(nodeId: string, contents: WebContents): Promise<void> {
  const url = contents.getURL();
  if (parseNodeSettingsUrl(url)?.path !== 'r/index.html') return;
  const gone = () => contents.isDestroyed() || contents.getURL() !== url;
  const booted = await waitUntil(
    async () => gone() || (await contents.executeJavaScript(BOOT_PROBE)) === true,
    { timeoutMs: BOOT_TIMEOUT_MS, intervalMs: 250 }
  );
  if (booted || gone()) return;
  const entry = surfaces.get(contents.id);
  if (entry) entry.bootFailed = true;
  void contents.loadURL(nodeShellUrl(nodeId, 'main'));
}

function showNodeView(view: WebContentsView | null): void {
  const win = layersWindow;
  if (!win || win.isDestroyed()) return;
  for (const other of layers.all()) if (other !== view) other.setVisible(false);
  setWindowCover(win, view);
  // 红绿灯显隐由当前层的弹窗控制；换层后按新层从显示开始，免得被上一层藏住
  if (process.platform === 'darwin') {
    win.setWindowButtonVisibility(true);
    win.setWindowButtonPosition(TRAFFIC_LIGHT_POSITION);
  }
  if (view) {
    view.setVisible(true);
    view.webContents.focus();
  } else {
    getWindowWebContents(win).focus();
  }
}

function destroyNodeView(view: WebContentsView): void {
  const win = layersWindow;
  if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
  if (!view.webContents.isDestroyed()) view.webContents.close();
}

export function switchNode(target: ActiveNode): NodeActionResult {
  if (target !== 'local' && !loadNodes().some((node) => node.nodeId === target)) {
    return { ok: false, error: 'node not found' };
  }
  if (!layerWindow()) return { ok: false, error: 'main window unavailable' };
  layers.switchTo(target);
  return { ok: true };
}

/** 节点在线后，停在离线提示上的节点层重新走一遍壳页 */
function retryOfflineShell(nodeId: string): void {
  const contents = layers.view(nodeId)?.webContents;
  if (
    contents &&
    !contents.isDestroyed() &&
    parseNodeSettingsUrl(contents.getURL())?.path === 'shell.html'
  ) {
    contents.reload();
  }
}

function surfaceOf(event: { sender: { id: number } }) {
  return surfaces.get(event.sender.id);
}

export function registerNodeRemoteHandlers(): void {
  setNodeRemoteHooks({
    frame: (nodeId, frame) => tunnels.get(nodeId)?.receive(frame),
    online: (nodeId, online) => {
      tunnels.get(nodeId)?.setOnline(online);
      if (!online) return;
      for (const surface of surfaces.values()) {
        if (surface.nodeId === nodeId) surface.bootFailed = false;
      }
      retryOfflineShell(nodeId);
    },
    removed: (nodeId) => {
      layers.drop(nodeId);
      windows.get(nodeId)?.close();
      dropTunnel(nodeId);
    },
    status: (status) => sendToNodeViews(IPC_CHANNELS.NODES_STATUS_CHANGED, status),
  });

  ipcMain.handle(IPC_CHANNELS.NODES_OPEN_SETTINGS, (event, nodeId: unknown) => {
    if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'forbidden' };
    if (typeof nodeId !== 'string' || !nodeId) return { ok: false, error: 'invalid nodeId' };
    return openNodeSettingsWindow(nodeId) ? { ok: true } : { ok: false, error: 'node not found' };
  });

  ipcMain.handle(IPC_CHANNELS.NODES_SWITCH, (event, target: unknown) => {
    if (!isMainRenderer(event.sender.id) && surfaceOf(event)?.page !== 'main') {
      return { ok: false, error: 'forbidden' };
    }
    if (typeof target !== 'string' || !target) return { ok: false, error: 'invalid node' };
    return switchNode(target);
  });

  ipcMain.handle(IPC_CHANNELS.NODES_ACTIVE, (): ActiveNode => layers.active);

  ipcMain.handle(IPC_CHANNELS.NODES_REQUEST_PAIR, (event) => {
    if (!isMainRenderer(event.sender.id) && surfaceOf(event)?.page !== 'main') {
      return { ok: false, error: 'forbidden' };
    }
    const result = switchNode('local');
    if (result.ok) sendToLocalMain(IPC_CHANNELS.NODES_PAIR_REQUESTED);
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.NODE_REMOTE_INIT, async (event) => {
    const entry = surfaceOf(event);
    if (!entry) return { ok: false, error: 'forbidden' };
    if (entry.bootFailed) return { ok: false, error: 'host-outdated' };
    if (!isNodeHostOnline(entry.nodeId)) return { ok: false, error: 'offline' };
    const meta = await fetchAsset(entry.nodeId, 'meta');
    if (meta.status !== 200) {
      return { ok: false, error: meta.status === 504 ? 'offline' : 'host-outdated' };
    }
    try {
      const parsed = JSON.parse(new TextDecoder().decode(meta.body)) as { platform?: unknown };
      if (typeof parsed.platform !== 'string') return { ok: false, error: 'host-outdated' };
      const link = entry.page === 'settings' ? pendingLinks.get(entry.nodeId) : undefined;
      pendingLinks.delete(entry.nodeId);
      return { ok: true, platform: parsed.platform, ...(link ? { link } : {}) };
    } catch {
      return { ok: false, error: 'host-outdated' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.NODE_REMOTE_ATTACH, (event, kind: unknown) => {
    const entry = surfaceOf(event);
    if (!entry || kind !== entry.page) return null;
    const { contents } = entry;
    const cid = tunnelFor(entry.nodeId).attach(entry.page, {
      onEvent: (channel, payload) => {
        if (contents.isDestroyed()) return;
        if (channel === IPC_CHANNELS.NOTIFICATION_SHOW) {
          if (entry.page === 'main') notifyFromHost(entry, payload);
          return;
        }
        contents.send(IPC_CHANNELS.NODE_REMOTE_EVENT, cid, channel, payload);
      },
      onReset: () => {
        entry.cids.delete(cid);
        if (!contents.isDestroyed()) contents.reload();
      },
      onReady: (leader) => {
        if (entry.page !== 'main' || contents.isDestroyed()) return;
        // 宿主只在 rpc-ready 里给初始 leader，之后才发变化事件；按事件补给 web-preload
        contents.send(
          IPC_CHANNELS.NODE_REMOTE_EVENT,
          cid,
          IPC_CHANNELS.REMOTE_LEADER_CHANGED,
          JSON.stringify([leader])
        );
      },
    });
    entry.cids.add(cid);
    return cid;
  });

  const owned = (event: { sender: { id: number } }, cid: unknown) => {
    const entry = surfaceOf(event);
    return entry && typeof cid === 'string' && entry.cids.has(cid) ? entry : null;
  };

  ipcMain.handle(
    IPC_CHANNELS.NODE_REMOTE_INVOKE,
    (event, cid: unknown, channel: unknown, payload: unknown) => {
      const entry = owned(event, cid);
      if (!entry || typeof channel !== 'string' || typeof payload !== 'string') {
        return Promise.reject(new Error('remote-frame-closed'));
      }
      return tunnelFor(entry.nodeId).invoke(cid as string, channel, payload);
    }
  );

  ipcMain.on(
    IPC_CHANNELS.NODE_REMOTE_SEND,
    (event, cid: unknown, channel: unknown, payload: unknown) => {
      const entry = owned(event, cid);
      if (!entry || typeof channel !== 'string' || typeof payload !== 'string') return;
      tunnelFor(entry.nodeId).send(cid as string, channel, payload);
    }
  );

  ipcMain.on(IPC_CHANNELS.NODE_REMOTE_DETACH, (event, cid: unknown) => {
    const entry = owned(event, cid);
    if (!entry) return;
    entry.cids.delete(cid as string);
    tunnels.get(entry.nodeId)?.detach(cid as string);
  });

  ipcMain.on(IPC_CHANNELS.NODE_REMOTE_CLOSE, (event) => {
    const entry = surfaceOf(event);
    if (entry?.page === 'settings') windows.get(entry.nodeId)?.close();
    else if (entry?.page === 'main') switchNode('local');
  });

  const localCall = (event: { sender: { id: number } }, channel: unknown, payload: unknown) => {
    const surface = surfaceOf(event);
    const call = surface?.page === 'main' ? parseLocalCall(channel, payload) : null;
    return surface && call ? { surface, call } : null;
  };

  ipcMain.handle(
    IPC_CHANNELS.NODE_REMOTE_LOCAL_INVOKE,
    async (event, channel: unknown, payload: unknown): Promise<string> => {
      const target = localCall(event, channel, payload);
      if (!target) {
        return JSON.stringify({
          ok: false,
          error: `Channel '${String(channel)}' is not available`,
        });
      }
      try {
        return JSON.stringify({ ok: true, value: await runLocalCall(target.surface, target.call) });
      } catch (error) {
        return JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );

  ipcMain.on(IPC_CHANNELS.NODE_REMOTE_LOCAL_SEND, (event, channel: unknown, payload: unknown) => {
    const target = localCall(event, channel, payload);
    if (target) void runLocalCall(target.surface, target.call).catch(() => {});
  });
}
