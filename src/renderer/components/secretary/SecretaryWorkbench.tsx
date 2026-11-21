import {
  NEEDS_YOU_RESULTS,
  type PendingDispatch,
  type SecretaryBoard,
  type SecretaryBoardTodo,
  type SecretaryTodoMutate,
  type TodoProblemCode,
} from '@shared/types/secretary';
import {
  ArrowUpRight,
  Coffee,
  Pencil,
  Plus,
  Send,
  ShieldAlert,
  Square,
  Trash2,
  Undo2,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { ApprovalBar } from '@/components/chat/ApprovalBar';
import { AskBar } from '@/components/chat/AskBar';
import { HOVER_ROW_CLASS, HoverActions } from '@/components/ui/hover-actions';
import { useI18n } from '@/i18n';
import { formatClock, formatRelativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { useSecretaryStore } from '@/stores/secretary';
import { useSessionsStore } from '@/stores/sessions';
import { SecretaryFace } from './SecretaryFace';
import { SecretaryProposalRow } from './SecretaryProposalRow';
import {
  type FeedEvent,
  type FeedTone,
  type SecretarySessionCard,
  secretaryDigest,
  sessionFeed,
} from './secretaryDigest';
import { useSecretaryFace } from './useSecretaryFace';
import { useSecretaryFeed } from './useSecretaryFeed';

function mutateTodo(request: SecretaryTodoMutate, secretaryId?: string): void {
  void window.electronAPI.secretary.mutateTodo(request, secretaryId);
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

const SESSION_STATE_LABEL = {
  running: 'Running',
  waiting: 'Waiting for you',
  idle: 'Idle',
  error: 'Failed',
  'not-started': 'Not started',
  gone: 'The session was deleted',
} as const;

const PROBLEM_LABEL: Record<TodoProblemCode, string> = {
  failed: 'The session failed',
  stopped: 'The session was stopped',
  deleted: 'The session was deleted',
};

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
/** 等依赖的派发出问题：它没有会话可打开，只说明原因，秘书已经收到同一条结果 */
function PendingProblemCard({ pending }: { pending: PendingDispatch }) {
  const { t } = useI18n();
  const title = pending.draft.title?.trim() || pending.draft.prompt.split('\n')[0]?.trim() || '';
  return (
    <div
      data-enso="secretary-pending-problem"
      data-problem={pending.problem ?? 'dispatch-failed'}
      className="rounded-xl border border-warning/40 bg-warning/5 px-3 py-2.5"
    >
      <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-warning">
        <ShieldAlert className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {t(PENDING_PROBLEM_LABELS[pending.problem ?? 'dispatch-failed'])}
        </span>
      </div>
      <p className="mt-1 text-[13px] font-medium">{title}</p>
      <p className="mt-0.5 text-[12px] text-muted-foreground">
        {t('Waited for {{ids}}', { ids: pending.after.join(', ') })}
      </p>
    </div>
  );
}

const PENDING_PROBLEM_LABELS: Record<NonNullable<PendingDispatch['problem']>, string> = {
  'dependency-failed': 'A dependency failed',
  'dependency-stopped': 'A dependency was stopped',
  'dependency-deleted': 'A dependency was deleted',
  'dispatch-failed': 'The dispatch could not start',
  cancelled: 'The dispatch was cancelled',
};

function AttentionCard({ card }: { card: SecretarySessionCard }) {
  const { t, locale } = useI18n();
  const face = useSecretaryFace();
  const approvals = useSessionsStore((s) => s.conversations[card.conversationId]?.pendingApprovals);
  const asks = useSessionsStore((s) => s.conversations[card.conversationId]?.pendingAsks);
  const selectConversation = useSessionsStore((s) => s.selectConversation);
  const [stopping, setStopping] = useState(false);
  const stop = () => {
    setStopping(true);
    void window.electronAPI.agent.abort(card.conversationId).finally(() => setStopping(false));
  };
  // 实时审批与提问由会话状态决定，清结果不会让它消失，所以只在原因是结果时给「知道了」
  const dismissible =
    card.state !== 'waiting' && card.result !== undefined && NEEDS_YOU_RESULTS.has(card.result);
  const feed = sessionFeed(card);
  return (
    <div
      data-enso="secretary-card"
      data-kind="session"
      data-state={card.state}
      className="rounded-xl border border-warning/40 bg-warning/5 px-3 py-2.5"
    >
      <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-warning">
        {face && (
          <SecretaryFace
            name={face.name}
            color={face.color}
            image={face.image}
            enso="secretary-card-avatar"
            className="size-4 rounded-[5px] text-[9px]"
          />
        )}
        <ShieldAlert className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t(feed.label)}</span>
        <span className="shrink-0 font-normal text-subtle-foreground">
          {formatRelativeTime(feed.at, locale)}
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
        {dismissible && (
          <button
            type="button"
            data-enso="secretary-dismiss-result"
            onClick={() => void window.electronAPI.secretary.dismissResult(card.conversationId)}
            className="rounded-md px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {t('Got it')}
          </button>
        )}
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

function TodoRow({ todo, secretaryId }: { todo: SecretaryBoardTodo; secretaryId?: string }) {
  const { t, locale } = useI18n();
  const selectConversation = useSessionsStore((s) => s.selectConversation);
  const [draft, setDraft] = useState<string | null>(null);
  const phase = todo.phase ?? 'todo';
  const openable = Boolean(todo.conversationId) && todo.sessionState !== 'gone';
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
            if (text) mutateTodo({ action: 'update', todoId: todo.id, text }, secretaryId);
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
      data-phase={phase}
      data-session={todo.conversationId}
      draggable={phase !== 'todo'}
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', todo.id);
        event.dataTransfer.effectAllowed = 'move';
      }}
      className={cn(HOVER_ROW_CLASS, 'flex items-start gap-2.5 rounded-lg px-1.5 py-1.5')}
    >
      <button
        type="button"
        data-enso="secretary-todo-done"
        aria-label={t('Mark done')}
        onClick={() => mutateTodo({ action: 'update', todoId: todo.id, done: true }, secretaryId)}
        className="mt-[3px] size-3.5 shrink-0 rounded-full border-[1.5px] border-foreground/30 transition-colors hover:border-success hover:bg-success/20"
      />
      <div className="min-w-0 flex-1">
        <p className="text-[13px]">{todo.text}</p>
        {phase !== 'todo' && (
          <button
            type="button"
            data-enso="secretary-todo-session"
            disabled={!openable}
            onClick={() => {
              if (todo.conversationId && openable) selectConversation(todo.conversationId);
            }}
            className="mt-0.5 block max-w-full truncate text-left text-[12px] text-muted-foreground hover:text-foreground disabled:cursor-default"
          >
            {todo.sessionTitle || t('Open session')}
            {todo.sessionState ? ` · ${t(SESSION_STATE_LABEL[todo.sessionState])}` : ''}
          </button>
        )}
        {phase === 'problem' && todo.problem && (
          <p data-enso="secretary-todo-problem" className="mt-0.5 text-[11.5px] text-destructive">
            {t(PROBLEM_LABEL[todo.problem])}
          </p>
        )}
        {todo.dueAt !== undefined && (
          <p className="mt-0.5 text-[11.5px] text-subtle-foreground">
            {formatRelativeTime(todo.dueAt, locale)}
          </p>
        )}
      </div>
      <HoverActions>
        {phase === 'todo' ? (
          <button
            type="button"
            data-enso="secretary-todo-dispatch"
            title={t('Dispatch')}
            aria-label={t('Dispatch')}
            onClick={() => mutateTodo({ action: 'dispatch', todoId: todo.id }, secretaryId)}
            className={ACTION_CLASS}
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        ) : (
          <button
            type="button"
            data-enso="secretary-todo-reopen"
            title={t('Back to to-do')}
            aria-label={t('Back to to-do')}
            onClick={() => mutateTodo({ action: 'reopen', todoId: todo.id }, secretaryId)}
            className={ACTION_CLASS}
          >
            <Undo2 className="h-3.5 w-3.5" />
          </button>
        )}
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
          onClick={() => mutateTodo({ action: 'remove', todoId: todo.id }, secretaryId)}
          className={ACTION_CLASS}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </HoverActions>
    </div>
  );
}

function TodoComposer({ onClose, secretaryId }: { onClose: () => void; secretaryId?: string }) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const submit = () => {
    const trimmed = text.trim();
    if (trimmed) mutateTodo({ action: 'add', text: trimmed }, secretaryId);
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
  const face = useSecretaryFace();
  const selectConversation = useSessionsStore((s) => s.selectConversation);
  const [stopping, setStopping] = useState(false);
  const [expanded, setExpanded] = useState(false);
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
      data-id={event.id}
      data-tone={event.tone}
      className="group/row relative flex items-start gap-2 py-1 pl-4"
    >
      <span
        aria-hidden
        className={cn(
          'absolute top-[9px] left-0 size-2 -translate-x-1/2 rounded-full border-[1.5px]',
          TONE_DOT[event.tone]
        )}
      />
      {face && (
        <SecretaryFace
          name={face.name}
          color={face.color}
          image={face.image}
          enso="secretary-feed-avatar"
          className="mt-0.5 size-4 shrink-0 rounded-[5px] text-[9px]"
        />
      )}
      <button
        type="button"
        data-enso="secretary-feed-expand"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="min-w-0 flex-1 text-left"
      >
        <span className="block text-[11px] text-subtle-foreground">
          {feedTime(event.at, locale, Date.now())}
          {event.projectName ? ` · ${event.projectName}` : ''}
        </span>
        <span className="mt-0.5 block truncate text-[13px]">{event.title}</span>
        <span
          className={cn(
            'mt-0.5 block text-[12px] text-muted-foreground',
            expanded ? 'whitespace-pre-wrap break-words' : 'line-clamp-2'
          )}
        >
          {event.detail ? `${t(event.label)} · ${event.detail}` : t(event.label)}
        </span>
      </button>
      {event.running && stop && (
        // 时间线行不着色，蒙版直接接面板底色。右侧让出跳转按钮的宽度并留出间距，
        // 停止浮出时不会落在跳转按钮的位置上（原来两个按钮叠在一起，点跳转点到停止）。
        <HoverActions className="from-background pr-7">
          <button
            type="button"
            data-enso="secretary-feed-stop"
            title={t('Stop')}
            aria-label={t('Stop')}
            disabled={stopping}
            onClick={(clickEvent) => {
              clickEvent.stopPropagation();
              stop();
            }}
            className={cn(ACTION_CLASS, 'hover:bg-destructive/10 hover:text-destructive')}
          >
            <Square className="h-3.5 w-3.5" />
          </button>
        </HoverActions>
      )}
      {open && (
        <button
          type="button"
          data-enso="secretary-feed-open"
          title={t('Open session')}
          aria-label={t('Open session')}
          onClick={(clickEvent) => {
            clickEvent.stopPropagation();
            open();
          }}
          // 排在蒙版之后并定位：跳转始终画在蒙版之上，位置由行尾固定，谁也盖不住也挤不动
          className={cn(ACTION_CLASS, 'relative')}
        >
          <ArrowUpRight className="h-3.5 w-3.5" />
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
export function SecretaryWorkbench({ name, secretaryId }: { name: string; secretaryId?: string }) {
  const { t } = useI18n();
  const ownBoard = useSecretaryStore((s) =>
    secretaryId ? (s.states[secretaryId]?.board ?? s.secretary.board) : s.secretary.board
  );
  const secretaries = useSecretaryStore((s) => s.secretaries);
  /** 多个秘书时可以看总看板：全部，或筛到某一个 */
  const [scope, setScope] = useState<'own' | 'all'>('own');
  const [filterId, setFilterId] = useState<string>('all');
  const [overviewBoards, setOverviewBoards] = useState<
    { secretaryId: string; name: string | null; board: SecretaryBoard }[] | null
  >(null);
  useEffect(() => {
    if (scope !== 'all') return;
    let alive = true;
    void window.electronAPI.secretary.overview().then((result) => {
      if (alive && result.ok) setOverviewBoards(result.boards);
    });
    return () => {
      alive = false;
    };
  }, [scope]);
  const board = useMemo(() => {
    if (scope !== 'all' || !overviewBoards) return ownBoard;
    const picked =
      filterId === 'all'
        ? overviewBoards
        : overviewBoards.filter((entry) => entry.secretaryId === filterId);
    return {
      needsYou: picked.flatMap((entry) => entry.board.needsYou),
      running: picked.flatMap((entry) => entry.board.running),
      todos: picked.flatMap((entry) => entry.board.todos),
      done: picked.flatMap((entry) => entry.board.done),
    };
  }, [scope, overviewBoards, filterId, ownBoard]);
  const focusProposal = useSecretaryStore((s) => s.focusProposal);
  const [adding, setAdding] = useState(false);
  /** 深链定位过来的那张卡：滚到它并闪一下，2 秒后恢复 */
  const [highlight, setHighlight] = useState<string | null>(null);
  const digest = secretaryDigest(board, Date.now());
  const feed = useSecretaryFeed(secretaryId);
  const empty =
    board.needsYou.length + board.running.length + board.todos.length + board.done.length === 0;

  useEffect(() => {
    if (!focusProposal) return;
    setHighlight(focusProposal.proposalId);
    const node = document.querySelector(
      `[data-enso=secretary-proposal-focus][data-proposal-id="${focusProposal.proposalId}"]`
    );
    node?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // 定位只做一次：高亮收掉时把这个请求清掉，下次打开面板不会又跳回来
    const timer = setTimeout(() => {
      setHighlight(null);
      useSecretaryStore.getState().clearFocusProposal();
    }, 2_400);
    return () => clearTimeout(timer);
  }, [focusProposal]);

  if (empty) {
    return adding ? (
      <div className="px-3 py-3">
        <TodoComposer onClose={() => setAdding(false)} secretaryId={secretaryId} />
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
  const active = board.todos.filter((todo) => todo.phase === 'active');
  const problem = board.todos.filter((todo) => todo.phase === 'problem');
  const open = board.todos.filter((todo) => (todo.phase ?? 'todo') === 'todo');
  const reopenIds = new Set([...active, ...problem].map((todo) => todo.id));

  return (
    <div data-enso="secretary-workbench" className="flex flex-col gap-3 px-3 py-3">
      {secretaries.length > 1 && (
        <div className="flex items-center gap-1.5">
          {(['own', 'all'] as const).map((option) => (
            <button
              key={option}
              type="button"
              data-enso="secretary-board-scope-option"
              data-scope={option}
              aria-pressed={scope === option}
              onClick={() => setScope(option)}
              className={cn(
                'rounded-md px-2 py-0.5 text-[12px] transition-colors',
                scope === option
                  ? 'bg-foreground/10 font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-foreground/5'
              )}
            >
              {option === 'own' ? name : t('All secretaries')}
            </button>
          ))}
          {scope === 'all' && (
            <select
              data-enso="secretary-board-filter"
              value={filterId}
              onChange={(event) => setFilterId(event.target.value)}
              className="ml-auto rounded-md bg-transparent text-[12px] text-muted-foreground"
            >
              <option value="all">{t('All secretaries')}</option>
              {secretaries.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name ?? t('Secretary')}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
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
              <div
                key={card.proposal.id}
                data-enso="secretary-proposal-focus"
                data-proposal-id={card.proposal.id}
                className={cn(
                  'rounded-lg transition-shadow',
                  highlight === card.proposal.id && 'ring-2 ring-warning'
                )}
              >
                <SecretaryProposalRow proposalId={card.proposal.id} prominent />
              </div>
            ) : card.kind === 'pending' ? (
              <PendingProblemCard key={card.pending.id} pending={card.pending} />
            ) : (
              <AttentionCard key={card.conversationId} card={card} />
            )
          )}
        </section>
      )}
      {active.length > 0 && (
        <TodoGroup title={t('In progress')} count={active.length} marker="secretary-active">
          {active.map((todo) => (
            <TodoRow key={todo.id} todo={todo} secretaryId={secretaryId} />
          ))}
        </TodoGroup>
      )}
      {problem.length > 0 && (
        <TodoGroup title={t('Problem')} count={problem.length} marker="secretary-problem">
          {problem.map((todo) => (
            <TodoRow key={todo.id} todo={todo} secretaryId={secretaryId} />
          ))}
        </TodoGroup>
      )}
      <section
        data-enso="secretary-todos"
        className="flex flex-col"
        onDragOver={(event) => {
          if ([...event.dataTransfer.types].includes('text/plain')) event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          const todoId = event.dataTransfer.getData('text/plain');
          if (reopenIds.has(todoId)) mutateTodo({ action: 'reopen', todoId }, secretaryId);
        }}
      >
        <h3 className="px-1.5 pb-1 text-[12px] text-subtle-foreground">
          {t('To do')}
          {open.length > 0 && <span className="ml-1 tabular-nums">{open.length}</span>}
        </h3>
        {open.map((todo) => (
          <TodoRow key={todo.id} todo={todo} secretaryId={secretaryId} />
        ))}
        {adding ? (
          <TodoComposer onClose={() => setAdding(false)} secretaryId={secretaryId} />
        ) : (
          <AddTodoRow onAdd={() => setAdding(true)} />
        )}
      </section>
      <section data-enso="secretary-feed" className="flex flex-col">
        <h3 className="px-1.5 pb-1 text-[12px] text-subtle-foreground">{t('Recent activity')}</h3>
        {feed.freshCount > 0 && (
          <button
            type="button"
            data-enso="secretary-feed-fresh"
            data-count={feed.freshCount}
            onClick={feed.reveal}
            className="sticky top-0 z-10 mx-1.5 h-7 -mb-7 rounded-md bg-muted px-2 text-[12px] text-foreground"
          >
            {t('{{count}} new updates', { count: feed.freshCount })}
          </button>
        )}
        <div className="ml-1.5 flex flex-col border-l border-border">
          {feed.events.map((event) => (
            <FeedEntry key={event.id} event={event} />
          ))}
          <div ref={feed.sentinelRef} data-enso="secretary-feed-sentinel" className="h-px" />
        </div>
        {feed.loading && (
          <p
            data-enso="secretary-feed-loading"
            className="px-1.5 py-1 text-[12px] text-subtle-foreground"
          >
            {t('Loading…')}
          </p>
        )}
        {feed.exhausted && !feed.loading && feed.events.length > 0 && (
          <p
            data-enso="secretary-feed-end"
            className="px-1.5 py-1 text-[12px] text-subtle-foreground"
          >
            {t('No earlier activity')}
          </p>
        )}
      </section>
    </div>
  );
}

function TodoGroup({
  title,
  count,
  marker,
  children,
}: {
  title: string;
  count: number;
  marker: string;
  children: ReactNode;
}) {
  return (
    <section data-enso={marker} className="flex flex-col">
      <h3 className="px-1.5 pb-1 text-[12px] text-subtle-foreground">
        {title}
        <span className="ml-1 tabular-nums">{count}</span>
      </h3>
      {children}
    </section>
  );
}
