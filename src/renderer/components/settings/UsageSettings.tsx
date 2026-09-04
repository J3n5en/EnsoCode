import { formatCost, formatDelta, formatDurationMs, formatTokens } from '@shared/usage/format';
import {
  USAGE_RANGE_DAYS,
  type UsageRangeDays,
  type UsageSummary,
  type UsageTotals,
} from '@shared/usage/types';
import { RefreshCw } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { DailyTrendChart } from './usage/DailyTrendChart';
import { HourlyHeatmap } from './usage/HourlyHeatmap';
import { RankingTable } from './usage/RankingTable';
import { StatCard } from './usage/StatCard';
import { UsagePricingEditor } from './usage/UsagePricingEditor';

const RANGE_LABEL_KEYS: Record<UsageRangeDays, string> = {
  1: 'Today',
  7: '7D',
  30: '30D',
  90: '90D',
};

/** 用量：本机 pi 会话的 token 统计与按 catalog 估算的费用。只读，不联网。 */
export function UsageSettings() {
  const { t } = useI18n();
  const [days, setDays] = React.useState<UsageRangeDays>(7);
  const [summary, setSummary] = React.useState<UsageSummary | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  // latest-wins：快速切换周期时，慢响应不得覆盖新周期的结果
  const requestId = React.useRef(0);

  const load = React.useCallback(async (range: UsageRangeDays) => {
    const id = ++requestId.current;
    setLoading(true);
    const result = await window.electronAPI.usage.summary(range);
    if (id !== requestId.current) return;
    setLoading(false);
    if (result.ok) {
      setSummary(result.summary);
      setError(null);
    } else {
      setSummary(null);
      setError(result.error);
    }
  }, []);

  React.useEffect(() => {
    void load(days);
  }, [days, load]);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-medium">{t('Usage')}</h3>
          <p className="text-sm text-muted-foreground">
            {t('Token usage across all local sessions; cost is estimated from catalog prices.')}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void load(days)}
          disabled={loading}
          aria-label={t('Refresh')}
        >
          <RefreshCw className={cn(loading && 'animate-spin')} />
        </Button>
      </div>

      <RangePills value={days} onChange={setDays} />

      {error && <p className="text-sm text-destructive">{error}</p>}

      {summary && (
        <>
          <StatGrid totals={summary.totals} previous={summary.previous} />
          <DailyTrendChart daily={summary.daily} />
          <HourlyHeatmap heatmap={summary.heatmap} />
          <div className="grid gap-4 xl:grid-cols-2">
            <RankingTable
              title={t('By model')}
              countLabel={t('Messages')}
              emptyLabel={t('No usage in this period')}
              rows={summary.byModel.map((row) => ({
                key: row.model,
                name: row.model,
                cost: row.cost,
                tokens: row.tokens,
                count: row.messages,
              }))}
            />
            <RankingTable
              title={t('By project')}
              countLabel={t('Sessions')}
              emptyLabel={t('No usage in this period')}
              rows={summary.byProject.map((row) => ({
                key: row.project || '#',
                name: row.project,
                cost: row.cost,
                tokens: row.tokens,
                count: row.sessions,
              }))}
            />
          </div>
          {summary.unpricedModels.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {t('No catalog price for: {{models}}. Their cost is not included.', {
                models: summary.unpricedModels.join(', '),
              })}
            </p>
          )}
        </>
      )}
      <UsagePricingEditor
        models={summary?.byModel ?? []}
        catalog={summary?.pricing ?? {}}
        onChanged={() => void load(days)}
      />
    </div>
  );
}

function RangePills({
  value,
  onChange,
}: {
  value: UsageRangeDays;
  onChange: (days: UsageRangeDays) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-1.5">
      {USAGE_RANGE_DAYS.map((days) => (
        <button
          key={days}
          type="button"
          onClick={() => onChange(days)}
          className={cn(
            'rounded-full px-3 py-1 font-mono text-xs transition-colors',
            value === days
              ? 'bg-foreground text-background'
              : 'bg-muted text-muted-foreground hover:text-foreground'
          )}
        >
          {t(RANGE_LABEL_KEYS[days])}
        </button>
      ))}
    </div>
  );
}

function StatGrid({ totals, previous }: { totals: UsageTotals; previous: UsageTotals }) {
  const { t } = useI18n();
  const cache = totals.cacheRead + totals.cacheWrite;
  const prevCache = previous.cacheRead + previous.cacheWrite;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <StatCard
        label={t('Estimated cost')}
        value={formatCost(totals.cost)}
        delta={formatDelta(previous.cost, totals.cost)}
        tone="success"
      />
      <StatCard
        label={t('Total tokens')}
        value={formatTokens(totals.tokens)}
        delta={formatDelta(previous.tokens, totals.tokens)}
      />
      <StatCard
        label={t('Input tokens')}
        value={formatTokens(totals.input)}
        delta={formatDelta(previous.input, totals.input)}
      />
      <StatCard
        label={t('Output tokens')}
        value={formatTokens(totals.output)}
        delta={formatDelta(previous.output, totals.output)}
      />
      <StatCard
        label={t('Cache tokens')}
        value={formatTokens(cache)}
        delta={formatDelta(prevCache, cache)}
        tone="muted"
      />
      <StatCard
        label={t('Active time')}
        value={formatDurationMs(totals.activeMs)}
        delta={formatDelta(previous.activeMs, totals.activeMs)}
        tone="info"
      />
      <StatCard
        label={t('Sessions')}
        value={String(totals.sessions)}
        delta={formatDelta(previous.sessions, totals.sessions)}
      />
      <StatCard
        label={t('Messages')}
        value={totals.messages.toLocaleString()}
        delta={formatDelta(previous.messages, totals.messages)}
      />
    </div>
  );
}
