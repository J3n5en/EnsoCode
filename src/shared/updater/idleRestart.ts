export const AUTO_RESTART_IDLE_MS = 5 * 60 * 1000;

export interface AutoRestartIdleSnapshot {
  enabled: boolean;
  downloaded: boolean;
  agentBusy: boolean;
  queuedCount: number;
  pendingAskCount: number;
  pendingApprovalCount: number;
  windowFocused: boolean;
  idleForMs: number;
}

type TurnBlocks = Pick<
  AutoRestartIdleSnapshot,
  'agentBusy' | 'queuedCount' | 'pendingAskCount' | 'pendingApprovalCount'
>;

/** 还有回合在跑、排队消息、待答提问或审批：重启会打断 */
export function isTurnRestartBlocked(snapshot: TurnBlocks): boolean {
  return (
    snapshot.agentBusy ||
    snapshot.queuedCount > 0 ||
    snapshot.pendingAskCount > 0 ||
    snapshot.pendingApprovalCount > 0
  );
}

export function isAutoRestartBlocked(
  snapshot: TurnBlocks & Pick<AutoRestartIdleSnapshot, 'windowFocused'>
): boolean {
  return isTurnRestartBlocked(snapshot) || snapshot.windowFocused;
}

/** 开关开、包已下好、无忙态，且该状态连续保持满 5 分钟才重启安装。 */
export function shouldAutoRestartForUpdate(snapshot: AutoRestartIdleSnapshot): boolean {
  return (
    snapshot.enabled &&
    snapshot.downloaded &&
    !isAutoRestartBlocked(snapshot) &&
    snapshot.idleForMs >= AUTO_RESTART_IDLE_MS
  );
}

export function countQueuedMessages(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export function countCatalogIdleBlocks(
  catalog: ReadonlyArray<{
    queued?: readonly unknown[];
    pendingAskCount?: number;
    pendingApprovalCount?: number;
  }>
): { queuedCount: number; pendingAskCount: number; pendingApprovalCount: number } {
  let queuedCount = 0;
  let pendingAskCount = 0;
  let pendingApprovalCount = 0;
  for (const entry of catalog) {
    queuedCount += entry.queued?.length ?? 0;
    pendingAskCount += entry.pendingAskCount ?? 0;
    pendingApprovalCount += entry.pendingApprovalCount ?? 0;
  }
  return { queuedCount, pendingAskCount, pendingApprovalCount };
}

export function persistedConversations(settings: unknown): Record<string, unknown> | null {
  if (!settings || typeof settings !== 'object') return null;
  const store = (settings as Record<string, unknown>)['enso-conversations'];
  if (!store || typeof store !== 'object') return null;
  const state = (store as Record<string, unknown>).state;
  if (!state || typeof state !== 'object') return null;
  const conversations = (state as Record<string, unknown>).conversations;
  if (!conversations || typeof conversations !== 'object' || Array.isArray(conversations)) {
    return null;
  }
  return conversations as Record<string, unknown>;
}

export function countPersistedQueuedMessages(conversations: unknown): number {
  if (!conversations || typeof conversations !== 'object') return 0;
  let total = 0;
  for (const value of Object.values(conversations as Record<string, unknown>)) {
    const row =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    total += countQueuedMessages(row?.queuedMessages);
  }
  return total;
}

export function nextIdleSince(prev: number | null, blocked: boolean, now: number): number | null {
  return blocked ? null : (prev ?? now);
}

export function idleDurationMs(idleSince: number | null, now: number): number {
  return idleSince === null ? 0 : Math.max(0, now - idleSince);
}

export type IdleRestartBlocks = {
  queuedCount: number;
  pendingAskCount: number;
  pendingApprovalCount: number;
};

export function mergeIdleRestartBlocks(...blocks: IdleRestartBlocks[]): IdleRestartBlocks {
  let queuedCount = 0;
  let pendingAskCount = 0;
  let pendingApprovalCount = 0;
  for (const block of blocks) {
    if (block.queuedCount > queuedCount) queuedCount = block.queuedCount;
    if (block.pendingAskCount > pendingAskCount) pendingAskCount = block.pendingAskCount;
    if (block.pendingApprovalCount > pendingApprovalCount) {
      pendingApprovalCount = block.pendingApprovalCount;
    }
  }
  return { queuedCount, pendingAskCount, pendingApprovalCount };
}

export function anyWindowFocused(
  windows: ReadonlyArray<{ isDestroyed(): boolean; isFocused(): boolean }>
): boolean {
  return windows.some((win) => !win.isDestroyed() && win.isFocused());
}

export function remainingIdleMs(
  idleSince: number | null,
  now: number,
  holdMs = AUTO_RESTART_IDLE_MS
): number | null {
  if (idleSince === null) return null;
  return Math.max(0, holdMs - idleDurationMs(idleSince, now));
}
