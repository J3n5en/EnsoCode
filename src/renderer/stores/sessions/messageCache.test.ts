import { describe, expect, it } from 'vitest';
import {
  btwHotSessionIds,
  chatSurfaceBusy,
  chatTimelineActivity,
  evictColdMessages,
  evictStampedColdMessages,
  isBulkyAgentEvent,
  isMessageCacheHot,
  MESSAGE_CACHE_TTL_MS,
  needsHistoryHydration,
  nextColdEvictDelay,
  pruneSessionClocks,
  viewedConversationId,
} from './messageCache';

describe('messageCache', () => {
  it('viewed id prefers an existing tab over the parent', () => {
    expect(viewedConversationId('parent', 'child', (id) => id === 'child')).toBe('child');
    expect(viewedConversationId('parent', 'missing', (id) => id === 'parent')).toBe('parent');
    expect(viewedConversationId(null, undefined, () => false)).toBeNull();
  });

  it('current viewed session is always hot', () => {
    expect(isMessageCacheHot('a', 'a', {}, 1000)).toBe(true);
    expect(isMessageCacheHot('b', 'a', {}, 1000)).toBe(false);
  });

  it('recently viewed stays hot until TTL', () => {
    const last = { b: 1000 };
    expect(isMessageCacheHot('b', 'a', last, 1000 + MESSAGE_CACHE_TTL_MS - 1)).toBe(true);
    expect(isMessageCacheHot('b', 'a', last, 1000 + MESSAGE_CACHE_TTL_MS)).toBe(false);
  });

  it('extraHotIds 即使不是 viewed 也保持热', () => {
    const extra = new Set(['btw']);
    expect(isMessageCacheHot('btw', 'parent', {}, 1000, MESSAGE_CACHE_TTL_MS, extra)).toBe(true);
    expect(isMessageCacheHot('other', 'parent', {}, 1000, MESSAGE_CACHE_TTL_MS, extra)).toBe(false);
  });

  it('btwHotSessionIds 收集带 btwParentId 的会话', () => {
    expect(
      btwHotSessionIds({
        parent: {},
        btw: { btwParentId: 'parent' },
        child: { btwParentId: undefined },
      })
    ).toEqual(new Set(['btw']));
  });

  it('evicts stale message bodies, leaves hot and empty conversations', () => {
    const conversations = {
      hot: { messages: [{}], customEntries: [2] },
      stale: {
        messages: [{ timestamp: 3 }],
        customEntries: [4],
        historyLoading: true,
        historyLoadAttempted: true,
      },
      empty: { messages: [], customEntries: [], historyLoadAttempted: true },
    };
    const next = evictColdMessages(conversations, 'hot', { stale: 0 }, MESSAGE_CACHE_TTL_MS);
    expect(next.hot).toBe(conversations.hot);
    expect(next.empty).toBe(conversations.empty);
    expect(next.stale).toEqual({
      messages: [],
      customEntries: [],
      lastActiveAt: 3,
      historyBaseIndex: undefined,
      historyLoading: undefined,
      historyLoadAttempted: undefined,
    });
  });

  it('丢正文时留下最后活跃时刻，侧栏不回落到 createdAt', () => {
    type Body = {
      messages: { timestamp?: number }[];
      customEntries: unknown[];
      lastActiveAt?: number;
    };
    const conversations: Record<'fromMessage' | 'kept' | 'noTimestamp', Body> = {
      fromMessage: { messages: [{ timestamp: 1 }, { timestamp: 500 }], customEntries: [] },
      kept: { messages: [{ timestamp: 500 }], customEntries: [], lastActiveAt: 900 },
      noTimestamp: { messages: [{}], customEntries: [], lastActiveAt: 700 },
    };
    const next = evictColdMessages(
      conversations,
      null,
      { fromMessage: 0, kept: 0, noTimestamp: 0 },
      MESSAGE_CACHE_TTL_MS
    );
    expect(next.fromMessage.lastActiveAt).toBe(500);
    expect(next.kept.lastActiveAt).toBe(900);
    expect(next.noTimestamp.lastActiveAt).toBe(700);
  });

  it('requireStamp 不碰从未离开过、因而没有盖章的正文', () => {
    const conversations = {
      fresh: { messages: [{}], customEntries: [] },
      expired: { messages: [{}], customEntries: [3] },
    };
    const next = evictStampedColdMessages(
      conversations,
      'hot',
      { expired: 0 },
      MESSAGE_CACHE_TTL_MS
    );
    expect(next.fresh).toBe(conversations.fresh);
    expect(next.expired.messages).toEqual([]);
  });

  it('下次回收看最早离开的会话，不从最近一次切换重计满 TTL', () => {
    const ttl = 5_000;
    expect(nextColdEvictDelay({ old: 1_000, recent: 4_000 }, 'current', 4_500, ttl)).toBe(1_500);
    expect(nextColdEvictDelay({ old: 1_000 }, 'current', 6_000, ttl)).toBe(0);
    expect(nextColdEvictDelay({ current: 1_000 }, 'current', 9_000, ttl)).toBeNull();
    expect(nextColdEvictDelay({}, null, 9_000, ttl)).toBeNull();
    expect(nextColdEvictDelay({ btw: 1_000 }, 'current', 9_000, ttl, new Set(['btw']))).toBeNull();
  });

  it('drops clocks for deleted conversations', () => {
    const clocks = { keep: 1, gone: 2 };
    pruneSessionClocks(clocks, new Set(['keep']));
    expect(clocks).toEqual({ keep: 1 });
  });

  it('message-upsert and custom entries are bulky', () => {
    expect(isBulkyAgentEvent('message-upsert')).toBe(true);
    expect(isBulkyAgentEvent('session-custom-entry')).toBe(true);
    expect(isBulkyAgentEvent('status')).toBe(false);
  });
});

describe('hasAuthoritativeMessages', () => {
  it('optimistic-only timeline still needs a snapshot', async () => {
    const { hasAuthoritativeMessages } = await import('./messageCache');
    expect(hasAuthoritativeMessages([])).toBe(false);
    expect(hasAuthoritativeMessages([{ optimistic: true }])).toBe(false);
    expect(hasAuthoritativeMessages([{}, { optimistic: true }])).toBe(true);
  });
});

describe('needsHistoryHydration', () => {
  it('started 会话无权威消息且未 spawning 时需要补正文', () => {
    expect(
      needsHistoryHydration({
        started: true,
        sessionFile: undefined,
        messages: [],
        spawning: false,
      })
    ).toBe(true);
    expect(
      needsHistoryHydration({
        started: true,
        sessionFile: '/tmp/s.jsonl',
        messages: [{ optimistic: true }],
        spawning: false,
      })
    ).toBe(true);
  });

  it('草稿、已有正文、正在 spawn 都不闪加载', () => {
    expect(
      needsHistoryHydration({
        started: false,
        sessionFile: undefined,
        messages: [],
        spawning: false,
      })
    ).toBe(false);
    expect(
      needsHistoryHydration({
        started: true,
        sessionFile: '/tmp/s.jsonl',
        messages: [{}],
        spawning: false,
      })
    ).toBe(false);
    expect(
      needsHistoryHydration({ started: true, sessionFile: undefined, messages: [], spawning: true })
    ).toBe(false);
  });

  it('failed 不挡 jsonl 历史：运行态失败与历史可读是两回事，否则一次瞬时失败就永久空白', () => {
    expect(
      needsHistoryHydration({
        started: false,
        sessionFile: '/tmp/s.jsonl',
        messages: [],
        spawning: false,
        status: 'failed',
      })
    ).toBe(true);
  });

  it('已尝试过读历史（含失败）就不再补，避免 Preparing 永久转圈', () => {
    expect(
      needsHistoryHydration({
        started: false,
        sessionFile: '/tmp/s.jsonl',
        messages: [],
        spawning: false,
        status: 'failed',
        historyLoadAttempted: true,
      })
    ).toBe(false);
  });
});

describe('needsWorkerSnapshot', () => {
  it('已启动或可 resume 且未 failed 就要对齐 worker，半截权威正文也不例外', async () => {
    const { needsWorkerSnapshot } = await import('./messageCache');
    expect(
      needsWorkerSnapshot({
        started: true,
        sessionFile: '/tmp/s.jsonl',
        status: 'idle',
      })
    ).toBe(true);
    expect(
      needsWorkerSnapshot({
        started: false,
        sessionFile: '/tmp/s.jsonl',
        status: 'idle',
      })
    ).toBe(true);
    expect(
      needsWorkerSnapshot({
        started: false,
        sessionFile: undefined,
        status: 'idle',
      })
    ).toBe(false);
    expect(
      needsWorkerSnapshot({
        started: true,
        sessionFile: '/tmp/s.jsonl',
        status: 'failed',
        messages: [{ optimistic: false }],
      })
    ).toBe(false);
  });

  it('failed 空窗且 worker 仍持有时要 snapshot，否则切回 coworker 只剩红字', async () => {
    const { needsWorkerSnapshot } = await import('./messageCache');
    expect(
      needsWorkerSnapshot({
        started: true,
        sessionFile: '/tmp/s.jsonl',
        status: 'failed',
        messages: [],
      })
    ).toBe(true);
    expect(
      needsWorkerSnapshot({
        started: false,
        sessionFile: '/tmp/s.jsonl',
        status: 'failed',
        messages: [],
      })
    ).toBe(false);
  });
});

describe('stampViewDeparture', () => {
  it('离开时盖章，当前会话不写自己', async () => {
    const { stampViewDeparture } = await import('./messageCache');
    const last: Record<string, number> = { stay: 1 };
    stampViewDeparture(last, 'left', 'next', 9);
    expect(last).toEqual({ stay: 1, left: 9 });
    stampViewDeparture(last, null, 'next', 10);
    expect(last.left).toBe(9);
    stampViewDeparture(last, 'same', 'same', 11);
    expect(last.same).toBeUndefined();
  });
});

describe('chatSurfaceBusy', () => {
  it('尾巴上屏后不再锁输入，即使还在 spawn', () => {
    expect(
      chatSurfaceBusy({
        started: false,
        sessionFile: '/tmp/s.jsonl',
        messages: [{}],
        spawning: true,
      })
    ).toBe(false);
    expect(
      chatSurfaceBusy({
        started: false,
        sessionFile: '/tmp/s.jsonl',
        messages: [],
        spawning: true,
      })
    ).toBe(true);
    expect(
      chatSurfaceBusy({
        started: true,
        messages: [{}],
        spawning: false,
        status: 'running',
      })
    ).toBe(true);
  });

  it('时间线脚点：只有真实 running 算生成中，未确认发送不冒充模型运行', () => {
    expect(chatTimelineActivity({ messages: [{}], spawning: false, status: 'running' })).toBe(
      'working'
    );
    expect(
      chatTimelineActivity({ messages: [{ optimistic: true }], spawning: false, status: 'idle' })
    ).toBeNull();
    expect(
      chatTimelineActivity({ messages: [{ optimistic: true }], spawning: true, status: 'idle' })
    ).toBe('loading');
  });

  it.each(['idle', 'failed'])(
    '历史中残留拒收或未确认气泡时，%s 不显示无法停止的生成状态',
    (status) => {
      for (const deliveryRejected of [false, true]) {
        const conversation = {
          started: true,
          spawning: false,
          status,
          historyLoadAttempted: true,
          messages: [{}, { optimistic: true, deliveryRejected }],
        };
        expect(chatSurfaceBusy(conversation)).toBe(false);
        expect(chatTimelineActivity(conversation)).toBeNull();
        expect(chatTimelineActivity({ ...conversation, status: 'running' })).toBe('working');
      }
    }
  );

  it('时间线脚点：冷会话恢复（spawn / 读历史）是加载中，不是生成中', () => {
    expect(chatTimelineActivity({ messages: [{}], spawning: true, status: 'idle' })).toBe(
      'loading'
    );
    expect(
      chatTimelineActivity({
        started: false,
        sessionFile: '/tmp/s.jsonl',
        messages: [],
        spawning: false,
      })
    ).toBe('loading');
  });

  it('时间线脚点：空闲与空草稿无脚点', () => {
    expect(chatTimelineActivity({ messages: [{}], spawning: false, status: 'idle' })).toBeNull();
    expect(chatTimelineActivity({ started: false, messages: [], spawning: false })).toBeNull();
    expect(
      chatTimelineActivity({ messages: [], spawning: false, status: 'idle', historyLoading: true })
    ).toBe('loading');
  });
});
