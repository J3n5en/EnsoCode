export const AUTO_RESTART_IDLE_MS = 5 * 60 * 1000;
/** 不等空闲：窗口在前台、最近这么久内有键盘或鼠标输入时算用户正在操作，先等 */
export const RECENT_INPUT_MS = 2 * 60 * 1000;

/** 更新下载完成后的自动重启：关（只提示）/ 空闲时 / 不等空闲（直接走优雅重启安全点） */
export type AutoRestartMode = 'off' | 'idle' | 'immediate';
export const AUTO_RESTART_MODES: readonly AutoRestartMode[] = ['off', 'idle', 'immediate'];

export function isAutoRestartMode(value: unknown): value is AutoRestartMode {
  return AUTO_RESTART_MODES.includes(value as AutoRestartMode);
}

/** 持久化设置里的模式；旧版布尔开关 autoRestartWhenIdle 开着按「空闲时」，其余按「关」 */
export function resolveAutoRestartMode(state: unknown): AutoRestartMode {
  if (!state || typeof state !== 'object') return 'off';
  const source = state as Record<string, unknown>;
  if (isAutoRestartMode(source.autoRestartForUpdate)) return source.autoRestartForUpdate;
  return source.autoRestartWhenIdle === true ? 'idle' : 'off';
}

export interface AutoRestartIdleSnapshot {
  mode: AutoRestartMode;
  agentBusy: boolean;
  queuedCount: number;
  pendingAskCount: number;
  pendingApprovalCount: number;
  windowFocused: boolean;
  /** 窗口在前台且最近 RECENT_INPUT_MS 内有输入 */
  userActive: boolean;
  /** 输入框里有重启后会丢的未发送草稿 */
  unsentDraft: boolean;
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

/**
 * 空闲时：回合、排队、提问、审批、窗口在前台都挡。
 * 不等空闲：在跑的会话按恢复清单续跑、排队消息落盘，都不挡；用户正在操作、草稿会丢时先等；
 * 待答与待审批是在跑的工具，安全点等它到上限就中止，提问与审批会丢，也先等
 */
export function isAutoRestartBlocked(
  snapshot: TurnBlocks &
    Pick<AutoRestartIdleSnapshot, 'mode' | 'windowFocused' | 'userActive' | 'unsentDraft'>
): boolean {
  if (snapshot.mode === 'immediate')
    return (
      snapshot.userActive ||
      snapshot.unsentDraft ||
      snapshot.pendingAskCount > 0 ||
      snapshot.pendingApprovalCount > 0
    );
  return isTurnRestartBlocked(snapshot) || snapshot.windowFocused;
}

/** 空闲时：无忙态连续保持满 5 分钟才重启安装；不等空闲：不挡就装 */
export function shouldAutoRestartForUpdate(snapshot: AutoRestartIdleSnapshot): boolean {
  if (snapshot.mode === 'off' || isAutoRestartBlocked(snapshot)) return false;
  return snapshot.mode === 'immediate' || snapshot.idleForMs >= AUTO_RESTART_IDLE_MS;
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
