import { conversationIdsToMove, type ImportProjectSessionsMode } from '@shared/moveConversation';
import { addToast } from '@/components/ui/toast';
import type { TFunction } from '@/i18n';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';

export {
  canMoveConversationFrom,
  defaultImportMode,
  moveConversationTargets,
} from '@shared/moveConversation';

const MOVE_ERROR_TITLES: Record<string, string> = {
  running: 'Cannot move a running conversation',
  'worktree-busy': 'Cannot move while its worktree is in use',
  'source-secretary': 'Secretary conversations cannot be moved',
};

export function conversationMoveErrorTitle(error: string): string {
  return Object.hasOwn(MOVE_ERROR_TITLES, error)
    ? MOVE_ERROR_TITLES[error]
    : 'Failed to move conversation';
}

export async function moveConversationFromMenu(
  conversationId: string,
  targetProjectId: string,
  t: TFunction
): Promise<void> {
  try {
    const result = await window.electronAPI.settings.moveConversation({
      conversationId,
      targetProjectId,
    });
    if (!result.ok) {
      addToast({
        type: 'error',
        title: t(conversationMoveErrorTitle(result.error)),
        ...(Object.hasOwn(MOVE_ERROR_TITLES, result.error) ? {} : { description: result.error }),
      });
      return;
    }
    applyMovedConversations([conversationId], targetProjectId);
  } catch (error) {
    addToast({
      type: 'error',
      title: t('Failed to move conversation'),
      description: String(error),
    });
  }
}

/** 根会话连同子会话 / btw 旁路改挂到目标项目；Main 已解除 worktree 绑定，根会话回到新项目根目录 */
function applyMovedConversations(rootIds: readonly string[], targetProjectId: string): void {
  if (rootIds.length === 0) return;
  useSessionsStore.setState((state) => {
    const conversations = { ...state.conversations };
    const worktreeStatuses = { ...state.worktreeStatuses };
    for (const id of conversationIdsToMove(conversations, rootIds)) {
      const row = conversations[id];
      if (row) conversations[id] = { ...row, projectId: targetProjectId };
    }
    for (const rootId of rootIds) {
      const root = conversations[rootId];
      if (root)
        conversations[rootId] = { ...root, worktree: undefined, worktreeMissing: undefined };
      delete worktreeStatuses[rootId];
    }
    return { conversations, worktreeStatuses };
  });
}

export function projectRootConversationCount(
  conversations: Record<string, { projectId?: string; parentId?: string; btwParentId?: string }>,
  projectId: string
): number {
  return Object.values(conversations).filter(
    (row) => row.projectId === projectId && !row.parentId && !row.btwParentId
  ).length;
}

/**
 * 把源项目的全部会话移动或复制到目标项目；运行中等被跳过的会话列出标题。
 * 复制出的会话行由 Main 的会话补丁送达。返回 null 表示失败；offerRemoveSource 表示移动后源项目已空。
 */
export async function importProjectSessionsFromDialog(
  sourceProjectId: string,
  targetProjectId: string,
  mode: ImportProjectSessionsMode,
  t: TFunction
): Promise<{ offerRemoveSource: boolean } | null> {
  try {
    const result = await window.electronAPI.settings.importProjectSessions({
      sourceProjectId,
      targetProjectId,
      mode,
    });
    if (!result.ok) {
      addToast({
        type: 'error',
        title: t('Failed to import conversations'),
        description: result.error,
      });
      return null;
    }
    if (result.mode === 'move') applyMovedConversations(result.imported, targetProjectId);
    const count = result.imported.length;
    if (result.skipped.length > 0) {
      const { conversations } = useSessionsStore.getState();
      addToast({
        type: 'warning',
        title:
          result.mode === 'move'
            ? t(
                'Imported {{moved}} conversations; {{count}} running or busy ones stay in the original project',
                { moved: count, count: result.skipped.length }
              )
            : t('Copied {{moved}} conversations; {{count}} running ones were not copied', {
                moved: count,
                count: result.skipped.length,
              }),
        description: result.skipped
          .map(({ conversationId }) => conversations[conversationId]?.title || t('Untitled'))
          .join('、'),
      });
    } else {
      addToast({
        type: count > 0 ? 'success' : 'info',
        title:
          count === 0
            ? t('No conversations to import')
            : result.mode === 'move'
              ? t('Imported {{count}} conversations', { count })
              : t('Copied {{count}} conversations', { count }),
      });
    }
    return { offerRemoveSource: result.mode === 'move' && result.sourceEmpty };
  } catch (error) {
    addToast({
      type: 'error',
      title: t('Failed to import conversations'),
      description: String(error),
    });
    return null;
  }
}

/** 只把空项目从列表里去掉；走 Main 的专用通道，不删会话文件、项目目录与 worktree */
export async function removeEmptyProjectFromDialog(
  projectId: string,
  t: TFunction
): Promise<boolean> {
  try {
    const result = await window.electronAPI.settings.removeEmptyProject({ projectId });
    if (!result.ok) {
      addToast({ type: 'error', title: t('Failed to remove project'), description: result.error });
      return false;
    }
    useSettingsStore.setState((state) => ({
      projects: state.projects.filter((project) => project.id !== projectId),
    }));
    return true;
  } catch (error) {
    addToast({ type: 'error', title: t('Failed to remove project'), description: String(error) });
    return false;
  }
}
