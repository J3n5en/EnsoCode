import { agentTypeDisplayName } from '@shared/builtinAgents';
import { childRunLabel } from '@shared/childRunLabel';
import type { ChildRunSummary } from '@shared/types/agent';
import { History } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SessionHistoryDialog } from '@/components/bots/SessionHistoryDialog';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import { useI18n } from '@/i18n';
import { formatRelativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';
import { ConversationStatusIndicator } from './ConversationStatusIndicator';

export function ChildRunsButton({
  parentId,
  coworkerIds,
}: {
  parentId: string;
  coworkerIds: readonly string[];
}) {
  const { t, locale } = useI18n();
  const customAgentTypes = useSettingsStore((state) => state.agentTypes);
  const [items, setItems] = useState<ChildRunSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState<ChildRunSummary | null>(null);
  const ticket = useRef(0);
  const coworkerKey = coworkerIds.join('\0');

  const refresh = useCallback(() => {
    const current = ++ticket.current;
    return window.electronAPI.agent.listChildRuns(parentId).then((result) => {
      if (current !== ticket.current) return;
      setItems(result.ok ? result.items : []);
    });
  }, [parentId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: coworkerKey 是 spawn/dismiss 后的重拉信号
  useEffect(() => {
    void refresh();
  }, [refresh, coworkerKey]);

  const read = useCallback(
    (beforeIndex?: number) => {
      const childId = viewing?.childId;
      if (!childId) {
        return Promise.resolve({
          ok: false as const,
          code: 'not-found' as const,
          error: 'No child run.',
        });
      }
      return window.electronAPI.agent.readChildRun(parentId, childId, beforeIndex);
    },
    [parentId, viewing?.childId]
  );

  const activate = (item: ChildRunSummary) => {
    if (!item.available) return;
    setOpen(false);
    if (item.live && coworkerIds.includes(item.childId)) {
      useSessionsStore.getState().selectTab(parentId, item.childId);
      return;
    }
    setViewing(item);
  };

  return (
    <>
      {items.length > 0 && (
        <Popover
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (next) void refresh();
          }}
        >
          <PopoverTrigger
            className="flex h-6 shrink-0 items-center justify-center gap-1 rounded-full px-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={t('Subagent history')}
            title={t('Subagent history')}
          >
            <History className="size-3.5" />
            <span className="text-[11px] tabular-nums leading-none">{items.length}</span>
          </PopoverTrigger>
          <PopoverPopup align="end" className="w-96 [&_[data-slot=popover-viewport]]:p-1">
            <ul className="flex flex-col">
              {items.map((item) => {
                const label = childRunLabel(item);
                return (
                  <li key={item.childId}>
                    <button
                      type="button"
                      disabled={!item.available}
                      title={label}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                        item.available
                          ? 'hover:bg-muted'
                          : 'cursor-default text-muted-foreground opacity-40'
                      )}
                      onClick={() => activate(item)}
                    >
                      <span className="min-w-0 flex-1 truncate">{label}</span>
                      {item.agentType && (
                        <span className="shrink-0 text-muted-foreground text-xs">
                          {agentTypeDisplayName(item.agentType, customAgentTypes)}
                        </span>
                      )}
                      <span className="shrink-0 text-muted-foreground text-xs">
                        {formatRelativeTime(item.startedAt, locale)}
                      </span>
                      {item.live && (
                        <ConversationStatusIndicator
                          tone="running"
                          size="sm"
                          title={t('Running')}
                        />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </PopoverPopup>
        </Popover>
      )}
      <SessionHistoryDialog
        conversationId={viewing?.childId ?? null}
        title={viewing ? childRunLabel(viewing) : ''}
        read={read}
        botSession={false}
        onClose={() => setViewing(null)}
      />
    </>
  );
}
