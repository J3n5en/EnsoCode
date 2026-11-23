import { conversationIdsToMove } from '@shared/moveConversation';
import { addToast } from '@/components/ui/toast';
import type { TFunction } from '@/i18n';
import { useSessionsStore } from '@/stores/sessions';

export { canMoveConversationFrom, moveConversationTargets } from '@shared/moveConversation';

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
    for (const rootId of rootIds) {
      for (const id of conversationIdsToMove(conversations, rootId)) {
        const row = conversations[id];
        if (row) conversations[id] = { ...row, projectId: targetProjectId };
      }
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

/** 把源项目的全部会话改挂到目标项目；运行中等被跳过的会话列出标题。返回是否已执行 */
export async function importProjectSessionsFromDialog(
  sourceProjectId: string,
  targetProjectId: string,
  t: TFunction
): Promise<boolean> {
  try {
    const result = await window.electronAPI.settings.importProjectSessions({
      sourceProjectId,
      targetProjectId,
    });
    if (!result.ok) {
      addToast({
        type: 'error',
        title: t('Failed to import conversations'),
        description: result.error,
      });
      return false;
    }
    applyMovedConversations(result.moved, targetProjectId);
    if (result.skipped.length > 0) {
      const { conversations } = useSessionsStore.getState();
      addToast({
        type: 'warning',
        title: t('Imported {{moved}} conversations, skipped {{count}} running or busy', {
          moved: result.moved.length,
          count: result.skipped.length,
        }),
        description: result.skipped
          .map(({ conversationId }) => conversations[conversationId]?.title || t('Untitled'))
          .join('、'),
      });
    } else {
      addToast({
        type: result.moved.length > 0 ? 'success' : 'info',
        title:
          result.moved.length > 0
            ? t('Imported {{count}} conversations', { count: result.moved.length })
            : t('No conversations to import'),
      });
    }
    return true;
  } catch (error) {
    addToast({
      type: 'error',
      title: t('Failed to import conversations'),
      description: String(error),
    });
    return false;
  }
}
