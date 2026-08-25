import type { ProjectedMessage } from '@shared/types/agent';
import { useMemo } from 'react';
import { useI18n } from '@/i18n';
import { computeStats, formatDuration, formatTokens } from '@/stores/sessions/stats';

interface StatsLineProps {
  messages: ProjectedMessage[];
}

/** composer 下方的会话统计条（deepseek-harness StatsLine 形状）：无数据的组整组消失。
 *  外层恒占一行高度，避免统计从无到有时输入框跳动。 */
export function StatsLine({ messages }: StatsLineProps) {
  const { t } = useI18n();
  const stats = useMemo(() => computeStats(messages), [messages]);

  const groups: string[] = [];
  if (stats.steps > 0) {
    groups.push(t('{{turns}} turns · {{steps}} steps', { turns: stats.turns, steps: stats.steps }));
    const durations: string[] = [];
    if (stats.llmMs > 0) {
      durations.push(t('LLM {{duration}}', { duration: formatDuration(stats.llmMs) }));
    }
    if (stats.toolMs > 0) {
      durations.push(t('Tool calls {{duration}}', { duration: formatDuration(stats.toolMs) }));
    }
    if (durations.length > 0) groups.push(durations.join(' · '));
    const speeds: string[] = [];
    if (stats.ttftAvgMs !== null) {
      speeds.push(t('First token avg {{duration}}', { duration: formatDuration(stats.ttftAvgMs) }));
    }
    if (stats.tokensPerSecond !== null) {
      speeds.push(t('{{speed}} tok/s', { speed: stats.tokensPerSecond }));
    }
    if (speeds.length > 0) groups.push(speeds.join(' · '));
  }
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

  return (
    <div data-slot="stats-line" className="flex h-7 items-center justify-center px-1">
      {groups.length > 0 && (
        <span className="truncate text-[11px] text-muted-foreground/70">
          {groups.join('  |  ')}
        </span>
      )}
    </div>
  );
}
