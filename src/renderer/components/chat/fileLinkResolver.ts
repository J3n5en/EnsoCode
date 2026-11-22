import type { FilesLinkResolution } from '@shared/types';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

/**
 * 聊天文件链接「能否打开」的批量判定与缓存。
 * - 同一 50ms 窗口内的请求按会话合并成一次 IPC，单批 ≤ 200 条；
 * - 缓存按「工作区 + 相对路径」：能打开的到下一次进入会话（epoch 递增）前有效，
 *   打不开的 30 秒后过期；过期条目先照旧显示，重新挂载时后台复查。
 */
export interface FileLinkScope {
  conversationId: string;
  projectId: string;
  cwd?: string;
}

export type FileLinkState =
  | { status: 'ok'; rel: string; kind: 'file' | 'dir' }
  | { status: 'missing' };

const BATCH_DELAY_MS = 50;
export const FILE_LINK_BATCH_MAX = 200;
const MISSING_TTL_MS = 30_000;
const MISSING: FileLinkState = { status: 'missing' };

interface Entry {
  state: FileLinkState;
  epoch: number;
  at: number;
}

const cache = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
const inflight = new Set<string>();
const pending = new Map<string, { scope: FileLinkScope; rels: Set<string> }>();
let timer: ReturnType<typeof setTimeout> | null = null;
let epoch = 0;

/** 实测用：累计 IPC 批次、路径数与往返耗时 */
export const fileLinkStats = { batches: 0, paths: 0, ms: 0 };

const workspaceOf = (scope: FileLinkScope) => scope.cwd ?? `conversation:${scope.conversationId}`;
const keyOf = (scope: FileLinkScope, rel: string) => `${workspaceOf(scope)}\0${rel}`;

function fresh(entry: Entry | undefined): boolean {
  if (!entry) return false;
  return entry.state.status === 'ok'
    ? entry.epoch === epoch
    : Date.now() - entry.at < MISSING_TTL_MS;
}

function store(key: string, state: FileLinkState): void {
  const previous = cache.get(key)?.state;
  const same =
    previous?.status === state.status &&
    (state.status === 'missing' ||
      (previous.status === 'ok' && previous.rel === state.rel && previous.kind === state.kind));
  // 内容没变就沿用旧对象，订阅方不重渲染
  cache.set(key, { state: same && previous ? previous : state, epoch, at: Date.now() });
  if (!same) for (const listener of listeners.get(key) ?? []) listener();
}

function toState(item: FilesLinkResolution | null | undefined): FileLinkState {
  return item ? { status: 'ok', rel: item.rel, kind: item.kind } : MISSING;
}

async function resolveBatch(scope: FileLinkScope, rels: string[]): Promise<FileLinkState[]> {
  const started = performance.now();
  try {
    const result = await window.electronAPI.workspaceFiles.resolveLinks({
      conversationId: scope.conversationId,
      projectId: scope.projectId,
      rels,
    });
    return rels.map((_, index) => toState(result.ok ? result.items[index] : null));
  } catch {
    return rels.map(() => MISSING);
  } finally {
    fileLinkStats.batches += 1;
    fileLinkStats.paths += rels.length;
    fileLinkStats.ms += performance.now() - started;
  }
}

function flush(): void {
  timer = null;
  const batches = [...pending.values()];
  pending.clear();
  for (const { scope, rels } of batches) {
    const all = [...rels];
    for (let start = 0; start < all.length; start += FILE_LINK_BATCH_MAX) {
      const chunk = all.slice(start, start + FILE_LINK_BATCH_MAX);
      void resolveBatch(scope, chunk).then((states) => {
        chunk.forEach((rel, index) => {
          const key = keyOf(scope, rel);
          inflight.delete(key);
          store(key, states[index]);
        });
      });
    }
  }
}

function request(scope: FileLinkScope, rel: string): void {
  const key = keyOf(scope, rel);
  if (inflight.has(key) || fresh(cache.get(key))) return;
  inflight.add(key);
  const batchKey = `${scope.conversationId}\0${scope.projectId}`;
  const batch = pending.get(batchKey) ?? { scope, rels: new Set<string>() };
  batch.rels.add(rel);
  pending.set(batchKey, batch);
  timer ??= setTimeout(flush, BATCH_DELAY_MS);
}

/** 进入会话：能打开的缓存全部视为待复查（显示不变，挂载时后台刷新） */
export function markFileLinksStale(): void {
  epoch += 1;
}

/** 点击前实时确认一次，结果同步回缓存 */
export async function confirmFileLink(scope: FileLinkScope, rel: string): Promise<FileLinkState> {
  const [state] = await resolveBatch(scope, [rel]);
  store(keyOf(scope, rel), state);
  return state;
}

export function resetFileLinkCache(): void {
  cache.clear();
  inflight.clear();
  pending.clear();
  if (timer) clearTimeout(timer);
  timer = null;
  Object.assign(fileLinkStats, { batches: 0, paths: 0, ms: 0 });
}

/**
 * scope 或 rel 为空表示不需要判定（返回 undefined）；enabled=false 时只读缓存不发请求
 * （消息不在视口附近或仍在流式输出）。
 */
export function useFileLink(
  scope: FileLinkScope | null,
  rel: string | null,
  enabled: boolean
): FileLinkState | undefined {
  const key = scope && rel ? keyOf(scope, rel) : null;
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!key) return () => {};
      const set = listeners.get(key) ?? new Set<() => void>();
      listeners.set(key, set);
      set.add(onChange);
      return () => {
        set.delete(onChange);
        if (set.size === 0) listeners.delete(key);
      };
    },
    [key]
  );
  const state = useSyncExternalStore(subscribe, () => (key ? cache.get(key)?.state : undefined));
  // biome-ignore lint/correctness/useExhaustiveDependencies: key 已涵盖 scope 与 rel
  useEffect(() => {
    if (enabled && scope && rel) request(scope, rel);
  }, [enabled, key]);
  return state;
}
