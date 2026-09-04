/**
 * 侧栏会话分组的排序纯函数。各栏目内按最后活跃时间倒序
 * (最后一条消息 timestamp,无消息回落 createdAt);置顶只改分组内先后。
 * 归档与置顶/项目分组互斥:archived 的会话只出现在「已归档」栏目。
 * 项目归档(archivedProjectIds)是项目层标记:该项目全部会话整组进「已归档」栏目,
 * 会话自身的 archived/pinned 标记原样保留,恢复项目后侧栏与归档前完全一致。
 */

interface SidebarConversation {
  projectId: string;
  pinned?: boolean;
  archived?: boolean;
  archivedAt?: number;
  createdAt: number;
  /** 持久化的最后活跃时刻:partialize 剥离 messages 前留下的标量,重启后排序靠它 */
  lastActiveAt?: number;
  messages: { timestamp?: number }[];
}

type Conversations = Record<string, SidebarConversation | undefined>;

/** 会话的最后活跃时刻:最后一条消息时间 → 持久化 lastActiveAt(messages 被剥离时) → createdAt */
function lastActiveAt(conversation: SidebarConversation): number {
  return (
    conversation.messages.at(-1)?.timestamp ?? conversation.lastActiveAt ?? conversation.createdAt
  );
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
  manualIds: readonly string[] = [],
  archivedProjectIds: readonly string[] = []
): string[] {
  const archivedProjects = new Set(archivedProjectIds);
  const byActivity = sortByActivity(
    order.filter((id) => {
      const conversation = conversations[id];
      return (
        conversation?.pinned === true &&
        conversation.archived !== true &&
        !archivedProjects.has(conversation.projectId)
      );
    }),
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

/** 全部归档会话 id(跨项目,按最后活跃时间倒序);归档项目的会话全部计入 */
export function archivedConversationIds(
  order: readonly string[],
  conversations: Conversations,
  archivedProjectIds: readonly string[] = []
): string[] {
  const archivedProjects = new Set(archivedProjectIds);
  return sortByActivity(
    order.filter((id) => {
      const conversation = conversations[id];
      return conversation?.archived === true || archivedProjects.has(conversation?.projectId ?? '');
    }),
    conversations
  );
}

export interface ArchivedGroup {
  projectId: string;
  ids: string[];
  /** 整个项目已归档:组内是该项目全部会话(含单独归档的),组头提供「恢复项目」 */
  projectArchived?: true;
}

/**
 * 归档会话按项目分组:已知项目按传入顺序,未知项目(已删)追加末尾;组内按活跃时间倒序。
 * 归档项目(须仍在 projectIds 中)即使没有会话也占一组,否则无处恢复。
 */
export function archivedConversationGroups(
  order: readonly string[],
  conversations: Conversations,
  projectIds: readonly string[],
  archivedProjectIds: readonly string[] = []
): ArchivedGroup[] {
  const archivedProjects = new Set(archivedProjectIds);
  const idsByProject = new Map<string, string[]>();
  for (const id of order) {
    const conversation = conversations[id];
    if (!conversation) continue;
    if (conversation.archived !== true && !archivedProjects.has(conversation.projectId)) continue;
    const bucket = idsByProject.get(conversation.projectId);
    if (bucket) bucket.push(id);
    else idsByProject.set(conversation.projectId, [id]);
  }
  const groups: ArchivedGroup[] = [];
  const seen = new Set<string>();
  for (const projectId of projectIds) {
    const projectArchived = archivedProjects.has(projectId);
    const ids = idsByProject.get(projectId);
    if (!ids && !projectArchived) continue;
    seen.add(projectId);
    groups.push({
      projectId,
      ids: sortByActivity(ids ?? [], conversations),
      ...(projectArchived ? { projectArchived: true } : {}),
    });
  }
  for (const [projectId, ids] of idsByProject) {
    if (seen.has(projectId)) continue;
    groups.push({ projectId, ids: sortByActivity(ids, conversations) });
  }
  return groups;
}

const DAY_MS = 86_400_000;

/** 归档超过 N 天的会话 id。缺 archivedAt 的旧数据回落最后活跃时间。 */
export function staleArchivedConversationIds(
  order: readonly string[],
  conversations: Conversations,
  olderThanDays: number,
  now: number,
  projectId?: string
): string[] {
  const cutoff = now - olderThanDays * DAY_MS;
  return order.filter((id) => {
    const conversation = conversations[id];
    if (conversation?.archived !== true) return false;
    if (projectId !== undefined && conversation.projectId !== projectId) return false;
    const archivedAt = conversation.archivedAt ?? lastActiveAt(conversation);
    return archivedAt <= cutoff;
  });
}
