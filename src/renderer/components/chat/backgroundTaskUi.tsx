import type { BackgroundTaskInfo } from '@shared/types/agent';
import { Moon, Pin, TerminalSquare } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { StepNode } from './StepNode';

type T = (key: string, params?: Record<string, string | number>) => string;

/** 后台任务在界面上的状态：疑似闲置优先于保留（保留到期复查后仍闲置会撤掉保留） */
export type TaskView = 'idle' | 'kept' | 'running' | 'done' | 'failed';

export function taskView(task: BackgroundTaskInfo): TaskView {
  if (task.status !== 'running') return task.status;
  if (task.idle) return 'idle';
  if (task.keep) return 'kept';
  return 'running';
}

/** 「42 分钟」「1 小时 5 分钟」 */
export function spanText(ms: number, t: T): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return t('{{n}} min', { n: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? t('{{n}} h', { n: hours }) : t('{{h}} h {{m}} min', { h: hours, m: rest });
}

/** 「42m」「1h 05m」 */
export function shortSpan(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function clockText(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 每 30 秒刷新一次「现在」：闲置时长、已运行时长按分钟显示，不必逐秒重绘 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const TONE = {
  ok: 'bg-success/15 text-success',
  pending: 'bg-warning/15 text-warning',
  neutral: 'bg-muted text-muted-foreground',
} as const;

export function TaskBadge({
  tone,
  children,
  className,
}: {
  tone: keyof typeof TONE;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn('shrink-0 rounded px-1 py-px text-[10px]', TONE[tone], className)}>
      {children}
    </span>
  );
}

export function idleLabel(task: BackgroundTaskInfo, now: number, t: T): string {
  return t('Idle {{duration}}', { duration: spanText(now - (task.idle?.since ?? now), t) });
}

export function TaskStatusBadge({ task, now }: { task: BackgroundTaskInfo; now: number }) {
  const { t } = useI18n();
  const view = taskView(task);
  if (view === 'idle') return <TaskBadge tone="pending">{idleLabel(task, now, t)}</TaskBadge>;
  if (view === 'kept') return <TaskBadge tone="neutral">{t('Kept')}</TaskBadge>;
  if (view === 'running') return <TaskBadge tone="ok">{t('Running')}</TaskBadge>;
  if (task.interrupted === 'restart')
    return <TaskBadge tone="pending">{t('Interrupted by restart')}</TaskBadge>;
  return null;
}

export function TaskNode({ task }: { task: BackgroundTaskInfo }) {
  if (taskView(task) === 'idle')
    return (
      <span className="relative flex size-[22px] shrink-0 items-center justify-center rounded-full border border-dashed border-warning/60 text-warning">
        <Moon className="size-3" />
      </span>
    );
  return (
    <StepNode
      icon={TerminalSquare}
      state={task.status === 'running' ? 'running' : task.status === 'failed' ? 'error' : 'ok'}
    />
  );
}

/** 保留理由：agent 的原样显示，用户手动保留的没写理由就显示保留时刻 */
export function keepText(task: BackgroundTaskInfo, t: T): string | undefined {
  const keep = task.keep;
  if (!keep) return undefined;
  const detail = keep.reason ?? clockText(keep.at);
  return keep.by === 'user'
    ? t('Kept by you · {{detail}}', { detail })
    : t('Kept: {{reason}}', { reason: detail });
}

export function KeepLine({ task, className }: { task: BackgroundTaskInfo; className?: string }) {
  const { t } = useI18n();
  const text = taskView(task) === 'kept' ? keepText(task, t) : undefined;
  if (!text) return null;
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground/85',
        className
      )}
    >
      <Pin className="size-3 shrink-0" />
      <span className="truncate" title={text}>
        {text}
      </span>
    </div>
  );
}

export function stopBackgroundTask(sessionId: string, taskId: string): void {
  void window.electronAPI.agent.stopTask(sessionId, taskId);
}

export function keepBackgroundTask(sessionId: string, taskId: string, reason: string | null): void {
  void window.electronAPI.agent.keepTask(sessionId, taskId, reason);
}

/** 带文字的停止：不用空心方块，免得和勾选框混淆 */
export function StopTaskButton({ onStop, className }: { onStop: () => void; className?: string }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onStop();
      }}
      title={t('Stop task')}
      className={cn(
        'flex h-6 shrink-0 items-center rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive',
        className
      )}
    >
      {t('Stop')}
    </button>
  );
}

/** 疑似闲置行内的「保留」「停止」；单个停止不确认 */
export function IdleActions({ sessionId, taskId }: { sessionId: string; taskId: string }) {
  const { t } = useI18n();
  return (
    <>
      <Button
        size="xs"
        variant="ghost"
        className="text-muted-foreground"
        onClick={(event) => {
          event.stopPropagation();
          keepBackgroundTask(sessionId, taskId, '');
        }}
      >
        {t('Keep')}
      </Button>
      <Button
        size="xs"
        variant="outline"
        className="hover:text-destructive"
        onClick={(event) => {
          event.stopPropagation();
          stopBackgroundTask(sessionId, taskId);
        }}
      >
        {t('Stop')}
      </Button>
    </>
  );
}
