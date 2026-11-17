import { conversationIdsToMove } from '@shared/moveConversation';
import { addToast } from '@/components/ui/toast';
import type { TFunction } from '@/i18n';
import { useSessionsStore } from '@/stores/sessions';

export { moveConversationTargets } from '@shared/moveConversation';

export function conversationMoveErrorTitle(error: string): string {
  return error === 'running' ? 'Cannot move a running conversation' : 'Failed to move conversation';
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
        ...(result.error === 'running' ? {} : { description: result.error }),
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
      return { conversations };
    });
  } catch (error) {
    addToast({
      type: 'error',
      title: t('Failed to move conversation'),
      description: String(error),
    });
  }
}
