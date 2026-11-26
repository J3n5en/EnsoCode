import { formatReminderClock, formatReminderTooltip } from '@shared/reminders';
import { Clock } from 'lucide-react';
import { useI18n } from '@/i18n';
import { usePendingReminder } from '@/stores/sessionReminders';

/** 侧栏会话行的等提醒标记：默认仅蓝色时钟图标，行 hover 才展开完整文字；悬停 tooltip 看完整 label 与剩余时间 */
export function ReminderMarker({
  conversationId,
  running,
  hidden = false,
}: {
  conversationId: string;
  running: boolean;
  hidden?: boolean;
}) {
  const { t } = useI18n();
  const { reminder, now } = usePendingReminder(conversationId, !running && !hidden);
  if (!reminder) return null;
  const tooltip = formatReminderTooltip(reminder, now, t);
  const label =
    reminder.count > 1
      ? t('Waiting for reminder ×{{count}}', { count: reminder.count })
      : t('Waiting for reminder · {{time}}', { time: formatReminderClock(reminder.dueAt) });
  return (
    <span
      data-enso="sidebar-reminder-waiting"
      className="inline-flex shrink-0 items-center rounded bg-sky-500/15 px-1 py-px text-[10px] text-sky-600 tabular-nums dark:text-sky-400"
      title={tooltip}
    >
      <Clock className="h-2.5 w-2.5 shrink-0" aria-hidden />
      <span
        data-enso="sidebar-reminder-label"
        className="max-w-0 overflow-hidden whitespace-nowrap transition-[max-width,padding] duration-200 group-hover:pl-1 group-hover:max-w-40"
      >
        {label}
      </span>
    </span>
  );
}
