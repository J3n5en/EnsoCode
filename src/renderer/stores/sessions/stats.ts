import type { ProjectedMessage } from '@shared/types/agent';

export interface SessionStats {
  turns: number;
  /** 计费输入 = 未命中输入 + 缓存读 + 缓存写 */
  inputTokens: number;
  outputTokens: number;
  /** 缓存读占计费输入的百分比；无计费输入时为 null */
  cacheHitPercent: number | null;
  /** 输出吞吐（含工具执行时间的整 turn 均值）；无计时或无输出时为 null */
  tokensPerSecond: number | null;
}

/** 从消息投影累计会话统计。纯函数。 */
export function computeStats(messages: ProjectedMessage[], activeMs: number): SessionStats {
  let turns = 0;
  let uncached = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    if (message.stopReason) turns += 1;
    if (!message.usage) continue;
    uncached += message.usage.input;
    output += message.usage.output;
    cacheRead += message.usage.cacheRead;
    cacheWrite += message.usage.cacheWrite;
  }
  const inputTokens = uncached + cacheRead + cacheWrite;
  return {
    turns,
    inputTokens,
    outputTokens: output,
    cacheHitPercent: inputTokens === 0 ? null : Math.round((cacheRead / inputTokens) * 100),
    tokensPerSecond:
      output > 0 && activeMs > 0 ? Math.round((output / (activeMs / 1000)) * 10) / 10 : null,
  };
}

/** 紧凑 token 数：517 / 12.2K / 517K / 1.2M（不足三位保留一位小数） */
export function formatTokens(n: number): string {
  const scaled = (v: number): string =>
    v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`;
  return `${scaled(n / 1_000_000)}M`;
}
