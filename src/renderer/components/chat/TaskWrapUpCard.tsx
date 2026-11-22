import type { TaskWrapUpItem } from '@shared/turnNotes';
import type { BackgroundTaskInfo } from '@shared/types/agent';
import { ArrowUpRight, Hourglass } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { NOTICE_FRAME, NOTICE_ICON } from './injectedVisual';

/**
 * 宿主在回合收尾后搭在下一条消息前的后台任务清单：默认一行摘要，展开逐条列任务。
 * 给模型的指令不显示；任务还在本会话里跑时可跳到任务条看输出。
 */
export function TaskWrapUpCard({
  items,
  live = [],
  onOpen,
}: {
  items: readonly TaskWrapUpItem[];
  /** 当前会话的后台任务：取完整命令、判断能否跳转 */
  live?: readonly BackgroundTaskInfo[];
  onOpen?: (taskId: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div data-enso="task-wrap-up" data-open={open ? 'true' : 'false'} className={NOTICE_FRAME}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-start gap-2 text-left hover:text-foreground"
      >
        <Hourglass className={NOTICE_ICON} />
        <span className="min-w-0 flex-1">
          {t('{{count}} background tasks to wrap up: stop them or say why they keep running', {
            count: items.length,
          })}
        </span>
      </button>
      {open && (
        <ul className="mt-1.5 space-y-1.5 border-t border-border/60 pt-1.5">
          {items.map((item) => {
            const task = live.find((candidate) => candidate.taskId === item.taskId);
            return (
              <TaskWrapUpRow
                key={item.taskId}
                item={item}
                command={task?.command ?? item.command}
                onOpen={task?.status === 'running' ? onOpen : undefined}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}

function TaskWrapUpRow({
  item,
  command,
  onOpen,
}: {
  item: TaskWrapUpItem;
  command: string;
  onOpen?: (taskId: string) => void;
}) {
  const { t } = useI18n();
  const [full, setFull] = useState(false);
  return (
    <li data-enso="task-wrap-up-item" data-task-id={item.taskId} className="flex min-w-0 gap-2">
      <button
        type="button"
        aria-expanded={full}
        onClick={() => setFull((value) => !value)}
        className="min-w-0 flex-1 text-left hover:text-foreground"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate font-mono text-[11px] text-foreground">
            {item.taskId}
          </span>
          {item.ran && (
            <span className="shrink-0">
              {t('Running for {{duration}}', { duration: item.ran })}
            </span>
          )}
        </span>
        <span
          data-enso="task-wrap-up-command"
          title={command}
          className={cn(
            'block font-mono text-[11px]',
            full ? 'whitespace-pre-wrap break-all' : 'truncate'
          )}
        >
          {command}
        </span>
      </button>
      {onOpen && (
        <button
          type="button"
          data-enso="task-wrap-up-open"
          title={t('Show in task bar')}
          aria-label={t('Show in task bar')}
          onClick={() => onOpen(item.taskId)}
          className="flex size-5 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowUpRight className="h-3.5 w-3.5" />
        </button>
      )}
    </li>
  );
}
