import { useMemo } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { formatDuration } from '@/stores/sessions/stats';
import { turnWaterfall, type WaterfallBar } from './turnWaterfall';

/** 与面板同一判断：画得出瀑布才给展开入口（历史重载的轮次没有打点） */
export function useTurnHasTiming(conversationId: string | null, messageIndex: number): boolean {
  return useSessionsStore((state) => {
    const conversation = conversationId ? state.conversations[conversationId] : undefined;
    if (!conversation) return false;
    const local = messageIndex - (conversation.historyBaseIndex ?? 0);
    if (!conversation.messages[local]?.timing) return false;
    return turnWaterfall(conversation.messages, local) !== null;
  });
}

const PHASE_COLOR = { ttft: 'bg-brand/30', thinking: 'bg-brand/60', output: 'bg-brand' } as const;

/** 模型步拆成 等首字 / 思考 / 输出 三段，宽度为该步内占比 */
function modelPhases(bar: WaterfallBar) {
  const { firstTokenMs, thinkingEndMs } = bar.phases ?? {};
  const cuts: { phase: keyof typeof PHASE_COLOR; from: number; to: number }[] = [];
  let at = bar.start;
  if (firstTokenMs !== undefined) {
    cuts.push({ phase: 'ttft', from: at, to: firstTokenMs });
    at = firstTokenMs;
  }
  if (thinkingEndMs !== undefined && thinkingEndMs > at) {
    cuts.push({ phase: 'thinking', from: at, to: thinkingEndMs });
    at = thinkingEndMs;
  }
  cuts.push({ phase: 'output', from: at, to: bar.end });
  const total = Math.max(1, bar.end - bar.start);
  return cuts.map((cut) => ({ ...cut, width: ((cut.to - cut.from) / total) * 100 }));
}

/** 工具常是毫秒级，formatDuration 会显示成 0s */
const spanLabel = (ms: number) => (ms < 1_000 ? `${Math.round(ms)}ms` : formatDuration(ms));

const PHASE_LABEL = {
  ttft: 'Waiting for first token',
  thinking: 'Think time',
  output: 'Output',
} as const;

const BAR_COLOR = {
  model: 'bg-brand',
  tool: 'bg-info',
  wait: 'bg-muted-foreground/30',
} as const;

/** 一轮的耗时瀑布：模型、工具、等待分色，最慢的一步标黄 */
export function TurnWaterfallPanel({
  conversationId,
  messageIndex,
}: {
  conversationId: string;
  messageIndex: number;
}) {
  const { t } = useI18n();
  const messages = useSessionsStore((state) => state.conversations[conversationId]?.messages);
  const base = useSessionsStore(
    (state) => state.conversations[conversationId]?.historyBaseIndex ?? 0
  );
  const data = useMemo(
    () => (messages ? turnWaterfall(messages, messageIndex - base) : null),
    [messages, messageIndex, base]
  );
  if (!data) return null;
  const span = Math.max(1, data.end - data.start);
  const phased = data.bars.some((bar) => bar.phases);
  return (
    <div
      data-enso="turn-waterfall"
      className="mt-1.5 max-h-64 overflow-auto rounded-lg border border-border/60 px-2.5 py-2 text-[11px]"
    >
      {data.bars.map((bar) => {
        const slow = bar.key === data.slowest;
        const label = bar.kind === 'model' ? t('Model') : bar.label || t('Wait');
        return (
          <div key={bar.key} className="grid grid-cols-[7rem_1fr_3.5rem] items-center gap-2 py-px">
            <span
              className={cn(
                'truncate text-muted-foreground',
                bar.kind === 'tool' && 'font-mono',
                slow && 'font-medium text-warning'
              )}
              title={label}
            >
              {label}
            </span>
            <span className="relative h-2.5">
              <span
                className={cn(
                  'absolute top-0.5 flex h-1.5 min-w-px overflow-hidden rounded-sm',
                  bar.phases
                    ? slow && 'ring-1 ring-warning ring-offset-1 ring-offset-background'
                    : slow
                      ? 'bg-warning'
                      : BAR_COLOR[bar.kind]
                )}
                style={{
                  left: `${((bar.start - data.start) / span) * 100}%`,
                  width: `${((bar.end - bar.start) / span) * 100}%`,
                }}
              >
                {bar.phases &&
                  modelPhases(bar).map((cut) => (
                    <span
                      key={cut.phase}
                      className={cn('h-full', PHASE_COLOR[cut.phase])}
                      style={{ width: `${cut.width}%` }}
                      title={`${t(PHASE_LABEL[cut.phase])} ${spanLabel(cut.to - cut.from)}`}
                    />
                  ))}
              </span>
            </span>
            <span
              className={cn(
                'text-right tabular-nums text-muted-foreground',
                slow && 'font-medium text-warning'
              )}
            >
              {spanLabel(bar.end - bar.start)}
            </span>
          </div>
        );
      })}
      {phased && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
          {(Object.keys(PHASE_COLOR) as (keyof typeof PHASE_COLOR)[]).map((phase) => (
            <span key={phase} className="flex items-center gap-1">
              <span className={cn('h-1.5 w-2.5 rounded-sm', PHASE_COLOR[phase])} />
              {t(PHASE_LABEL[phase])}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
