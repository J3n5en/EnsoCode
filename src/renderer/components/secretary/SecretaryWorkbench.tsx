import type { SecretaryTodo, SecretaryTodoMutate } from '@shared/types/secretary';
import { Coffee, Pencil, Plus, Send, ShieldAlert, Square, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ApprovalBar } from '@/components/chat/ApprovalBar';
import { AskBar } from '@/components/chat/AskBar';
import { useI18n } from '@/i18n';
import { formatClock, formatRelativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { useSecretaryStore } from '@/stores/secretary';
import { useSessionsStore } from '@/stores/sessions';
import { SecretaryProposalRow } from './SecretaryProposalRow';
import {
  type FeedEvent,
  type FeedTone,
  type SecretarySessionCard,
  secretaryDigest,
  sessionFeed,
} from './secretaryDigest';

function mutateTodo(request: SecretaryTodoMutate): void {
  void window.electronAPI.secretary.mutateTodo(request);
}

/** 今天只给钟点，更早给相对时间：时间线上一眼看出新旧 */
function feedTime(at: number, locale: string, now: number): string {
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  return sameDay ? formatClock(at, locale) : formatRelativeTime(at, locale, now);
}

const TONE_DOT: Record<FeedTone, string> = {
  ok: 'border-success bg-success',
  warn: 'border-warning bg-warning',
  bad: 'border-destructive bg-destructive',
  run: 'border-success bg-background',
  idle: 'border-subtle-foreground bg-background',
};

const ACTION_CLASS =
  'flex size-5 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

function Stat({ value, label, warn }: { value: number; label: string; warn?: boolean }) {
  return (
    <div
      data-enso="secretary-stat"
      data-warn={warn || undefined}
      className={cn(
        'rounded-[10px] border px-2.5 py-2',
        warn ? 'border-warning/40 bg-warning/5' : 'border-border'
      )}
    >
      <div className="text-[18px] font-semibold tabular-nums">{value}</div>
      <div className="text-[11.5px] text-muted-foreground">{label}</div>
    </div>
  );
}

/** 需要你处理的会话：就地审批与提问，主按钮打开会话 */
function AttentionCard({ card }: { card: SecretarySessionCard }) {
  const { t, locale } = useI18n();
  const approvals = useSessionsStore((s) => s.conversations[card.conversationId]?.pendingApprovals);
  const asks = useSessionsStore((s) => s.conversations[card.conversationId]?.pendingAsks);
  const selectConversation = useSessionsStore((s) => s.selectConversation);
  const [stopping, setStopping] = useState(false);
  const stop = () => {
    setStopping(true);
    void window.electronAPI.agent.abort(card.conversationId).finally(() => setStopping(false));
  };
  return (
    <div
      data-enso="secretary-card"
      data-kind="session"
      data-state={card.state}
      className="rounded-xl border border-warning/40 bg-warning/5 px-3 py-2.5"
    >
      <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-warning">
        <ShieldAlert className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t(sessionFeed(card).label)}</span>
        <span className="shrink-0 font-normal text-subtle-foreground">
          {formatRelativeTime(card.updatedAt, locale)}
        </span>
      </div>
      <p className="mt-1 text-[13px] font-medium">{card.title}</p>
      <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <span className="shrink-0 rounded bg-muted px-1.5 text-[11px]">{card.projectName}</span>
        {card.lastText && <span className="line-clamp-1">{card.lastText}</span>}
      </div>
      {approvals && approvals.length > 0 && (
        <div className="mt-2">
          <ApprovalBar
            approvals={approvals}
            onRespond={(requestId, decision) =>
              void window.electronAPI.agent.respondApproval(
                card.conversationId,
                requestId,
                decision
              )
            }
          />
        </div>
      )}
      {asks && asks.length > 0 && (
        <div className="mt-2">
          <AskBar
            asks={asks}
            autoFocus={false}
            onAnswer={(requestId, answer) =>
              void window.electronAPI.agent.respondAsk(card.conversationId, requestId, answer)
            }
          />
        </div>
      )}
      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => selectConversation(card.conversationId)}
          className="rounded-md bg-primary px-2.5 py-1 text-[12px] text-primary-foreground transition-colors hover:bg-primary/90"
        >
          {t('Open session')}
        </button>
        {card.state === 'running' && (
          <button
            type="button"
            disabled={stopping}
            onClick={stop}
            className="rounded-md px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            {t('Stop')}
          </button>
        )}
      </div>
    </div>
  );
}

function TodoRow({ todo }: { todo: SecretaryTodo }) {
  const { t, locale } = useI18n();
  const [draft, setDraft] = useState<string | null>(null);
  if (draft !== null) {
    return (
      <div className="rounded-lg border border-border px-2.5 py-1.5">
        <input
          // biome-ignore lint/a11y/noAutofocus: 点编辑就是要改这条
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setDraft(null);
            if (event.key !== 'Enter') return;
            const text = draft.trim();
            if (text) mutateTodo({ action: 'update', todoId: todo.id, text });
            setDraft(null);
          }}
          className="w-full bg-transparent text-[13px] outline-none"
        />
      </div>
    );
  }
  return (
    <div
      data-enso="secretary-todo"
      className="group flex items-start gap-2.5 rounded-lg px-1.5 py-1.5 transition-colors hover:bg-foreground/5"
    >
      <button
        type="button"
        data-enso="secretary-todo-done"
        aria-label={t('Mark done')}
        onClick={() => mutateTodo({ action: 'update', todoId: todo.id, done: true })}
        className="mt-[3px] size-3.5 shrink-0 rounded-full border-[1.5px] border-foreground/30 transition-colors hover:border-success hover:bg-success/20"
      />
      <div className="min-w-0 flex-1">
        <p className="text-[13px]">{todo.text}</p>
        {todo.dueAt !== undefined && (
          <p className="mt-0.5 text-[11.5px] text-subtle-foreground">
            {formatRelativeTime(todo.dueAt, locale)}
          </p>
        )}
      </div>
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <button
          type="button"
          title={t('Dispatch')}
          aria-label={t('Dispatch')}
          onClick={() => mutateTodo({ action: 'dispatch', todoId: todo.id })}
          className={ACTION_CLASS}
        >
          <Send className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title={t('Edit')}
          aria-label={t('Edit')}
          onClick={() => setDraft(todo.text)}
          className={ACTION_CLASS}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title={t('Delete')}
          aria-label={t('Delete')}
          onClick={() => mutateTodo({ action: 'remove', todoId: todo.id })}
          className={ACTION_CLASS}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </span>
    </div>
  );
}

function TodoComposer({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const submit = () => {
    const trimmed = text.trim();
    if (trimmed) mutateTodo({ action: 'add', text: trimmed });
    onClose();
  };
  return (
    <div className="rounded-lg border border-border px-2.5 py-1.5">
      <input
        // biome-ignore lint/a11y/noAutofocus: 点了新增就是要输入
        autoFocus
        value={text}
        placeholder={t('Add a to-do')}
        onChange={(event) => setText(event.target.value)}
        onBlur={submit}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
          if (event.key === 'Enter') submit();
        }}
        className="w-full bg-transparent text-[13px] outline-none"
      />
    </div>
  );
}

function AddTodoRow({ onAdd }: { onAdd: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onAdd}
      className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-[13px] text-subtle-foreground transition-colors hover:bg-foreground/5 hover:text-muted-foreground"
    >
      <Plus className="size-3.5 shrink-0" />
      {t('Add a to-do')}
    </button>
  );
}

function FeedEntry({ event }: { event: FeedEvent }) {
  const { t, locale } = useI18n();
  const selectConversation = useSessionsStore((s) => s.selectConversation);
  const [stopping, setStopping] = useState(false);
  const conversationId = event.conversationId;
  const open = conversationId ? () => selectConversation(conversationId) : undefined;
  const stop = conversationId
    ? () => {
        setStopping(true);
        void window.electronAPI.agent.abort(conversationId).finally(() => setStopping(false));
      }
    : undefined;
  return (
    <div
      data-enso="secretary-feed-event"
      data-tone={event.tone}
      className="group relative flex items-start gap-2 py-1 pl-4"
    >
      <span
        aria-hidden
        className={cn(
          'absolute top-[9px] left-0 size-2 -translate-x-1/2 rounded-full border-[1.5px]',
          TONE_DOT[event.tone]
        )}
      />
      <button
        type="button"
        disabled={!open}
        onClick={open}
        className="min-w-0 flex-1 text-left disabled:cursor-default"
      >
        <span className="block text-[11px] text-subtle-foreground">
          {feedTime(event.at, locale, Date.now())}
          {event.projectName ? ` · ${event.projectName}` : ''}
        </span>
        <span className="mt-0.5 block truncate text-[13px]">{event.title}</span>
        <span className="mt-0.5 block line-clamp-2 text-[12px] text-muted-foreground">
          {event.detail ? `${t(event.label)} · ${event.detail}` : t(event.label)}
        </span>
      </button>
      {event.running && stop && (
        <button
          type="button"
          title={t('Stop')}
          aria-label={t('Stop')}
          disabled={stopping}
          onClick={stop}
          className={cn(ACTION_CLASS, 'opacity-0 group-hover:opacity-100')}
        >
          <Square className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function EmptyState({ name, onAdd }: { name: string; onAdd: () => void }) {
  const { t } = useI18n();
  return (
    <div
      data-enso="secretary-empty"
      className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-14 text-center"
    >
      <span className="flex size-11 items-center justify-center rounded-[14px] bg-muted text-subtle-foreground">
        <Coffee className="size-5" />
      </span>
      <p className="text-[13.5px] font-medium">{t('Nothing on your plate')}</p>
      <p className="text-[12px] text-muted-foreground">
        {t('Ask {{name}} for work in the chat, or note a to-do first', { name })}
      </p>
      <button
        type="button"
        onClick={onAdd}
        className="mt-2 flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12px] transition-colors hover:bg-muted"
      >
        <Plus className="size-3.5" />
        {t('Add a to-do')}
      </button>
    </div>
  );
}

/** 工作台：问候与今日战报、三个计数、需要你处理、待办、动态时间线 */
export function SecretaryWorkbench({ name }: { name: string }) {
  const { t } = useI18n();
  const board = useSecretaryStore((s) => s.secretary.board);
  const [adding, setAdding] = useState(false);
  const digest = secretaryDigest(board, Date.now());
  const empty =
    board.needsYou.length + board.running.length + board.todos.length + board.done.length === 0;

  if (empty) {
    return adding ? (
      <div className="px-3 py-3">
        <TodoComposer onClose={() => setAdding(false)} />
      </div>
    ) : (
      <EmptyState name={name} onAdd={() => setAdding(true)} />
    );
  }

  const { dispatched, completed, failed } = digest.today;
  const todayLine =
    dispatched + completed + failed === 0
      ? t('Nothing dispatched today')
      : t('Today {{dispatched}} dispatched, {{completed}} completed, {{failed}} failed', {
          dispatched,
          completed,
          failed,
        });

  return (
    <div data-enso="secretary-workbench" className="flex flex-col gap-3 px-3 py-3">
      <div>
        <p className="text-[15px] font-semibold">{t(digest.greeting)}</p>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">{todayLine}</p>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        <Stat
          value={digest.counts.needsYou}
          label={t('Waiting on you')}
          warn={digest.counts.needsYou > 0}
        />
        <Stat value={digest.counts.running} label={t('In progress')} />
        <Stat value={digest.counts.todos} label={t('To do')} />
      </div>
      {board.needsYou.length > 0 && (
        <section data-enso="secretary-needs-you" className="flex flex-col gap-1.5">
          {board.needsYou.map((card) =>
            card.kind === 'proposal' ? (
              <SecretaryProposalRow
                key={card.proposal.id}
                proposalId={card.proposal.id}
                prominent
              />
            ) : (
              <AttentionCard key={card.conversationId} card={card} />
            )
          )}
        </section>
      )}
      <section data-enso="secretary-todos" className="flex flex-col">
        <h3 className="px-1.5 pb-1 text-[12px] text-subtle-foreground">
          {t('To do')}
          {board.todos.length > 0 && (
            <span className="ml-1 tabular-nums">{board.todos.length}</span>
          )}
        </h3>
        {board.todos.map((todo) => (
          <TodoRow key={todo.id} todo={todo} />
        ))}
        {adding ? (
          <TodoComposer onClose={() => setAdding(false)} />
        ) : (
          <AddTodoRow onAdd={() => setAdding(true)} />
        )}
      </section>
      <section data-enso="secretary-feed" className="flex flex-col">
        <h3 className="px-1.5 pb-1 text-[12px] text-subtle-foreground">{t('Recent activity')}</h3>
        <div className="ml-1.5 flex flex-col border-l border-border">
          {digest.events.map((event) => (
            <FeedEntry key={event.id} event={event} />
          ))}
        </div>
      </section>
    </div>
  );
}
