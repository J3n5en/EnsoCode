import type { BackgroundTaskInfo } from '@shared/types/agent';
import { Activity, ArrowUpRight, Moon } from 'lucide-react';
import {
  IdleActions,
  idleLabel,
  KeepLine,
  StopTaskButton,
  shortSpan,
  stopBackgroundTask,
  TaskNode,
  taskView,
  useNow,
} from '@/components/chat/backgroundTaskUi';
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from '@/components/ui/preview-card';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { openBackgroundTasks, useBackgroundTasksView } from '@/stores/backgroundTasksView';
import { useSessionsStore } from '@/stores/sessions';
import { countTasks } from './overview';

const EMPTY: readonly BackgroundTaskInfo[] = [];

/** 计数：脉冲 = 在跑（灰），月亮 = 疑似闲置（琥珀），两种都有时并排 */
export function TaskCounts({ running, idle }: { running: number; idle: number }) {
  const { t } = useI18n();
  if (running === 0 && idle === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[10px] tabular-nums text-muted-foreground/70">
      {running > 0 && (
        <span
          className="inline-flex items-center gap-0.5"
          title={t('{{n}} background tasks running', { n: running })}
        >
          <Activity className="h-3 w-3" aria-hidden />
          {running}
        </span>
      )}
      {idle > 0 && (
        <span
          className="inline-flex items-center gap-0.5 text-warning"
          title={t('{{n}} suspected idle', { n: idle })}
        >
          <Moon className="h-3 w-3" aria-hidden />
          {idle}
        </span>
      )}
    </span>
  );
}

/** 侧栏会话行的后台任务标记；悬停弹出任务卡，未打开的会话也能直接停 */
export function BackgroundTaskMarker({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const tasks = useSessionsStore(
    (state) => state.conversations[conversationId]?.backgroundTasks ?? EMPTY
  );
  const title = useSessionsStore((state) => state.conversations[conversationId]?.title);
  const unopened = useSessionsStore((state) => !state.conversations[conversationId]?.generation);
  const { running, idle } = countTasks(tasks);
  if (running === 0 && idle === 0) return null;
  const live = tasks.filter((task) => task.status === 'running');
  const firstIdle = live.find((task) => task.idle);
  const ports = firstIdle?.idle?.ports ?? [];
  return (
    <PreviewCard>
      <PreviewCardTrigger
        render={<span data-enso="session-task-marker" className="flex shrink-0 items-center" />}
      >
        <TaskCounts running={running} idle={idle} />
      </PreviewCardTrigger>
      <PreviewCardPopup
        align="start"
        className="w-[340px] flex-col p-1 text-[13px]"
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-1.5 px-1.5 pt-1 pb-1.5 text-[11px] text-muted-foreground">
          <span className="min-w-0 truncate">
            {t('Background tasks of {{title}}', { title: title || t('New conversation') })}
          </span>
          {unopened && (
            <span className="shrink-0 rounded bg-muted px-1 text-[10px]">
              {t('Session not open')}
            </span>
          )}
        </div>
        {live.map((task) => (
          <MiniTaskRow key={task.taskId} conversationId={conversationId} task={task} />
        ))}
        <div className="mt-1 flex items-center gap-3 border-t border-border/60 px-1.5 pt-1.5 pb-0.5 text-[11px] text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">
            {firstIdle
              ? ports.length > 0
                ? t('Port {{ports}} has no connections · CPU 0%', { ports: ports.join(', ') })
                : 'CPU 0%'
              : ''}
          </span>
          <button
            type="button"
            onClick={() => openBackgroundTasks()}
            className="inline-flex shrink-0 items-center gap-0.5 text-foreground/80 hover:text-foreground"
          >
            {t('All tasks')}
            <ArrowUpRight className="size-3" />
          </button>
        </div>
      </PreviewCardPopup>
    </PreviewCard>
  );
}

function MiniTaskRow({
  conversationId,
  task,
}: {
  conversationId: string;
  task: BackgroundTaskInfo;
}) {
  const { t } = useI18n();
  const now = useNow();
  const view = taskView(task);
  return (
    <div className="flex min-h-[30px] min-w-0 items-center gap-2 rounded-lg px-1.5 py-0.5">
      <TaskNode task={task} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs text-muted-foreground" title={task.command}>
          {task.command}
        </div>
        {view === 'idle' ? (
          <div className="mt-0.5 text-[11px] text-warning">{idleLabel(task, now, t)}</div>
        ) : view === 'kept' ? (
          <KeepLine task={task} className="mt-0.5" />
        ) : (
          <div className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
            {t('Running for {{duration}}', { duration: shortSpan(now - task.startedAt) })}
          </div>
        )}
      </div>
      {view === 'idle' ? (
        <IdleActions sessionId={conversationId} taskId={task.taskId} />
      ) : (
        <StopTaskButton onStop={() => stopBackgroundTask(conversationId, task.taskId)} />
      )}
    </div>
  );
}

/** 侧栏秘书下方的「后台任务」入口：没有在跑的任务时整行隐藏 */
export function BackgroundTasksEntry() {
  const { t } = useI18n();
  const active = useBackgroundTasksView((state) => state.open);
  const counts = useSessionsStore((state) => {
    let running = 0;
    let idle = 0;
    for (const conversation of Object.values(state.conversations)) {
      const own = countTasks(conversation?.backgroundTasks);
      running += own.running;
      idle += own.idle;
    }
    return `${running}:${idle}`;
  });
  const [running, idle] = counts.split(':').map(Number) as [number, number];
  if (running + idle === 0) return null;
  return (
    <button
      type="button"
      data-enso="background-tasks-entry"
      data-active={active || undefined}
      onClick={() => openBackgroundTasks()}
      className={cn(
        'flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[0.9286rem] transition-colors',
        active
          ? 'bg-foreground/[0.075] text-foreground dark:bg-foreground/10'
          : 'text-foreground/88 hover:bg-foreground/5 hover:text-foreground'
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
        <Activity className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate">{t('Background tasks')}</span>
      {idle > 0 && (
        <span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] tabular-nums text-warning">
          <Moon className="h-3 w-3" aria-hidden />
          {idle}
        </span>
      )}
      <span className="shrink-0 text-[0.7857rem] text-subtle-foreground tabular-nums">
        {running + idle}
      </span>
    </button>
  );
}
