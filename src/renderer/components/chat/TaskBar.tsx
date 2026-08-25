import type { BackgroundTaskInfo } from '@shared/types/agent';
import { Square, TerminalSquare, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { formatDuration } from '@/stores/sessions/stats';

interface TaskBarProps {
  sessionId: string;
  tasks: BackgroundTaskInfo[];
}

const STATUS_DOT = {
  running: 'bg-green-500 animate-pulse',
  done: 'bg-blue-500',
  failed: 'bg-destructive',
} as const;

/**
 * 后台任务胶囊条（EnsoAI SessionBar 视觉）：时间线顶部居中悬浮；
 * 有任务才出现；点击胶囊展开输出面板。
 */
export function TaskBar({ sessionId, tasks }: TaskBarProps) {
  const { t } = useI18n();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

  // done 的任务 5s 后自动收起（面板开着的不收）；failed 保留让用户看到,手动关闭
  useEffect(() => {
    const doneTasks = tasks.filter(
      (task) => task.status === 'done' && !dismissed.has(task.taskId) && task.taskId !== openTaskId
    );
    if (doneTasks.length === 0) return;
    const timer = setTimeout(() => {
      setDismissed((prev) => {
        const next = new Set(prev);
        for (const task of doneTasks) next.add(task.taskId);
        return next;
      });
    }, 5000);
    return () => clearTimeout(timer);
  }, [tasks, dismissed, openTaskId]);

  const visible = tasks.filter((task) => !dismissed.has(task.taskId));
  const openTask = visible.find((task) => task.taskId === openTaskId) ?? null;
  if (visible.length === 0) return null;

  const dismiss = (taskId: string) => {
    setDismissed((prev) => new Set(prev).add(taskId));
    if (openTaskId === taskId) setOpenTaskId(null);
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex flex-col items-center gap-1.5">
      <div className="pointer-events-auto flex min-w-fit flex-nowrap items-center gap-1 rounded-full border bg-background/80 px-2 py-1.5 shadow-lg backdrop-blur-sm">
        {visible.map((task) => (
          <button
            key={task.taskId}
            type="button"
            onClick={() => setOpenTaskId(openTaskId === task.taskId ? null : task.taskId)}
            className={cn(
              'group flex items-center gap-1.5 rounded-full px-3 py-1 text-sm transition-colors',
              openTaskId === task.taskId
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
            )}
          >
            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[task.status])} />
            <TerminalSquare className="h-3.5 w-3.5 shrink-0" />
            <span className="max-w-40 truncate font-mono text-xs">{task.command}</span>
            {task.status !== 'running' && (
              <span
                role="button"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  dismiss(task.taskId);
                }}
                className="flex h-4 w-4 items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-100 hover:bg-destructive/20 hover:text-destructive"
              >
                <X className="h-3 w-3" />
              </span>
            )}
          </button>
        ))}
      </div>

      {openTask && (
        <div className="pointer-events-auto w-[min(40rem,90%)] rounded-xl border bg-background/95 shadow-xl backdrop-blur-sm">
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <span
              className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[openTask.status])}
            />
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{openTask.command}</span>
            <ElapsedOrExit task={openTask} />
            {openTask.status === 'running' && (
              <button
                type="button"
                onClick={() => void window.electronAPI.agent.stopTask(sessionId, openTask.taskId)}
                className="flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs text-destructive transition-colors hover:bg-destructive/10"
                title={t('Stop task')}
              >
                <Square className="h-3 w-3" />
                {t('Stop')}
              </button>
            )}
            <button
              type="button"
              onClick={() => setOpenTaskId(null)}
              className="rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <TailView tail={openTask.tail} />
        </div>
      )}
    </div>
  );
}

/** 输出尾部：等宽流式,新内容自动贴底 */
function TailView({ tail }: { tail: string }) {
  const { t } = useI18n();
  const ref = useRef<HTMLPreElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tail 变化时贴底
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tail]);
  return (
    <pre
      ref={ref}
      className="max-h-64 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground"
    >
      {tail || t('(no output yet)')}
    </pre>
  );
}

function ElapsedOrExit({ task }: { task: BackgroundTaskInfo }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (task.status !== 'running') return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [task.status]);
  return (
    <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
      {task.status === 'running'
        ? formatDuration(Date.now() - task.startedAt)
        : task.exitCode !== undefined
          ? `exit ${task.exitCode}`
          : task.status}
    </span>
  );
}
