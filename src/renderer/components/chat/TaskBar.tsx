import type { BackgroundTaskInfo } from '@shared/types/agent';
import { ChevronDown, Circle, Square, X } from 'lucide-react';
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
 * 后台任务状态行（grok-build 风）：输入框上方每任务一行；
 * 点「查看」在行下内嵌展开输出;done 5s 自动移除,failed 手动关闭。
 */
export function TaskBar({ sessionId, tasks }: TaskBarProps) {
  const { t } = useI18n();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

  // 结束的任务(done/failed)5s 后自动收起（展开中的不收）
  useEffect(() => {
    const doneTasks = tasks.filter(
      (task) =>
        task.status !== 'running' && !dismissed.has(task.taskId) && task.taskId !== openTaskId
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
  if (visible.length === 0) return null;

  const dismiss = (taskId: string) => {
    setDismissed((prev) => new Set(prev).add(taskId));
    if (openTaskId === taskId) setOpenTaskId(null);
  };

  const openTask = visible.find((task) => task.taskId === openTaskId) ?? null;

  return (
    <div className="relative mb-1 flex flex-col gap-0.5">
      {openTask && (
        <div className="absolute bottom-full left-0 right-0 z-30 mb-1.5 rounded-xl border bg-background/95 shadow-xl backdrop-blur-sm">
          <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs">
            <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
              {openTask.command}
            </span>
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
      {visible.map((task) => {
        const open = openTaskId === task.taskId;
        return (
          <div key={task.taskId} className="rounded-lg border border-border/60 bg-muted/20">
            <div className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
              <Circle
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full border-0',
                  STATUS_DOT[task.status]
                )}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                {task.command}
              </span>
              <TaskMeta task={task} />
              <button
                type="button"
                onClick={() => setOpenTaskId(open ? null : task.taskId)}
                className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {t('Output')}
                <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
              </button>
              {task.status === 'running' ? (
                <button
                  type="button"
                  onClick={() => void window.electronAPI.agent.stopTask(sessionId, task.taskId)}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-destructive transition-colors hover:bg-destructive/10"
                  title={t('Stop task')}
                >
                  <Square className="h-3 w-3" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => dismiss(task.taskId)}
                  className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TaskMeta({ task }: { task: BackgroundTaskInfo }) {
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
      className="max-h-56 overflow-auto border-t border-border/60 px-2.5 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground"
    >
      {tail || t('(no output yet)')}
    </pre>
  );
}
