import type { BotChat } from '@shared/types/bot';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { useBotsStore } from '@/stores/bots';
import { useSettingsStore } from '@/stores/settings';
import { FieldLabel } from './BotFields';
import { chatErrorText, chatTitle, cloneTitle, workspaceLabel } from './botText';

/** 克隆群聊：复制成员、群主与分派；记录、笔记、例行、任务板、群记忆都不带 */
export function CloneGroupDialog({
  chat,
  onOpenChange,
}: {
  chat: BotChat | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const bots = useBotsStore((s) => s.bots);
  const chats = useBotsStore((s) => s.chats);
  const projects = useSettingsStore((s) => s.projects);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 每次打开重置
  useEffect(() => {
    if (!chat) return;
    const taken = chats.filter((item) => item.kind === 'group').map((item) => item.title);
    setTitle(cloneTitle(t('{{title}} copy', { title: chatTitle(chat, bots, t) }), taken));
    setBusy(false);
  }, [chat?.id]);

  if (!chat) return null;
  const name = (id: string | null) => bots.find((bot) => bot.id === id)?.name ?? '—';
  const routing = `${
    chat.routing.mode === 'smart' ? t('Smart pick') : t('Group owner replies')
  } · ${t('Relay {{hops}} · {{turns}} replies each', {
    hops: chat.routing.maxHops,
    turns: chat.routing.maxTurnsPerBot,
  })}`;

  const clone = async () => {
    const value = title.trim();
    if (!value) return;
    setBusy(true);
    try {
      const result = await window.electronAPI.bots.cloneChat({ chatId: chat.id, title: value });
      if (!result.ok) {
        addToast({ type: 'error', title: chatErrorText(result.error, t) });
        return;
      }
      const store = useBotsStore.getState();
      store.upsertChat(result.chat);
      store.setView({ kind: 'chat', chatId: result.chat.id });
      void store.loadLatest(result.chat.id);
      addToast({ type: 'success', title: t('Cloned. The chat history is empty.') });
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Clone group chat')}</DialogTitle>
          <DialogDescription>
            {t(
              'Copies the setup of “{{title}}”. The original stays as is; replies in progress are not stopped.',
              { title: chatTitle(chat, bots, t) }
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4 text-sm">
          <div>
            <FieldLabel>{t('Group name')}</FieldLabel>
            <Input
              value={title}
              autoFocus
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && void clone()}
            />
          </div>
          <div className="space-y-1">
            <FieldLabel>{t('Will copy')}</FieldLabel>
            <p>
              <span className="text-muted-foreground">{t('Members')}：</span>
              {chat.members.map(name).join('、')}
            </p>
            <p>
              <span className="text-muted-foreground">{t('Owner')}：</span>
              {name(chat.bossBotId)}
            </p>
            <p>
              <span className="text-muted-foreground">{t('Routing')}：</span>
              {routing}
            </p>
            <p>
              <span className="text-muted-foreground">{t('Workspace')}：</span>
              {chat.workspace.kind === 'project'
                ? t('Same project: {{name}}', {
                    name: workspaceLabel(chat, projects, bots, t),
                  })
                : t('A new empty folder, separate from the original')}
            </p>
          </div>
          <div className="space-y-1">
            <FieldLabel>{t('Not copied')}</FieldLabel>
            <p className="text-muted-foreground">
              {t('Chat history, group notes, routines, task board and group memory')}
            </p>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('Cancel')}
          </Button>
          <Button size="sm" disabled={!title.trim() || busy} onClick={() => void clone()}>
            {t('Clone')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
