import {
  type ConversationDotTone,
  conversationDotTone,
  conversationHasRunningChild,
} from '@shared/conversationDotTone';
import type { WorktreeStatus } from '@shared/types/worktree';
import { worktreeReadyToAutoCleanup } from './worktree';

/**
 * 侧栏会话分组的排序纯函数。各栏目内按最后活跃时间倒序
 * (最后一条消息 timestamp,无消息回落 createdAt);置顶只改分组内先后。
 * 归档与置顶/项目分组互斥:archived 的会话只出现在「已归档」栏目。
 * 项目归档(archivedProjectIds)是项目层标记:该项目全部会话整组进「已归档」栏目,
 * 会话自身的 archived/pinned 标记原样保留,恢复项目后侧栏与归档前完全一致。
 */

interface SidebarConversation {
  projectId: string;
  parentId?: string;
  pinned?: boolean;
  archived?: boolean;
  archivedAt?: number;
  createdAt: number;
  /** 持久化的最后活跃时刻:partialize 剥离 messages 前留下的标量,重启后排序靠它 */
  lastActiveAt?: number;
  messages: { timestamp?: number }[];
  status?: string;
  spawning?: boolean;
  unread?: boolean;
  /** 仍在「活跃中」时被点开的时刻:留存窗口从它与最后一条消息中较晚者起算 */
  activeRenewedAt?: number;
  pendingAsks?: readonly { requestId: string }[];
  pendingApprovals?: readonly unknown[];
  pendingCapabilityAsks?: readonly unknown[];
  coworkerIds?: readonly string[];
  subagents?: readonly { status: string }[];
  worktree?: { path?: string };
}

type Conversations = Record<string, SidebarConversation | undefined>;

/** 子会话只在父会话的 tab 里出现；即使旧数据把它写进 order 也不进侧栏 */
function sidebarRoot(id: string, conversations: Conversations): SidebarConversation | undefined {
  const conversation = conversations[id];
  return conversation && !conversation.parentId ? conversation : undefined;
}

/** 侧栏时钟刷新间隔:相对时间与「活跃中」留存都按它过期,点开判定需留出同样余量 */
export const SIDEBAR_TICK_MS = 60_000;

/** 会话的最后活跃时刻:最后一条消息时间 → 持久化 lastActiveAt(messages 被剥离时) → createdAt */
export function lastActiveAt(conversation: SidebarConversation): number {
  return (
    conversation.messages.at(-1)?.timestamp ?? conversation.lastActiveAt ?? conversation.createdAt
  );
}

/** 「最近」只收这个窗口内有过未归档会话的项目，不是全部项目的另一种排序 */
export const RECENT_PROJECT_WINDOW_DAYS = 7;
export const RECENT_PROJECT_WINDOW_MS = RECENT_PROJECT_WINDOW_DAYS * 24 * 60 * 60 * 1000;

function latestActivityByProject(
  order: readonly string[],
  conversations: Conversations
): Map<string, number> {
  const activity = new Map<string, number>();
  for (const id of order) {
    const conversation = sidebarRoot(id, conversations);
    if (!conversation || conversation.archived === true) continue;
    activity.set(
      conversation.projectId,
      Math.max(activity.get(conversation.projectId) ?? 0, lastActiveAt(conversation))
    );
  }
  return activity;
}

function byLatestActivity<T extends { id: string }>(
  projects: readonly T[],
  activity: ReadonlyMap<string, number>
): T[] {
  return [...projects].sort((a, b) => (activity.get(b.id) ?? 0) - (activity.get(a.id) ?? 0));
}

/** 按最后活跃时间倒序;时间相同保持传入顺序(sort 稳定) */
export function sortProjectsByActivity<T extends { id: string }>(
  projects: readonly T[],
  order: readonly string[],
  conversations: Conversations
): T[] {
  return byLatestActivity(projects, latestActivityByProject(order, conversations));
}

/** 最近视图：未归档、且最新会话落在窗口内；没有会话或更早的项目不显示 */
export function recentProjects<T extends { id: string }>(
  projects: readonly T[],
  order: readonly string[],
  conversations: Conversations,
  now: number
): T[] {
  const activity = latestActivityByProject(order, conversations);
  const cutoff = now - RECENT_PROJECT_WINDOW_MS;
  return byLatestActivity(
    projects.filter((project) => {
      const at = activity.get(project.id);
      return at !== undefined && at >= cutoff;
    }),
    activity
  );
}

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
    (id) =>
      sidebarRoot(id, conversations)?.projectId === projectId &&
      conversations[id]?.archived !== true
  );
  return waitingFirst(
    [
      ...sortByActivity(
        ids.filter((id) => conversations[id]?.pinned === true),
        conversations
      ),
      ...sortByActivity(
        ids.filter((id) => conversations[id]?.pinned !== true),
        conversations
      ),
    ],
    conversations
  );
}

function sidebarTone(
  conversation: SidebarConversation,
  conversations: Conversations
): ConversationDotTone {
  return conversationDotTone({
    status: conversation.status ?? 'idle',
    spawning: conversation.spawning,
    unread: conversation.unread,
    pendingAskCount: conversation.pendingAsks?.length ?? 0,
    hasRunningChild: conversationHasRunningChild(
      { ...conversation, status: conversation.status ?? 'idle' },
      conversations as Record<string, { status: string; spawning?: boolean } | undefined>
    ),
  });
}

/** 不受留存窗口影响、始终留在「活跃中」:运行、待确认、未读、未读失败 */
function staysActive(tone: ConversationDotTone, conversation: SidebarConversation): boolean {
  if (tone === 'failed') return conversation.unread === true;
  return tone === 'running' || tone === 'waiting' || tone === 'unread';
}

/** 留存窗口起点:最后一条消息与续期时刻中较晚者;都没有则不参与留存 */
function retentionAnchor(conversation: SidebarConversation): number | undefined {
  const messageAt = conversation.messages.at(-1)?.timestamp ?? conversation.lastActiveAt;
  return conversation.activeRenewedAt === undefined
    ? messageAt
    : Math.max(messageAt ?? 0, conversation.activeRenewedAt);
}

/**
 * 全部置顶会话 id(跨项目)。manualIds 是用户拖拽过的手动顺序:
 * 命中的按其顺序排前,未收录的新置顶按活跃时间追加末尾,失效 id 忽略。
 * 归档的与 order 之外的会话(coworker)不参与。
 */
/**
 * 蓝/绿/红活跃态:运行、待确认、未读失败、未读。失败查看过即退出(红点仍在项目组里)。
 * retention.ms>0 时,最后一条消息或续期时刻落在窗口内的会话不论已读都保留;超窗回到上述规则。
 */
export function activeConversationIds(
  order: readonly string[],
  conversations: Conversations,
  archivedProjectIds: readonly string[] = [],
  retention?: { now: number; ms: number }
): string[] {
  const archivedProjects = new Set(archivedProjectIds);
  const cutoff = retention && retention.ms > 0 ? retention.now - retention.ms : undefined;
  return sortByActivity(
    order.filter((id) => {
      const conversation = sidebarRoot(id, conversations);
      if (!conversation || conversation.archived === true) return false;
      if (archivedProjects.has(conversation.projectId)) return false;
      if (staysActive(sidebarTone(conversation, conversations), conversation)) return true;
      const anchor = retentionAnchor(conversation);
      return cutoff !== undefined && anchor !== undefined && anchor >= cutoff;
    }),
    conversations
  );
}

/** 仅靠留存窗口留在「活跃中」的会话还剩多少毫秒;不会因超时移出或已超时的返回 undefined */
export function activeRetentionRemainingMs(
  id: string,
  conversations: Conversations,
  retention: { now: number; ms: number }
): number | undefined {
  if (!(retention.ms > 0)) return undefined;
  const conversation = sidebarRoot(id, conversations);
  if (!conversation || staysActive(sidebarTone(conversation, conversations), conversation)) {
    return undefined;
  }
  const anchor = retentionAnchor(conversation);
  if (anchor === undefined) return undefined;
  const remaining = anchor + retention.ms - retention.now;
  return remaining > 0 ? remaining : undefined;
}

export function pinnedConversationIds(
  order: readonly string[],
  conversations: Conversations,
  manualIds: readonly string[] = [],
  archivedProjectIds: readonly string[] = []
): string[] {
  const archivedProjects = new Set(archivedProjectIds);
  const byActivity = sortByActivity(
    order.filter((id) => {
      const conversation = sidebarRoot(id, conversations);
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
  return [
    ...ordered,
    ...waitingFirst(
      byActivity.filter((id) => remaining.has(id)),
      conversations
    ),
  ];
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
      const conversation = sidebarRoot(id, conversations);
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
    const conversation = sidebarRoot(id, conversations);
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

function dotTone(id: string, conversations: Conversations): ConversationDotTone | undefined {
  const conversation = conversations[id];
  if (!conversation) return undefined;
  return conversationDotTone({
    status: conversation.status ?? 'idle',
    spawning: conversation.spawning,
    unread: conversation.unread,
    pendingAskCount: conversation.pendingAsks?.length ?? 0,
    hasRunningChild: conversationHasRunningChild(
      { ...conversation, status: conversation.status ?? 'idle' },
      conversations as Record<string, { status: string; spawning?: boolean } | undefined>
    ),
  });
}

export function isActiveTone(id: string, conversations: Conversations): boolean {
  const tone = dotTone(id, conversations);
  return tone === 'running' || tone === 'waiting' || tone === 'failed' || tone === 'unread';
}

/** 等你处理:待审批 / 待能力确认（圆点 attention），或圆点 waiting（待回答） */
function isWaiting(id: string, conversations: Conversations): boolean {
  const conversation = conversations[id];
  if (
    (conversation?.pendingApprovals?.length ?? 0) > 0 ||
    (conversation?.pendingCapabilityAsks?.length ?? 0) > 0
  )
    return true;
  return dotTone(id, conversations) === 'waiting';
}

/** 稳定两档:等你处理的在前,其余保持传入顺序 */
function waitingFirst(ids: string[], conversations: Conversations): string[] {
  const waiting = ids.filter((id) => isWaiting(id, conversations));
  if (waiting.length === 0) return ids;
  return [...waiting, ...ids.filter((id) => !isWaiting(id, conversations))];
}

/** Dock 角标数:order 内等你处理的会话数 */
export function waitingConversationCount(
  order: readonly string[],
  conversations: Conversations
): number {
  return order.filter((id) => isWaiting(id, conversations)).length;
}

const DAY_MS = 86_400_000;

/**
 * 闲置自动归档候选。idleDays=0 为从不。
 * 排除已归档、置顶、当前打开、Active 态。
 * 隔离 worktree 默认排除；cleanupMergedWorktrees 开时，已合并干净或目录已不存在的可入选。
 */
export function staleUnarchivedConversationIds(input: {
  order: readonly string[];
  conversations: Conversations;
  now: number;
  idleDays: number;
  activeId?: string | null;
  cleanupMergedWorktrees?: boolean;
  worktreeStatuses?: Record<string, Pick<WorktreeStatus, 'exists' | 'dirty' | 'ahead'> | undefined>;
}): string[] {
  const {
    order,
    conversations,
    now,
    idleDays,
    activeId,
    cleanupMergedWorktrees,
    worktreeStatuses,
  } = input;
  if (!(idleDays > 0)) return [];
  const cutoff = now - idleDays * DAY_MS;
  return order.filter((id) => {
    const conversation = conversations[id];
    if (!conversation || conversation.archived === true) return false;
    if (conversation.pinned === true) return false;
    if (activeId && id === activeId) return false;
    if (conversation.worktree) {
      if (!cleanupMergedWorktrees) return false;
      const status = worktreeStatuses?.[id];
      if (!status) return false;
      if (status.exists !== false && !worktreeReadyToAutoCleanup(status)) return false;
    }
    if (isActiveTone(id, conversations)) return false;
    return lastActiveAt(conversation) <= cutoff;
  });
}

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

/**
 * 自动删除超期归档。days=0 为从不（与手动「全部删除」的 days=0 不同）。
 * 跳过当前打开的会话。
 */
export function staleArchivedConversationIdsToDelete(
  order: readonly string[],
  conversations: Conversations,
  days: number,
  now: number,
  activeId?: string | null
): string[] {
  if (!(days > 0)) return [];
  return staleArchivedConversationIds(order, conversations, days, now).filter(
    (id) => id !== activeId
  );
}
