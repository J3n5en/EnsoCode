import type { BotChat } from '@shared/types/bot';
import type { BotChatWorkspaceInput } from '@shared/types/botIpc';
import { Check, ChevronDown, Folder, FolderOpen } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useBotsStore } from '@/stores/bots';
import { useSettingsStore } from '@/stores/settings';
import { chatErrorText, localProjects, workspaceLabel } from './botText';

const sameWorkspace = (chat: BotChat, input: BotChatWorkspaceInput) =>
  chat.workspace.kind === input.kind &&
  (input.kind !== 'project' ||
    (chat.workspace.kind === 'project' && chat.workspace.projectId === input.projectId));

/** 工作区徽标：打开目录 / 改绑 Code 项目（成员会开新会话） */
export function WorkspaceMenu({ chat, className }: { chat: BotChat; className?: string }) {
  const { t } = useI18n();
  const projects = useSettingsStore((s) => s.projects);
  const bots = useBotsStore((s) => s.bots);
  const upsertChat = useBotsStore((s) => s.upsertChat);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<BotChatWorkspaceInput | null>(null);
  const label = workspaceLabel(chat, projects, bots, t);
  const options: { input: BotChatWorkspaceInput; label: string }[] = [
    chat.kind === 'direct'
      ? { input: { kind: 'member-home' }, label: t("Member's own workspace") }
      : { input: { kind: 'chat-home' }, label: t('Standalone workspace') },
    ...localProjects(projects).map((project) => ({
      input: { kind: 'project' as const, projectId: project.id },
      label: project.alias || project.name,
    })),
  ];

  const apply = async (input: BotChatWorkspaceInput) => {
    const result = await window.electronAPI.bots.updateChat({
      chatId: chat.id,
      expectedVersion: chat.version,
      workspace: input,
    });
    if (result.ok) upsertChat(result.chat);
    else addToast({ type: 'error', title: chatErrorText(result.error, t) });
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className={cn(
            'flex h-7 min-w-0 max-w-56 items-center gap-1.5 rounded-md border px-2 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground',
            className
          )}
          title={t('Workspace')}
        >
          <Folder className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{label}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </PopoverTrigger>
        <PopoverPopup
          side="bottom"
          align="end"
          className="w-64 [&_[data-slot=popover-viewport]]:p-1"
        >
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              void window.electronAPI.bots.openWorkspace({ chatId: chat.id }).then((result) => {
                if (!result.ok) addToast({ type: 'error', title: chatErrorText(result.error, t) });
              });
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
          >
            <FolderOpen className="h-3.5 w-3.5 shrink-0" />
            {t('Open folder')}
          </button>
          <div className="my-1 border-t" />
          <div className="px-2 py-1 text-[11px] text-muted-foreground">{t('Change workspace')}</div>
          <div className="max-h-64 overflow-y-auto">
            {options.map((option) => {
              const selected = sameWorkspace(chat, option.input);
              return (
                <button
                  key={option.input.kind === 'project' ? option.input.projectId : option.input.kind}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    if (!selected) setPending(option.input);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {selected && <Check className="h-3.5 w-3.5 shrink-0 text-brand" />}
                </button>
              );
            })}
          </div>
        </PopoverPopup>
      </Popover>
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(value) => !value && setPending(null)}
        title={t('Change workspace?')}
        description={t(
          'Members start new conversations in the new workspace. Earlier conversations stay readable in history.'
        )}
        confirmLabel={t('Change')}
        onConfirm={() => {
          const input = pending;
          setPending(null);
          if (input) void apply(input);
        }}
      />
    </>
  );
}
