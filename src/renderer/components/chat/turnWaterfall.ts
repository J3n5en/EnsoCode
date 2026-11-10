import type { ProjectedMessage } from '@shared/types/agent';

export interface WaterfallBar {
  key: string;
  kind: 'model' | 'tool' | 'wait';
  /** 工具名；模型步与空档为空串，由调用方翻译 */
  label: string;
  start: number;
  end: number;
  /** 模型步内的分段：start→首字为等首字，首字→思考结束为思考，其后为输出 */
  phases?: { firstTokenMs?: number; thinkingEndMs?: number };
}

export interface TurnWaterfall {
  start: number;
  end: number;
  bars: WaterfallBar[];
  /** 最慢的模型步或工具（不含等待） */
  slowest?: string;
}

/** 两步之间的空档超过它才单列为「等待」（审批、排队等） */
const GAP_MS = 1_000;
/** 这些工具的耗时本质是等人 */
const WAIT_TOOLS = new Set(['ask_user']);

/**
 * 一轮的耗时瀑布：模型步取 worker 计时打点，工具取结果时刻与执行耗时。
 * 打点只在 worker 存活期间有（历史重载后缺失）；凑不出两段、唯一一步也分不出阶段时不给。
 */
export function turnWaterfall(
  messages: readonly ProjectedMessage[],
  endIndex: number
): TurnWaterfall | null {
  let from = endIndex;
  while (from > 0 && messages[from - 1]?.role !== 'user') from--;
  const bars: WaterfallBar[] = [];
  for (let i = from; i <= endIndex && i < messages.length; i++) {
    const message = messages[i];
    if (message.role === 'assistant' && message.timing) {
      const start = message.timing.stepStartMs;
      const end =
        message.timing.completedMs ??
        (typeof message.duration === 'number' ? start + message.duration : undefined);
      if (end !== undefined && end > start) {
        const inside = (ms?: number) =>
          ms !== undefined && ms > start && ms < end ? ms : undefined;
        const firstTokenMs = inside(message.timing.firstTokenMs);
        const thinkingEndMs = inside(message.timing.thinkingEndMs);
        bars.push({
          key: `m${i}`,
          kind: 'model',
          label: '',
          start,
          end,
          ...(firstTokenMs !== undefined || thinkingEndMs !== undefined
            ? {
                phases: {
                  ...(firstTokenMs !== undefined ? { firstTokenMs } : {}),
                  ...(thinkingEndMs !== undefined ? { thinkingEndMs } : {}),
                },
              }
            : {}),
        });
      }
    } else if (
      message.role === 'toolResult' &&
      typeof message.toolDurationMs === 'number' &&
      typeof message.timestamp === 'number'
    ) {
      const name = message.toolName ?? 'tool';
      bars.push({
        key: `t${i}`,
        kind: WAIT_TOOLS.has(name) ? 'wait' : 'tool',
        label: name,
        start: message.timestamp - message.toolDurationMs,
        end: message.timestamp,
      });
    }
  }
  if (bars.length === 0 || (bars.length === 1 && !bars[0].phases)) return null;
  bars.sort((a, b) => a.start - b.start);
  const withGaps: WaterfallBar[] = [];
  let reached = bars[0].start;
  for (const bar of bars) {
    if (bar.start - reached > GAP_MS) {
      withGaps.push({
        key: `w${bar.key}`,
        kind: 'wait',
        label: '',
        start: reached,
        end: bar.start,
      });
    }
    withGaps.push(bar);
    reached = Math.max(reached, bar.end);
  }
  let slowest: WaterfallBar | undefined;
  const timed = withGaps.filter((bar) => bar.kind !== 'wait');
  for (const bar of timed.length > 1 ? timed : []) {
    if (!slowest || bar.end - bar.start > slowest.end - slowest.start) slowest = bar;
  }
  return {
    start: withGaps[0].start,
    end: reached,
    bars: withGaps,
    ...(slowest ? { slowest: slowest.key } : {}),
  };
}
