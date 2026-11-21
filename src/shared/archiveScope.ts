import { ALL_GROUP_ID, RECENT_GROUP_ID, UNGROUPED_GROUP_ID } from '@shared/projectGroups';

const DEFAULT_SECRETARY_ID = 'default';

/** 已归档弹窗的列出范围；「最近」按活跃度划分、对归档会话没有意义，退回全部并在弹窗里写明 */
export type ArchiveScope =
  | { kind: 'all'; fallbackFrom?: 'recent' }
  | { kind: 'group'; groupId: string }
  | { kind: 'ungrouped' }
  | { kind: 'secretary'; secretaryId: string };

interface ScopeGroup {
  projectId: string;
  ids: string[];
  projectArchived?: true;
}

type SecretaryOrigin = { secretaryConversationId: string; secretaryId?: string };
type ScopeConversation = { secretaryOrigin?: SecretaryOrigin } | undefined;

interface ScopeContext {
  projects: readonly { id: string; groupId?: string }[];
  projectGroups: readonly { id: string }[];
  conversations: Record<string, ScopeConversation>;
}

export function archiveScopeForTab(
  tabId: string,
  projectGroups: readonly { id: string }[]
): ArchiveScope {
  if (tabId === RECENT_GROUP_ID) return { kind: 'all', fallbackFrom: 'recent' };
  if (tabId === UNGROUPED_GROUP_ID) return { kind: 'ungrouped' };
  if (tabId !== ALL_GROUP_ID && projectGroups.some((group) => group.id === tabId)) {
    return { kind: 'group', groupId: tabId };
  }
  return { kind: 'all' };
}

const dispatcherOf = (conversation: ScopeConversation): string | undefined =>
  conversation?.secretaryOrigin
    ? (conversation.secretaryOrigin.secretaryId ?? DEFAULT_SECRETARY_ID)
    : undefined;

export function filterArchivedByScope<T extends ScopeGroup>(
  groups: readonly T[],
  scope: ArchiveScope,
  { projects, projectGroups, conversations }: ScopeContext
): T[] {
  switch (scope.kind) {
    case 'all':
      return [...groups];
    case 'secretary':
      return groups
        .map((group) => ({
          ...group,
          ids: group.ids.filter((id) => dispatcherOf(conversations[id]) === scope.secretaryId),
        }))
        .filter((group) => group.ids.length > 0);
    default: {
      const known = new Set(projectGroups.map((group) => group.id));
      return groups.filter((group) => {
        const groupId = projects.find((project) => project.id === group.projectId)?.groupId;
        if (scope.kind === 'group') return groupId === scope.groupId;
        return !groupId || !known.has(groupId);
      });
    }
  }
}

export const archivedTotal = (groups: readonly ScopeGroup[]): number =>
  groups.reduce((count, group) => count + group.ids.length, 0);

/** 有已归档派出会话的秘书，按首次出现顺序 */
export function archiveSecretaryIds(
  groups: readonly ScopeGroup[],
  conversations: ScopeContext['conversations']
): string[] {
  const seen = new Set<string>();
  for (const group of groups) {
    for (const id of group.ids) {
      const secretaryId = dispatcherOf(conversations[id]);
      if (secretaryId) seen.add(secretaryId);
    }
  }
  return [...seen];
}
