import { formatReminderClock, formatReminderTooltip } from '@shared/reminders';
import { Clock } from 'lucide-react';
import { useI18n } from '@/i18n';
import { usePendingReminder } from '@/stores/sessionReminders';

/** 侧栏会话行的等提醒标记：空闲且挂着未到点 remind_me 时显示静态时钟与钟点，悬停看完整 label 与剩余时间 */
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
  return (
    <span
      data-enso="sidebar-reminder-waiting"
      className="inline-flex shrink-0 items-center gap-1 rounded bg-sky-500/15 px-1 py-px text-[10px] text-sky-600 tabular-nums dark:text-sky-400"
      title={tooltip}
    >
      <Clock className="h-2.5 w-2.5 shrink-0" aria-hidden />
      <span>
        {t('Waiting for reminder · {{time}}', { time: formatReminderClock(reminder.dueAt) })}
      </span>
    </span>
  );
}
