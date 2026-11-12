import type {
  ParentHistoryTailResult,
  RendererAgentEvent,
  SourceAuthorityProjection,
} from '@shared/types/agent';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentPrompt,
  agentSpawn,
  bindSessionProjection,
  installSessionGlobals,
  loadSessionModules,
  onAgentEvent,
  readChildHistory,
  readParentHistoryTail,
  requestSnapshot,
  seedParent,
  sessionsModule,
  settingsModule,
} from './index.testUtils';
import { MESSAGE_CACHE_TTL_MS } from './messageCache';

let sourceProjection: SourceAuthorityProjection = { projects: [], conversations: [] };
let nextConversationId = 'parent';
bindSessionProjection({
  get sourceProjection() {
    return sourceProjection;
  },
  set sourceProjection(value) {
    sourceProjection = value;
  },
  get nextConversationId() {
    return nextConversationId;
  },
  set nextConversationId(value) {
    nextConversationId = value;
  },
});
installSessionGlobals();

describe('parent history tail hydrate', () => {
  beforeAll(async () => {
    await loadSessionModules();
  });

  beforeEach(async () => {
    requestSnapshot.mockClear();
    readParentHistoryTail.mockReset();
    readParentHistoryTail.mockResolvedValue({
      ok: false,
      code: 'not-found',
      error: 'no',
    });
    if (sessionsModule.useSessionsStore.getState().conversations.parent) return;
    nextConversationId = 'parent';
    sourceProjection = {
      projects: [
        {
          projectId: 'project',
          canonicalPath: '/workspace',
          state: 'active',
          version: 1,
        },
      ],
      conversations: [],
    };
    sessionsModule.useSessionsStore.setState({
      conversations: {},
      order: [],
      activeId: null,
    });
    settingsModule.useSettingsStore.setState({
      projects: [{ id: 'project', name: 'Project', path: '/workspace' }],
    });
    await seedParent();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('spawn 中仍能上屏尾巴，且不写 historyOnly', async () => {
    let resolveTail: ((value: ParentHistoryTailResult) => void) | undefined;
    readParentHistoryTail.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTail = resolve;
        })
    );
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        cold: {
          ...state.conversations.parent,
          id: 'cold',
          started: false,
          spawning: false,
          sessionFile: '/tmp/cold.jsonl',
          messages: [],
          generation: 'stale-generation',
        },
      },
      order: ['cold'],
      activeId: 'parent',
    }));
    sessionsModule.useSessionsStore.getState().selectConversation('cold');
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        cold: { ...state.conversations.cold, spawning: true, started: true },
      },
    }));
    resolveTail?.({
      ok: true,
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'tail' }] }],
      baseIndex: 12,
    });
    await vi.waitFor(() =>
      expect(sessionsModule.useSessionsStore.getState().conversations.cold.messages).toHaveLength(1)
    );
    const cold = sessionsModule.useSessionsStore.getState().conversations.cold;
    expect(cold.historyOnly).toBeUndefined();
    expect(cold.historyBaseIndex).toBe(12);
    expect(cold.generation).toBe('stale-generation');
  });

  it('上滑只按当前 historyBaseIndex 取更早一页', async () => {
    readParentHistoryTail.mockResolvedValue({
      ok: true,
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'older' }] }],
      baseIndex: 11,
    });
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: false,
          sessionFile: '/tmp/parent.jsonl',
          historyBaseIndex: 12,
          messages: [{ role: 'assistant', content: [{ type: 'text', text: 'tail' }] }],
        },
      },
      activeId: 'parent',
    }));
    await sessionsModule.useSessionsStore.getState().loadOlderHistory('parent');
    expect(readParentHistoryTail).toHaveBeenCalledWith('parent', 12);
    const parent = sessionsModule.useSessionsStore.getState().conversations.parent;
    expect(parent.historyBaseIndex).toBe(11);
    expect(parent.messages.map((message) => (message.content[0] as { text: string }).text)).toEqual(
      ['older', 'tail']
    );
    expect(parent.historyLoading).toBeUndefined();
  });

  it('上滑在途时 historyLoading，结束后清除', async () => {
    let resolvePage: ((value: ParentHistoryTailResult) => void) | undefined;
    readParentHistoryTail.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePage = resolve;
        })
    );
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: false,
          sessionFile: '/tmp/parent.jsonl',
          historyBaseIndex: 12,
          messages: [{ role: 'assistant', content: [{ type: 'text', text: 'tail' }] }],
        },
      },
      activeId: 'parent',
    }));
    const pending = sessionsModule.useSessionsStore.getState().loadOlderHistory('parent');
    expect(sessionsModule.useSessionsStore.getState().conversations.parent.historyLoading).toBe(
      true
    );
    resolvePage?.({
      ok: true,
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'older' }] }],
      baseIndex: 11,
    });
    await pending;
    expect(sessionsModule.useSessionsStore.getState().conversations.parent.historyLoading).toBe(
      undefined
    );
  });

  it('resume 已在 spawn 时 send 不再二次 spawn', async () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: false,
          spawning: true,
          sessionFile: '/tmp/parent.jsonl',
          messages: [{ role: 'assistant', content: [{ type: 'text', text: 'tail' }] }],
        },
      },
      activeId: 'parent',
    }));
    agentSpawn.mockClear();
    agentPrompt.mockClear();
    await sessionsModule.useSessionsStore
      .getState()
      .send('follow up', { providerId: 'p', modelId: 'm', cwd: '/workspace' });
    expect(agentSpawn).not.toHaveBeenCalled();
    expect(agentPrompt).toHaveBeenCalled();
  });

  it('send 在未 started 时才 spawn，点开本身不 spawn', async () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: false,
          spawning: false,
          sessionFile: '/tmp/parent.jsonl',
          messages: [{ role: 'assistant', content: [{ type: 'text', text: 'tail' }] }],
        },
      },
      activeId: 'parent',
    }));
    agentSpawn.mockClear();
    expect(agentSpawn).not.toHaveBeenCalled();
    await sessionsModule.useSessionsStore
      .getState()
      .send('go', { providerId: 'p', modelId: 'm', cwd: '/workspace' });
    expect(agentSpawn).toHaveBeenCalledTimes(1);
  });

  it('切到已有半截权威正文的会话仍要 snapshot，不打尾窗', () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        partial: {
          ...state.conversations.parent,
          id: 'partial',
          started: true,
          spawning: false,
          status: 'idle',
          sessionFile: '/tmp/partial.jsonl',
          messages: [{ role: 'assistant', content: [{ type: 'text', text: '前半' }] }],
        },
      },
      order: ['parent', 'partial'],
      activeId: 'parent',
    }));
    requestSnapshot.mockClear();
    readParentHistoryTail.mockClear();
    sessionsModule.useSessionsStore.getState().selectConversation('partial');
    expect(requestSnapshot).toHaveBeenCalledWith('partial');
    expect(readParentHistoryTail).not.toHaveBeenCalled();
  });

  it('切到空窗可 resume 会话仍走尾窗 + snapshot', () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        empty: {
          ...state.conversations.parent,
          id: 'empty',
          started: false,
          spawning: false,
          status: 'idle',
          sessionFile: '/tmp/empty.jsonl',
          messages: [],
        },
      },
      order: ['parent', 'empty'],
      activeId: 'parent',
    }));
    requestSnapshot.mockClear();
    readParentHistoryTail.mockClear();
    sessionsModule.useSessionsStore.getState().selectConversation('empty');
    expect(requestSnapshot).toHaveBeenCalledWith('empty');
    expect(readParentHistoryTail).toHaveBeenCalledWith('empty');
  });

  it('切到失败且空窗的已启动 coworker 仍要 snapshot，不能只剩红字', () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: { ...state.conversations.parent, started: true, activeTabId: undefined },
        child: {
          ...state.conversations.parent,
          id: 'child',
          parentId: 'parent',
          started: true,
          spawning: false,
          status: 'failed' as const,
          error: 'Codex error: The usage limit has been reached',
          sessionFile: '/tmp/child.jsonl',
          messages: [],
        },
      },
      activeId: 'parent',
    }));
    requestSnapshot.mockClear();
    readParentHistoryTail.mockClear();
    readChildHistory.mockClear();
    sessionsModule.useSessionsStore.getState().selectTab('parent', 'child');
    expect(requestSnapshot).toHaveBeenCalledWith('child');
    expect(readParentHistoryTail).not.toHaveBeenCalled();
    expect(readChildHistory).toHaveBeenCalledWith('child');
  });

  function seedReleasable(id: string) {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        [id]: {
          ...state.conversations.parent,
          id,
          parentId: undefined,
          activeTabId: undefined,
          started: true,
          spawning: false,
          status: 'idle',
          generation: 'g1',
          lastSeq: 0,
          sessionFile: `/tmp/${id}.jsonl`,
          messages: [{ role: 'assistant', content: [{ type: 'text', text: '前半' }] }],
          customEntries: [{ kind: 'agent-completed', at: 1 } as never],
          historyBaseIndex: 3,
        },
      },
      order: ['parent', id],
      activeId: 'parent',
    }));
  }

  it('worker 释放冷会话（parent-ended）时清掉可能掉队的正文，切回走尾窗', () => {
    seedReleasable('released');
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        released: { ...state.conversations.released, historyLoadAttempted: true },
      },
    }));
    onAgentEvent?.({
      type: 'parent-ended',
      identity: { sessionId: 'released', generation: 'g1' },
      seq: 9,
      reason: 'evicted',
    });
    const released = sessionsModule.useSessionsStore.getState().conversations.released;
    expect(released.started).toBe(false);
    expect(released.messages).toEqual([]);
    expect(released.customEntries).toEqual([]);
    expect(released.historyBaseIndex).toBeUndefined();
    expect(released.historyLoadAttempted).toBeUndefined();
    readParentHistoryTail.mockClear();
    sessionsModule.useSessionsStore.getState().selectConversation('released');
    expect(readParentHistoryTail).toHaveBeenCalledWith('released');
  });

  it('worker 释放热会话（刚离开）时正文可信，保留', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    seedReleasable('warm');
    sessionsModule.useSessionsStore.getState().selectConversation('warm');
    sessionsModule.useSessionsStore.getState().selectConversation('parent');
    vi.setSystemTime(2_000);
    onAgentEvent?.({
      type: 'parent-ended',
      identity: { sessionId: 'warm', generation: 'g1' },
      seq: 9,
      reason: 'released',
    });
    const warm = sessionsModule.useSessionsStore.getState().conversations.warm;
    expect(warm.started).toBe(false);
    expect(warm.messages).toHaveLength(1);
    expect(warm.historyBaseIndex).toBe(3);
    vi.useRealTimers();
  });

  it('worker 释放冷会话清正文时留下最后活跃时刻，侧栏不回落到 createdAt', () => {
    seedReleasable('releasedAt');
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        releasedAt: {
          ...state.conversations.releasedAt,
          lastActiveAt: undefined,
          messages: [{ role: 'assistant', content: [], timestamp: 42_000 }],
        },
      },
    }));
    onAgentEvent?.({
      type: 'parent-ended',
      identity: { sessionId: 'releasedAt', generation: 'g1' },
      seq: 9,
      reason: 'evicted',
    });
    const released = sessionsModule.useSessionsStore.getState().conversations.releasedAt;
    expect(released.messages).toEqual([]);
    expect(released.lastActiveAt).toBe(42_000);
  });

  it('partial snapshot 不往冷会话灌正文，但 worker 持有即 started', () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        phoneFed: {
          ...state.conversations.parent,
          id: 'phoneFed',
          parentId: undefined,
          activeTabId: undefined,
          started: false,
          spawning: false,
          status: 'idle',
          generation: undefined,
          sessionFile: '/tmp/phoneFed.jsonl',
          messages: [],
          customEntries: [],
        },
      },
      order: ['parent', 'phoneFed'],
      activeId: 'parent',
    }));
    onAgentEvent?.({
      type: 'snapshot',
      partial: true,
      sessions: [
        {
          identity: { sessionId: 'phoneFed', generation: 'g1' },
          status: 'idle',
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'text', text: '手机灌进来的' }],
              timestamp: 77_000,
            },
          ],
          commands: [],
        },
      ],
    });
    const phoneFed = sessionsModule.useSessionsStore.getState().conversations.phoneFed;
    expect(phoneFed.messages).toEqual([]);
    expect(phoneFed.lastActiveAt).toBe(77_000);
    expect(phoneFed.started).toBe(true);
    expect(phoneFed.generation).toBe('g1');
  });

  it('冷会话正文本来就是空时，快照不清掉失败标记', () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        emptyCold: {
          ...state.conversations.parent,
          id: 'emptyCold',
          parentId: undefined,
          activeTabId: undefined,
          started: true,
          spawning: false,
          status: 'idle',
          generation: 'g1',
          sessionFile: '/tmp/emptyCold.jsonl',
          messages: [],
          customEntries: [],
          historyLoadAttempted: true,
        },
      },
      order: ['parent', 'emptyCold'],
      activeId: 'parent',
    }));
    onAgentEvent?.({
      type: 'snapshot',
      partial: true,
      sessions: [
        {
          identity: { sessionId: 'emptyCold', generation: 'g1' },
          status: 'idle',
          messages: [],
          commands: [],
        },
      ],
    });
    expect(
      sessionsModule.useSessionsStore.getState().conversations.emptyCold.historyLoadAttempted
    ).toBe(true);
  });

  it('空 partial snapshot 带 sessionId：目标不在 worker 则收回 started，正在看就清空并读尾窗', () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        gone: {
          ...state.conversations.parent,
          id: 'gone',
          parentId: undefined,
          activeTabId: undefined,
          started: true,
          spawning: false,
          status: 'idle',
          sessionFile: '/tmp/gone.jsonl',
          messages: [{ role: 'assistant', content: [{ type: 'text', text: '前半' }] }],
        },
      },
      order: ['parent', 'gone'],
      activeId: 'gone',
    }));
    readParentHistoryTail.mockClear();
    onAgentEvent?.({ type: 'snapshot', partial: true, sessionId: 'gone', sessions: [] });
    const gone = sessionsModule.useSessionsStore.getState().conversations.gone;
    expect(gone.started).toBe(false);
    expect(gone.messages).toEqual([]);
    expect(readParentHistoryTail).toHaveBeenCalledWith('gone');
  });

  it('空 snapshot 清掉已尝试过的正文后仍会再读历史', async () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: { ...state.conversations.parent, activeTabId: 'watched-child' },
        'watched-child': {
          ...state.conversations.parent,
          id: 'watched-child',
          parentId: 'parent',
          started: true,
          spawning: false,
          status: 'idle',
          sessionFile: '/tmp/watched-child.jsonl',
          historyLoadAttempted: true,
          messages: [{ role: 'assistant', content: [{ type: 'text', text: '前半' }] }],
        },
      },
      activeId: 'parent',
    }));
    readChildHistory.mockResolvedValueOnce({
      ok: true,
      projection: {
        records: [{ type: 'safe-assistant-text', text: '补回', at: 1 }],
        partial: false,
      },
    } as never);
    onAgentEvent?.({
      type: 'snapshot',
      partial: true,
      sessionId: 'watched-child',
      sessions: [],
    });
    await vi.waitFor(() =>
      expect(
        sessionsModule.useSessionsStore.getState().conversations['watched-child'].messages
      ).toHaveLength(1)
    );
    expect(readChildHistory).toHaveBeenCalledWith('watched-child');
  });

  it('空 partial snapshot 带 sessionId：spawning 中的会话不动', () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        reviving: {
          ...state.conversations.parent,
          id: 'reviving',
          parentId: undefined,
          activeTabId: undefined,
          started: true,
          spawning: true,
          status: 'idle',
          sessionFile: '/tmp/reviving.jsonl',
          messages: [{ role: 'assistant', content: [{ type: 'text', text: '前半' }] }],
        },
      },
      order: ['parent', 'reviving'],
      activeId: 'parent',
    }));
    onAgentEvent?.({ type: 'snapshot', partial: true, sessionId: 'reviving', sessions: [] });
    const reviving = sessionsModule.useSessionsStore.getState().conversations.reviving;
    expect(reviving.started).toBe(true);
    expect(reviving.messages).toHaveLength(1);
  });

  it('在会话里坐超 TTL 再离开，TTL 内后台 upsert 仍写入', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const template = sessionsModule.useSessionsStore.getState().conversations.parent;
    sessionsModule.useSessionsStore.setState({
      conversations: {
        stay: {
          ...template,
          id: 'stay',
          started: false,
          sessionFile: undefined,
          activeTabId: undefined,
          parentId: undefined,
          messages: [],
        },
        leave: {
          ...template,
          id: 'leave',
          started: true,
          sessionFile: '/tmp/leave.jsonl',
          status: 'running',
          generation: 'g1',
          lastSeq: 0,
          historyBaseIndex: undefined,
          activeTabId: undefined,
          parentId: undefined,
          messages: [{ role: 'assistant', content: [{ type: 'text', text: '前半' }] }],
        },
      },
      order: ['stay', 'leave'],
      activeId: 'stay',
    });
    sessionsModule.useSessionsStore.getState().selectConversation('leave');
    vi.setSystemTime(1_000 + MESSAGE_CACHE_TTL_MS + 1);
    sessionsModule.useSessionsStore.getState().selectConversation('stay');
    onAgentEvent?.({
      type: 'message-upsert',
      identity: { sessionId: 'leave', generation: 'g1' },
      seq: 1,
      index: 0,
      message: { role: 'assistant', content: [{ type: 'text', text: '后半' }] },
    });
    const message = sessionsModule.useSessionsStore.getState().conversations.leave.messages[0];
    expect((message.content[0] as { text: string }).text).toBe('后半');
  });

  it('活跃中留存:仍在活跃中时点开重新计时,已移出的点开不回来', () => {
    vi.useFakeTimers();
    const minute = 60_000;
    vi.setSystemTime(100 * minute);
    settingsModule.useSettingsStore.setState({ activeRetentionMinutes: 30 });
    const template = sessionsModule.useSessionsStore.getState().conversations.parent;
    const at = (id: string, timestamp: number, unread?: boolean) => ({
      ...template,
      id,
      started: false,
      sessionFile: undefined,
      status: 'idle' as const,
      activeTabId: undefined,
      parentId: undefined,
      unread,
      messages: [{ role: 'assistant' as const, content: [], timestamp }],
    });
    sessionsModule.useSessionsStore.setState({
      conversations: {
        recent: at('recent', 90 * minute),
        unreadOld: at('unreadOld', 10 * minute, true),
        expired: at('expired', 10 * minute),
      },
      order: ['recent', 'unreadOld', 'expired'],
      activeId: null,
    });
    const store = sessionsModule.useSessionsStore.getState();
    store.selectConversation('recent');
    store.selectConversation('unreadOld');
    store.selectConversation('expired');
    const conversations = sessionsModule.useSessionsStore.getState().conversations;
    expect(conversations.recent.activeRenewedAt).toBe(100 * minute);
    expect(conversations.unreadOld.activeRenewedAt).toBe(100 * minute);
    expect(conversations.expired.activeRenewedAt).toBeUndefined();
    settingsModule.useSettingsStore.setState({ activeRetentionMinutes: 0 });
  });

  it('活跃中留存:侧栏刷新间隔内刚超时、仍显示着的会话点开也续期', () => {
    vi.useFakeTimers();
    const minute = 60_000;
    vi.setSystemTime(100 * minute);
    settingsModule.useSettingsStore.setState({ activeRetentionMinutes: 30 });
    const template = sessionsModule.useSessionsStore.getState().conversations.parent;
    sessionsModule.useSessionsStore.setState({
      conversations: {
        edge: {
          ...template,
          id: 'edge',
          started: false,
          sessionFile: undefined,
          status: 'idle',
          activeTabId: undefined,
          parentId: undefined,
          unread: false,
          messages: [{ role: 'assistant', content: [], timestamp: 70 * minute - 30_000 }],
        },
      },
      order: ['edge'],
      activeId: null,
    });
    sessionsModule.useSessionsStore.getState().selectConversation('edge');
    expect(sessionsModule.useSessionsStore.getState().conversations.edge.activeRenewedAt).toBe(
      100 * minute
    );
    settingsModule.useSettingsStore.setState({ activeRetentionMinutes: 0 });
  });

  it('活跃中留存关闭时点开不记录续期', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    settingsModule.useSettingsStore.setState({ activeRetentionMinutes: 0 });
    const template = sessionsModule.useSessionsStore.getState().conversations.parent;
    sessionsModule.useSessionsStore.setState({
      conversations: {
        done: {
          ...template,
          id: 'done',
          started: false,
          sessionFile: undefined,
          status: 'idle',
          activeTabId: undefined,
          parentId: undefined,
          unread: true,
          messages: [],
        },
      },
      order: ['done'],
      activeId: null,
    });
    sessionsModule.useSessionsStore.getState().selectConversation('done');
    expect(
      sessionsModule.useSessionsStore.getState().conversations.done.activeRenewedAt
    ).toBeUndefined();
  });

  it('连续切 coworker 时，已过 TTL 的正文马上清掉，不等下一次满 TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const template = sessionsModule.useSessionsStore.getState().conversations.parent;
    const body = (text: string) => [
      { role: 'assistant' as const, content: [{ type: 'text' as const, text }] },
    ];
    sessionsModule.useSessionsStore.setState({
      conversations: {
        parent: {
          ...template,
          id: 'parent',
          parentId: undefined,
          activeTabId: undefined,
          coworkerIds: ['cw-a', 'cw-b'],
          messages: body('parent-body'),
        },
        'cw-a': {
          ...template,
          id: 'cw-a',
          parentId: 'parent',
          activeTabId: undefined,
          messages: body('a-body'),
        },
        'cw-b': {
          ...template,
          id: 'cw-b',
          parentId: 'parent',
          activeTabId: undefined,
          messages: body('b-body'),
        },
      },
      order: ['parent'],
      activeId: 'parent',
    });
    const store = sessionsModule.useSessionsStore.getState();
    // 先钉住当前视图再写正文，避免沿用上一个测试留下的过期盖章。
    try {
      store.selectTab('parent', undefined);
      sessionsModule.useSessionsStore.setState((state) => ({
        conversations: {
          ...state.conversations,
          parent: {
            ...state.conversations.parent,
            activeTabId: undefined,
            messages: body('parent-body'),
          },
          'cw-a': { ...state.conversations['cw-a'], messages: body('a-body') },
          'cw-b': { ...state.conversations['cw-b'], messages: body('b-body') },
        },
      }));
      store.selectTab('parent', 'cw-a');
      // 若 cw-b 还带着过期盖章，上面这次切换会清掉它；补回后再离开，才算仍在 TTL 内。
      sessionsModule.useSessionsStore.setState((state) => ({
        conversations: {
          ...state.conversations,
          'cw-b': { ...state.conversations['cw-b'], messages: body('b-body') },
        },
      }));
      store.selectTab('parent', 'cw-b');
      vi.setSystemTime(10_000 + MESSAGE_CACHE_TTL_MS);
      store.selectTab('parent', undefined);

      const conversations = sessionsModule.useSessionsStore.getState().conversations;
      expect(conversations['cw-a'].messages).toEqual([]);
      expect(conversations['cw-b'].messages).toEqual(body('b-body'));
      expect(conversations.parent.messages).toEqual(body('parent-body'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('冷会话的可见输出仍续 lastOutputAt（节流），正文不落地，用户消息不算', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const template = sessionsModule.useSessionsStore.getState().conversations.parent;
    sessionsModule.useSessionsStore.setState({
      conversations: {
        stay: {
          ...template,
          id: 'stay',
          started: false,
          sessionFile: undefined,
          activeTabId: undefined,
          parentId: undefined,
          messages: [],
        },
        bgRun: {
          ...template,
          id: 'bgRun',
          started: true,
          sessionFile: '/tmp/bgRun.jsonl',
          status: 'running',
          generation: 'g1',
          lastSeq: 0,
          lastOutputAt: 1_000,
          historyBaseIndex: undefined,
          activeTabId: undefined,
          parentId: undefined,
          messages: [],
        },
      },
      order: ['stay', 'bgRun'],
      activeId: 'stay',
    });
    const upsert = (
      seq: number,
      message: Extract<RendererAgentEvent, { type: 'message-upsert' }>['message']
    ) =>
      onAgentEvent?.({
        type: 'message-upsert',
        identity: { sessionId: 'bgRun', generation: 'g1' },
        seq,
        index: seq - 1,
        message,
      });
    const bgRun = () => sessionsModule.useSessionsStore.getState().conversations.bgRun;

    vi.setSystemTime(60_000);
    upsert(1, { role: 'user', content: [{ type: 'text', text: 'hi' }] });
    expect(bgRun().lastOutputAt).toBe(1_000);

    upsert(2, { role: 'assistant', content: [{ type: 'text', text: 'working' }] });
    expect(bgRun().messages).toEqual([]);
    expect(bgRun().lastOutputAt).toBe(60_000);

    vi.setSystemTime(62_000);
    upsert(3, { role: 'assistant', content: [{ type: 'text', text: 'working more' }] });
    expect(bgRun().lastOutputAt).toBe(60_000);
  });

  it('冷会话新消息推进 lastActiveAt，侧栏时间不停在冷却那一刻', () => {
    const template = sessionsModule.useSessionsStore.getState().conversations.parent;
    sessionsModule.useSessionsStore.setState({
      conversations: {
        stay: { ...template, id: 'stay', activeTabId: undefined, parentId: undefined },
        coldRun: {
          ...template,
          id: 'coldRun',
          started: true,
          sessionFile: '/tmp/coldRun.jsonl',
          status: 'running',
          generation: 'g1',
          lastSeq: 0,
          lastActiveAt: 5_000,
          activeTabId: undefined,
          parentId: undefined,
          messages: [],
        },
      },
      order: ['stay', 'coldRun'],
      activeId: 'stay',
    });
    const upsert = (seq: number, timestamp: number) =>
      onAgentEvent?.({
        type: 'message-upsert',
        identity: { sessionId: 'coldRun', generation: 'g1' },
        seq,
        index: seq - 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], timestamp },
      });
    const coldRun = () => sessionsModule.useSessionsStore.getState().conversations.coldRun;

    upsert(1, 9_000);
    expect(coldRun().messages).toEqual([]);
    expect(coldRun().lastActiveAt).toBe(9_000);
    upsert(2, 3_000);
    expect(coldRun().lastActiveAt).toBe(9_000);
  });
});
