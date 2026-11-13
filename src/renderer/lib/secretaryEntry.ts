interface Directory {
  order: readonly string[];
  conversations: Record<
    string,
    { projectId: string; archived?: boolean; lastActiveAt?: number } | undefined
  >;
}

/** 折叠侧栏图标与快捷键共用：打开该秘书项目下最近活跃的会话 */
export function latestSecretaryConversation(
  projectId: string | null,
  directory: Directory
): string | null {
  if (!projectId) return null;
  let best: string | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const id of directory.order) {
    const conversation = directory.conversations[id];
    if (!conversation || conversation.projectId !== projectId || conversation.archived) continue;
    const at = conversation.lastActiveAt ?? 0;
    if (at > bestAt) {
      best = id;
      bestAt = at;
    }
  }
  return best;
}
