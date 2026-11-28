/**
 * 浏览器里替代 `electron` 模块：web-preload 构建时把 preload 的 electron 导入指到这里，
 * ipcRenderer 走父页面（PWA 壳）持有的加密隧道；作用于宿主桌面的通道在本地实现。
 */

import { coalesceRuns } from '@shared/coalesceRuns';
import { REMOTE_LOCAL_PREFIXES, type RemoteBridge } from '@shared/remoteBridge';
import {
  REREAD_MARK,
  RemoteReadClient,
  type RemoteReadStore,
  RemoteWriteClient,
  UPSERT_MARK,
  UpsertDecoder,
  withIfNone,
  withUpsertReset,
  writeSeedOf,
} from '@shared/remoteDelta';
import { expandRemoteWireResult } from '@shared/remoteWireCompact';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { decodeRemoteValue, encodeRemoteValue } from '../../packages/pair/src/remote';
import { isRemoteChannelAllowed } from '../main/services/remoteRenderer/channels';

// 手机壳里 renderer 是 iframe，桥在父页面；桌面节点层的主界面是顶层文档，parent 即自身
const bridge = (window.parent as Window & { __ensoRemote?: RemoteBridge }).__ensoRemote;
if (!bridge) {
  throw new Error('EnsoCode remote bridge is missing');
}

export const remoteBridge: RemoteBridge = bridge;
const frame = bridge.attach('main');
addEventListener('pagehide', () => frame.close());

/** 结果按内容 hash 缓存的只读通道：设置页与 iframe 重载时可直接复用（宿主回 same/增量） */
const CACHED_READS: ReadonlySet<string> = new Set([
  IPC_CHANNELS.SETTINGS_READ,
  IPC_CHANNELS.MODEL_DIRECTORY_GET,
  IPC_CHANNELS.SOURCE_AUTHORITY_READ,
  IPC_CHANNELS.ASSETS_LIST_PROJECT_SKILLS,
  IPC_CHANNELS.PROVIDERS_MODEL_META,
  IPC_CHANNELS.AGENT_PARENT_HISTORY_TAIL,
  // 会话记录占启动下载的大头：重开页面没变就回 same，变了回增量
  IPC_CHANNELS.CONVERSATIONS_READ,
  // 插件脚本与样式每次启动都要取，单个可达数百 KB
  IPC_CHANNELS.EXTENSION_PLUGINS_ASSET,
  // 每 30s 轮询与启动高频读取的大包：没变直接回 same，避免反复重传百 KB 级列表
  IPC_CHANNELS.WORKTREE_LIST,
  IPC_CHANNELS.WORKTREE_STATUSES,
  IPC_CHANNELS.PROJECTS_GET_ICON,
  IPC_CHANNELS.PROJECTS_GET_ICONS,
  IPC_CHANNELS.EXTENSION_PLUGINS_LIST,
  // 秘书面板状态可达数百 KB：冷启动与重载没变直接回 same，变了走增量
  IPC_CHANNELS.SECRETARY_GET_STATE,
]);
/** 只合并同时发出的相同请求（结果随会话变化或依赖发起方，不跨次缓存） */
const SHARED_READS: ReadonlySet<string> = new Set([
  IPC_CHANNELS.OAUTH_CREDENTIAL_KEYS_LIST,
  IPC_CHANNELS.WORKTREE_BRANCHES,
  IPC_CHANNELS.PROJECTS_CODE_SOURCES,
  // 秘书状态变化时多个面板同时刷新
  IPC_CHANNELS.SECRETARY_FEED,
  IPC_CHANNELS.SECRETARY_SCHEDULES_LIST,
]);

// 缓存放父页面（父 realm 的 Map，只存字符串）：iframe 重载、设置页 iframe 都能复用
const host = window.parent as Window & { __ensoRemoteReads?: RemoteReadStore; Map: MapConstructor };
host.__ensoRemoteReads ??= new host.Map() as unknown as RemoteReadStore;
const reads = new RemoteReadClient(host.__ensoRemoteReads);
const writes = new RemoteWriteClient();
const upserts = new UpsertDecoder();
const shared = new Map<string, Promise<unknown>>();

const OPTIMISTIC_READ_STORE_KEY: Readonly<Record<string, string>> = {
  [IPC_CHANNELS.SETTINGS_READ]: 'enso-settings',
  [IPC_CHANNELS.CONVERSATIONS_READ]: 'enso-conversations',
};
const OPTIMISTIC_RESYNC_EVENT: Readonly<Record<string, string>> = {
  [IPC_CHANNELS.SETTINGS_READ]: IPC_CHANNELS.SETTINGS_CHANGED,
  [IPC_CHANNELS.CONVERSATIONS_READ]: IPC_CHANNELS.CONVERSATIONS_RESYNC,
};
/** 本次 iframe 生命周期内已完成首次乐观返回的通道 key（同一通道仅首读走乐观，重读直接走线上校对） */
const optimisticServedKeys = new Set<string>();
/** 正在后台校对中的持久化 store 名：校对落地前拒收对应 SETTINGS_WRITE_KEY，防止用本地旧缓存覆盖宿主新状态 */
const pendingOptimisticStores = new Set<string>();
/** 后台校对刚拿到变更后暂存的新鲜 JSON，紧随其后的 resync 重读可直接消费一次，免再打一轮 RPC */
const optimisticFreshJson = new Map<string, string>();

const unavailable = (channel: string) =>
  new Error(`Channel '${channel}' is not available remotely`);

/** 编码态参数 → 编码态结果 */
async function rawInvoke(channel: string, encodedArgs: unknown[]): Promise<unknown> {
  return JSON.parse(await frame.invoke(channel, JSON.stringify(encodedArgs)));
}

async function fetchCachedWithPrefetch(
  channel: string,
  key: string,
  encodedArgs: unknown[],
  hash: string
): Promise<unknown> {
  const pending = remoteBridge.prefetch?.take(key, hash);
  if (pending) {
    const hit = await pending;
    if (hit !== null && hit !== undefined) return hit;
  }
  return rawInvoke(channel, withIfNone(encodedArgs, hash));
}

function emitLocalChannel(channel: string, args: unknown[]): void {
  const listeners = channelListeners.get(channel);
  if (!listeners) return;
  for (const fn of [...listeners]) fn(...args);
}

function startOptimisticVerify(
  channel: string,
  key: string,
  encodedArgs: unknown[],
  storeKey: string,
  cachedHash: string
): void {
  pendingOptimisticStores.add(storeKey);
  void reads
    .readJson(key, (hash) => fetchCachedWithPrefetch(channel, key, encodedArgs, hash))
    .then((freshJson) => {
      const latestHash = host.__ensoRemoteReads?.get(key)?.h;
      const changed = latestHash !== undefined && latestHash !== cachedHash;
      if (!changed) {
        const expanded = () => expandRemoteWireResult(channel, JSON.parse(freshJson));
        const seed = writeSeedOf(channel, expanded());
        if (seed) writes.seedLazy(seed.name, () => writeSeedOf(channel, expanded())?.value);
      } else {
        optimisticFreshJson.set(key, freshJson);
      }
      pendingOptimisticStores.delete(storeKey);
      remoteBridge.optimistic?.onVerified?.(channel, changed);
      if (changed) {
        const eventChannel = OPTIMISTIC_RESYNC_EVENT[channel];
        if (eventChannel) emitLocalChannel(eventChannel, []);
      }
    })
    .catch(() => {
      pendingOptimisticStores.delete(storeKey);
      remoteBridge.optimistic?.onVerified?.(channel, false);
    });
}

async function invokeEncoded(channel: string, args: unknown[]): Promise<unknown> {
  const encoded = encodeRemoteValue(args) as unknown[];
  if (channel === IPC_CHANNELS.SETTINGS_WRITE_KEY && typeof args[0] === 'string') {
    if (pendingOptimisticStores.has(args[0])) return false;
    // 第三个参数是会话写回的确认号，丢了宿主会当它什么补丁都没应用
    return writes.write(args[0], args[1] === undefined ? undefined : encoded[1], async (arg) =>
      decodeRemoteValue(
        await rawInvoke(channel, [
          encoded[0],
          arg === undefined ? encoded[1] : arg,
          ...encoded.slice(2),
        ])
      )
    );
  }
  const key = `${channel}\0${JSON.stringify(encoded)}`;
  if (CACHED_READS.has(channel)) {
    const fresh = optimisticFreshJson.get(key);
    if (fresh !== undefined) {
      optimisticFreshJson.delete(key);
      const expanded = () => expandRemoteWireResult(channel, JSON.parse(fresh));
      const result = expanded();
      const seed = writeSeedOf(channel, result);
      if (seed) {
        writes.seedLazy(seed.name, () => writeSeedOf(channel, expanded())?.value);
      }
      return decodeRemoteValue(result);
    }
    const optimisticStore = OPTIMISTIC_READ_STORE_KEY[channel];
    if (optimisticStore && remoteBridge.optimistic?.enabled && !optimisticServedKeys.has(key)) {
      const cached = host.__ensoRemoteReads?.get(key);
      if (cached) {
        optimisticServedKeys.add(key);
        startOptimisticVerify(channel, key, encoded, optimisticStore, cached.h);
        remoteBridge.optimistic.onHydrated?.(channel);
        return decodeRemoteValue(expandRemoteWireResult(channel, JSON.parse(cached.json)));
      }
    }
    const json = await reads.readJson(key, (hash) =>
      fetchCachedWithPrefetch(channel, key, encoded, hash)
    );
    const expanded = () => expandRemoteWireResult(channel, JSON.parse(json));
    const result = expanded();
    const seed = writeSeedOf(channel, result);
    if (seed) {
      writes.seedLazy(seed.name, () => writeSeedOf(channel, expanded())?.value);
    }
    return decodeRemoteValue(result);
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

/** 秘书重读通知：同一秘书在途时合并成一次尾随重读，每次重读的结果分发一次 */
const secretaryRereads = new Map<string, () => Promise<void>>();
function rereadSecretary(secretaryId: string): void {
  let run = secretaryRereads.get(secretaryId);
  if (!run) {
    run = coalesceRuns(async () => {
      const state = await invokeEncoded(IPC_CHANNELS.SECRETARY_GET_STATE, [secretaryId]);
      const set = channelListeners.get(IPC_CHANNELS.SECRETARY_STATE_CHANGED);
      for (const fn of [...(set ?? [])]) fn(state);
    });
    secretaryRereads.set(secretaryId, run);
  }
  void run().catch(() => undefined);
}

function rereadTarget(raw: unknown): string | null {
  const first = Array.isArray(raw) ? (raw[0] as Record<string, unknown> | undefined) : undefined;
  const id = first && typeof first === 'object' ? first[REREAD_MARK] : undefined;
  return typeof id === 'string' ? id : null;
}

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
          if (channel === IPC_CHANNELS.SECRETARY_STATE_CHANGED) {
            const secretaryId = rereadTarget(raw);
            if (secretaryId) {
              rereadSecretary(secretaryId);
              return;
            }
          }
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

/**
 * 桌面远程节点层：本机窗口、节点切换与系统通知交给所在电脑的 main（由它白名单裁决），
 * 其余照旧经隧道到宿主。手机壳没有 bridge.local，不走这里。
 */
const native = bridge.local;
const isNativeChannel = (channel: string): boolean =>
  native !== undefined && REMOTE_LOCAL_PREFIXES.some((prefix) => channel.startsWith(prefix));

const nativeFrame = {
  async invoke(channel: string, args: unknown[]): Promise<unknown> {
    const raw = (await native?.invoke(channel, JSON.stringify(args))) ?? '{"ok":false}';
    const reply = JSON.parse(raw) as { ok: boolean; value?: unknown; error?: string };
    if (!reply.ok) throw new Error(reply.error ?? `Channel '${channel}' is not available`);
    return reply.value;
  },
  send(channel: string, args: unknown[]): void {
    native?.send(channel, JSON.stringify(args));
  },
  on(channel: string, listener: (...args: unknown[]) => void): () => void {
    return (
      native?.on(channel, (payload) => listener(...(JSON.parse(payload) as unknown[]))) ??
      (() => {})
    );
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
  [IPC_CHANNELS.WINDOW_CLOSE]: () => undefined,
  [IPC_CHANNELS.WINDOW_IS_MAXIMIZED]: () => false,
  [IPC_CHANNELS.WINDOW_IS_FULLSCREEN]: () => false,
  [IPC_CHANNELS.WINDOW_SET_TITLE_BAR_APPEARANCE]: () => undefined,
  [IPC_CHANNELS.WINDOW_SET_TRAFFIC_LIGHTS_VISIBLE]: () => undefined,
  [IPC_CHANNELS.WINDOW_POPUP_MENU]: () => null,
  // 远程界面没有托盘、应用菜单和 enso://，不会有主进程转来的「打开设置」
  [IPC_CHANNELS.SETTINGS_DEEP_LINK_CONSUME]: () => null,
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
  [IPC_CHANNELS.PROJECTS_OPEN_IN_APPS]: () => [],
  [IPC_CHANNELS.RESOURCES_STORAGE_REVEAL]: unsupported,
  [IPC_CHANNELS.DCG_CHECK_UPDATE]: unsupported,
  [IPC_CHANNELS.DCG_RULE_STATE]: () => null,
  [IPC_CHANNELS.DCG_RULE_ALLOWED]: () => null,
  [IPC_CHANNELS.DCG_RULE_EXEMPT]: () => null,
  [IPC_CHANNELS.DCG_RULE_REVOKE]: () => null,
  [IPC_CHANNELS.DCG_EXEMPTIONS_LIST]: () => [],
  [IPC_CHANNELS.DCG_EXEMPTIONS_CLEAR]: () => false,
  [IPC_CHANNELS.LOGS_ERRORS]: () => [],
  [IPC_CHANNELS.LOGS_EXPORT]: unsupported,
  [IPC_CHANNELS.LOGS_REVEAL_EXPORT]: () => undefined,
  [IPC_CHANNELS.BOT_OPEN_WORKSPACE]: unsupported,
  [IPC_CHANNELS.BOT_ARTIFACT_OPEN]: unsupported,
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
  [IPC_CHANNELS.APP_RESTART_FORCE]: () => undefined,
  [IPC_CHANNELS.APP_RESTART_WAITING_GET]: () => null,
  [IPC_CHANNELS.NOTIFICATION_ACTIVE_SESSION]: (sessionId) => {
    bridge.setViewedSession?.(typeof sessionId === 'string' && sessionId ? sessionId : null);
  },
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
  const target = isNativeChannel(channel) ? nativeFrame : remoteFrame;
  const off = target.on(channel, (...args) => {
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
    if (isNativeChannel(channel)) return nativeFrame.invoke(channel, args);
    const handler = local[channel];
    if (handler) return Promise.resolve().then(() => handler(...args));
    return remoteFrame.invoke(channel, args);
  },
  send(channel: string, ...args: unknown[]): void {
    if (isNativeChannel(channel)) {
      nativeFrame.send(channel, args);
      return;
    }
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

/** Web 远程没有 Chromium 页面缩放，横幅按 100% 永不出现 */
export const webFrame = {
  getZoomFactor: (): number => 1,
  setZoomFactor: (_factor: number): void => {},
};
