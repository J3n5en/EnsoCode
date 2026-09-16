import { describe, expect, it } from 'vitest';
import {
  btwHotSessionIds,
  chatSurfaceBusy,
  chatTimelineBusy,
  evictColdMessages,
  isBulkyAgentEvent,
  isMessageCacheHot,
  MESSAGE_CACHE_TTL_MS,
  needsHistoryHydration,
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
      hot: { messages: [1], customEntries: [2] },
      stale: { messages: [3], customEntries: [4], historyLoading: true },
      empty: { messages: [], customEntries: [] },
    };
    const next = evictColdMessages(conversations, 'hot', { stale: 0 }, MESSAGE_CACHE_TTL_MS);
    expect(next.hot).toBe(conversations.hot);
    expect(next.stale).toEqual({
      messages: [],
      customEntries: [],
      historyBaseIndex: undefined,
      historyLoading: undefined,
    });
    expect(next.empty).toBe(conversations.empty);
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
        messages: [{ role: 'assistant' }],
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

  it('尾巴上屏后 spawn 仍要在时间线出 loading', () => {
    expect(
      chatTimelineBusy({
        messages: [{}],
        spawning: true,
        status: 'idle',
      })
    ).toBe(true);
    expect(
      chatTimelineBusy({
        messages: [{ optimistic: true }],
        spawning: false,
        status: 'idle',
      })
    ).toBe(true);
    expect(
      chatTimelineBusy({
        messages: [{}],
        spawning: false,
        status: 'idle',
      })
    ).toBe(false);
  });

  it('空窗等尾巴时时间线 busy，避免露出空聊天态', () => {
    expect(
      chatTimelineBusy({
        started: false,
        sessionFile: '/tmp/s.jsonl',
        messages: [],
        spawning: false,
      })
    ).toBe(true);
    expect(
      chatTimelineBusy({
        started: false,
        messages: [],
        spawning: false,
      })
    ).toBe(false);
  });
});
