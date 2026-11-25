import type { ProjectedMessage } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import { projectSessionHistoryStats, RECENT_ACTIVITY_WINDOW_MS } from './sessionHistoryStats';

const NOW = 1_700_000_000_000;

function user(at: number): ProjectedMessage {
  return { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: at };
}

function assistant(
  at: number,
  options: {
    calls?: string[];
    usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  } = {}
): ProjectedMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: 'ok' },
      ...(options.calls ?? []).map((name, i) => ({
        type: 'toolCall' as const,
        id: `c${at}-${i}`,
        name,
      })),
    ],
    timestamp: at,
    ...(options.usage ? { usage: options.usage } : {}),
  };
}

function toolResult(at: number): ProjectedMessage {
  return {
    role: 'toolResult',
    content: [],
    toolCallId: 'x',
    toolName: 'bash',
    timestamp: at,
  };
}

function compaction(at: number, tokensBefore: number): ProjectedMessage {
  return { role: 'compactionSummary', content: [], tokensBefore, timestamp: at };
}

describe('projectSessionHistoryStats', () => {
  it('空历史全部归零，时间相关字段为 null', () => {
    const stats = projectSessionHistoryStats([], NOW);
    expect(stats.turns).toBe(0);
    expect(stats.steps).toBe(0);
    expect(stats.toolCalls).toBe(0);
    expect(stats.topTools).toEqual([]);
    expect(stats.compactions).toBe(0);
    expect(stats.lastCompactionTokensBefore).toBeNull();
    expect(stats.lastActivityAt).toBeNull();
    expect(stats.recentEvents).toBe(0);
    expect(stats.inputTokens).toBe(0);
    expect(stats.outputTokens).toBe(0);
  });

  it('轮次按 user 消息计数，工具按名字聚合降序', () => {
    const stats = projectSessionHistoryStats(
      [
        user(NOW - 5000),
        assistant(NOW - 4000, { calls: ['bash', 'read'] }),
        toolResult(NOW - 3000),
        user(NOW - 2500),
        assistant(NOW - 2000, { calls: ['bash', 'bash', 'read'] }),
      ],
      NOW
    );
    expect(stats.turns).toBe(2);
    expect(stats.steps).toBe(2);
    expect(stats.toolCalls).toBe(5);
    expect(stats.topTools).toEqual([
      { name: 'bash', count: 3 },
      { name: 'read', count: 2 },
    ]);
  });

  it('同次数的工具按名字排序，输出稳定', () => {
    const stats = projectSessionHistoryStats(
      [assistant(NOW - 1000, { calls: ['write', 'bash', 'read'] })],
      NOW
    );
    expect(stats.topTools.map((tool) => tool.name)).toEqual(['bash', 'read', 'write']);
  });

  it('token 累计沿用 computeStats 口径：输入含缓存读与写', () => {
    const usage = { input: 100, output: 50, cacheRead: 40, cacheWrite: 10 };
    const stats = projectSessionHistoryStats([assistant(NOW - 1000, { usage })], NOW);
    expect(stats.inputTokens).toBe(150);
    expect(stats.outputTokens).toBe(50);
  });

  it('压缩次数按 compactionSummary 计，保留最近一次压缩前的 token 数', () => {
    const stats = projectSessionHistoryStats(
      [
        compaction(NOW - 90_000, 300_000),
        assistant(NOW - 60_000),
        compaction(NOW - 30_000, 520_000),
      ],
      NOW
    );
    expect(stats.compactions).toBe(2);
    expect(stats.lastCompactionTokensBefore).toBe(520_000);
  });

  it('最近一分钟只算助手步与工具结果，窗口外与用户消息不计', () => {
    const inside = NOW - RECENT_ACTIVITY_WINDOW_MS / 2;
    const outside = NOW - RECENT_ACTIVITY_WINDOW_MS * 2;
    const stats = projectSessionHistoryStats(
      [
        user(inside),
        assistant(outside),
        toolResult(inside),
        assistant(inside),
        assistant(NOW + 1000),
      ],
      NOW
    );
    expect(stats.recentEvents).toBe(2);
    expect(stats.lastActivityAt).toBe(NOW + 1000);
  });
});
