import {
  type ConversationDotTone,
  conversationDotTone,
  conversationHasRunningChild,
  userAskCount,
} from '@shared/conversationDotTone';
import { lastActiveAt, retentionAnchor, staysActive } from '@/stores/sessions/pinned';

/** 折叠栏要点开的项目。进行中只认 running / spawning / 子任务仍在跑，不含未读和待回答。 */
export interface CollapsedActiveProject {
  projectId: string;
  conversationId: string;
  parentId?: string;
  title: string;
}

/** 折叠 rail 悬停浮层里的一行：项目下某条未归档会话的可观察状态。 */
export interface CollapsedProjectSession {
  conversationId: string;
  parentId?: string;
  title: string;
  tone: ConversationDotTone;
  /** 最近活跃时间，浮层内排序用（新在前） */
  activity: number;
}

/** 与侧栏会话行同一套 tone 计算，只是数据源是投影字段。 */
function sessionTone(conversation: {
  status?: string;
  spawning?: boolean;
  unread?: boolean;
  pendingAsks?: readonly { relay?: unknown; answered?: unknown }[];
  hasRunningChild?: boolean;
  queued?: boolean;
  queueFailed?: string;
  hasPendingReminder?: boolean;
  pendingApprovalCount?: number;
}): ConversationDotTone {
  return conversationDotTone({
    status: conversation.queueFailed ? 'failed' : (conversation.status ?? 'idle'),
    spawning: conversation.spawning,
    unread: conversation.unread,
    pendingAskCount: userAskCount(conversation.pendingAsks),
    hasRunningChild: conversation.hasRunningChild,
    queued: conversation.queued === true && !conversation.queueFailed,
    hasPendingReminder: conversation.hasPendingReminder,
  });
}

interface ActivityConversation {
  projectId: string;
  parentId?: string;
  archived?: boolean;
  title?: string;
  createdAt: number;
  lastActiveAt?: number;
  activeRenewedAt?: number;
  messages?: { timestamp?: number }[];
  status?: string;
  spawning?: boolean;
  unread?: boolean;
  pendingAsks?: readonly { relay?: unknown; answered?: unknown }[];
  hasRunningChild?: boolean;
  queued?: boolean;
  queueFailed?: string;
  coworkerIds?: readonly string[];
  subagents?: readonly { status: string }[];
  backgroundTasks?: readonly { status: string }[];
  goal?: { status: string };
}

function activityAt(conversation: ActivityConversation): number {
  return lastActiveAt({
    projectId: conversation.projectId,
    createdAt: conversation.createdAt,
    lastActiveAt: conversation.lastActiveAt,
    messages: conversation.messages ?? [],
  });
}

function inProgress(
  conversation: ActivityConversation,
  conversations: Readonly<Record<string, ActivityConversation | undefined>>
): boolean {
  if (
    conversation.status === 'running' ||
    conversation.spawning === true ||
    conversation.hasRunningChild === true
  ) {
    return true;
  }
  return conversationHasRunningChild(
    {
      status: conversation.status ?? 'idle',
      spawning: conversation.spawning,
      subagents: conversation.subagents,
      coworkerIds: conversation.coworkerIds,
      backgroundTasks: conversation.backgroundTasks,
    },
    conversations
  );
}

export function collapsedActiveProjects(
  projects: readonly { id: string; kind?: string }[],
  conversations: Readonly<Record<string, ActivityConversation | undefined>>,
  options?: { archivedProjectIds?: readonly string[] }
): CollapsedActiveProject[] {
  const archived = new Set(options?.archivedProjectIds ?? []);
  const entries: (CollapsedActiveProject & { activity: number })[] = [];
  for (const project of projects) {
    if (project.kind === 'scratch' || project.kind === 'secretary') continue;
    if (archived.has(project.id)) continue;
    const owned = Object.entries(conversations).flatMap(([id, conversation]) =>
      conversation && conversation.projectId === project.id && conversation.archived !== true
        ? [[id, conversation] as const]
        : []
    );
    if (!owned.some(([, conversation]) => inProgress(conversation, conversations))) continue;
    const [conversationId, conversation] = owned.reduce((best, item) =>
      activityAt(item[1]) >= activityAt(best[1]) ? item : best
    );
    const parentId = conversation.parentId;
    entries.push({
      projectId: project.id,
      conversationId,
      ...(parentId && conversations[parentId] ? { parentId } : {}),
      title: conversation.title ?? '',
      activity: activityAt(conversation),
    });
  }
  return entries
    .sort(
      (left, right) =>
        right.activity - left.activity || left.projectId.localeCompare(right.projectId)
    )
    .map(({ activity: _activity, ...entry }) => entry);
}

/**
 * 折叠 rail 浮层的行数据：该项目**活跃中**的未归档会话（含 coworker 子会话，后者有 parentId），
 * 最近活跃在前；已删除/不存在的 parent 不挡行——打开逻辑自己会回退直接选会话。
 *
 * 「活跃中」与侧栏 Active 分组同口径：running / waiting / unread / 未读失败 / 续跑 goal /
 * 排队 / 等提醒，以及 activeRetention 窗口内有过消息或续期的会话。已 idle 且超窗的会话不进列表,
 * 自然也不参与角标计数。
 */
export function collapsedProjectSessions(
  projectId: string,
  conversations: Readonly<Record<string, ActivityConversation | undefined>>,
  options?: {
    pendingReminderIds?: ReadonlySet<string>;
    activeRetention?: { now: number; ms: number };
  }
): CollapsedProjectSession[] {
  const pendingReminderIds = options?.pendingReminderIds ?? new Set<string>();
  const retention = options?.activeRetention;
  const cutoff = retention && retention.ms > 0 ? retention.now - retention.ms : undefined;
  return Object.entries(conversations)
    .flatMap(([id, conversation]) =>
      conversation && conversation.projectId === projectId && conversation.archived !== true
        ? [[id, conversation] as const]
        : []
    )
    .map(([conversationId, conversation]) => {
      const parentId = conversation.parentId;
      const hasReminder = pendingReminderIds.has(conversationId);
      const tone = sessionTone({
        ...conversation,
        hasRunningChild:
          conversation.hasRunningChild === true ||
          conversationHasRunningChild(
            {
              status: conversation.status ?? 'idle',
              spawning: conversation.spawning,
              subagents: conversation.subagents,
              coworkerIds: conversation.coworkerIds,
              backgroundTasks: conversation.backgroundTasks,
            },
            conversations
          ),
        hasPendingReminder: hasReminder,
      });
      return {
        conversationId,
        ...(parentId && conversations[parentId] ? { parentId } : {}),
        title: conversation.title ?? '',
        tone,
        activity: activityAt(conversation),
        conversation,
      };
    })
    .filter(({ tone, conversation }) => {
      if (staysActive(tone, conversation)) return true;
      if (cutoff === undefined) return false;
      const anchor = retentionAnchor({
        messages: conversation.messages ?? [],
        lastActiveAt: conversation.lastActiveAt,
        activeRenewedAt: conversation.activeRenewedAt,
      });
      return anchor !== undefined && anchor >= cutoff;
    })
    .map(({ conversation: _conversation, ...row }) => row)
    .sort((left, right) => right.activity - left.activity);
}

/** 与全局搜索 openHit 相同：子会话先选父，再选 tab。 */
export function openCollapsedActiveProject(
  entry: CollapsedActiveProject,
  sessions: {
    conversations: Readonly<Record<string, unknown>>;
    selectConversation: (id: string) => void;
    selectTab: (parentId: string, conversationId: string) => void;
  }
): void {
  const parentId = entry.parentId;
  if (parentId && sessions.conversations[parentId]) {
    sessions.selectConversation(parentId);
    sessions.selectTab(parentId, entry.conversationId);
    return;
  }
  sessions.selectConversation(entry.conversationId);
}
