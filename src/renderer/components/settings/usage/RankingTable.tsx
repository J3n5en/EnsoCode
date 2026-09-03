import { formatCost, formatTokens } from '@shared/usage/format';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

export interface RankingRow {
  key: string;
  name: string;
  cost: number | null;
  tokens: number;
  /** 第三列（消息数 / 会话数） */
  count: number;
}

interface RankingTableProps {
  title: string;
  countLabel: string;
  rows: RankingRow[];
  emptyLabel: string;
  limit?: number;
}

/** 排行表：名称 + 占比条 | 费用 | Tokens | 计数。占比按表内 tokens 总量。 */
export function RankingTable({
  title,
  countLabel,
  rows,
  emptyLabel,
  limit = 8,
}: RankingTableProps) {
  const { t } = useI18n();
  const total = rows.reduce((sum, row) => sum + row.tokens, 0);
  const visible = rows.slice(0, limit);
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-medium">{title}</span>
        {rows.length > limit && (
          <span className="text-[11px] text-muted-foreground">
            {t('Top {{count}} of {{total}}', { count: limit, total: rows.length })}
          </span>
        )}
      </div>
      {visible.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">{emptyLabel}</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[11px] text-muted-foreground">
              <th className="pb-2 text-left font-normal">{t('Name')}</th>
              <th className="pb-2 text-right font-normal">{t('Cost')}</th>
              <th className="pb-2 text-right font-normal">{t('Token')}</th>
              <th className="pb-2 text-right font-normal">{countLabel}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const share = total > 0 ? row.tokens / total : 0;
              return (
                <tr key={row.key} className="border-t border-border/60">
                  <td className="py-2 pr-3">
                    <div className="truncate" title={row.name}>
                      {row.name || t('(no project)')}
                    </div>
                    <div className="mt-1 h-1 w-full rounded-full bg-foreground/[0.06]">
                      <div
                        className="h-1 rounded-full bg-foreground/70"
                        style={{ width: `${Math.max(1, share * 100)}%` }}
                      />
                    </div>
                  </td>
                  <td
                    className={cn(
                      'py-2 text-right font-mono tabular-nums',
                      row.cost === null && 'text-muted-foreground'
                    )}
                  >
                    {formatCost(row.cost)}
                  </td>
                  <td className="py-2 text-right font-mono tabular-nums">
                    {formatTokens(row.tokens)}
                    <span className="ml-1 text-muted-foreground">{(share * 100).toFixed(0)}%</span>
                  </td>
                  <td className="py-2 text-right font-mono tabular-nums">{row.count}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
