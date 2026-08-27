import type { ProjectedMessage } from '@shared/types/agent';
import { useMemo } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { formatTokens } from '@/stores/sessions/stats';

/** 最近一条带非零 usage 的 assistant 消息的整段 prompt+输出 ≈ 当前上下文水位。
 *  流式中的消息 usage 是空对象（投影成全 0），须跳过，否则对话中显示 0% */
function latestContextTokens(messages: ProjectedMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = messages[i].role === 'assistant' ? messages[i].usage : undefined;
    if (!usage) continue;
    const total = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
    if (total > 0) return total;
  }
  return null;
}

/** composer 工具栏的上下文占用环：窗口取当前模型 catalog；未知则显示 ?，不拿常数凑百分比 */
export function ContextMeter({
  messages,
  contextWindow,
}: {
  messages: ProjectedMessage[];
  contextWindow?: number;
}) {
  const { t } = useI18n();
  const used = useMemo(() => latestContextTokens(messages), [messages]);
  if (used === null) return null;
  const window = contextWindow && contextWindow > 0 ? contextWindow : 0;
  const percent = window > 0 ? Math.min(100, Math.round((used / window) * 100)) : null;
  const critical = percent !== null && percent >= 90;
  const radius = 5.5;
  const circumference = 2 * Math.PI * radius;
  return (
    <span
      className={cn(
        'flex items-center gap-1 text-[11px] tabular-nums',
        critical ? 'text-destructive' : 'text-muted-foreground'
      )}
      title={t('Context {{used}} / {{window}} tok', {
        used: formatTokens(used),
        window: window > 0 ? formatTokens(window) : '?',
      })}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" className="-rotate-90" aria-hidden>
        <circle
          cx="7"
          cy="7"
          r={radius}
          fill="none"
          strokeWidth="2"
          className="stroke-muted-foreground/25"
        />
        <circle
          cx="7"
          cy="7"
          r={radius}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - (percent ?? 0) / 100)}
          className={critical ? 'stroke-destructive' : 'stroke-muted-foreground'}
        />
      </svg>
      {percent === null ? '?' : `${percent}%`}
    </span>
  );
}
