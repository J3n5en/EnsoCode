/**
 * 会话历史的一次性统计投影：复用 computeStats 的轮次与 token 口径，
 * 在同一趟遍历里加上工具调用分布、压缩次数与最近活跃度。
 * 秘书 session_stats 用，全部来自权威 jsonl 的已有记录，不加新埋点。
 */
import { computeStats, type SessionStats } from '@shared/sessionStats';
import type { ProjectedMessage } from '@shared/types/agent';

export const RECENT_ACTIVITY_WINDOW_MS = 60_000;

export interface ToolCallCount {
  name: string;
  count: number;
}

export interface SessionHistoryStats extends SessionStats {
  /** 工具调用总数（assistant 消息里的 toolCall part 计数） */
  toolCalls: number;
  /** 按调用次数降序的工具分布；同次数按名字排序，保证稳定输出 */
  topTools: ToolCallCount[];
  /** 当前分支上的压缩次数（jsonl compaction 条目投影为 compactionSummary） */
  compactions: number;
  /** 最近一次压缩前的上下文 token 数；没压缩过为 null */
  lastCompactionTokensBefore: number | null;
  /** 全部分支消息里最新的时间戳；空历史为 null */
  lastActivityAt: number | null;
  /** 最近 RECENT_ACTIVITY_WINDOW_MS 内的助手步 + 工具结果条数：判断空转用 */
  recentEvents: number;
}

export function projectSessionHistoryStats(
  messages: readonly ProjectedMessage[],
  now: number = Date.now()
): SessionHistoryStats {
  const base = computeStats([...messages]);
  const tools = new Map<string, number>();
  let toolCalls = 0;
  let compactions = 0;
  let lastCompactionTokensBefore: number | null = null;
  let lastActivityAt: number | null = null;
  let recentEvents = 0;

  for (const message of messages) {
    if (typeof message.timestamp === 'number') {
      lastActivityAt =
        lastActivityAt === null ? message.timestamp : Math.max(lastActivityAt, message.timestamp);
      if (
        (message.role === 'assistant' || message.role === 'toolResult') &&
        now - message.timestamp >= 0 &&
        now - message.timestamp < RECENT_ACTIVITY_WINDOW_MS
      ) {
        recentEvents += 1;
      }
    }
    if (message.role === 'compactionSummary') {
      compactions += 1;
      if (typeof message.tokensBefore === 'number')
        lastCompactionTokensBefore = message.tokensBefore;
      continue;
    }
    if (message.role !== 'assistant') continue;
    for (const part of message.content) {
      if (part.type !== 'toolCall') continue;
      toolCalls += 1;
      tools.set(part.name, (tools.get(part.name) ?? 0) + 1);
    }
  }

  const topTools = [...tools.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));

  return {
    ...base,
    toolCalls,
    topTools,
    compactions,
    lastCompactionTokensBefore,
    lastActivityAt,
    recentEvents,
  };
}
