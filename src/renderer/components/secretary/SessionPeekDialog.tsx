import { projectDisplayName } from '@shared/projectName';
import { Archive, ArrowUpRight, GitBranch, ShieldAlert } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { LiveSessionDialog } from '@/components/bots/LiveSessionTimeline';
import { ApprovalBar } from '@/components/chat/ApprovalBar';
import { AskBar } from '@/components/chat/AskBar';
import { ChatSessionTimeline } from '@/components/chat/ChatSessionTimeline';
import { ChatHostContext } from '@/components/chat/chatHost';
import type { MessageTimelineHandle } from '@/components/chat/MessageTimeline';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { openSessionFromSecretary } from '@/stores/secretaryReturn';
import { type SessionPeekTab, useSessionPeek } from '@/stores/sessionPeek';
import { type Conversation, peekConversation, useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';
import { SecretaryDoneReport } from './SecretaryDoneReport';

type PeekStatus = 'waiting' | 'running' | 'failed' | 'done';

const STATUS_STYLE: Record<PeekStatus, { label: string; className: string }> = {
  waiting: { label: 'Waiting for you', className: 'bg-warning/15 text-warning' },
  running: { label: 'Running', className: 'bg-success/15 text-success' },
  failed: { label: 'Failed', className: 'bg-destructive/15 text-destructive' },
  done: { label: 'Completed', className: 'bg-muted text-muted-foreground' },
};

const GOAL_LABEL = {
  active: 'working',
  paused: 'paused',
  waiting: 'waiting',
  blocked: 'blocked',
  completed: 'completed',
} as const;

const CHIP_CLASS = 'shrink-0 rounded px-1.5 py-px text-[11px]';

const TABS: { key: SessionPeekTab; label: string }[] = [
  { key: 'result', label: 'Result' },
  { key: 'session', label: 'Session' },
];

export function peekStatus(
  conversation: Pick<Conversation, 'status' | 'spawning'> &
    Partial<Pick<Conversation, 'pendingApprovals' | 'pendingAsks'>>
): PeekStatus {
  if (
    (conversation.pendingApprovals?.length ?? 0) > 0 ||
    (conversation.pendingAsks?.length ?? 0) > 0
  )
    return 'waiting';
  if (conversation.status === 'running' || conversation.spawning) return 'running';
  if (conversation.status === 'failed') return 'failed';
  return 'done';
}

/** 秘书面板里点会话：就地实时看，不离开秘书；「打开会话」才跳转 */
export function SessionPeekDialog() {
  const { t } = useI18n();
  const conversationId = useSessionPeek((state) => state.conversationId);
  const close = useSessionPeek((state) => state.close);
  const result = useSessionPeek((state) => state.result);
  const tab = useSessionPeek((state) => (state.result ? state.tab : 'session'));
  const setTab = useSessionPeek((state) => state.setTab);
  const conversation = useSessionsStore((state) =>
    conversationId ? state.conversations[conversationId] : undefined
  );
  const project = useSettingsStore((state) =>
    conversation ? state.projects.find((entry) => entry.id === conversation.projectId) : undefined
  );
  const exists = Boolean(conversation);
  // 已归档（派活完成多半会自动归档）只读看：只读 jsonl 历史，不动归档 / 未读 / 侧栏，不要 worker
  const archived = conversation?.archived === true;
  useEffect(
    () =>
      conversationId && exists
        ? peekConversation(conversationId, { readOnly: archived })
        : undefined,
    [conversationId, exists, archived]
  );
  const timelineRef = useRef<MessageTimelineHandle>(null);
  const host = useMemo(
    () => ({ sessionId: conversationId, canRewind: false, canRetry: false, canFork: false }),
    [conversationId]
  );

  const from = useSessionPeek((state) => state.from);
  const openSession = () => {
    if (!conversationId) return;
    if (archived) useSessionsStore.getState().toggleArchiveConversation(conversationId);
    openSessionFromSecretary(conversationId, from ?? undefined);
  };

  const unavailable = !conversation
    ? t('This session no longer exists, or you do not have access to it')
    : null;
  const status = conversation ? STATUS_STYLE[peekStatus(conversation)] : null;
  const branch = conversation?.worktree?.name || conversation?.worktree?.branch;
  const goal = conversation?.goal;
  const approvals = conversation?.pendingApprovals ?? [];
  const asks = conversation?.pendingAsks ?? [];
  const pending =
    exists && !archived && conversationId && (approvals.length > 0 || asks.length > 0);

  const tabs = result && (
    <div
      role="tablist"
      data-enso="session-peek-tabs"
      className="inline-flex w-fit rounded-md bg-muted p-0.5 text-[12px]"
    >
      {TABS.map((entry) => (
        <button
          key={entry.key}
          type="button"
          role="tab"
          aria-selected={tab === entry.key}
          data-enso={`session-peek-tab-${entry.key}`}
          onClick={() => setTab(entry.key)}
          className={cn(
            'rounded-[5px] px-2.5 py-0.5 transition-colors',
            tab === entry.key
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {t(entry.label)}
        </button>
      ))}
    </div>
  );

  const meta = (conversation || tabs) && (
    <div data-enso="session-peek-meta" className="flex flex-col gap-1.5">
      {tabs}
      {conversation && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-muted-foreground">
          {status && (
            <span data-enso="session-peek-status" className={cn(CHIP_CLASS, status.className)}>
              {t(status.label)}
            </span>
          )}
          {project && (
            <span data-enso="session-peek-project" className={cn(CHIP_CLASS, 'bg-muted')}>
              {projectDisplayName(project)}
            </span>
          )}
          {branch && (
            <span
              data-enso="session-peek-branch"
              className={cn(CHIP_CLASS, 'inline-flex items-center gap-1 bg-muted font-mono')}
            >
              <GitBranch className="size-3" />
              {branch}
            </span>
          )}
        </div>
      )}
      {goal && (
        <p data-enso="session-peek-goal" className="truncate text-[12px] text-muted-foreground">
          {t('Goal')} · {goal.text} · {t(GOAL_LABEL[goal.status])}
          {goal.status === 'active' && goal.autoTurns > 0 ? ` · ${goal.autoTurns}/25` : ''}
        </p>
      )}
    </div>
  );

  // 归档的打开即恢复，按钮直接写「恢复并打开」；只有会话不在时不给
  const actions = conversation && (
    <div
      data-enso="session-peek-actions"
      className="flex shrink-0 flex-col items-end gap-1 sm:flex-row-reverse sm:items-center sm:gap-2"
    >
      <button
        type="button"
        data-enso="session-peek-open"
        onClick={openSession}
        className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[12px] text-primary-foreground transition-colors hover:bg-primary/90"
      >
        <ArrowUpRight className="size-3.5" />
        {archived ? t('Restore and open') : t('Open session')}
      </button>
      {archived && (
        <span
          data-enso="session-peek-archived"
          className={cn(
            CHIP_CLASS,
            'inline-flex items-center gap-1 bg-muted text-muted-foreground'
          )}
        >
          <Archive className="size-3" />
          {t('Archived · read-only')}
        </span>
      )}
    </div>
  );

  return (
    <LiveSessionDialog
      dataEnso="session-peek"
      conversationId={conversationId}
      title={conversation?.title || result?.title || t('Unnamed')}
      meta={meta}
      actions={actions}
      footer={
        pending ? (
          <div data-enso="session-peek-pending" className="pb-3">
            <div className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-warning">
              <ShieldAlert className="size-3.5" />
              {t('Needs your approval or answer')}
            </div>
            <ApprovalBar
              approvals={approvals}
              allowSession={conversation?.child?.lockedProfileId === undefined}
              onRespond={(requestId, decision) =>
                void window.electronAPI.agent.respondApproval(conversationId, requestId, decision)
              }
            />
            <AskBar
              asks={asks}
              autoFocus={false}
              onAnswer={(requestId, answer) =>
                void window.electronAPI.agent.respondAsk(conversationId, requestId, answer)
              }
            />
          </div>
        ) : undefined
      }
      onClose={close}
    >
      {tab === 'result' && conversationId ? (
        <SecretaryDoneReport conversationId={conversationId} fallback={result?.fallback} />
      ) : unavailable ? (
        <p
          data-enso="session-peek-unavailable"
          className="flex flex-1 items-center justify-center border-t px-6 text-center text-[13px] text-muted-foreground"
        >
          {unavailable}
        </p>
      ) : conversationId ? (
        <ChatHostContext.Provider value={host}>
          <div className="@container flex min-h-0 flex-1 flex-col border-t">
            <ChatSessionTimeline
              peek
              readOnly={archived}
              conversationId={conversationId}
              cwd={conversation?.worktree?.path ?? project?.path}
              emptyTitle={conversation?.title || t('Unnamed')}
              timelineRef={timelineRef}
            />
          </div>
        </ChatHostContext.Provider>
      ) : null}
    </LiveSessionDialog>
  );
}
