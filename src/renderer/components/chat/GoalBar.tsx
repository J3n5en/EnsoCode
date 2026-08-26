import { Pause, Play, Target, X } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { SessionGoal } from '@/stores/sessions';
import { useSessionsStore } from '@/stores/sessions';

const STATUS_STYLE: Record<SessionGoal['status'], string> = {
  active: 'border-blue-500/50 bg-blue-500/5',
  paused: 'border-amber-500/50 bg-amber-500/5',
  waiting: 'border-amber-500/50 bg-amber-500/5',
  blocked: 'border-destructive/50 bg-destructive/5',
  completed: 'border-green-500/50 bg-green-500/5',
};

/** 会话目标状态条:目标文本 + 状态/轮数 + 暂停/继续/清除 */
export function GoalBar({ conversationId, goal }: { conversationId: string; goal: SessionGoal }) {
  const { t } = useI18n();
  const statusLabel: Record<SessionGoal['status'], string> = {
    active: t('working'),
    paused: t('paused'),
    waiting: t('waiting'),
    blocked: t('blocked'),
    completed: t('completed'),
  };
  return (
    <div
      className={cn(
        'mb-1 flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs',
        STATUS_STYLE[goal.status]
      )}
    >
      <Target className="h-3.5 w-3.5 shrink-0" />
      <span
        className="min-w-0 flex-1 truncate"
        title={goal.note ? `${goal.text} — ${goal.note}` : goal.text}
      >
        {goal.text}
        {goal.note && <span className="text-muted-foreground"> — {goal.note}</span>}
      </span>
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
        {statusLabel[goal.status]}
        {goal.status === 'active' && goal.autoTurns > 0 ? ` · ${goal.autoTurns}/25` : ''}
      </span>
      {goal.status === 'active' ? (
        <button
          type="button"
          title={t('Pause goal')}
          onClick={() => useSessionsStore.getState().pauseGoal(conversationId)}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
        >
          <Pause className="h-3.5 w-3.5" />
        </button>
      ) : goal.status !== 'completed' ? (
        <button
          type="button"
          title={t('Resume goal')}
          onClick={() => useSessionsStore.getState().resumeGoal(conversationId)}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
        >
          <Play className="h-3.5 w-3.5" />
        </button>
      ) : null}
      <button
        type="button"
        title={t('Clear goal')}
        onClick={() => useSessionsStore.getState().clearGoal(conversationId)}
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
