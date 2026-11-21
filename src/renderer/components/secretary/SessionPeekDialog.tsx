import { projectDisplayName } from '@shared/projectName';
import { ArrowLeft, ArrowUpRight, GitBranch, ShieldAlert } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { LiveSessionDialog } from '@/components/bots/LiveSessionTimeline';
import { ApprovalBar } from '@/components/chat/ApprovalBar';
import { AskBar } from '@/components/chat/AskBar';
import { ChatSessionTimeline } from '@/components/chat/ChatSessionTimeline';
import { ChatHostContext } from '@/components/chat/chatHost';
import type { MessageTimelineHandle } from '@/components/chat/MessageTimeline';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSessionPeek } from '@/stores/sessionPeek';
import { type Conversation, peekConversation, useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';

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
  const conversation = useSessionsStore((state) =>
    conversationId ? state.conversations[conversationId] : undefined
  );
  const project = useSettingsStore((state) =>
    conversation ? state.projects.find((entry) => entry.id === conversation.projectId) : undefined
  );
  const viewable = Boolean(conversation && !conversation.archived);
  useEffect(
    () => (conversationId && viewable ? peekConversation(conversationId) : undefined),
    [conversationId, viewable]
  );
  const timelineRef = useRef<MessageTimelineHandle>(null);
  const host = useMemo(
    () => ({ sessionId: conversationId, canRewind: false, canRetry: false, canFork: false }),
    [conversationId]
  );

  const openSession = () => {
    if (!conversationId) return;
    const { activeId, conversations, selectConversation } = useSessionsStore.getState();
    const from = activeId ? conversations[activeId] : undefined;
    const fromSecretary =
      from &&
      from.id !== conversationId &&
      useSettingsStore
        .getState()
        .projects.some((entry) => entry.id === from.projectId && entry.kind === 'secretary');
    close();
    selectConversation(conversationId);
    useSessionPeek
      .getState()
      .setBack(fromSecretary && from ? { from: from.id, to: conversationId } : null);
  };

  const unavailable = !conversation
    ? t('This session no longer exists, or you do not have access to it')
    : conversation.archived
      ? t('This session is archived. Restore it from the archive to view it.')
      : null;
  const status = conversation ? STATUS_STYLE[peekStatus(conversation)] : null;
  const branch = conversation?.worktree?.name || conversation?.worktree?.branch;
  const goal = conversation?.goal;
  const approvals = conversation?.pendingApprovals ?? [];
  const asks = conversation?.pendingAsks ?? [];
  const pending = viewable && conversationId && (approvals.length > 0 || asks.length > 0);

  const meta = conversation && (
    <div data-enso="session-peek-meta" className="flex flex-col gap-1.5">
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
        {viewable && (
          <button
            type="button"
            data-enso="session-peek-open"
            onClick={openSession}
            className="ml-auto inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[12px] text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <ArrowUpRight className="size-3.5" />
            {t('Open session')}
          </button>
        )}
      </div>
      {goal && (
        <p data-enso="session-peek-goal" className="truncate text-[12px] text-muted-foreground">
          {t('Goal')} · {goal.text} · {t(GOAL_LABEL[goal.status])}
          {goal.status === 'active' && goal.autoTurns > 0 ? ` · ${goal.autoTurns}/25` : ''}
        </p>
      )}
    </div>
  );

  return (
    <LiveSessionDialog
      dataEnso="session-peek"
      conversationId={conversationId}
      title={conversation?.title || t('Unnamed')}
      meta={meta}
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
      {unavailable ? (
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

/** 从弹窗跳进的会话：标题栏给一键回到发起时的秘书会话（回去或再从弹窗跳别处时换掉） */
export function SecretaryReturnButton({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const back = useSessionPeek((state) => state.back);
  const fromAlive = useSessionsStore((state) =>
    back ? Boolean(state.conversations[back.from]) : false
  );
  if (!back || back.to !== conversationId || !fromAlive) return null;
  return (
    <button
      type="button"
      data-enso="secretary-return"
      onClick={() => {
        useSessionPeek.getState().setBack(null);
        useSessionsStore.getState().selectConversation(back.from);
      }}
      className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <ArrowLeft className="size-3.5" />
      {t('Back to secretary')}
    </button>
  );
}
