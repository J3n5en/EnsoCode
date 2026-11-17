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
    useSessionsStore.setState((state) => {
      const ids = new Set(conversationIdsToMove(state.conversations, conversationId));
      const conversations = { ...state.conversations };
      for (const id of ids) {
        const row = conversations[id];
        if (row) conversations[id] = { ...row, projectId: targetProjectId };
      }
      // Main 已解除 worktree 绑定：根会话回到新项目根目录
      const root = conversations[conversationId];
      if (root)
        conversations[conversationId] = {
          ...root,
          worktree: undefined,
          worktreeMissing: undefined,
        };
      const { [conversationId]: _dropped, ...worktreeStatuses } = state.worktreeStatuses;
      return { conversations, worktreeStatuses };
    });
  } catch (error) {
    addToast({
      type: 'error',
      title: t('Failed to move conversation'),
      description: String(error),
    });
  }
}
