import type { AssetOccupancyRow } from '@shared/types';
import { formatTokens } from '@shared/usage/format';
import * as React from 'react';
import { useI18n } from '@/i18n';

export function occupancyMap(rows: AssetOccupancyRow[]): Record<string, AssetOccupancyRow> {
  return Object.fromEntries(rows.map((row) => [row.id, row]));
}

export function enabledOccupancyTotal(
  ids: readonly string[],
  rows: Record<string, AssetOccupancyRow>
): number {
  return ids.reduce((sum, id) => {
    const tokens = rows[id]?.tokens;
    return tokens == null ? sum : sum + tokens;
  }, 0);
}

export function OccupancyMark({ row, pending }: { row?: AssetOccupancyRow; pending?: boolean }) {
  const { t } = useI18n();
  const label = pending ? '…' : row?.tokens == null ? '—' : formatTokens(row.tokens);
  return (
    <span
      className="w-12 shrink-0 text-right text-muted-foreground text-xs tabular-nums"
      title={row?.error || t('Estimate')}
    >
      {label}
    </span>
  );
}

export function OccupancyEnabledTotal({ tokens }: { tokens: number }) {
  if (tokens <= 0) return null;
  return (
    <span className="ml-2 font-normal text-muted-foreground text-xs tabular-nums">
      {formatTokens(tokens)}
    </span>
  );
}

export function useOccupancyRows(
  ids: readonly string[],
  load: (ids: string[]) => Promise<AssetOccupancyRow[]>
): { rows: Record<string, AssetOccupancyRow>; pending: boolean } {
  const [rows, setRows] = React.useState<Record<string, AssetOccupancyRow>>({});
  const [pending, setPending] = React.useState(() => ids.length > 0);
  const key = ids.join('\0');
  const loadRef = React.useRef(load);
  loadRef.current = load;
  React.useEffect(() => {
    let cancelled = false;
    const currentIds = key.length === 0 ? [] : key.split('\0');
    if (currentIds.length === 0) {
      setRows({});
      setPending(false);
      return;
    }
    setPending(true);
    void loadRef
      .current(currentIds)
      .then((list) => {
        if (cancelled) return;
        setRows(occupancyMap(list));
      })
      .finally(() => {
        if (!cancelled) setPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return { rows, pending };
}
