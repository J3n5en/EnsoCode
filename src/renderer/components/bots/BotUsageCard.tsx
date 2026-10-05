import type { BotProfile } from '@shared/types/bot';
import type { BotUsageTotals } from '@shared/usage/botUsage';
import { formatCost, formatTokens } from '@shared/usage/format';
import { useEffect } from 'react';
import { useI18n } from '@/i18n';
import { useBotsStore } from '@/stores/bots';

/** 资料面板：成员今日 / 近 7 天 / 近 30 天的 token 与估算成本，以及今日预算进度 */
export function BotUsageCard({ bot }: { bot: BotProfile }) {
  const { t } = useI18n();
  const overview = useBotsStore((s) => s.usage?.bots[bot.id]);
  useEffect(() => {
    void useBotsStore.getState().refreshUsage();
  }, []);
  if (!overview) return null;
  const cells: Array<[string, BotUsageTotals]> = [
    [t('Today'), overview.today],
    [t('Last 7 days'), overview.week],
    [t('Last 30 days'), overview.month],
  ];
  const budget = bot.budget;
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="grid grid-cols-3 gap-2">
        {cells.map(([label, totals]) => (
          <div key={label} className="min-w-0">
            <div className="text-muted-foreground text-xs">{label}</div>
            <div className="truncate font-medium text-sm tabular-nums">
              {formatTokens(totals.tokens)}
            </div>
            <div className="truncate text-muted-foreground text-xs tabular-nums">
              {formatCost(totals.cost)}
            </div>
          </div>
        ))}
      </div>
      {budget && (
        <div
          className={
            overview.exhausted
              ? 'mt-2 text-destructive text-xs'
              : 'mt-2 text-muted-foreground text-xs'
          }
        >
          {[
            budget.dailyTokens !== undefined &&
              `${formatTokens(overview.today.tokens)} / ${formatTokens(budget.dailyTokens)} tokens`,
            budget.dailyCostUsd !== undefined &&
              `${formatCost(overview.today.cost ?? 0)} / ${formatCost(budget.dailyCostUsd)}`,
          ]
            .filter(Boolean)
            .join(' · ')}
          {overview.exhausted && ` · ${t("Today's budget is used up")}`}
        </div>
      )}
    </div>
  );
}
