import { formatReminderClock, formatReminderTooltip } from '@shared/reminders';
import { formatRetryClock, isUpstreamWaitingGoal } from '@shared/upstreamRecovery';
import { Clock, Pause, Play, RotateCcw, Square, X } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { usePendingReminder } from '@/stores/sessionReminders';
import type { SessionGoal } from '@/stores/sessions';
import { useSessionsStore } from '@/stores/sessions';
import { GOAL_FRAME, GoalIcon } from './injectedVisual';

/** 状态色点(与 TaskBar 同款):整条保持中性,状态只落在小点上 */
const STATUS_DOT: Record<SessionGoal['status'], string> = {
  active: 'bg-green-500 animate-pulse',
  paused: 'bg-amber-500',
  waiting: 'bg-amber-500',
  blocked: 'bg-destructive',
  completed: 'bg-blue-500',
};

/** 会话目标状态条:目标文本 + 状态/轮数 + 暂停/继续/清除 */
export function GoalBar({
  conversationId,
  goal,
  sessionStatus,
}: {
  conversationId: string;
  goal: SessionGoal;
  sessionStatus?: string;
}) {
  const { t } = useI18n();
  const upstreamWaiting = isUpstreamWaitingGoal(goal);
  const retry = upstreamWaiting ? goal.retry : undefined;
  const { reminder: pendingReminder, now } = usePendingReminder(
    conversationId,
    !retry && goal.status === 'active' && sessionStatus !== 'running'
  );
  const statusLabel: Record<SessionGoal['status'], string> = {
    active: t('working'),
    paused: t('paused'),
    waiting: t('waiting'),
    blocked: t('blocked'),
    completed: t('completed'),
  };
  const label = retry
    ? retry.kind === 'quota'
      ? t('Quota exhausted · next {{time}}', { time: formatRetryClock(retry.at) })
      : t('Waiting for upstream recovery · next {{time}}', { time: formatRetryClock(retry.at) })
    : statusLabel[goal.status];
  const reminderTooltip = pendingReminder
    ? formatReminderTooltip(pendingReminder, now, t)
    : undefined;
  return (
    <div className={cn('mb-1 flex items-center gap-2', GOAL_FRAME)}>
      <GoalIcon />
      <span
        className="min-w-0 flex-1 truncate"
        title={
          retry?.lastError
            ? `${goal.text} — ${retry.lastError}`
            : reminderTooltip
              ? `${goal.text} — ${reminderTooltip}`
              : goal.note
                ? `${goal.text} — ${goal.note}`
                : goal.text
        }
      >
        {goal.text}
        {goal.note && <span className="text-muted-foreground"> — {goal.note}</span>}
      </span>
      {pendingReminder ? (
        <span
          data-enso="goal-reminder-waiting"
          title={reminderTooltip}
          className="inline-flex min-w-0 max-w-[260px] shrink-0 items-center gap-1 rounded bg-sky-500/15 px-1.5 py-0.5 font-mono text-[10px] text-sky-600 tabular-nums dark:text-sky-400"
        >
          <Clock className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate">
            {t('Waiting for reminder · {{time}}', {
              time: formatReminderClock(pendingReminder.dueAt),
            })}
            {pendingReminder.label ? ` · ${pendingReminder.label}` : ''}
          </span>
        </span>
      ) : (
        <>
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[goal.status])} />
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
            {label}
            {goal.status === 'active' && goal.autoTurns > 0 ? ` · ${goal.autoTurns}/25` : ''}
          </span>
        </>
      )}
      {retry ? (
        <>
          <button
            type="button"
            data-enso="upstream-retry-now"
            title={t('Retry now')}
            onClick={() => void useSessionsStore.getState().retryUpstreamNow(conversationId)}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-amber-600 transition-colors hover:bg-amber-500/10 dark:text-amber-400"
          >
            <RotateCcw className="h-3 w-3" />
            {t('Retry now')}
          </button>
          <button
            type="button"
            data-enso="upstream-stop"
            title={t('Stop auto-retry')}
            onClick={() => void useSessionsStore.getState().abort(conversationId)}
            className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-destructive"
          >
            <Square className="h-3 w-3" />
          </button>
        </>
      ) : goal.status === 'active' ? (
        <button
          type="button"
          title={t('Pause goal')}
          onClick={() => useSessionsStore.getState().pauseGoal(conversationId)}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <Pause className="h-3.5 w-3.5" />
        </button>
      ) : goal.status !== 'completed' ? (
        <button
          type="button"
          title={t('Resume goal')}
          onClick={() => useSessionsStore.getState().resumeGoal(conversationId)}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <Play className="h-3.5 w-3.5" />
        </button>
      ) : null}
      <button
        type="button"
        title={t('Clear goal')}
        onClick={() => useSessionsStore.getState().clearGoal(conversationId)}
        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-destructive"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
