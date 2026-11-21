import type { SecretaryScheduleView } from '@shared/types/secretary';
import { AlarmClock, Clock, Repeat, Sunrise, Trash2 } from 'lucide-react';
import { HOVER_ROW_CLASS, HoverActions } from '@/components/ui/hover-actions';
import { useI18n } from '@/i18n';
import { formatClock, formatRelativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';

function scheduleIcon(schedule: SecretaryScheduleView) {
  if (schedule.system === 'daily-brief') return <Sunrise className="size-3.5" />;
  if (schedule.system) return <AlarmClock className="size-3.5" />;
  return schedule.at ? <Clock className="size-3.5" /> : <Repeat className="size-3.5" />;
}

const when = (ts: number, locale: string) =>
  `${formatRelativeTime(ts, locale)} ${formatClock(ts, locale)}`;

/** 一行说明：来源（系统 / 待办 / 一次性 / 重复）加上下一次与上一次触发 */
function scheduleDetail(
  schedule: SecretaryScheduleView,
  t: (key: string, params?: Record<string, string | number>) => string,
  locale: string
): string {
  const parts: string[] = [];
  if (schedule.system === 'daily-brief') {
    parts.push(
      t('Every day at {{time}}', { time: formatClock(schedule.nextRunAt ?? Date.now(), locale) })
    );
  } else {
    parts.push(schedule.system ? t('From a to-do') : schedule.at ? t('One-off') : t('Repeats'));
    if (schedule.nextRunAt !== undefined) parts.push(when(schedule.nextRunAt, locale));
  }
  if (schedule.lastFiredAt !== undefined) {
    parts.push(t('Last run {{time}}', { time: when(schedule.lastFiredAt, locale) }));
  }
  return parts.join(' · ');
}

function ScheduleRow({
  schedule,
  onRemove,
}: {
  schedule: SecretaryScheduleView;
  onRemove?: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  return (
    <div
      data-enso="secretary-schedule"
      data-system={schedule.system !== undefined || undefined}
      className={cn(HOVER_ROW_CLASS, 'flex items-start gap-2.5 rounded-lg px-1.5 py-2')}
    >
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-subtle-foreground">
        {scheduleIcon(schedule)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px]">{schedule.name}</p>
        <p className="mt-0.5 text-[11.5px] text-muted-foreground">
          {scheduleDetail(schedule, t, locale)}
        </p>
      </div>
      {onRemove && (
        <HoverActions>
          <button
            type="button"
            title={t('Delete')}
            aria-label={t('Delete')}
            onClick={() => onRemove(schedule.id)}
            className="flex size-5 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
          </button>
        </HoverActions>
      )}
    </div>
  );
}

/** 定时：系统派生的条目只读，秘书帮你定的可以删 */
export function SecretarySchedulePanel({
  schedules,
  name,
  onReload,
  secretaryId,
}: {
  schedules: SecretaryScheduleView[];
  name: string;
  onReload: () => void;
  secretaryId?: string;
}) {
  const { t } = useI18n();
  const system = schedules.filter((schedule) => schedule.system !== undefined);
  const mine = schedules.filter((schedule) => schedule.system === undefined);
  const remove = (id: string) => {
    void window.electronAPI.secretary.removeSchedule(id, secretaryId).then(onReload);
  };
  return (
    <div data-enso="secretary-schedules" className="flex flex-col gap-1 px-3 py-3">
      {system.length > 0 && (
        <section className="flex flex-col">
          <h3 className="px-1.5 pb-1 text-[12px] text-subtle-foreground">{t('System')}</h3>
          {system.map((schedule) => (
            <ScheduleRow key={schedule.id} schedule={schedule} />
          ))}
        </section>
      )}
      {mine.length > 0 && (
        <section className="flex flex-col">
          <h3 className="px-1.5 pb-1 text-[12px] text-subtle-foreground">
            {t('Scheduled by {{name}}', { name })}
          </h3>
          {mine.map((schedule) => (
            <ScheduleRow key={schedule.id} schedule={schedule} onRemove={remove} />
          ))}
        </section>
      )}
      <p className="px-1.5 pt-2 text-[11.5px] text-subtle-foreground">
        {t('To add a schedule, just tell {{name}}', { name })}
      </p>
    </div>
  );
}
