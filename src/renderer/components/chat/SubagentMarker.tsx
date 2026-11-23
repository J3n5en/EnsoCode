import { Bot } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useI18n } from '@/i18n';
import { useSubagentRunsStore } from '@/stores/subagentRuns';

const TICK_MS = 30_000;

/** 侧栏会话行的子代理运行标记：即使未打开会话也能看出正在等哪个子代理、已运行几分钟 */
export function SubagentMarker({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const runs = useSubagentRunsStore((state) => state.byConversation[conversationId]);
  const [tick, setTick] = useState<{ runs: typeof runs; extraMs: number }>({ runs, extraMs: 0 });
  useEffect(() => {
    if (!runs || runs.length === 0) return;
    const started = Date.now();
    const timer = setInterval(() => setTick({ runs, extraMs: Date.now() - started }), TICK_MS);
    return () => clearInterval(timer);
  }, [runs]);
  if (!runs || runs.length === 0) return null;
  const extraMs = tick.runs === runs ? tick.extraMs : 0;
  const longest = runs.reduce(
    (best, run) => (run.elapsedMs > best.elapsedMs ? run : best),
    runs[0]
  );
  const title = longest.title || longest.agentId.slice(0, 8);
  const minutes = Math.floor((longest.elapsedMs + extraMs) / 60_000);
  const tooltip =
    runs.length === 1
      ? minutes >= 1
        ? t('Waiting on subagent {{title}} ({{minutes}}m)', { title, minutes })
        : t('Waiting on subagent {{title}} (<1m)', { title })
      : minutes >= 1
        ? t('Waiting on {{n}} subagents ({{title}} · {{minutes}}m)', {
            n: runs.length,
            title,
            minutes,
          })
        : t('Waiting on {{n}} subagents ({{title}} · <1m)', { n: runs.length, title });
  return (
    <span
      data-enso="session-subagent-marker"
      className="flex shrink-0 items-center gap-0.5 text-[10px] tabular-nums text-muted-foreground/80"
      title={tooltip}
    >
      <Bot className="h-3 w-3" aria-hidden />
      {minutes >= 1 ? `${minutes}m` : runs.length}
    </span>
  );
}
