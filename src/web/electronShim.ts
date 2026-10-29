/**
 * 浏览器里替代 `electron` 模块：web-preload 构建时把 preload 的 electron 导入指到这里，
 * ipcRenderer 走父页面（PWA 壳）持有的加密隧道；作用于宿主桌面的通道在本地实现。
 */
import type { RemoteBridge, RemoteFrameKind } from '@shared/remoteBridge';
import {
  RemoteReadClient,
  type RemoteReadStore,
  RemoteWriteClient,
  UPSERT_MARK,
  UpsertDecoder,
  withIfNone,
  withUpsertReset,
} from '@shared/remoteDelta';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { decodeRemoteValue, encodeRemoteValue } from '../../packages/pair/src/remote';
import { isRemoteChannelAllowed } from '../main/services/remoteRenderer/channels';

const bridge = (window.parent as Window & { __ensoRemote?: RemoteBridge }).__ensoRemote;
if (!bridge || window.parent === window) {
  throw new Error('EnsoCode remote bridge is missing');
}

export const remoteBridge: RemoteBridge = bridge;
const kind: RemoteFrameKind = /settings\.html$/.test(location.pathname) ? 'settings' : 'main';
const frame = bridge.attach(kind);
addEventListener('pagehide', () => frame.close());

/** 结果按内容 hash 缓存的只读通道：设置页与 iframe 重载时可直接复用（宿主回 same/增量） */
const CACHED_READS: ReadonlySet<string> = new Set([
  IPC_CHANNELS.SETTINGS_READ,
  IPC_CHANNELS.MODEL_DIRECTORY_GET,
  IPC_CHANNELS.SOURCE_AUTHORITY_READ,
  IPC_CHANNELS.ASSETS_LIST_PROJECT_SKILLS,
  IPC_CHANNELS.PROVIDERS_MODEL_META,
  IPC_CHANNELS.AGENT_PARENT_HISTORY_TAIL,
]);
/** 只合并同时发出的相同请求（结果随会话变化或依赖发起方，不跨次缓存） */
const SHARED_READS: ReadonlySet<string> = new Set([
  IPC_CHANNELS.OAUTH_CREDENTIAL_KEYS_LIST,
  IPC_CHANNELS.WORKTREE_LIST,
  IPC_CHANNELS.WORKTREE_BRANCHES,
  IPC_CHANNELS.PROJECTS_CODE_SOURCES,
]);

// 缓存放父页面（父 realm 的 Map，只存字符串）：iframe 重载、设置页 iframe 都能复用
const host = window.parent as Window & { __ensoRemoteReads?: RemoteReadStore; Map: MapConstructor };
host.__ensoRemoteReads ??= new host.Map() as unknown as RemoteReadStore;
const reads = new RemoteReadClient(host.__ensoRemoteReads);
const writes = new RemoteWriteClient();
const upserts = new UpsertDecoder();
const shared = new Map<string, Promise<unknown>>();

const unavailable = (channel: string) =>
  new Error(`Channel '${channel}' is not available remotely`);

/** 编码态参数 → 编码态结果 */
async function rawInvoke(channel: string, encodedArgs: unknown[]): Promise<unknown> {
  return JSON.parse(await frame.invoke(channel, JSON.stringify(encodedArgs)));
}

async function invokeEncoded(channel: string, args: unknown[]): Promise<unknown> {
  const encoded = encodeRemoteValue(args) as unknown[];
  if (channel === IPC_CHANNELS.SETTINGS_WRITE_KEY && typeof args[0] === 'string') {
    return writes.write(args[0], args[1] === undefined ? undefined : encoded[1], async (arg) =>
      decodeRemoteValue(
        await rawInvoke(channel, [encoded[0], arg === undefined ? encoded[1] : arg])
      )
    );
  }
  const key = `${channel}\0${JSON.stringify(encoded)}`;
  if (CACHED_READS.has(channel)) {
    return decodeRemoteValue(
      await reads.read(key, (hash) => rawInvoke(channel, withIfNone(encoded, hash)))
    );
  }
  if (SHARED_READS.has(channel)) {
    let pending = shared.get(key);
    if (!pending) {
      pending = rawInvoke(channel, encoded).finally(() => shared.delete(key));
      shared.set(key, pending);
    }
    return decodeRemoteValue(await pending);
  }
  return decodeRemoteValue(await rawInvoke(channel, encoded));
}

// 流式基线丢失：让宿主清空基线（之后整条重发），并重拉受影响会话的快照
let resetting = false;
const resyncSessions = new Set<string>();
function resyncUpserts(sessionId: unknown): void {
  if (typeof sessionId === 'string') resyncSessions.add(sessionId);
  if (resetting) return;
  resetting = true;
  const first = [...resyncSessions][0];
  resyncSessions.delete(first as string);
  void rawInvoke(
    IPC_CHANNELS.AGENT_SNAPSHOT,
    withUpsertReset(encodeRemoteValue([first]) as unknown[])
  )
    .catch(() => undefined)
    .finally(() => {
      resetting = false;
      for (const id of resyncSessions) {
        void rawInvoke(IPC_CHANNELS.AGENT_SNAPSHOT, [id]).catch(() => undefined);
      }
      resyncSessions.clear();
    });
}

/** 还原流式增量；缺基线返回 null 并触发重同步 */
function expandUpsert(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  const event = raw[0] as Record<string, unknown> | undefined;
  if (!event || typeof event !== 'object' || !(UPSERT_MARK in event)) return raw;
  const { [UPSERT_MARK]: mark, ...rest } = event;
  const message = upserts.decode(mark, rest.message);
  if (message === null) {
    resyncUpserts((rest.identity as { sessionId?: unknown } | undefined)?.sessionId);
    return null;
  }
  return [{ ...rest, message }, ...raw.slice(1)];
}

const channelListeners = new Map<string, Set<(...args: unknown[]) => void>>();
const channelOff = new Map<string, () => void>();

/** 编解码都在本 iframe 的 realm 内完成；每个通道只订阅一次、解码一次再分发（同 Electron 语义） */
export const remoteFrame = {
  invoke(channel: string, args: unknown[]): Promise<unknown> {
    // 宿主控制通道交给宿主裁决（只有服务端开放）
    if (!isRemoteChannelAllowed(channel, true, true)) return Promise.reject(unavailable(channel));
    return invokeEncoded(channel, args);
  },
  send(channel: string, args: unknown[]): void {
    if (!isRemoteChannelAllowed(channel, true, true)) return;
    frame.send(channel, JSON.stringify(encodeRemoteValue(args)));
  },
  on(channel: string, listener: (...args: unknown[]) => void): () => void {
    let listeners = channelListeners.get(channel);
    if (!listeners) {
      const set = new Set<(...args: unknown[]) => void>();
      listeners = set;
      channelListeners.set(channel, set);
      channelOff.set(
        channel,
        frame.on(channel, (payload) => {
          let raw: unknown = JSON.parse(payload);
          if (channel === IPC_CHANNELS.AGENT_EVENT) raw = expandUpsert(raw);
          if (raw === null) return;
          const args = decodeRemoteValue<unknown>(raw);
          const list = Array.isArray(args) ? args : [];
          for (const fn of [...set]) fn(...list);
        })
      );
    }
    const entry = (...args: unknown[]) => listener(...args);
    listeners.add(entry);
    const set = listeners;
    return () => {
      set.delete(entry);
      if (set.size > 0 || channelListeners.get(channel) !== set) return;
      channelListeners.delete(channel);
      channelOff.get(channel)?.();
      channelOff.delete(channel);
    };
  },
};

// preload 在模块顶层读 process.platform：快捷键与路径展示跟随宿主
(globalThis as { process?: unknown }).process = {
  platform: bridge.platform,
  env: {},
  versions: {},
};

const unsupported = () => ({ ok: false, error: 'unsupported-remote' });

function pickFile(extensions: unknown): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (Array.isArray(extensions) && extensions.length > 0) {
      input.accept = extensions.map((ext) => `.${String(ext)}`).join(',');
    }
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export async function uploadToHost(file: File): Promise<string | null> {
  const result = (await remoteFrame.invoke(IPC_CHANNELS.REMOTE_UPLOAD, [
    file.name,
    new Uint8Array(await file.arrayBuffer()),
  ])) as { ok: boolean; path?: string } | null;
  return result?.ok && result.path ? result.path : null;
}

const local: Record<string, (...args: unknown[]) => unknown> = {
  [IPC_CHANNELS.WINDOW_MINIMIZE]: () => undefined,
  [IPC_CHANNELS.WINDOW_MAXIMIZE]: () => undefined,
  [IPC_CHANNELS.WINDOW_CLOSE]: () => {
    if (kind === 'settings') bridge.closeSettings();
  },
  [IPC_CHANNELS.WINDOW_IS_MAXIMIZED]: () => false,
  [IPC_CHANNELS.WINDOW_IS_FULLSCREEN]: () => false,
  [IPC_CHANNELS.WINDOW_SET_TITLE_BAR_APPEARANCE]: () => undefined,
  [IPC_CHANNELS.WINDOW_SET_TRAFFIC_LIGHTS_VISIBLE]: () => undefined,
  [IPC_CHANNELS.WINDOW_OPEN_SETTINGS]: (link) => bridge.openSettings(link),
  [IPC_CHANNELS.WINDOW_POPUP_MENU]: () => null,
  [IPC_CHANNELS.SETTINGS_DEEP_LINK_CONSUME]: () => bridge.consumeSettingsLink() ?? null,
  [IPC_CHANNELS.DIALOG_SELECT_DIRECTORY]: () => {
    const path = window.prompt('输入宿主电脑上的目录绝对路径 / Absolute directory path on host');
    return path?.trim() || null;
  },
  [IPC_CHANNELS.DIALOG_SELECT_FILE]: async (extensions) => {
    const file = await pickFile(extensions);
    return file ? uploadToHost(file) : null;
  },
  [IPC_CHANNELS.FILES_COPY_PATH]: async (request) => {
    const r = (request ?? {}) as { mode?: unknown; rel?: unknown };
    let text = typeof r.rel === 'string' ? r.rel : '';
    if (r.mode !== 'relative') {
      const abs = (await remoteFrame.invoke(IPC_CHANNELS.FILES_ABS, [request])) as {
        ok: boolean;
        abs?: string;
      };
      if (!abs?.ok || !abs.abs) return { ok: false, error: 'unavailable' };
      text = abs.abs;
    }
    await navigator.clipboard.writeText(text);
    return { ok: true };
  },
  [IPC_CHANNELS.FILES_COPY_FILE]: unsupported,
  [IPC_CHANNELS.FILES_REVEAL]: unsupported,
  [IPC_CHANNELS.FILES_REVEAL_EXTERNAL]: unsupported,
  [IPC_CHANNELS.FILES_OPEN]: unsupported,
  [IPC_CHANNELS.FILES_OPEN_CONTEXT]: unsupported,
  [IPC_CHANNELS.PROJECTS_REVEAL]: unsupported,
  [IPC_CHANNELS.PROJECTS_OPEN_IN_APPS]: unsupported,
  [IPC_CHANNELS.RESOURCES_STORAGE_REVEAL]: unsupported,
  [IPC_CHANNELS.BOT_OPEN_WORKSPACE]: unsupported,
  [IPC_CHANNELS.BOT_ARTIFACT_OPEN]: unsupported,
  [IPC_CHANNELS.SPEECH_MIC_ACCESS]: async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      return true;
    } catch {
      return false;
    }
  },
  [IPC_CHANNELS.APP_SET_BADGE_COUNT]: (count) => {
    const nav = navigator as Navigator & {
      setAppBadge?: (n?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    const n = typeof count === 'number' ? count : 0;
    void (n > 0 ? nav.setAppBadge?.(n) : nav.clearAppBadge?.())?.catch(() => {});
  },
  [IPC_CHANNELS.APP_CLOSE_RESPONSE]: () => undefined,
  [IPC_CHANNELS.APP_FLUSH_PERSIST_RESPONSE]: () => undefined,
  [IPC_CHANNELS.NOTIFICATION_ACTIVE_SESSION]: () => undefined,
  [IPC_CHANNELS.NOTIFICATION_FOCUS_SESSION]: () => undefined,
};

type Listener = (event: unknown, ...args: unknown[]) => void;
const subscriptions = new Map<string, Map<Listener, () => void>>();

function subscribe(channel: string, listener: Listener, once = false): void {
  let byListener = subscriptions.get(channel);
  if (!byListener) {
    byListener = new Map();
    subscriptions.set(channel, byListener);
  }
  if (byListener.has(listener)) return;
  const off = remoteFrame.on(channel, (...args) => {
    if (once) unsubscribe(channel, listener);
    listener({ sender: null }, ...args);
  });
  byListener.set(listener, off);
}

function unsubscribe(channel: string, listener: Listener): void {
  const byListener = subscriptions.get(channel);
  byListener?.get(listener)?.();
  byListener?.delete(listener);
}

export const ipcRenderer = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = local[channel];
    if (handler) return Promise.resolve().then(() => handler(...args));
    return remoteFrame.invoke(channel, args);
  },
  send(channel: string, ...args: unknown[]): void {
    const handler = local[channel];
    if (handler) {
      void handler(...args);
      return;
    }
    remoteFrame.send(channel, args);
  },
  on(channel: string, listener: Listener) {
    subscribe(channel, listener);
    return ipcRenderer;
  },
  once(channel: string, listener: Listener) {
    subscribe(channel, listener, true);
    return ipcRenderer;
  },
  removeListener(channel: string, listener: Listener) {
    unsubscribe(channel, listener);
    return ipcRenderer;
  },
  off(channel: string, listener: Listener) {
    unsubscribe(channel, listener);
    return ipcRenderer;
  },
  removeAllListeners(channel: string) {
    for (const listener of [...(subscriptions.get(channel)?.keys() ?? [])]) {
      unsubscribe(channel, listener);
    }
    return ipcRenderer;
  },
};

export const contextBridge = {
  exposeInMainWorld(key: string, api: unknown): void {
    (window as unknown as Record<string, unknown>)[key] = api;
  },
};

/** 浏览器拿不到本地文件路径；调用方应改用 electronAPI.remote.upload */
export const webUtils = {
  getPathForFile: (_file: File): string => '',
};
