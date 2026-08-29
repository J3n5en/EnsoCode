/**
 * 侧栏会话分组的排序纯函数。order 新的在前;置顶只改分组内先后,不动 order 本身。
 * 归档与置顶/项目分组互斥:archived 的会话只出现在「已归档」栏目。
 */

interface SidebarConversation {
  projectId: string;
  pinned?: boolean;
  archived?: boolean;
}

/** 某项目下的会话 id:归档的不进组;置顶的排最前,组内保持 order 相对顺序 */
export function projectConversationIds(
  order: readonly string[],
  conversations: Record<string, SidebarConversation | undefined>,
  projectId: string
): string[] {
  const ids = order.filter(
    (id) => conversations[id]?.projectId === projectId && conversations[id]?.archived !== true
  );
  return [
    ...ids.filter((id) => conversations[id]?.pinned === true),
    ...ids.filter((id) => conversations[id]?.pinned !== true),
  ];
}

/** 全部置顶会话 id(跨项目,保持 order 顺序);归档的与 order 之外的会话(coworker)不参与 */
export function pinnedConversationIds(
  order: readonly string[],
  conversations: Record<string, SidebarConversation | undefined>
): string[] {
  return order.filter(
    (id) => conversations[id]?.pinned === true && conversations[id]?.archived !== true
  );
}

/** 全部归档会话 id(跨项目,保持 order 顺序) */
export function archivedConversationIds(
  order: readonly string[],
  conversations: Record<string, SidebarConversation | undefined>
): string[] {
  return order.filter((id) => conversations[id]?.archived === true);
}
