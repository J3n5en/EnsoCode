/**
 * 侧栏会话分组的排序纯函数。各栏目内按最后活跃时间倒序
 * (最后一条消息 timestamp,无消息回落 createdAt);置顶只改分组内先后。
 * 归档与置顶/项目分组互斥:archived 的会话只出现在「已归档」栏目。
 */

interface SidebarConversation {
  projectId: string;
  pinned?: boolean;
  archived?: boolean;
  createdAt: number;
  messages: { timestamp?: number }[];
}

type Conversations = Record<string, SidebarConversation | undefined>;

/** 会话的最后活跃时刻:最后一条消息时间,没消息回落创建时间 */
function lastActiveAt(conversation: SidebarConversation): number {
  return conversation.messages.at(-1)?.timestamp ?? conversation.createdAt;
}

/** 按最后活跃时间倒序;时间相同保持传入顺序(sort 稳定) */
function sortByActivity(ids: string[], conversations: Conversations): string[] {
  return ids.sort((left, right) => {
    const a = conversations[left];
    const b = conversations[right];
    return (b ? lastActiveAt(b) : 0) - (a ? lastActiveAt(a) : 0);
  });
}

/** 某项目下的会话 id:归档的不进组;置顶的排最前,各组内按最后活跃时间倒序 */
export function projectConversationIds(
  order: readonly string[],
  conversations: Conversations,
  projectId: string
): string[] {
  const ids = order.filter(
    (id) => conversations[id]?.projectId === projectId && conversations[id]?.archived !== true
  );
  return [
    ...sortByActivity(
      ids.filter((id) => conversations[id]?.pinned === true),
      conversations
    ),
    ...sortByActivity(
      ids.filter((id) => conversations[id]?.pinned !== true),
      conversations
    ),
  ];
}

/**
 * 全部置顶会话 id(跨项目)。manualIds 是用户拖拽过的手动顺序:
 * 命中的按其顺序排前,未收录的新置顶按活跃时间追加末尾,失效 id 忽略。
 * 归档的与 order 之外的会话(coworker)不参与。
 */
export function pinnedConversationIds(
  order: readonly string[],
  conversations: Conversations,
  manualIds: readonly string[] = []
): string[] {
  const byActivity = sortByActivity(
    order.filter(
      (id) => conversations[id]?.pinned === true && conversations[id]?.archived !== true
    ),
    conversations
  );
  const remaining = new Set(byActivity);
  const ordered: string[] = [];
  for (const id of manualIds) {
    if (remaining.has(id)) {
      ordered.push(id);
      remaining.delete(id);
    }
  }
  for (const id of byActivity) {
    if (remaining.has(id)) ordered.push(id);
  }
  return ordered;
}

/** 全部归档会话 id(跨项目,按最后活跃时间倒序) */
export function archivedConversationIds(
  order: readonly string[],
  conversations: Conversations
): string[] {
  return sortByActivity(
    order.filter((id) => conversations[id]?.archived === true),
    conversations
  );
}
