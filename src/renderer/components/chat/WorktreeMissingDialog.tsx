import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { useSessionsStore } from '@/stores/sessions';

/**
 * resume 时发现隔离 worktree 丢失（被 prune/手动删除）的选择弹窗。
 * 设计决策：不自动重建——用户选「从记录分支重建」或「回退主工作树」。
 */
export function WorktreeMissingDialog({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const conversation = useSessionsStore((state) => state.conversations[conversationId]);
  const rebuildWorktree = useSessionsStore((state) => state.rebuildWorktree);
  const fallbackToMainWorkspace = useSessionsStore((state) => state.fallbackToMainWorkspace);
  if (!conversation?.worktreeMissing || !conversation.worktree) return null;

  return (
    <AlertDialog open>
      <AlertDialogPopup className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-base">
            {t('Isolated worktree is missing')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              'The worktree of this session was deleted. Rebuild it from branch "{{branch}}" (committed work is preserved), or fall back to the main working tree.',
              { branch: conversation.worktree.branch }
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter variant="bare">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void fallbackToMainWorkspace(conversationId)}
          >
            {t('Fall back to main working tree')}
          </Button>
          <Button
            size="sm"
            onClick={() =>
              void rebuildWorktree(conversationId).then((error) => {
                if (error) {
                  addToast({
                    type: 'error',
                    title: t('Failed to rebuild worktree'),
                    description: error,
                  });
                }
              })
            }
          >
            {t('Rebuild worktree')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
