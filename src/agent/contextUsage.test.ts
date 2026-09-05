import { describe, expect, it } from 'vitest';
import {
  type AnchorMessage,
  ContextUsageTracker,
  calculateContextTokens,
  calculatePromptTokens,
  findTranscriptUsageAnchor,
  hasContextTokenUsage,
  isTranscriptUsageAnchor,
} from './contextUsage';

const estimateTokens = (message: unknown): number => (message as { tokens?: number }).tokens ?? 0;

describe('calculatePromptTokens', () => {
  it('排除 output，只算 input + cacheRead + cacheWrite', () => {
    const usage = { input: 100, output: 999, cacheRead: 20, cacheWrite: 5 };
    expect(calculatePromptTokens(usage)).toBe(125);
  });

  it('contextTokens 存在时直接采用，忽略其余字段', () => {
    const usage = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, contextTokens: 777 };
    expect(calculatePromptTokens(usage)).toBe(777);
  });

  it('contextTokens 为负数时钳到 0', () => {
    const usage = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, contextTokens: -5 };
    expect(calculatePromptTokens(usage)).toBe(0);
  });
});

describe('calculateContextTokens', () => {
  it('contextTokens 覆盖优先，负数钳到 0', () => {
    expect(
      calculateContextTokens({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        contextTokens: 500,
      })
    ).toBe(500);
    expect(
      calculateContextTokens({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        contextTokens: -5,
      })
    ).toBe(0);
  });

  it('无 contextTokens 时用 totalTokens 或四项之和', () => {
    expect(calculateContextTokens({ input: 10, output: 20, cacheRead: 5, cacheWrite: 5 })).toBe(40);
  });

  it('编排（orchestration）token 从上下文用量中扣除', () => {
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1000,
      orchestration: { input: 100, output: 50, cacheRead: 10 },
    };
    expect(calculateContextTokens(usage)).toBe(840);
  });

  it('编排扣除后为负也钳到 0', () => {
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 100,
      orchestration: { input: 200 },
    };
    expect(calculateContextTokens(usage)).toBe(0);
  });
});

describe('hasContextTokenUsage', () => {
  it('全部为 0 时判定为无用量', () => {
    expect(hasContextTokenUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(false);
  });

  it('prompt 分量 > 0 即判定有用量', () => {
    expect(hasContextTokenUsage({ input: 5, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(true);
  });

  it('contextTokens 字段本身 > 0 即判定有用量', () => {
    expect(
      hasContextTokenUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 5 })
    ).toBe(true);
  });

  it('仅有 output（如纯 thinking 应答）且不超过 output 时判定为无用量', () => {
    const usage = { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 10 };
    expect(hasContextTokenUsage(usage)).toBe(false);
  });
});

describe('isTranscriptUsageAnchor', () => {
  const usage = { input: 5, output: 2, cacheRead: 0, cacheWrite: 0 };

  it('正常 assistant 消息且有用量时视为锚点', () => {
    expect(isTranscriptUsageAnchor({ role: 'assistant', usage })).toBe(true);
  });

  it('stopReason 为 aborted 时不算锚点', () => {
    expect(isTranscriptUsageAnchor({ role: 'assistant', stopReason: 'aborted', usage })).toBe(
      false
    );
  });

  it('stopReason 为 error 时不算锚点', () => {
    expect(isTranscriptUsageAnchor({ role: 'assistant', stopReason: 'error', usage })).toBe(false);
  });

  it('非 assistant 角色不算锚点', () => {
    expect(isTranscriptUsageAnchor({ role: 'user', usage })).toBe(false);
  });

  it('usage 缺失不算锚点', () => {
    expect(isTranscriptUsageAnchor({ role: 'assistant' })).toBe(false);
  });

  it('usage 全为 0 不算锚点', () => {
    expect(
      isTranscriptUsageAnchor({
        role: 'assistant',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      })
    ).toBe(false);
  });
});

describe('findTranscriptUsageAnchor', () => {
  const messages: AnchorMessage[] = [
    { role: 'user' },
    { role: 'assistant', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } },
    { role: 'user' },
    {
      role: 'assistant',
      stopReason: 'aborted',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    },
    { role: 'assistant', usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 } },
  ];

  it('从后往前找到最新的合格锚点', () => {
    const found = findTranscriptUsageAnchor(messages);
    expect(found?.index).toBe(4);
    expect(found?.tokens).toBe(25);
  });

  it('fromIndex 之前的锚点不参与匹配', () => {
    expect(findTranscriptUsageAnchor(messages, 5)).toBeUndefined();
    expect(findTranscriptUsageAnchor(messages, 4)?.index).toBe(4);
  });
});

describe('ContextUsageTracker.getBreakdown', () => {
  it('compactionIndex 让压缩前的旧锚点失效，不再误报接近 100%（对应 31% 场景 bug）', () => {
    const tracker = new ContextUsageTracker();
    const activeMessages: AnchorMessage[] = [
      { role: 'user', ...{ tokens: 0 } } as AnchorMessage,
      {
        role: 'assistant',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 9500 },
      },
      { role: 'user', ...{ tokens: 50 } } as AnchorMessage,
      { role: 'assistant', ...{ tokens: 80 } } as AnchorMessage,
    ];
    const result = tracker.getBreakdown({
      contextWindow: 10000,
      activeMessages,
      branchMessages: activeMessages,
      compactionIndex: 1,
      currentNonMessageTokens: 500,
      categoryNonMessageTokens: 500,
      estimateMessageTokens: estimateTokens,
    });
    expect(result.anchored).toBe(false);
    expect(result.usedTokens).toBe(630);
    expect(result.messagesTokens).toBe(130);
    expect(result.usedTokens).toBeLessThan(9500);
  });

  it('命中锚点后，锚点之后的尾部消息按估算累加', () => {
    const tracker = new ContextUsageTracker();
    const activeMessages: AnchorMessage[] = [
      { role: 'user', ...{ tokens: 0 } } as AnchorMessage,
      {
        role: 'assistant',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 1000 },
      },
      { role: 'user', ...{ tokens: 40 } } as AnchorMessage,
      { role: 'assistant', ...{ tokens: 60 } } as AnchorMessage,
    ];
    const result = tracker.getBreakdown({
      contextWindow: 5000,
      activeMessages,
      branchMessages: activeMessages,
      currentNonMessageTokens: 200,
      categoryNonMessageTokens: 0,
      estimateMessageTokens: estimateTokens,
    });
    expect(result.anchored).toBe(true);
    expect(result.usedTokens).toBe(1100);
    expect(result.messagesTokens).toBe(1100);
  });

  it('快照记录之后非消息占用增长的部分计入用量', () => {
    const tracker = new ContextUsageTracker();
    const anchor: AnchorMessage = {
      role: 'assistant',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 2000 },
      contextSnapshot: { promptTokens: 2000, nonMessageTokens: 300, compactionEpoch: 0 },
    };
    const activeMessages: AnchorMessage[] = [
      anchor,
      { role: 'user', ...{ tokens: 0 } } as AnchorMessage,
    ];
    const result = tracker.getBreakdown({
      contextWindow: 8000,
      activeMessages,
      branchMessages: activeMessages,
      currentNonMessageTokens: 500,
      categoryNonMessageTokens: 0,
      estimateMessageTokens: estimateTokens,
    });
    expect(result.anchored).toBe(true);
    expect(result.usedTokens).toBe(2200);
  });

  it('没有截断后有效锚点时，退回 pending 快照估算', () => {
    const tracker = new ContextUsageTracker();
    tracker.setPendingSnapshot({ promptTokens: 1500, nonMessageTokens: 100, cutoffCount: 2 });
    const activeMessages: AnchorMessage[] = [
      { role: 'user', ...{ tokens: 0 } } as AnchorMessage,
      { role: 'user', ...{ tokens: 0 } } as AnchorMessage,
      { role: 'user', ...{ tokens: 30 } } as AnchorMessage,
      { role: 'user', ...{ tokens: 20 } } as AnchorMessage,
    ];
    const result = tracker.getBreakdown({
      contextWindow: 4000,
      activeMessages,
      branchMessages: [],
      currentNonMessageTokens: 150,
      categoryNonMessageTokens: 50,
      estimateMessageTokens: estimateTokens,
    });
    expect(result.anchored).toBe(true);
    expect(result.usedTokens).toBe(1600);
    expect(result.messagesTokens).toBe(1550);
  });

  it('rebaseAfterCompaction 提升 epoch，旧 epoch 的锚点让位给新 pending 快照', () => {
    const tracker = new ContextUsageTracker();
    expect(tracker.compactionEpoch).toBe(0);
    tracker.setPendingSnapshot({ promptTokens: 1000, nonMessageTokens: 50, cutoffCount: 0 });
    tracker.rebaseAfterCompaction({ promptTokens: 3000, nonMessageTokens: 80, cutoffCount: 0 });
    expect(tracker.compactionEpoch).toBe(1);

    const staleAnchor: AnchorMessage = {
      role: 'assistant',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 999 },
      contextSnapshot: { promptTokens: 999, nonMessageTokens: 10, compactionEpoch: 0 },
    };
    const activeMessages: AnchorMessage[] = [staleAnchor];
    const result = tracker.getBreakdown({
      contextWindow: 6000,
      activeMessages,
      branchMessages: activeMessages,
      currentNonMessageTokens: 80,
      categoryNonMessageTokens: 0,
      estimateMessageTokens: estimateTokens,
    });
    expect(result.usedTokens).toBe(3000);
    expect(result.anchored).toBe(true);
  });

  it('pendingNonMessageTokens 反映当前 pending 快照，清空后为 undefined', () => {
    const tracker = new ContextUsageTracker();
    expect(tracker.pendingNonMessageTokens).toBeUndefined();
    tracker.setPendingSnapshot({ promptTokens: 100, nonMessageTokens: 42, cutoffCount: 0 });
    expect(tracker.pendingNonMessageTokens).toBe(42);
    tracker.setPendingSnapshot(undefined);
    expect(tracker.pendingNonMessageTokens).toBeUndefined();
  });
});

describe('ContextUsageTracker.recordAnchoredHistoryRewrite', () => {
  it('记录历史裁剪量后，修正后的 prompt tokens 相应减少', () => {
    const tracker = new ContextUsageTracker();
    const message: AnchorMessage = {
      role: 'assistant',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 5000 },
    };
    const messages: AnchorMessage[] = [message];

    tracker.recordAnchoredHistoryRewrite(120.7, messages, -1, 400);

    expect(message.contextSnapshot?.promptTokens).toBe(5000);
    expect(message.contextSnapshot?.nonMessageTokens).toBe(400);
    expect(message.contextSnapshot?.historyRewriteTokensRemoved).toBe(120);

    const result = tracker.getBreakdown({
      contextWindow: 9000,
      activeMessages: messages,
      branchMessages: messages,
      currentNonMessageTokens: 400,
      categoryNonMessageTokens: 0,
      estimateMessageTokens: estimateTokens,
    });
    expect(result.usedTokens).toBe(4880);
  });
});
