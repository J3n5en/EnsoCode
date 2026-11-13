import type {
  SecretaryBoard,
  SecretaryCard,
  SecretaryTodo,
  SecretaryTodoMutate,
} from '@shared/types/secretary';
import { ChevronRight, Plus } from 'lucide-react';
import { useState } from 'react';
import { ApprovalBar } from '@/components/chat/ApprovalBar';
import { AskBar } from '@/components/chat/AskBar';
import { useI18n } from '@/i18n';
import { formatRelativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { useSecretaryStore } from '@/stores/secretary';
import { useSessionsStore } from '@/stores/sessions';
import { SecretaryProposalRow } from './SecretaryProposalRow';

export type BoardGroupKey = 'needsYou' | 'running' | 'todos' | 'done';

export interface BoardGroup {
  key: BoardGroupKey;
  title: string;
  cards: SecretaryCard[];
  todos: SecretaryTodo[];
  /** 「已完成」默认折叠，其余常显 */
  collapsible: boolean;
}

const BOARD_GROUPS: readonly Omit<BoardGroup, 'cards' | 'todos'>[] = [
  { key: 'needsYou', title: 'Waiting on you', collapsible: false },
  { key: 'running', title: 'In progress', collapsible: false },
  { key: 'todos', title: 'To do', collapsible: false },
  { key: 'done', title: 'Completed', collapsible: true },
];

/** 分组顺序固定：需要你处理置顶，已完成垫底 */
export function boardGroups(board: SecretaryBoard): BoardGroup[] {
  const cards: Record<Exclude<BoardGroupKey, 'todos'>, SecretaryCard[]> = {
    needsYou: board.needsYou,
    running: board.running,
    done: board.done,
  };
  return BOARD_GROUPS.map((group) => ({
    ...group,
    cards: group.key === 'todos' ? [] : cards[group.key],
    todos: group.key === 'todos' ? board.todos : [],
  }));
}

const STATE_LABELS: Record<Extract<SecretaryCard, { kind: 'session' }>['state'], string> = {
  running: 'Running',
  idle: 'Idle',
  waiting: 'Waiting for you',
  error: 'Failed',
  'not-started': 'Not started',
};

const CARD_CLASS = 'rounded-lg border border-border/60 bg-muted/20 px-2.5 py-2';
const BUTTON_CLASS =
  'rounded-md px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

/** 卡片即派出会话，不手动拖动；分组由 Main 按会话真实状态决定 */
function SessionCard({ card }: { card: Extract<SecretaryCard, { kind: 'session' }> }) {
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
      className={CARD_CLASS}
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
          {card.projectName}
        </span>
        <span className="min-w-0 flex-1 truncate">{card.title}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {formatRelativeTime(card.startedAt, locale)}
        </span>
      </div>
      {card.lastText && (
        <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{card.lastText}</p>
      )}
      {/* 就地审批与提问复用聊天里的组件和 IPC，处理完 Main 推同一份状态 */}
      {approvals && approvals.length > 0 && (
        <div className="mt-1.5">
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
        <div className="mt-1.5">
          <AskBar
            asks={asks}
            autoFocus={false}
            onAnswer={(requestId, answer) =>
              void window.electronAPI.agent.respondAsk(card.conversationId, requestId, answer)
            }
          />
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className="text-[11px] text-muted-foreground">{t(STATE_LABELS[card.state])}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            className={BUTTON_CLASS}
            onClick={() => selectConversation(card.conversationId)}
          >
            {t('Open')}
          </button>
          {card.state === 'running' && (
            <button type="button" className={BUTTON_CLASS} disabled={stopping} onClick={stop}>
              {t('Stop')}
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

function mutateTodo(request: SecretaryTodoMutate): void {
  void window.electronAPI.secretary.mutateTodo(request);
}

function TodoRow({ todo }: { todo: SecretaryTodo }) {
  const { t, locale } = useI18n();
  const [draft, setDraft] = useState<string | null>(null);
  if (draft !== null) {
    return (
      <div className={CARD_CLASS}>
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
          className="w-full bg-transparent text-xs outline-none"
        />
      </div>
    );
  }
  return (
    <div data-enso="secretary-card" data-kind="todo" className={CARD_CLASS}>
      <p className="text-xs">{todo.text}</p>
      <div className="mt-1 flex items-center gap-1.5">
        {todo.dueAt !== undefined && (
          <span className="text-[10px] text-muted-foreground">
            {formatRelativeTime(todo.dueAt, locale)}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            className={BUTTON_CLASS}
            onClick={() => mutateTodo({ action: 'dispatch', todoId: todo.id })}
          >
            {t('Dispatch')}
          </button>
          <button type="button" className={BUTTON_CLASS} onClick={() => setDraft(todo.text)}>
            {t('Edit')}
          </button>
          <button
            type="button"
            className={BUTTON_CLASS}
            onClick={() => mutateTodo({ action: 'remove', todoId: todo.id })}
          >
            {t('Delete')}
          </button>
        </span>
      </div>
    </div>
  );
}

function TodoSection({ todos }: { todos: SecretaryTodo[] }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<string | null>(null);
  const submit = () => {
    const text = draft?.trim();
    if (text) mutateTodo({ action: 'add', text });
    setDraft(null);
  };
  return (
    <>
      {todos.map((todo) => (
        <TodoRow key={todo.id} todo={todo} />
      ))}
      {draft === null ? (
        <button
          type="button"
          onClick={() => setDraft('')}
          className="flex items-center gap-1 rounded-lg border border-dashed px-2.5 py-1.5 text-[11px] text-muted-foreground transition-colors hover:border-solid hover:text-foreground"
        >
          <Plus className="h-3 w-3" />
          {t('Add a to-do')}
        </button>
      ) : (
        <div className={CARD_CLASS}>
          <input
            // biome-ignore lint/a11y/noAutofocus: 点了新增就是要输入
            autoFocus
            value={draft}
            placeholder={t('What needs doing?')}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={submit}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setDraft(null);
              if (event.key === 'Enter') submit();
            }}
            className="w-full bg-transparent text-xs outline-none"
          />
        </div>
      )}
    </>
  );
}

/** 工作台：Main 中 todos.json + dispatch.json + 会话状态的投影 */
export function SecretaryBoardPanel() {
  const { t } = useI18n();
  const board = useSecretaryStore((s) => s.secretary.board);
  const [folded, setFolded] = useState<Record<string, boolean>>({ done: true });
  return (
    <div
      data-enso="secretary-board"
      className="flex h-full min-h-0 flex-col overflow-y-auto px-2 py-2"
    >
      {boardGroups(board).map((group) => {
        const count = group.key === 'todos' ? group.todos.length : group.cards.length;
        const isFolded = folded[group.key] === true;
        return (
          <section
            key={group.key}
            data-enso="secretary-board-group"
            data-group={group.key}
            className="pb-1"
          >
            <button
              type="button"
              aria-expanded={!isFolded}
              onClick={() => setFolded((prev) => ({ ...prev, [group.key]: !isFolded }))}
              className="flex h-7 w-full items-center gap-1 rounded-md px-1 text-[0.8214rem] font-medium text-subtle-foreground transition-colors hover:text-foreground"
            >
              <ChevronRight
                className={cn(
                  'size-3 shrink-0 transition-transform duration-150',
                  !isFolded && 'rotate-90'
                )}
              />
              <span className="min-w-0 flex-1 truncate text-left">{t(group.title)}</span>
              <span className="shrink-0 font-normal tabular-nums">{count}</span>
            </button>
            {!isFolded && (
              <div className="flex flex-col gap-1.5 pt-1">
                {group.key === 'todos' ? (
                  <TodoSection todos={group.todos} />
                ) : (
                  group.cards.map((card) =>
                    card.kind === 'proposal' ? (
                      <SecretaryProposalRow key={card.proposal.id} proposalId={card.proposal.id} />
                    ) : (
                      <SessionCard key={card.conversationId} card={card} />
                    )
                  )
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
