import { Activity } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { openBackgroundTasks, useBackgroundTasksView } from '@/stores/backgroundTasksView';
import { useSessionsStore } from '@/stores/sessions';
import { countTasks } from './overview';

/** 侧栏底栏与折叠栏的「后台任务」入口：与归档同款小图标+角标；没有在跑的任务时隐藏 */
export function BackgroundTasksButton({ className }: { className?: string }) {
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
  return (
    <BackgroundTasksButtonView
      running={running}
      idle={idle}
      active={active}
      onClick={() => openBackgroundTasks()}
      className={className}
    />
  );
}

export function BackgroundTasksButtonView({
  running,
  idle,
  active,
  onClick,
  className,
}: {
  running: number;
  idle: number;
  active: boolean;
  onClick: () => void;
  className?: string;
}) {
  const { t } = useI18n();
  const total = running + idle;
  if (total === 0) return null;
  const label =
    idle > 0
      ? `${t('Background tasks')} (${total}) · ${t('{{n}} suspected idle', { n: idle })}`
      : `${t('Background tasks')} (${total})`;
  return (
    <button
      type="button"
      data-enso="background-tasks-entry"
      data-active={active || undefined}
      aria-pressed={active}
      onClick={onClick}
      className={cn('relative', className, active && 'text-foreground')}
      title={label}
      aria-label={label}
    >
      <Activity className="h-4 w-4" />
      <span
        data-slot="background-tasks-count"
        data-idle={idle > 0 || undefined}
        className={cn(
          'absolute top-0.5 right-0 min-w-3.5 rounded-full bg-muted px-[3px] text-center font-medium text-[9px] leading-3.5 tabular-nums',
          idle > 0 ? 'text-warning' : 'text-muted-foreground'
        )}
      >
        {total > 99 ? '99+' : total}
      </span>
    </button>
  );
}
