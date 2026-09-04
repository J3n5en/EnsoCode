import { formatTokens } from '@shared/usage/format';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

const WEEKDAY_KEYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const HOURS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0'));
const LEVELS = [
  'bg-foreground/[0.06]',
  'bg-foreground/20',
  'bg-foreground/40',
  'bg-foreground/60',
  'bg-foreground/80',
  'bg-foreground',
] as const;

function levelOf(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return 1 + Math.min(LEVELS.length - 2, Math.floor((value / max) * (LEVELS.length - 1)));
}

/** 7×24 活跃热力图，值为 tokens；颜色按与峰值的比例分 5 档。 */
export function HourlyHeatmap({ heatmap }: { heatmap: number[][] }) {
  const { t } = useI18n();
  const max = Math.max(0, ...heatmap.flat());
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-medium">{t('Activity by hour')}</span>
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <span>{t('Less')}</span>
          {LEVELS.map((cls) => (
            <span key={cls} className={cn('inline-block h-2.5 w-2.5 rounded-[2px]', cls)} />
          ))}
          <span>{t('More')}</span>
        </div>
      </div>
      <div className="grid grid-cols-[28px_1fr] gap-x-2 gap-y-1">
        {heatmap.map((row, weekday) => (
          <div key={WEEKDAY_KEYS[weekday]} className="contents">
            <span className="self-center text-[10px] text-muted-foreground">
              {t(WEEKDAY_KEYS[weekday])}
            </span>
            <div className="grid grid-cols-24 gap-[3px]">
              {HOURS.map((label, hour) => (
                <span
                  key={label}
                  title={`${t(WEEKDAY_KEYS[weekday])} ${label}:00 · ${formatTokens(row[hour] ?? 0)}`}
                  className={cn(
                    'aspect-square rounded-[2px]',
                    LEVELS[levelOf(row[hour] ?? 0, max)]
                  )}
                />
              ))}
            </div>
          </div>
        ))}
        <span />
        <div className="grid grid-cols-24 font-mono text-[10px] text-muted-foreground">
          {HOURS.map((label, hour) => (
            <span key={label} className={cn(hour % 3 !== 0 && 'invisible')}>
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
