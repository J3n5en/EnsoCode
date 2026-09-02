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
  ttl = MESSAGE_CACHE_TTL_MS
): boolean {
  if (sessionId === viewedId) return true;
  const at = lastViewedAt[sessionId];
  return at !== undefined && now - at < ttl;
}

export function isBulkyAgentEvent(type: string): boolean {
  return type === 'message-upsert' || type === 'session-custom-entry';
}

export function evictColdMessages<T extends { messages: unknown[]; customEntries: unknown[] }>(
  conversations: Record<string, T>,
  viewedId: string | null,
  lastViewedAt: Readonly<Record<string, number>>,
  now: number,
  ttl = MESSAGE_CACHE_TTL_MS
): Record<string, T> {
  let changed = false;
  const next: Record<string, T> = { ...conversations };
  for (const [id, conversation] of Object.entries(conversations)) {
    if (isMessageCacheHot(id, viewedId, lastViewedAt, now, ttl)) continue;
    if (conversation.messages.length === 0 && conversation.customEntries.length === 0) continue;
    next[id] = { ...conversation, messages: [], customEntries: [] };
    changed = true;
  }
  return changed ? next : conversations;
}
