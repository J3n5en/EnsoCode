/** 侧栏会话置顶的排序纯函数。order 新的在前;置顶只改分组内先后,不动 order 本身。 */

interface PinnableConversation {
  projectId: string;
  pinned?: boolean;
}

/** 某项目下的会话 id:置顶的排最前,组内保持 order 相对顺序 */
export function projectConversationIds(
  order: readonly string[],
  conversations: Record<string, PinnableConversation | undefined>,
  projectId: string
): string[] {
  const ids = order.filter((id) => conversations[id]?.projectId === projectId);
  return [
    ...ids.filter((id) => conversations[id]?.pinned === true),
    ...ids.filter((id) => conversations[id]?.pinned !== true),
  ];
}

/** 全部置顶会话 id(跨项目,保持 order 顺序);order 之外的会话(coworker)不参与 */
export function pinnedConversationIds(
  order: readonly string[],
  conversations: Record<string, PinnableConversation | undefined>
): string[] {
  return order.filter((id) => conversations[id]?.pinned === true);
}
