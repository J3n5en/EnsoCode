/** 离开会话后，正文在 renderer 里再留这么久；worker/jsonl 仍是全文。 */
export const MESSAGE_CACHE_TTL_MS = 5 * 60_000;

export function viewedConversationId(
  activeId: string | null | undefined,
  activeTabId: string | undefined,
  hasConversation: (id: string) => boolean
): string | null {
  if (activeTabId && hasConversation(activeTabId)) return activeTabId;
  return activeId ?? null;
}

export function isMessageCacheHot(
  sessionId: string,
  viewedId: string | null,
  lastViewedAt: Readonly<Record<string, number>>,
  now: number,
  ttl = MESSAGE_CACHE_TTL_MS,
  extraHotIds?: ReadonlySet<string>
): boolean {
  if (sessionId === viewedId || extraHotIds?.has(sessionId)) return true;
  const at = lastViewedAt[sessionId];
  return at !== undefined && now - at < ttl;
}

/** 旁路会话挂在主会话侧栏，不算冷缓存 */
export function btwHotSessionIds(
  conversations: Record<string, { btwParentId?: string } | undefined>
): Set<string> {
  const ids = new Set<string>();
  for (const [id, conversation] of Object.entries(conversations)) {
    if (conversation?.btwParentId) ids.add(id);
  }
  return ids;
}
/**
 * 正文是否已有权威（worker 确认过的）消息。乐观回显是本地先上屏的未确认尾巴，
 * 不算：冷缓存清空后用户先发一句，length 变 1 但历史与正在跑的工具卡都还没补回，
 * 仍需要向 worker 要 snapshot。
 */
export function hasAuthoritativeMessages(messages: readonly { optimistic?: boolean }[]): boolean {
  return messages.some((message) => !message.optimistic);
}

/**
 * 已启动或可 resume 的会话缺权威正文：应显示 Preparing，并补 jsonl 尾窗。
 * 不看 status：运行态 failed 与 jsonl 可读是两回事，failed 挡补水会把一次瞬时失败
 * 固化成「只剩红字、历史空白」。已尝试过（含失败）由 historyLoadAttempted 收口，避免永久转圈。
 */
export function needsHistoryHydration(conversation: {
  started: boolean;
  sessionFile?: string;
  messages: readonly { optimistic?: boolean }[];
  spawning: boolean;
  status?: string;
  historyLoadAttempted?: boolean;
}): boolean {
  return (
    !conversation.historyLoadAttempted &&
    (conversation.started || Boolean(conversation.sessionFile)) &&
    !hasAuthoritativeMessages(conversation.messages) &&
    !conversation.spawning
  );
}

/**
 * 切回应对齐 worker 全文。failed 且本地已有权威正文时不要再要 snapshot：
 * 空回包会把历史抹掉、只剩红字。failed 空窗且 worker 仍持有（started）则要补回。
 */
export function needsWorkerSnapshot(conversation: {
  started: boolean;
  sessionFile?: string;
  status?: string;
  messages?: readonly { optimistic?: boolean }[];
}): boolean {
  if (conversation.status === 'failed') {
    if (hasAuthoritativeMessages(conversation.messages ?? [])) return false;
    return conversation.started;
  }
  return conversation.started || Boolean(conversation.sessionFile);
}

/** 离开会话时盖章；正在看的会话不写自己，由 isMessageCacheHot 的 viewedId 保热 */
export function stampViewDeparture(
  lastViewedAt: Record<string, number>,
  previousId: string | null,
  nextId: string | null,
  now: number
): void {
  if (previousId && previousId !== nextId) lastViewedAt[previousId] = now;
}

/** 输入框 busy：有权威正文后不再因 spawn/读历史锁输入 */
export function chatSurfaceBusy(conversation: {
  started: boolean;
  sessionFile?: string;
  messages: readonly { optimistic?: boolean }[];
  spawning: boolean;
  status?: string;
  historyLoadAttempted?: boolean;
  syncStalled?: boolean;
}): boolean {
  if (conversation.status === 'running') return true;
  if (hasAuthoritativeMessages(conversation.messages)) return false;
  // 准备超时降级：读历史不再锁输入；spawn 仍在途时发出去不会真正投递，继续锁到重试
  if (conversation.syncStalled) return conversation.spawning;
  return needsHistoryHydration(conversation) || conversation.spawning;
}

/** 非生成态的准备（spawn / resume / 读尾窗 / 等快照）最长等待；超时降级为空态 + 重试 */
export const PREPARING_STALL_MS = 20_000;

/** 时间线脚点只反映运行态；未确认气泡不代表模型仍在生成。 */
export function chatTimelineActivity(conversation: {
  started?: boolean;
  sessionFile?: string;
  messages: readonly { optimistic?: boolean }[];
  spawning: boolean;
  status?: string;
  historyLoadAttempted?: boolean;
  historyLoading?: boolean;
  syncStalled?: boolean;
}): 'working' | 'loading' | null {
  if (conversation.status === 'running') return 'working';
  if (conversation.syncStalled) return null;
  if (conversation.historyLoading) return 'loading';
  if (
    conversation.spawning ||
    needsHistoryHydration({
      started: conversation.started === true,
      sessionFile: conversation.sessionFile,
      messages: conversation.messages,
      spawning: conversation.spawning,
      historyLoadAttempted: conversation.historyLoadAttempted,
    })
  )
    return 'loading';
  return null;
}

export function isBulkyAgentEvent(type: string): boolean {
  return type === 'message-upsert' || type === 'session-custom-entry';
}

/** 丢正文前留下最后活跃时刻，否则侧栏与排序回落到 createdAt */
export function bodyLastActiveAt(
  messages: readonly { timestamp?: number }[],
  lastActiveAt: number | undefined
): number | undefined {
  const last = messages.at(-1)?.timestamp;
  if (last === undefined) return lastActiveAt;
  return lastActiveAt === undefined ? last : Math.max(last, lastActiveAt);
}

type EvictableConversation = {
  messages: { timestamp?: number }[];
  customEntries: unknown[];
  lastActiveAt?: number;
};

export function evictColdMessages<T extends EvictableConversation>(
  conversations: Record<string, T>,
  viewedId: string | null,
  lastViewedAt: Readonly<Record<string, number>>,
  now: number,
  ttl = MESSAGE_CACHE_TTL_MS,
  extraHotIds?: ReadonlySet<string>
): Record<string, T> {
  return evictColdMessageBodies(
    conversations,
    viewedId,
    lastViewedAt,
    now,
    ttl,
    extraHotIds,
    false
  );
}

/** 只清已经离开并过 TTL 的正文。没有盖章的留给定时全量清，避免同一次写入被切 tab 抹掉。 */
export function evictStampedColdMessages<T extends EvictableConversation>(
  conversations: Record<string, T>,
  viewedId: string | null,
  lastViewedAt: Readonly<Record<string, number>>,
  now: number,
  ttl = MESSAGE_CACHE_TTL_MS,
  extraHotIds?: ReadonlySet<string>
): Record<string, T> {
  return evictColdMessageBodies(conversations, viewedId, lastViewedAt, now, ttl, extraHotIds, true);
}

function evictColdMessageBodies<T extends EvictableConversation>(
  conversations: Record<string, T>,
  viewedId: string | null,
  lastViewedAt: Readonly<Record<string, number>>,
  now: number,
  ttl: number,
  extraHotIds: ReadonlySet<string> | undefined,
  requireStamp: boolean
): Record<string, T> {
  let changed = false;
  const next: Record<string, T> = { ...conversations };
  for (const [id, conversation] of Object.entries(conversations)) {
    if (requireStamp && lastViewedAt[id] === undefined) continue;
    if (isMessageCacheHot(id, viewedId, lastViewedAt, now, ttl, extraHotIds)) continue;
    if (conversation.messages.length === 0 && conversation.customEntries.length === 0) continue;
    next[id] = {
      ...conversation,
      messages: [],
      customEntries: [],
      lastActiveAt: bodyLastActiveAt(conversation.messages, conversation.lastActiveAt),
      historyBaseIndex: undefined,
      historyLoading: undefined,
      historyLoadAttempted: undefined,
    };
    changed = true;
  }
  return changed ? next : conversations;
}

/**
 * 下次清冷正文的等待时间。已过期返回 0（调用方应立刻清）；
 * 只安排尚未到期的最早离开，不能从最近一次切 tab 重计满 TTL。
 * 正在看的会话和旁路热会话不参与。
 */
export function nextColdEvictDelay(
  lastViewedAt: Readonly<Record<string, number>>,
  viewedId: string | null,
  now: number,
  ttl = MESSAGE_CACHE_TTL_MS,
  extraHotIds?: ReadonlySet<string>
): number | null {
  let soonest: number | null = null;
  let due = false;
  for (const [id, at] of Object.entries(lastViewedAt)) {
    if (id === viewedId || extraHotIds?.has(id)) continue;
    const remaining = at + ttl - now;
    if (remaining <= 0) {
      due = true;
      continue;
    }
    if (soonest === null || remaining < soonest) soonest = remaining;
  }
  return soonest ?? (due ? 0 : null);
}

/** 已删会话的浏览/resync 时间戳不再占表 */
export function pruneSessionClocks(
  clocks: Record<string, number>,
  knownIds: ReadonlySet<string>
): void {
  for (const id of Object.keys(clocks)) {
    if (!knownIds.has(id)) delete clocks[id];
  }
}
