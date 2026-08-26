import { Bot, X } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { type Conversation, useSessionsStore } from '@/stores/sessions';

/**
 * 聊天区顶部 tab 条：主会话 + 每个 coworker 一个 tab。
 * tab 只能切换,不能关闭;「解雇」是显式销毁动作(hover 出 X,带确认),避免幽灵态。
 */
export function CoworkerTabs({
  parent,
  displayedId,
  trailing,
}: {
  parent: Conversation;
  displayedId: string;
  trailing?: React.ReactNode;
}) {
  const { t } = useI18n();
  const conversations = useSessionsStore((state) => state.conversations);
  const coworkers = (parent.coworkerIds ?? [])
    .map((id) => conversations[id])
    .filter((c): c is Conversation => Boolean(c));

  const tabClass = (active: boolean) =>
    cn(
      'flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
      active ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/50'
    );

  return (
    <div className="flex items-center gap-1 border-b px-2 py-1">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        <button
          type="button"
          className={tabClass(displayedId === parent.id)}
          onClick={() => useSessionsStore.getState().selectTab(parent.id, undefined)}
        >
          <span className="max-w-48 truncate">{parent.title || t('New conversation')}</span>
        </button>
        {coworkers.map((coworker) => {
          const needsAttention = (coworker.pendingApprovals ?? []).length > 0;
          return (
            <div key={coworker.id} className="group/tab flex shrink-0 items-center">
              <button
                type="button"
                className={tabClass(displayedId === coworker.id)}
                onClick={() => useSessionsStore.getState().selectTab(parent.id, coworker.id)}
              >
                <Bot className="h-3 w-3 shrink-0" />
                <span className="max-w-32 truncate">{coworker.coworkerName ?? coworker.title}</span>
                <span
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    needsAttention
                      ? 'bg-destructive animate-pulse'
                      : coworker.status === 'running' || coworker.spawning
                        ? 'animate-pulse bg-blue-500'
                        : coworker.status === 'failed'
                          ? 'bg-destructive'
                          : 'bg-muted-foreground/30'
                  )}
                />
              </button>
              <button
                type="button"
                title={t('Dismiss coworker')}
                className="hidden rounded p-0.5 text-muted-foreground hover:text-destructive group-hover/tab:block"
                onClick={() => {
                  if (window.confirm(t('Dismiss this coworker? Its session will be closed.'))) {
                    useSessionsStore.getState().dismissCoworkerFromUI(parent.id, coworker.id);
                  }
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>
      {trailing}
    </div>
  );
}
