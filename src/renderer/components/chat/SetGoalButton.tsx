import { Target } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/i18n';
import { useSessionsStore } from '@/stores/sessions';

/** Composer toolbar 的目标入口:设定后 agent 空闲即自动续跑 */
export function SetGoalButton({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');

  const start = () => {
    if (!text.trim()) return;
    useSessionsStore.getState().setGoal(conversationId, text.trim());
    setText('');
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        title={t('Set a goal')}
        onClick={() => setOpen(true)}
        className="flex h-6 items-center gap-1 rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Target className="h-3.5 w-3.5" />
      </button>
      {open && (
        <Dialog open onOpenChange={(value) => !value && setOpen(false)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{t('Session goal')}</DialogTitle>
            </DialogHeader>
            <DialogPanel className="space-y-3">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                // biome-ignore lint/a11y/noAutofocus: 弹窗即输入是预期交互
                autoFocus
                placeholder={t('What should the agent keep working toward?')}
                className="w-full rounded-md border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
              />
              <div className="h-1" />
            </DialogPanel>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                {t('Cancel')}
              </Button>
              <Button onClick={start} disabled={!text.trim()}>
                {t('Start')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
