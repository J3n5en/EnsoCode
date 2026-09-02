/**
 * 订阅会话的同步状态投影（纯函数）：
 * subscribe 发出到对应 snapshot 到达之间为 syncing，期间时间线可能是陈旧的。
 * 边界：会话被桌面删除后 snapshot 永不回包，靠目录判定幽灵会话收尾。
 */

export type SyncState = 'syncing' | 'synced';

export interface SyncTracking {
  state: SyncState;
  /** 出现在最近一次目录里的会话 id：曾在目录、现在消失 = 幽灵会话 */
  knownIds: ReadonlySet<string>;
}

export const initialSync: SyncTracking = { state: 'synced', knownIds: new Set() };

/**
 * 订阅切换（含重连后重订阅）：订阅具体会话进入 syncing；回列表页无正文可等，视为已同步。
 * fresh = 手机刚 spawn 的全新会话：没有历史可陈旧，直接 synced——否则会因
 * spawn 在途时的快照不含它而永远等不到同步完成（没人再发新快照）。
 */
export function applySubscribe(
  t: SyncTracking,
  sessionId: string | null,
  opts?: { fresh?: boolean }
): SyncTracking {
  return { ...t, state: sessionId && !opts?.fresh ? 'syncing' : 'synced' };
}

/** 快照到达：含订阅会话即完成同步 */
export function applySnapshot(
  t: SyncTracking,
  subscribedId: string | null,
  snapshotIds: readonly string[]
): SyncTracking {
  if (!subscribedId || !snapshotIds.includes(subscribedId)) return t;
  return { ...t, state: 'synced' };
}

/**
 * 目录到达：更新已知会话集。订阅的会话曾在目录、现在没了 → 幽灵会话
 * （桌面删除了它），结束 syncing 并报告 ghost 让上层跳离。
 * 刚 spawn 尚未进目录的会话不在 knownIds 里，不会误判。
 */
export function applyCatalog(
  t: SyncTracking,
  subscribedId: string | null,
  catalogIds: readonly string[]
): { tracking: SyncTracking; ghost: boolean } {
  const ghost =
    subscribedId !== null && t.knownIds.has(subscribedId) && !catalogIds.includes(subscribedId);
  return {
    tracking: { state: ghost ? 'synced' : t.state, knownIds: new Set(catalogIds) },
    ghost,
  };
}
