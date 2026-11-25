import { conversationHasRunningChild } from '@shared/conversationDotTone';
import { lastActiveAt } from '@/stores/sessions/pinned';

/** 折叠栏要点开的项目。进行中只认 running / spawning / 子任务仍在跑，不含未读和待回答。 */
export interface CollapsedActiveProject {
  projectId: string;
  conversationId: string;
  parentId?: string;
  title: string;
}

interface ActivityConversation {
  projectId: string;
  parentId?: string;
  archived?: boolean;
  title?: string;
  createdAt: number;
  lastActiveAt?: number;
  messages?: { timestamp?: number }[];
  status?: string;
  spawning?: boolean;
  hasRunningChild?: boolean;
  coworkerIds?: readonly string[];
  subagents?: readonly { status: string }[];
  backgroundTasks?: readonly { status: string }[];
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
