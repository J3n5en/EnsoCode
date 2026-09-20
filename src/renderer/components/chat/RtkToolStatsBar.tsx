import { parseRtkToolStats, type RtkToolStats } from '@shared/rtk';
import { useI18n } from '@/i18n';
import { formatTokens } from '@/stores/sessions/stats';
import { rtkSavings } from './rtkToolStats';

const STATUS_LABELS: Record<RtkToolStats['status'], string> = {
  compressed: 'Compressed',
  unchanged: 'Unchanged',
  pending: 'Background task started',
  bypassed: 'Bypassed',
  unavailable: 'Unavailable',
};

export function RtkToolStatsBar({ value }: { value: unknown }) {
  const stats = parseRtkToolStats(value);
  const { t } = useI18n();
  if (!stats) return null;

  const savings = rtkSavings(stats);
  return (
    <div
      className="border-border/60 border-t text-[10px] text-muted-foreground"
      data-rtk-status={stats.status}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 px-3 py-1">
        <span className="font-semibold tracking-wide text-foreground/75">RTK</span>
        <span aria-hidden="true">·</span>
        <span>{t(STATUS_LABELS[stats.status])}</span>
        {savings && (
          <>
            <span aria-hidden="true">·</span>
            <span>{t('~{{count}} tokens saved', { count: formatTokens(savings.tokens) })}</span>
            {savings.percent !== null && <span>({savings.percent}%)</span>}
          </>
        )}
      </div>
      <div className="space-y-2 px-3 pb-2">
        {stats.status === 'pending' && (
          <p className="rounded bg-muted/40 px-2 py-1 text-foreground/80">
            {t('This is the startup receipt; see the task_output result for final statistics.')}
          </p>
        )}
        {(stats.inputTokens !== undefined || stats.reason) && (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            {stats.inputTokens !== undefined && stats.outputTokens !== undefined && (
              <>
                <dt>{t('Input estimate')}</dt>
                <dd className="font-mono text-foreground/80">
                  {t('{{count}} tokens', { count: formatTokens(stats.inputTokens) })}
                </dd>
                <dt>{t('Output estimate')}</dt>
                <dd className="font-mono text-foreground/80">
                  {t('{{count}} tokens', { count: formatTokens(stats.outputTokens) })}
                </dd>
              </>
            )}
            {stats.reason && (
              <>
                <dt>{t('Reason')}</dt>
                <dd className="min-w-0 whitespace-pre-wrap text-foreground/80">{stats.reason}</dd>
              </>
            )}
          </dl>
        )}
      </div>
    </div>
  );
}
