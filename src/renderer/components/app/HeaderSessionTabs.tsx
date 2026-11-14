import { conversationDotTone } from '@shared/conversationDotTone';
import { MessageSquare, Plus, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ConversationStatusIndicator } from '@/components/chat/ConversationStatusIndicator';
import { useI18n } from '@/i18n';
import { formatBinding } from '@/lib/keybindings';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import {
  dismissHeaderTab,
  restoreHeaderTab,
  useSessionSwitchState,
} from '@/stores/sessions/sessionSwitchState';
import {
  type SidebarDirectoryEntry,
  selectSidebarConversations,
} from '@/stores/sessions/sidebarDirectory';

/** 顶栏空白处的活跃会话标签：左右边界跟随下方主卡片，编号与侧栏 ⌘1–9 同源 */
export function HeaderSessionTabs({ onNew }: { onNew: () => void }) {
  const { t } = useI18n();
  const ids = useSessionSwitchState((s) => s.activeIds);
  const slots = useSessionSwitchState((s) => s.slots);
  const modHeld = useSessionSwitchState((s) => s.modHeld);
  const conversations = useSessionsStore((s) => selectSidebarConversations(s.conversations));
  const activeId = useSessionsStore((s) => s.activeId);
  const selectConversation = useSessionsStore((s) => s.selectConversation);
  const rootRef = useRef<HTMLDivElement>(null);
  const [inset, setInset] = useState({ left: 0, right: 0 });

  useEffect(() => {
    useSessionSwitchState.setState({ headerMounted: true });
    return () => useSessionSwitchState.setState({ headerMounted: false });
  }, []);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const main = document.querySelector<HTMLElement>('[data-enso="main"]');
    if (!root || !main) return;
    const update = () => {
      const box = root.getBoundingClientRect();
      const card = main.getBoundingClientRect();
      const left = Math.max(0, Math.round(card.left - box.left));
      const right = Math.max(0, Math.round(box.right - card.right));
      setInset((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(main);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!activeId) return;
    restoreHeaderTab(activeId);
    rootRef.current
      ?.querySelector(`[data-session-tab="${CSS.escape(activeId)}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);

  const tabIds = ids.filter((id) => conversations[id]);
  const closeTab = (id: string) => {
    if (id === activeId) {
      const index = tabIds.indexOf(id);
      const next = tabIds[index + 1] ?? tabIds[index - 1];
      if (!next) return;
      selectConversation(next);
    }
    dismissHeaderTab(id);
  };
  const closable = (id: string) => id !== activeId || tabIds.length > 1;
  return (
    <div
      ref={rootRef}
      data-enso="header-session-tabs"
      className="flex h-full min-w-0 flex-1 items-center gap-1"
      style={{ paddingLeft: inset.left, paddingRight: inset.right }}
    >
      {tabIds.length > 0 && (
        <>
          <div className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
            {tabIds.map((id) => {
              const index = slots.indexOf(id);
              return (
                <SessionTab
                  key={id}
                  id={id}
                  conversation={conversations[id]}
                  active={id === activeId}
                  hint={
                    modHeld && index >= 0 && index < 9
                      ? formatBinding(`mod+${index + 1}`)
                      : undefined
                  }
                  untitled={t('New conversation')}
                  closeLabel={t('Remove from title bar')}
                  onSelect={selectConversation}
                  onClose={closable(id) ? closeTab : undefined}
                />
              );
            })}
          </div>
          <button
            type="button"
            className="no-drag flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            onClick={onNew}
            title={t('New conversation')}
            aria-label={t('New conversation')}
          >
            <Plus className="size-3.5" />
          </button>
        </>
      )}
    </div>
  );
}

function SessionTab({
  id,
  conversation,
  active,
  hint,
  untitled,
  closeLabel,
  onSelect,
  onClose,
}: {
  id: string;
  conversation: SidebarDirectoryEntry;
  active: boolean;
  hint?: string;
  untitled: string;
  closeLabel: string;
  onSelect: (id: string) => void;
  onClose?: (id: string) => void;
}) {
  const tone =
    (conversation.pendingApprovals?.length ?? 0) > 0
      ? 'attention'
      : conversationDotTone({
          status: conversation.status,
          spawning: conversation.spawning,
          unread: conversation.unread,
          pendingAskCount: conversation.pendingAsks?.length ?? 0,
          hasRunningChild: conversation.hasRunningChild,
        });
  const title = conversation.title || untitled;
  return (
    <div
      data-session-tab={id}
      data-active={active || undefined}
      className={cn(
        'group/tab no-drag box-border flex h-7 w-[202.5px] min-w-[80px] shrink items-center rounded-md border-[0.5px] border-foreground/10 text-[0.8125rem] transition-colors',
        active
          ? 'bg-background text-foreground'
          : 'bg-foreground/[0.04] text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground'
      )}
      onAuxClick={(event) => {
        if (event.button === 1 && onClose) onClose(id);
      }}
    >
      <button
        type="button"
        className={cn(
          'flex h-full min-w-0 flex-1 items-center gap-1.5 pl-2.5',
          onClose ? 'pr-1' : 'pr-2.5'
        )}
        onClick={() => onSelect(id)}
        title={title}
      >
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          {tone === 'idle' ? (
            <MessageSquare className="size-3" />
          ) : (
            <ConversationStatusIndicator tone={tone} size="sm" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-left">{title}</span>
        {hint && (
          <span className="shrink-0 text-[10px] leading-none text-subtle-foreground tabular-nums">
            {hint}
          </span>
        )}
      </button>
      {onClose && (
        <button
          type="button"
          className={cn(
            'mr-1 flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-opacity hover:bg-foreground/[0.08] hover:text-foreground focus-visible:opacity-100',
            active ? 'opacity-100' : 'opacity-0 group-hover/tab:opacity-100'
          )}
          onClick={() => onClose(id)}
          title={closeLabel}
          aria-label={closeLabel}
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}
