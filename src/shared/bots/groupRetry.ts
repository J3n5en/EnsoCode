interface RetryEntry {
  id: string;
  seq: number;
  kind: string;
  botId?: string;
  failure?: { botId: string };
  retryOf?: string;
  newConversation?: true;
}

/** 新任务使旧失败失效；已重试或成员已有新回复的失败不再提供恢复入口。 */
export function retryableGroupFailures(entries: readonly RetryEntry[], floor = 0): Set<string> {
  const latest = new Map<string, string>();
  for (const entry of entries) {
    if (entry.seq <= floor) continue;
    if (entry.kind === 'human' || entry.newConversation) latest.clear();
    if (entry.kind === 'bot' && entry.botId) latest.delete(entry.botId);
    if (entry.failure) latest.set(entry.failure.botId, entry.id);
    if (entry.retryOf)
      for (const [botId, id] of latest) if (id === entry.retryOf) latest.delete(botId);
  }
  return new Set(latest.values());
}
