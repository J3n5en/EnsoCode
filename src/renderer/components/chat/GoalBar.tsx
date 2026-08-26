import { Pause, Play, Target, X } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { SessionGoal } from '@/stores/sessions';
import { useSessionsStore } from '@/stores/sessions';

/** 状态色点(与 TaskBar 同款):整条保持中性,状态只落在小点上 */
const STATUS_DOT: Record<SessionGoal['status'], string> = {
  active: 'bg-green-500 animate-pulse',
  paused: 'bg-amber-500',
  waiting: 'bg-amber-500',
  blocked: 'bg-destructive',
  completed: 'bg-blue-500',
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
    <div className="mb-1 flex items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-2.5 py-1.5 text-xs">
      <Target className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span
        className="min-w-0 flex-1 truncate"
        title={goal.note ? `${goal.text} — ${goal.note}` : goal.text}
      >
        {goal.text}
        {goal.note && <span className="text-muted-foreground"> — {goal.note}</span>}
      </span>
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[goal.status])} />
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
        {statusLabel[goal.status]}
        {goal.status === 'active' && goal.autoTurns > 0 ? ` · ${goal.autoTurns}/25` : ''}
      </span>
      {goal.status === 'active' ? (
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
