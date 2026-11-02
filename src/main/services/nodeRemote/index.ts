import { join } from 'node:path';
import { ipcMain } from '@platform';
import { NODE_SETTINGS_SCHEME, nodeSettingsUrl, parseNodeSettingsUrl } from '@shared/nodeSettings';
import { IPC_CHANNELS } from '@shared/types';
import { BrowserWindow, protocol, shell } from 'electron';
import { loadNodes } from '../nodeStore';
import { isNodeHostOnline, sendRemoteToNode, setNodeRemoteHooks } from '../pairGuest';
import { isMainRenderer } from '../renderers';
import { type NodeAsset, NodeRemoteTunnel } from './tunnel';

/**
 * 节点设置窗口：在本机窗口里跑宿主的设置页 renderer。
 * 壳页（shell.html）由专用 preload 挂 `__ensoRemote`，iframe 加载宿主下发的 r/settings.html，
 * 其 web-preload 经该桥走 main 侧 rpc 隧道；资源经 enso-node:// 协议向宿主取。
 */

const tunnels = new Map<string, NodeRemoteTunnel>();
const windows = new Map<string, BrowserWindow>();
/** webContents.id → { nodeId, 该页面 attach 的 cid } */
const senders = new Map<number, { nodeId: string; cids: Set<string> }>();

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
  return Promise.race([
    tunnelFor(nodeId).fetchAsset(path),
    new Promise<NodeAsset>((resolve) =>
      setTimeout(
        () => resolve({ status: 504, mime: 'text/plain', body: new Uint8Array() }),
        ASSET_TIMEOUT_MS
      )
    ),
  ]);
}

const SHELL_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<style>html,body{margin:0;height:100%;overflow:hidden;font:13px system-ui;color:#888;background:Canvas}
iframe{position:absolute;inset:0;border:0;width:100%;height:100%;opacity:0;transition:opacity .2s}
iframe.on{opacity:1}
#s{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px}
#s i{width:20px;height:20px;border:2px solid #8884;border-top-color:#888;border-radius:50%;animation:r .8s linear infinite}
#s.err i{display:none}
@keyframes r{to{transform:rotate(360deg)}}</style></head>
<body><div id="s"><i></i><span></span></div></body></html>`;

/** scheme 特权与 local-image 在 localImageScheme.ts 一次登记（registerSchemesAsPrivileged 后调用会覆盖前者） */
export function registerNodeSettingsProtocolHandler(): void {
  protocol.handle(NODE_SETTINGS_SCHEME, async (request) => {
    const parsed = parseNodeSettingsUrl(request.url);
    // 只为已打开的节点设置窗口服务
    if (!parsed || !windows.has(parsed.nodeId)) return new Response(null, { status: 404 });
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

export function openNodeSettingsWindow(nodeId: string): boolean {
  const node = loadNodes().find((n) => n.nodeId === nodeId);
  if (!node) return false;
  const existing = windows.get(nodeId);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return true;
  }
  const win = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 720,
    minHeight: 480,
    title: node.label,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: join(import.meta.dirname, '../preload/nodeSettings.mjs'),
    },
  });
  const contents = win.webContents;
  const id = contents.id;
  windows.set(nodeId, win);
  senders.set(id, { nodeId, cids: new Set() });
  win.on('page-title-updated', (event) => event.preventDefault());
  win.once('ready-to-show', () => win.show());
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${NODE_SETTINGS_SCHEME}:`)) event.preventDefault();
  });
  win.on('closed', () => {
    const entry = senders.get(id);
    senders.delete(id);
    windows.delete(nodeId);
    for (const cid of entry?.cids ?? []) tunnels.get(nodeId)?.detach(cid);
  });
  void win.loadURL(nodeSettingsUrl(nodeId));
  return true;
}

function senderEntry(event: { sender: { id: number } }) {
  return senders.get(event.sender.id);
}

export function registerNodeRemoteHandlers(): void {
  setNodeRemoteHooks({
    frame: (nodeId, frame) => tunnels.get(nodeId)?.receive(frame),
    online: (nodeId, online) => tunnels.get(nodeId)?.setOnline(online),
    removed: (nodeId) => {
      windows.get(nodeId)?.close();
      dropTunnel(nodeId);
    },
  });

  ipcMain.handle(IPC_CHANNELS.NODES_OPEN_SETTINGS, (event, nodeId: unknown) => {
    if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'forbidden' };
    if (typeof nodeId !== 'string' || !nodeId) return { ok: false, error: 'invalid nodeId' };
    return openNodeSettingsWindow(nodeId) ? { ok: true } : { ok: false, error: 'node not found' };
  });

  ipcMain.handle(IPC_CHANNELS.NODE_REMOTE_INIT, async (event) => {
    const entry = senderEntry(event);
    if (!entry) return { ok: false, error: 'forbidden' };
    if (!isNodeHostOnline(entry.nodeId)) return { ok: false, error: 'offline' };
    const meta = await fetchAsset(entry.nodeId, 'meta');
    if (meta.status !== 200) {
      return { ok: false, error: meta.status === 504 ? 'offline' : 'host-outdated' };
    }
    try {
      const parsed = JSON.parse(new TextDecoder().decode(meta.body)) as { platform?: unknown };
      if (typeof parsed.platform !== 'string') return { ok: false, error: 'host-outdated' };
      return { ok: true, platform: parsed.platform };
    } catch {
      return { ok: false, error: 'host-outdated' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.NODE_REMOTE_ATTACH, (event, kind: unknown) => {
    const entry = senderEntry(event);
    if (!entry || kind !== 'settings') return null;
    const contents = event.sender;
    const cid = tunnelFor(entry.nodeId).attach('settings', {
      onEvent: (channel, payload) => {
        if (!contents.isDestroyed()) {
          contents.send(IPC_CHANNELS.NODE_REMOTE_EVENT, cid, channel, payload);
        }
      },
      onReset: () => {
        entry.cids.delete(cid);
        const win = windows.get(entry.nodeId);
        if (win && !win.isDestroyed()) win.webContents.reload();
      },
    });
    entry.cids.add(cid);
    return cid;
  });

  const owned = (event: { sender: { id: number } }, cid: unknown) => {
    const entry = senderEntry(event);
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
    const entry = senderEntry(event);
    if (entry) windows.get(entry.nodeId)?.close();
  });
}
