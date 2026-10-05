import type { BotProfile, Delegation } from '@shared/types/bot';
import type { BotInboxItem } from '@shared/types/botIpc';
import { Inbox } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n';
import { protectedActionLabel } from '@/lib/protectedAction';
import { toolLabel } from '@/lib/toolLabels';
import { useBotsStore } from '@/stores/bots';
import { inboxSections } from '@/stores/bots/inbox';
import type { PendingItem } from '@/stores/bots/selectors';
import { usePendingMemoryWrites } from '@/stores/memoryReview';
import { BotAvatar } from './BotAvatar';
import { chatTitle } from './botText';
import { DelegationBadge, failureText, retryDelegation } from './DelegationCard';
import { MemoryWriteCard } from './MemoryWriteCard';
import { RoutineAlertCard } from './RoutineCards';
import { SessionHistoryDialog } from './SessionHistoryDialog';
import { QuietFor } from './SilenceNote';

/** 收件箱：Main 汇总的审批、提问、预算、例程、静默与中断委派，另加待批准的记忆写入 */
export function BotInbox() {
  const { t } = useI18n();
  const inbox = useBotsStore((s) => s.inbox);
  const chats = useBotsStore((s) => s.chats);
  const bots = useBotsStore((s) => s.bots);
  const delegations = useBotsStore((s) => s.delegations);
  const routines = useBotsStore((s) => s.routines);
  const [history, setHistory] = useState<{ id: string; title: string; bot?: BotProfile } | null>(
    null
  );
  const sections = useMemo(
    () => inboxSections(inbox, { routines, delegations }),
    [inbox, routines, delegations]
  );
  const memoryWrites = usePendingMemoryWrites();
  const byId = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const chatName = (chatId: string | null) => {
    const chat = chats.find((entry) => entry.id === chatId);
    return chat ? chatTitle(chat, bots, t) : '';
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header className="flex h-[52px] shrink-0 items-center gap-2.5 border-b px-4">
        <div className="font-semibold text-sm">{t('Inbox')}</div>
        <div className="text-muted-foreground text-xs">
          {t('Everything members are waiting on you for')}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl space-y-2.5 px-6 py-4">
          {sections.count === 0 && memoryWrites.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
              <Inbox className="h-6 w-6" />
              <p className="text-sm">{t('Nothing needs your attention')}</p>
            </div>
          )}
          {sections.pending.map((item) => (
            <InboxCard
              key={`${item.conversationId}:${item.request.requestId}`}
              item={item}
              bot={byId.get(item.botId)}
              owner={item.delegation ? byId.get(item.delegation.parentBotId) : undefined}
              chatName={chatName(item.chatId)}
            />
          ))}
          {sections.budgets.map((item) => (
            <BudgetCard key={item.key} item={item} bot={byId.get(item.botId ?? '')} />
          ))}
          {memoryWrites.map((write) => (
            <MemoryWriteCard
              key={write.id}
              write={write}
              bot={write.botId ? byId.get(write.botId) : undefined}
              chatName={chatName(write.chatId)}
            />
          ))}
          {sections.routines.map((alert) => (
            <RoutineAlertCard key={alert.routine.id} alert={alert} />
          ))}
          {sections.silences.map((item) => (
            <SilenceCard
              key={item.key}
              item={item}
              bot={byId.get(item.botId ?? '')}
              chatName={chatName(item.chatId)}
            />
          ))}
          {sections.interrupted.length > 0 && (
            <div className="pt-3 font-medium text-muted-foreground text-xs">
              {t('Interrupted delegations')}
            </div>
          )}
          {sections.interrupted.map(({ item, record }) => (
            <InterruptedCard
              key={item.key}
              inboxKey={item.key}
              record={record}
              bots={byId}
              chatName={chatName(record.chatId)}
              onOpen={(title) =>
                setHistory({
                  id: record.childConversationId,
                  title,
                  bot: byId.get(record.targetBotId),
                })
              }
            />
          ))}
        </div>
      </div>
      <SessionHistoryDialog
        conversationId={history?.id ?? null}
        title={history?.title ?? ''}
        speaker={
          history?.bot ? { name: history.bot.name, color: history.bot.avatar.color } : undefined
        }
        onClose={() => setHistory(null)}
      />
    </div>
  );
}

/** 静默看门狗：只提示不中断，成员恢复输出后自动消失 */
function SilenceCard({
  item,
  bot,
  chatName,
}: {
  item: BotInboxItem;
  bot: BotProfile | undefined;
  chatName: string;
}) {
  const { t } = useI18n();
  const setView = useBotsStore((s) => s.setView);
  const dismiss = useBotsStore((s) => s.dismissInbox);
  const name = bot?.name ?? t('Deleted member');
  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <BotAvatar bot={bot} size="sm" busy />
        <span className="text-foreground">{name}</span>
        {chatName && <span>· {chatName}</span>}
        {item.delegationId && <span>· {t('Delegation')}</span>}
        <span className="rounded bg-warning/20 px-1.5 text-[11px] text-warning">
          <QuietFor since={item.since ?? item.createdAt} />
        </span>
      </div>
      <div className="mt-2 text-sm">
        {t('{{name}} is still running but has produced no output for a while', { name })}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center justify-end gap-1.5">
        <Button size="xs" variant="ghost" onClick={() => void dismiss(item.key)}>
          {t('Dismiss')}
        </Button>
        {item.chatId && (
          <Button
            size="xs"
            variant="outline"
            onClick={() => item.chatId && setView({ kind: 'chat', chatId: item.chatId })}
          >
            {t('Go to chat')}
          </Button>
        )}
      </div>
    </div>
  );
}

function BudgetCard({ item, bot }: { item: BotInboxItem; bot: BotProfile | undefined }) {
  const { t } = useI18n();
  const dismiss = useBotsStore((s) => s.dismissInbox);
  const openDirect = useBotsStore((s) => s.openDirect);
  const name = bot?.name ?? t('Deleted member');
  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <BotAvatar bot={bot} size="sm" />
        <span className="text-foreground">{name}</span>
        <span className="rounded bg-destructive/15 px-1.5 text-[11px] text-destructive">
          {t('Budget')}
        </span>
      </div>
      <div className="mt-2 text-sm">{t("{{name}}'s budget for today is used up", { name })}</div>
      <div className="mt-1 text-muted-foreground text-xs">
        {item.budget?.reason === 'cost'
          ? t('Daily cost limit reached. New messages are refused until local midnight.')
          : t('Daily token limit reached. New messages are refused until local midnight.')}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center justify-end gap-1.5">
        <Button size="xs" variant="ghost" onClick={() => void dismiss(item.key)}>
          {t('Dismiss')}
        </Button>
        {bot && (
          <Button size="xs" variant="outline" onClick={() => void openDirect(bot.id)}>
            {t('Go to chat')}
          </Button>
        )}
      </div>
    </div>
  );
}

function InterruptedCard({
  inboxKey,
  record,
  bots,
  chatName,
  onOpen,
}: {
  inboxKey: string;
  record: Delegation;
  bots: Map<string, BotProfile>;
  chatName: string;
  onOpen: (title: string) => void;
}) {
  const { t } = useI18n();
  const setView = useBotsStore((s) => s.setView);
  const dismiss = useBotsStore((s) => s.dismissInbox);
  const from = bots.get(record.parentBotId);
  const to = bots.get(record.targetBotId);
  const fromName = from?.name ?? t('Deleted member');
  const toName = to?.name ?? t('Deleted member');
  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
        <BotAvatar bot={from} size="xs" />
        <span className="text-foreground">{fromName}</span>
        <span>→</span>
        <BotAvatar bot={to} size="xs" />
        <span className="text-foreground">{toName}</span>
        <span>· {t('Delegation')}</span>
        {chatName && <span>· {chatName}</span>}
        <DelegationBadge state={record.state} interrupted />
      </div>
      <div className="mt-2 line-clamp-3 text-sm">{record.task}</div>
      <div className="mt-1 text-muted-foreground text-xs">{failureText(record, t)}</div>
      <div className="mt-2.5 flex flex-wrap items-center justify-end gap-1.5">
        <Button size="xs" variant="ghost" onClick={() => void dismiss(inboxKey)}>
          {t('Dismiss')}
        </Button>
        {record.chatId && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => record.chatId && setView({ kind: 'chat', chatId: record.chatId })}
          >
            {t('Go to chat')}
          </Button>
        )}
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            onOpen(t('{{from}} → {{to}} · Delegation', { from: fromName, to: toName }))
          }
        >
          {t('View conversation')}
        </Button>
        <Button size="xs" onClick={() => retryDelegation(record.id, t)}>
          {t('Retry')}
        </Button>
      </div>
    </div>
  );
}

function InboxCard({
  item,
  bot,
  owner,
  chatName,
}: {
  item: PendingItem;
  bot: BotProfile | undefined;
  owner: BotProfile | undefined;
  chatName: string;
}) {
  const { t } = useI18n();
  const setView = useBotsStore((s) => s.setView);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const run = (task: Promise<unknown>) => {
    setBusy(true);
    void task.finally(() => setBusy(false));
  };
  const approve = (decision: 'allow' | 'allowSession' | 'deny') =>
    run(
      window.electronAPI.agent.respondApproval(
        item.conversationId,
        item.request.requestId,
        decision
      )
    );
  const reply = (text: string) =>
    text.trim() &&
    run(
      window.electronAPI.agent.respondAsk(item.conversationId, item.request.requestId, text.trim())
    );
  const reviewing = item.kind === 'approval' && item.request.phase === 'reviewing';

  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <BotAvatar bot={bot} size="sm" />
        <span className="text-foreground">
          {item.delegation
            ? t('{{name}} on behalf of {{owner}}', {
                name: bot?.name ?? t('Deleted member'),
                owner: owner?.name ?? t('Deleted member'),
              })
            : (bot?.name ?? t('Deleted member'))}
        </span>
        {chatName && <span>· {chatName}</span>}
        <span
          className={
            item.kind === 'approval'
              ? 'rounded bg-warning/20 px-1.5 text-[11px] text-warning'
              : 'rounded bg-info/15 px-1.5 text-[11px] text-info'
          }
        >
          {item.kind === 'approval' ? t('Approval') : t('Question')}
        </span>
        {item.kind === 'approval' && item.request.protected && (
          <span className="rounded bg-destructive/15 px-1.5 text-[11px] text-destructive">
            {protectedActionLabel(item.request.protected, t)}
          </span>
        )}
      </div>
      {item.kind === 'approval' ? (
        <div className="mt-2 text-sm">
          {toolLabel(item.request.tool, t)}
          <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded-md bg-muted/60 px-2 py-1.5 font-mono text-xs">
            {item.request.summary}
          </pre>
        </div>
      ) : (
        <div className="mt-2 whitespace-pre-wrap text-sm">{item.request.question}</div>
      )}
      <div className="mt-2.5 flex flex-wrap items-center justify-end gap-1.5">
        <Button
          size="xs"
          variant="ghost"
          onClick={() => setView({ kind: 'chat', chatId: item.chatId })}
        >
          {t('Go to chat')}
        </Button>
        {item.kind === 'approval' ? (
          reviewing ? (
            <span className="text-muted-foreground text-xs">{t('Assistant reviewing…')}</span>
          ) : (
            <>
              <Button size="xs" variant="outline" disabled={busy} onClick={() => approve('deny')}>
                {t('Deny')}
              </Button>
              {!item.request.protected && (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => approve('allowSession')}
                >
                  {t('Always allow in this session')}
                </Button>
              )}
              <Button size="xs" disabled={busy} onClick={() => approve('allow')}>
                {t('Allow')}
              </Button>
            </>
          )
        ) : (
          <>
            {item.request.options?.map((option) => (
              <Button
                key={option}
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => reply(option)}
              >
                {option}
              </Button>
            ))}
            <Input
              className="h-7 w-48"
              value={answer}
              placeholder={t('Custom answer…')}
              onChange={(event) => setAnswer(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && reply(answer)}
            />
            <Button size="xs" disabled={busy || !answer.trim()} onClick={() => reply(answer)}>
              {t('Reply')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
