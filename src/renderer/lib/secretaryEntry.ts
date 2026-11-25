import { projectConversationIds } from '@/stores/sessions/pinned';

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

/** 侧栏秘书分区的会话列表：与普通项目组同一排序规则（置顶在前、无消息回落 createdAt） */
export function secretaryConversationIds(
  projectId: string | null,
  order: readonly string[],
  conversations: Parameters<typeof projectConversationIds>[1]
): string[] {
  return projectId ? projectConversationIds(order, conversations, projectId) : [];
}

/** 折叠侧栏头像上的未读数：只数展开时该秘书分区会列出的会话 */
export function secretaryUnreadCount(
  projectId: string | null,
  order: readonly string[],
  conversations: Record<
    string,
    (Parameters<typeof projectConversationIds>[1][string] & { unread?: boolean }) | undefined
  >
): number {
  return secretaryConversationIds(projectId, order, conversations).filter(
    (id) => conversations[id]?.unread === true
  ).length;
}
