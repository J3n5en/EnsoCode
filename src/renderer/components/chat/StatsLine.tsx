import type { ProjectedMessage } from '@shared/types/agent';
import { useMemo } from 'react';
import { useI18n } from '@/i18n';
import { computeStats, formatTokens } from '@/stores/sessions/stats';

interface StatsLineProps {
  messages: ProjectedMessage[];
  activeMs: number;
}

/** composer 下方的会话统计条（deepseek-harness StatsLine 形状）：无数据的组整组消失 */
export function StatsLine({ messages, activeMs }: StatsLineProps) {
  const { t } = useI18n();
  const stats = useMemo(() => computeStats(messages, activeMs), [messages, activeMs]);
  if (stats.turns === 0 && stats.inputTokens === 0 && stats.outputTokens === 0) return null;

  const groups: string[] = [];
  if (stats.turns > 0) groups.push(t('{{count}} turns', { count: stats.turns }));
  if (stats.cacheHitPercent !== null) {
    groups.push(t('Cache hit {{percent}}%', { percent: stats.cacheHitPercent }));
  }
  if (stats.inputTokens > 0 || stats.outputTokens > 0) {
    groups.push(
      t('Input {{input}} tok · Output {{output}} tok', {
        input: formatTokens(stats.inputTokens),
        output: formatTokens(stats.outputTokens),
      })
    );
  }
  if (stats.tokensPerSecond !== null) {
    groups.push(t('{{speed}} tok/s', { speed: stats.tokensPerSecond }));
  }

  return (
    <p className="truncate px-1 pt-1.5 text-center text-[11px] text-muted-foreground/70">
      {groups.join('  |  ')}
    </p>
  );
}
