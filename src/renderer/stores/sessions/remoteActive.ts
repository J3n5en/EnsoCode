/**
 * 完整模式和桌面窗口共用 enso-conversations，多端合并不含 activeId，
 * 避免两边互相抢走当前会话。手机上的选择因此写不进磁盘，重启会回到旧会话。
 * 远程界面按配对设备把当前会话记在本机，水合时若该会话还在就盖过磁盘值。
 */

const KEY_PREFIX = 'enso-remote-active:';
const ID_MAX = 200;

type ActiveMemory = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

interface ActiveSlice {
  activeId: string | null;
}

export function remotePairScope(pathname: string): string | null {
  const match = /^\/desk\/r\/([^/]+)\//.exec(pathname);
  if (!match?.[1]) return null;
  try {
    const id = decodeURIComponent(match[1]);
    return id ? id : null;
  } catch {
    return null;
  }
}

export function remoteActiveKey(scope: string): string {
  return `${KEY_PREFIX}${scope}`;
}

function usableId(value: string | null): string | null {
  if (!value) return null;
  const id = value.trim();
  if (!id || id.length > ID_MAX) return null;
  return id;
}

export function readRememberedActive(
  storage: Pick<ActiveMemory, 'getItem'>,
  scope: string | null
): string | null {
  if (!scope) return null;
  try {
    return usableId(storage.getItem(remoteActiveKey(scope)));
  } catch {
    return null;
  }
}

export function writeRememberedActive(
  storage: Pick<ActiveMemory, 'setItem' | 'removeItem'>,
  scope: string,
  activeId: string | null
): void {
  try {
    const key = remoteActiveKey(scope);
    const id = usableId(activeId);
    if (id) storage.setItem(key, id);
    else storage.removeItem(key);
  } catch {
    // 隐私模式或配额满时记不住，下次仍回落到磁盘上的当前会话
  }
}

export function pickRememberedActive(
  diskActiveId: string | null,
  remembered: string | null,
  exists: (id: string) => boolean
): string | null {
  if (remembered && exists(remembered)) return remembered;
  return diskActiveId;
}

export function mergeWithRememberedActive<
  S extends { activeId: string | null; conversations?: Record<string, unknown> },
>(current: S, persisted: unknown, remembered: string | null): S {
  const base: S = {
    ...current,
    ...(persisted && typeof persisted === 'object' ? (persisted as Partial<S>) : {}),
  };
  const activeId = pickRememberedActive(base.activeId ?? null, remembered, (id) =>
    Boolean(base.conversations?.[id])
  );
  const merged = activeId === base.activeId ? base : { ...base, activeId };
  if (currentRemoteScope()) hydratedActiveId = merged.activeId ?? null;
  return merged;
}

export function trackRemoteActive<S extends ActiveSlice>(
  store: { subscribe(listener: (next: S, prev: S) => void): () => void },
  storage: Pick<ActiveMemory, 'setItem' | 'removeItem'>,
  scope: string | null
): () => void {
  if (!scope) return () => {};
  return store.subscribe((next, prev) => {
    if (next.activeId === prev.activeId) return;
    writeRememberedActive(storage, scope, next.activeId);
  });
}

function currentRemoteScope(): string | null {
  if (typeof window === 'undefined' || !window.electronAPI?.remote) return null;
  const pathname = window.location?.pathname;
  return typeof pathname === 'string' ? remotePairScope(pathname) : null;
}

/** 水合 merge 时读。非远程界面返回 null，行为与原来的整份合并一致。 */
export function readCurrentRememberedActive(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return readRememberedActive(localStorage, currentRemoteScope());
}

/** 水合 set 通知订阅者时还没 arm，避免把磁盘上的当前会话当成用户的选择写回来。 */
let armed = false;
let installed = false;
let hydratedActiveId: string | null | undefined;

export function installRemoteActiveMemory(store: {
  subscribe(listener: (next: ActiveSlice, prev: ActiveSlice) => void): () => void;
}): void {
  if (installed || typeof localStorage === 'undefined') return;
  const scope = currentRemoteScope();
  if (!scope) return;
  installed = true;
  store.subscribe((next, prev) => {
    if (!armed || next.activeId === prev.activeId) return;
    writeRememberedActive(localStorage, scope, next.activeId);
  });
}

/** 水合回调里调用：此前用户已经切走的会话补记一笔，已删除的记忆清掉。 */
export function armRemoteActiveMemory(store: {
  getState(): { activeId: string | null; conversations: Record<string, unknown> };
}): void {
  if (armed) return;
  const scope = currentRemoteScope();
  if (!scope || typeof localStorage === 'undefined') return;
  const state = store.getState();
  if (hydratedActiveId !== undefined && state.activeId !== hydratedActiveId) {
    writeRememberedActive(localStorage, scope, state.activeId);
  } else {
    const remembered = readRememberedActive(localStorage, scope);
    if (remembered && !state.conversations[remembered]) {
      writeRememberedActive(localStorage, scope, null);
    }
  }
  armed = true;
}
