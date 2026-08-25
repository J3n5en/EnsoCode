import type { ProjectedMessage } from '@shared/types/agent';

export interface SessionStats {
  /** 轮数 = user 消息数（每次 prompt 一轮） */
  turns: number;
  /** 步数 = assistant 消息数（一轮可含多步：文本↔工具交替） */
  steps: number;
  /** LLM 墙钟 = Σ(step 完成 − step 开始) */
  llmMs: number;
  /** 工具墙钟 = 同一轮内相邻 step 之间的间隙之和 */
  toolMs: number;
  /** 计费输入 = 未命中输入 + 缓存读 + 缓存写 */
  inputTokens: number;
  outputTokens: number;
  /** 缓存读占计费输入的百分比；无计费输入时为 null */
  cacheHitPercent: number | null;
  /** 首 token 平均延迟（ms）；无采样步时为 null */
  ttftAvgMs: number | null;
  /** 解码吞吐（tok/s）；无采样或无输出时为 null */
  tokensPerSecond: number | null;
}

/** 从消息投影累计会话统计。纯函数。 */
export function computeStats(messages: ProjectedMessage[]): SessionStats {
  let turns = 0;
  let steps = 0;
  let uncached = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let llmMs = 0;
  let toolMs = 0;
  let ttftMs = 0;
  let ttftSteps = 0;
  let decodeMs = 0;
  let decodeTokens = 0;
  // 工具间隙基准：上一 step 的完成时刻；遇到 user 消息重置（轮尾后的间隙是用户等待，不计）
  let prevStepEndMs: number | null = null;

  for (const message of messages) {
    if (message.role === 'user') {
      turns += 1;
      prevStepEndMs = null;
    }
    if (message.role !== 'assistant') continue;
    steps += 1;
    if (message.usage) {
      uncached += message.usage.input;
      output += message.usage.output;
      cacheRead += message.usage.cacheRead;
      cacheWrite += message.usage.cacheWrite;
    }
    const timing = message.timing;
    if (timing) {
      const { stepStartMs, firstTokenMs, completedMs } = timing;
      if (completedMs !== undefined) llmMs += Math.max(0, completedMs - stepStartMs);
      if (firstTokenMs !== undefined) {
        ttftMs += Math.max(0, firstTokenMs - stepStartMs);
        ttftSteps += 1;
      }
      const out = message.usage?.output ?? 0;
      if (firstTokenMs !== undefined && completedMs !== undefined && out > 0) {
        decodeMs += Math.max(0, completedMs - firstTokenMs);
        decodeTokens += out;
      }
      // 与上一 step 的间隙 = 工具执行墙钟
      if (prevStepEndMs !== null) {
        toolMs += Math.max(0, stepStartMs - prevStepEndMs);
      }
      prevStepEndMs = completedMs ?? null;
    }
  }

  const inputTokens = uncached + cacheRead + cacheWrite;
  return {
    turns,
    steps,
    llmMs,
    toolMs,
    inputTokens,
    outputTokens: output,
    cacheHitPercent: inputTokens === 0 ? null : Math.round((cacheRead / inputTokens) * 100),
    ttftAvgMs: ttftSteps > 0 ? ttftMs / ttftSteps : null,
    tokensPerSecond:
      decodeMs > 0 && decodeTokens > 0
        ? Math.round((decodeTokens / (decodeMs / 1000)) * 10) / 10
        : null,
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

/** 紧凑时长：不足 1 分钟 45.2s，其后 2m42s */
export function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s * 10) / 10}s`;
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)}m${whole % 60}s`;
}
