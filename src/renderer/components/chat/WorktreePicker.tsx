import type { WorktreeStatus } from '@shared/types/worktree';
import { Check, ChevronDown, GitBranch, House } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { worktreeHasPendingWork } from '@/stores/sessions/worktree';
import { useSettingsStore } from '@/stores/settings';

/**
 * composer 工具行的工作区选择（紧跟预设选择器）：本地工作区 / 隔离 worktree。
 * fresh 会话直接绑定；已开聊会话走完整迁移语义（主树干净检查 + release + 迁移提醒）；
 * 切回本地 = 清理 worktree，有未落地成果时弹确认（分支保留）。
 */
export function WorktreePicker({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const conversation = useSessionsStore((state) => state.conversations[conversationId]);
  const moveConversationToWorktree = useSessionsStore((state) => state.moveConversationToWorktree);
  const cleanupWorktree = useSessionsStore((state) => state.cleanupWorktree);
  const refreshWorktreeStatuses = useSessionsStore((state) => state.refreshWorktreeStatuses);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingCleanup, setPendingCleanup] = useState<WorktreeStatus | null>(null);

  const project = useSettingsStore((state) =>
    conversation ? state.projects.find((p) => p.id === conversation.projectId) : undefined
  );
  if (!conversation || conversation.parentId) return null;
  // ssh 远程项目没有本机 git worktree可用,main 也会拒绝——入口直接隐藏
  if (project?.kind === 'ssh') return null;
  const isolated = Boolean(conversation.worktree);

  const runCleanup = async () => {
    const error = await cleanupWorktree(conversationId);
    if (error) {
      addToast({ type: 'error', title: t('Failed to clean up worktree'), description: error });
    } else {
      void refreshWorktreeStatuses();
    }
  };

  const handleIsolate = async () => {
    setBusy(true);
    try {
      const error = await moveConversationToWorktree(conversationId);
      if (error) {
        addToast({ type: 'error', title: t('Failed to move to worktree'), description: error });
      } else {
        void refreshWorktreeStatuses();
      }
    } finally {
      setBusy(false);
    }
  };

  const handleLocal = async () => {
    setBusy(true);
    try {
      const status = await window.electronAPI.worktree.status(conversationId);
      if (status.ok && worktreeHasPendingWork(status.value)) {
        setPendingCleanup(status.value);
        return;
      }
      await runCleanup();
    } finally {
      setBusy(false);
    }
  };

  const options = [
    {
      id: 'local',
      selected: !isolated,
      icon: <House className="h-3.5 w-3.5 shrink-0" />,
      name: t('Local workspace'),
      hint: t('Work directly in the main working tree'),
      onSelect: () => {
        if (isolated) void handleLocal();
      },
    },
    {
      id: 'worktree',
      selected: isolated,
      icon: <GitBranch className="h-3.5 w-3.5 shrink-0" />,
      name: t('Isolated worktree'),
      hint: isolated
        ? conversation.worktree?.branch
        : t('Run this session on its own git worktree'),
      onSelect: () => {
        if (!isolated) void handleIsolate();
      },
    },
  ];

  const cleanupWarning = (): string => {
    const parts: string[] = [];
    if (pendingCleanup?.dirty) parts.push(t('uncommitted changes will be lost'));
    if (pendingCleanup && pendingCleanup.ahead > 0)
      parts.push(t('{{n}} unmerged commits (branch is kept)', { n: pendingCleanup.ahead }));
    return parts.join('; ');
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          disabled={busy}
          className="flex h-7 max-w-44 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          {isolated ? (
            <GitBranch className="h-3 w-3 shrink-0" />
          ) : (
            <House className="h-3 w-3 shrink-0" />
          )}
          <span className="truncate">
            {isolated ? (conversation.worktree?.branch ?? t('Isolated worktree')) : t('Local')}
          </span>
          <ChevronDown className="h-3 w-3 shrink-0" />
        </PopoverTrigger>
        <PopoverPopup
          side="top"
          align="start"
          className="w-64 [&_[data-slot=popover-viewport]]:p-1"
        >
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => {
                option.onSelect();
                setOpen(false);
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                option.selected
                  ? 'bg-primary/10 text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              {option.icon}
              <span className="min-w-0 flex-1">
                <span className="block truncate">{option.name}</span>
                {option.hint && (
                  <span className="block truncate text-xs text-muted-foreground">
                    {option.hint}
                  </span>
                )}
              </span>
              {option.selected && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
            </button>
          ))}
        </PopoverPopup>
      </Popover>
      <ConfirmDialog
        open={pendingCleanup !== null}
        onOpenChange={(dialogOpen) => {
          if (!dialogOpen) setPendingCleanup(null);
        }}
        title={t('Clean up worktree?')}
        description={t(
          'The isolated worktree has unfinished work: {{warning}}. The session falls back to the main working tree.',
          { warning: cleanupWarning() }
        )}
        confirmLabel={t('Clean up')}
        onConfirm={() => {
          setPendingCleanup(null);
          void runCleanup();
        }}
      />
    </>
  );
}
