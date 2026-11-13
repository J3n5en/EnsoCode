import type { RendererAgentEvent, SourceAuthorityProjection } from '@shared/types/agent';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentAbort,
  agentPrompt,
  agentRelease,
  agentSpawn,
  bindSessionProjection,
  installSessionGlobals,
  loadSessionModules,
  onAgentEvent,
  resetSessionHarness,
  sessionsModule,
  settingsModule,
  summarizeTitle,
} from './index.testUtils';

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

describe('typed Agent child projection', () => {
  beforeAll(async () => {
    await loadSessionModules();
  });

  beforeEach(async () => {
    await resetSessionHarness();
  });

  it('interruptAndSendQueued aborts the running turn, then prompts once the turn settles', async () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          status: 'running' as const,
          queuedMessages: [{ id: 'q1', text: 'urgent' }],
        },
      },
    }));
    agentAbort.mockClear();
    agentPrompt.mockClear();

    const pending = sessionsModule.useSessionsStore
      .getState()
      .interruptAndSendQueued('parent', 'q1');

    await vi.waitFor(() => expect(agentAbort).toHaveBeenCalledWith('parent'));
    // 轮次未收束前不投递，避免打在还在跑的轮上
    expect(agentPrompt).not.toHaveBeenCalled();

    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: { ...state.conversations.parent, status: 'idle' as const },
      },
    }));
    await pending;

    expect(agentPrompt).toHaveBeenCalledWith('parent', 'urgent', undefined, expect.any(String));
    const echo = sessionsModule.useSessionsStore
      .getState()
      .conversations.parent.messages.find((message) => message.optimistic);
    // 投递标识与回显一致，worker 回执 delivery-settled 才能精确收回它
    expect(echo?.deliveryId).toBe((agentPrompt.mock.calls.at(-1) as unknown[] | undefined)?.[3]);
    expect(echo?.deliveryId).toEqual(expect.any(String));
    expect(
      sessionsModule.useSessionsStore.getState().conversations.parent.queuedMessages
    ).toHaveLength(0);
  });

  it('interruptAndSendQueued 在空闲压缩中：中断压缩并立即投递，不留中断标记', async () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          status: 'idle' as const,
          compaction: 'running',
          queuedMessages: [{ id: 'q1', text: 'urgent' }],
        },
      },
    }));
    agentAbort.mockClear();
    agentPrompt.mockClear();

    await sessionsModule.useSessionsStore.getState().interruptAndSendQueued('parent', 'q1');

    expect(agentAbort).toHaveBeenCalledWith('parent');
    expect(agentPrompt).toHaveBeenCalledWith('parent', 'urgent', undefined, expect.any(String));
    const conversation = sessionsModule.useSessionsStore.getState().conversations.parent;
    expect(conversation.queuedMessages).toHaveLength(0);
    expect(conversation.messages.some((message) => message.optimistic)).toBe(true);
    expect(conversation.abortRequested).not.toBe(true);
  });

  it('removeConversation releases a started idle parent so the worker drops it', () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: { ...state.conversations.parent, started: true, status: 'idle' as const },
      },
    }));
    agentRelease.mockClear();
    agentAbort.mockClear();

    sessionsModule.useSessionsStore.getState().removeConversation('parent');

    expect(agentRelease).toHaveBeenCalledWith('parent');
    expect(agentAbort).not.toHaveBeenCalled();
  });

  it('enqueueMessage queues for the given conversation without touching activeId', () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          status: 'running' as const,
          queuedMessages: [],
        },
      },
      activeId: null,
    }));
    agentPrompt.mockClear();

    sessionsModule.useSessionsStore.getState().enqueueMessage('parent', 'from phone');

    const queued =
      sessionsModule.useSessionsStore.getState().conversations.parent.queuedMessages ?? [];
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ text: 'from phone' });
    // 入队不投递，等本轮收束后由 flushQueue 发
    expect(agentPrompt).not.toHaveBeenCalled();
  });

  it('编辑排队消息保留图片', () => {
    const images = [{ data: 'AAAA', mimeType: 'image/png' }];
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          queuedMessages: [{ id: 'q1', text: 'before', images }],
        },
      },
    }));

    sessionsModule.useSessionsStore.getState().updateQueuedMessage('parent', 'q1', 'after');

    expect(sessionsModule.useSessionsStore.getState().conversations.parent.queuedMessages).toEqual([
      { id: 'q1', text: 'after', images },
    ]);
  });

  it('编辑后的排队消息发送时仍携带图片', async () => {
    const images = [{ data: 'AAAA', mimeType: 'image/png' }];
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          status: 'idle' as const,
          queuedMessages: [{ id: 'q1', text: 'before', images }],
        },
      },
    }));
    agentPrompt.mockClear();

    const store = sessionsModule.useSessionsStore.getState();
    store.updateQueuedMessage('parent', 'q1', 'after');
    store.sendQueuedNow('parent', 'q1');

    await vi.waitFor(() =>
      expect(agentPrompt).toHaveBeenCalledWith('parent', 'after', images, expect.any(String))
    );
  });

  it('仅图片回退事件也把图片交给输入框', () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          spawning: false,
          status: 'idle' as const,
          generation: 'pg1',
          messages: [{ role: 'user', entryId: 'e1', content: [{ type: 'text', text: '' }] }],
        },
      },
    }));
    sessionsModule.useSessionsStore.getState().rewind('parent', 0);
    onAgentEvent?.({
      type: 'rewind-done',
      identity: { sessionId: 'parent', generation: 'pg1' },
      seq: 1,
      editorImages: [{ data: 'AAAA', mimeType: 'image/png' }],
    });

    expect(sessionsModule.useSessionsStore.getState().conversations.parent).toMatchObject({
      draftImages: [{ data: 'AAAA', mimeType: 'image/png' }],
    });
  });

  it('运行中每次只 steer 队首一条排队消息', async () => {
    const steer = vi.mocked(window.electronAPI.agent.steer);
    steer.mockClear();
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          status: 'running' as const,
          queuedMessages: [
            { id: 'q1', text: 'first' },
            { id: 'q2', text: 'second' },
          ],
        },
      },
    }));

    sessionsModule.useSessionsStore.getState().steerQueued('parent');

    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
    expect(steer.mock.calls[0][1]).toBe('first');
    expect(sessionsModule.useSessionsStore.getState().conversations.parent.queuedMessages).toEqual([
      { id: 'q2', text: 'second' },
    ]);
  });

  it('未在运行时不 steer 排队消息', () => {
    const steer = vi.mocked(window.electronAPI.agent.steer);
    steer.mockClear();
    agentPrompt.mockClear();
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          status: 'idle' as const,
          queuedMessages: [{ id: 'q1', text: 'first' }],
        },
      },
    }));

    sessionsModule.useSessionsStore.getState().steerQueued('parent');

    expect(steer).not.toHaveBeenCalled();
    expect(agentPrompt).not.toHaveBeenCalled();
    expect(
      sessionsModule.useSessionsStore.getState().conversations.parent.queuedMessages
    ).toHaveLength(1);
  });

  it('别的窗口发起的回退不把回退文本写进本窗口输入框', () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: { ...state.conversations.parent, generation: 'pg1', draftText: 'mine' },
      },
    }));
    onAgentEvent?.({
      type: 'rewind-done',
      identity: { sessionId: 'parent', generation: 'pg1' },
      seq: 1,
      editorText: 'theirs',
    });
    expect(sessionsModule.useSessionsStore.getState().conversations.parent.draftText).toBe('mine');
  });

  it('连续回退用本次内容成对替换草稿，避免文本和图片串台', () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          spawning: false,
          status: 'idle' as const,
          generation: 'pg1',
          draftText: 'stale text',
          draftImages: [{ data: 'OLD', mimeType: 'image/png' }],
          messages: [
            { role: 'user', entryId: 'e1', content: [{ type: 'text', text: 'one' }] },
            { role: 'user', entryId: 'e2', content: [{ type: 'text', text: 'two' }] },
          ],
        },
      },
    }));

    sessionsModule.useSessionsStore.getState().rewind('parent', 0);
    onAgentEvent?.({
      type: 'rewind-done',
      identity: { sessionId: 'parent', generation: 'pg1' },
      seq: 1,
      editorText: 'fresh text',
    });
    expect(sessionsModule.useSessionsStore.getState().conversations.parent).toMatchObject({
      draftText: 'fresh text',
      draftImages: undefined,
    });

    sessionsModule.useSessionsStore.getState().rewind('parent', 0);
    onAgentEvent?.({
      type: 'rewind-done',
      identity: { sessionId: 'parent', generation: 'pg1' },
      seq: 2,
      editorImages: [{ data: 'NEW', mimeType: 'image/jpeg' }],
    });
    expect(sessionsModule.useSessionsStore.getState().conversations.parent).toMatchObject({
      draftText: undefined,
      draftImages: [{ data: 'NEW', mimeType: 'image/jpeg' }],
    });
  });

  it('压缩进行中发送消息入队，不立刻 prompt', async () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          status: 'idle' as const,
          generation: 'pg1',
          compaction: 'running',
          queuedMessages: [],
        },
      },
      activeId: 'parent',
    }));
    agentPrompt.mockClear();

    const error = await sessionsModule.useSessionsStore
      .getState()
      .send('during compact', { providerId: 'p', modelId: 'm', cwd: '/workspace' });

    expect(error).toBeNull();
    expect(agentPrompt).not.toHaveBeenCalled();
    const conversation = sessionsModule.useSessionsStore.getState().conversations.parent;
    expect(conversation.queuedMessages).toEqual([
      expect.objectContaining({ text: 'during compact' }),
    ]);
    expect(conversation.messages.some((message) => message.optimistic)).toBe(false);
  });

  it('上下文压缩成功结束后自动投递排队消息', async () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          status: 'idle' as const,
          generation: 'pg1',
          compaction: 'running',
          queuedMessages: [{ id: 'q1', text: 'after compact' }],
        },
      },
    }));
    agentPrompt.mockClear();

    onAgentEvent?.({
      type: 'compaction',
      identity: { sessionId: 'parent', generation: 'pg1' },
      seq: 1,
      state: 'end',
    });

    await vi.waitFor(() =>
      expect(agentPrompt).toHaveBeenCalledWith(
        'parent',
        'after compact',
        undefined,
        expect.any(String)
      )
    );
    expect(
      sessionsModule.useSessionsStore.getState().conversations.parent.queuedMessages
    ).toHaveLength(0);
    expect(
      sessionsModule.useSessionsStore.getState().conversations.parent.compaction
    ).toBeUndefined();
  });

  it('压缩结束时已有投递在途（worker 等压完才起轮）：不再泵下一条', async () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          status: 'idle' as const,
          generation: 'pg1',
          compaction: 'running',
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: 'in flight' }],
              timestamp: 1,
              optimistic: true,
              deliveryId: 'd1',
            },
          ],
          queuedMessages: [{ id: 'q2', text: 'next' }],
        },
      },
    }));
    agentPrompt.mockClear();

    onAgentEvent?.({
      type: 'compaction',
      identity: { sessionId: 'parent', generation: 'pg1' },
      seq: 1,
      state: 'end',
    });
    await Promise.resolve();

    expect(agentPrompt).not.toHaveBeenCalled();
    expect(sessionsModule.useSessionsStore.getState().conversations.parent.queuedMessages).toEqual([
      { id: 'q2', text: 'next' },
    ]);
  });

  it('运行中压缩时用户中断：压缩放弃收口不吞中断标记，被中断轮收束时也不泵队列', async () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          status: 'running' as const,
          generation: 'pg1',
          compaction: 'running',
          queuedMessages: [{ id: 'q1', text: 'keep queued' }],
        },
      },
    }));
    agentPrompt.mockClear();
    await sessionsModule.useSessionsStore.getState().abort('parent');
    const identity = { sessionId: 'parent', generation: 'pg1' };
    onAgentEvent?.({ type: 'status', identity, seq: 1, status: 'idle' });
    onAgentEvent?.({ type: 'compaction', identity, seq: 2, state: 'end', abandoned: true });
    onAgentEvent?.({ type: 'turn-completed', identity, seq: 3, turnId: 't1' });
    await Promise.resolve();

    expect(agentPrompt).not.toHaveBeenCalled();
    const conversation = sessionsModule.useSessionsStore.getState().conversations.parent;
    expect(conversation.queuedMessages).toEqual([{ id: 'q1', text: 'keep queued' }]);
    expect(conversation.abortRequested).toBe(false);
  });

  it('空闲压缩中停止：不留中断标记（无轮次收束可消费），下一轮完成照常泵队列', async () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          status: 'idle' as const,
          generation: 'pg1',
          compaction: 'running',
          queuedMessages: [{ id: 'q1', text: 'later' }],
        },
      },
    }));
    agentPrompt.mockClear();
    await sessionsModule.useSessionsStore.getState().abort('parent');
    const identity = { sessionId: 'parent', generation: 'pg1' };
    onAgentEvent?.({ type: 'compaction', identity, seq: 1, state: 'end', abandoned: true });
    await Promise.resolve();
    expect(agentPrompt).not.toHaveBeenCalled();
    expect(sessionsModule.useSessionsStore.getState().conversations.parent.abortRequested).not.toBe(
      true
    );

    onAgentEvent?.({ type: 'turn-completed', identity, seq: 2, turnId: 't2' });
    await vi.waitFor(() =>
      expect(agentPrompt).toHaveBeenCalledWith('parent', 'later', undefined, expect.any(String))
    );
  });

  it('别的窗口中断的轮次（turn-completed.aborted）：本窗口无中断标记也不泵队列、不续跑目标', async () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          status: 'idle' as const,
          generation: 'pg1',
          queuedMessages: [{ id: 'q1', text: 'sent by other window' }],
          goal: { text: 'ship', status: 'active' as const, autoTurns: 0, noProgressRuns: 0 },
        },
      },
    }));
    agentPrompt.mockClear();

    onAgentEvent?.({
      type: 'turn-completed',
      identity: { sessionId: 'parent', generation: 'pg1' },
      seq: 2,
      turnId: 't1',
      aborted: true,
    });
    await Promise.resolve();

    expect(agentPrompt).not.toHaveBeenCalled();
    expect(sessionsModule.useSessionsStore.getState().conversations.parent.queuedMessages).toEqual([
      { id: 'q1', text: 'sent by other window' },
    ]);
  });

  it('轮次结束时压缩仍在排队则不投递，等压缩结束再发', async () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          status: 'idle' as const,
          generation: 'pg1',
          compaction: 'queued',
          queuedMessages: [{ id: 'q1', text: 'wait for compact' }],
        },
      },
    }));
    agentPrompt.mockClear();

    onAgentEvent?.({
      type: 'turn-completed',
      identity: { sessionId: 'parent', generation: 'pg1' },
      seq: 2,
      turnId: 't1',
    });
    expect(agentPrompt).not.toHaveBeenCalled();
    expect(sessionsModule.useSessionsStore.getState().conversations.parent.queuedMessages).toEqual([
      { id: 'q1', text: 'wait for compact' },
    ]);

    onAgentEvent?.({
      type: 'compaction',
      identity: { sessionId: 'parent', generation: 'pg1' },
      seq: 3,
      state: 'end',
    });
    await vi.waitFor(() =>
      expect(agentPrompt).toHaveBeenCalledWith(
        'parent',
        'wait for compact',
        undefined,
        expect.any(String)
      )
    );
  });

  it('partial snapshot 恢复后先泵排队消息；用户中断收束前不泵', async () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          status: 'idle' as const,
          generation: 'pg1',
          queuedMessages: [{ id: 'q1', text: 'after reload' }],
          abortRequested: true,
        },
      },
    }));
    agentPrompt.mockClear();
    const snapshot: RendererAgentEvent = {
      type: 'snapshot',
      partial: true,
      sessionId: 'parent',
      sessions: [
        {
          identity: { sessionId: 'parent', generation: 'pg1' },
          status: 'idle',
          messages: [],
          commands: [],
        },
      ],
    };

    onAgentEvent?.(snapshot);
    expect(agentPrompt).not.toHaveBeenCalled();
    expect(sessionsModule.useSessionsStore.getState().conversations.parent.abortRequested).toBe(
      true
    );

    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: { ...state.conversations.parent, abortRequested: false },
      },
    }));
    onAgentEvent?.(snapshot);
    await vi.waitFor(() =>
      expect(agentPrompt).toHaveBeenCalledWith(
        'parent',
        'after reload',
        undefined,
        expect.any(String)
      )
    );
    expect(
      sessionsModule.useSessionsStore.getState().conversations.parent.queuedMessages
    ).toHaveLength(0);
  });

  describe('goal 续跑的无进展判定', () => {
    function seedGoal() {
      sessionsModule.useSessionsStore.setState((state) => ({
        conversations: {
          ...state.conversations,
          parent: {
            ...state.conversations.parent,
            started: true,
            status: 'idle' as const,
            generation: 'pg1',
            messages: [],
            lastTurnDigest: undefined,
            // digest 会顺带触发滚动标题总结并留下在飞基准，污染后续标题用例
            titleLocked: true,
            goal: {
              text: 'ship it',
              status: 'active' as const,
              autoTurns: 0,
              noProgressRuns: 2,
              lastOutput: 'old',
            },
          },
        },
      }));
      agentPrompt.mockClear();
    }

    it('正文被冷清空时回退到本轮 digest，不误判无进展', async () => {
      seedGoal();
      onAgentEvent?.({
        type: 'turn-completed',
        identity: { sessionId: 'parent', generation: 'pg1' },
        seq: 2,
        turnId: 't1',
        digest: {
          firstUserText: 'ship it',
          userText: 'ship it',
          assistantText: 'Refactored  the parser',
        },
      });
      await vi.waitFor(() =>
        expect(agentPrompt).toHaveBeenCalledWith(
          'parent',
          expect.stringContaining('<goal-continuation>'),
          undefined,
          expect.any(String)
        )
      );
      expect(sessionsModule.useSessionsStore.getState().conversations.parent.goal).toMatchObject({
        status: 'active',
        autoTurns: 1,
        noProgressRuns: 0,
        lastOutput: 'refactored the parser',
      });
    });

    it('正文与 digest 都为空才计无进展，第三次暂停', () => {
      seedGoal();
      onAgentEvent?.({
        type: 'turn-completed',
        identity: { sessionId: 'parent', generation: 'pg1' },
        seq: 2,
        turnId: 't1',
      });
      expect(agentPrompt).not.toHaveBeenCalled();
      expect(sessionsModule.useSessionsStore.getState().conversations.parent.goal).toMatchObject({
        status: 'paused',
        noProgressRuns: 3,
      });
    });
  });

  describe('放弃排队压缩：清进度但不重钉锚点', () => {
    function seedCompaction(over: Record<string, unknown> = {}) {
      sessionsModule.useSessionsStore.setState((state) => ({
        conversations: {
          ...state.conversations,
          parent: {
            ...state.conversations.parent,
            id: 'parent',
            started: true,
            status: 'idle' as const,
            generation: 'pg1',
            compaction: 'queued' as const,
            compactionNoticeAt: 3,
            compactionError: undefined,
            messages: [
              { role: 'user', content: [{ type: 'text', text: 'm0' }] },
              { role: 'assistant', content: [{ type: 'text', text: 'm1' }] },
              { role: 'user', content: [{ type: 'text', text: 'm2' }] },
              { role: 'assistant', content: [{ type: 'text', text: 'm3' }] },
              { role: 'user', content: [{ type: 'text', text: 'm4' }] },
            ],
            ...over,
          },
        },
      }));
    }

    it('abandoned end 清掉 compaction 进度，但不更新 compactionNoticeAt，也不产生 compactionError', () => {
      seedCompaction();
      onAgentEvent?.({
        type: 'compaction',
        identity: { sessionId: 'parent', generation: 'pg1' },
        seq: 1,
        state: 'end',
        abandoned: true,
      } as RendererAgentEvent);
      const conversation = sessionsModule.useSessionsStore.getState().conversations.parent;
      expect(conversation.compaction).toBeUndefined();
      expect(conversation.compactionNoticeAt).toBe(3);
      expect(conversation.compactionError).toBeUndefined();
    });

    it('对照：普通 end 仍会更新锚点到 messages.length', () => {
      seedCompaction({ compaction: 'running' });
      onAgentEvent?.({
        type: 'compaction',
        identity: { sessionId: 'parent', generation: 'pg1' },
        seq: 1,
        state: 'end',
      });
      const conversation = sessionsModule.useSessionsStore.getState().conversations.parent;
      expect(conversation.compaction).toBeUndefined();
      expect(conversation.compactionNoticeAt).toBe(5);
    });

    it('只持有尾窗时锚点取绝对下标，与时间线行 key 同口径', () => {
      seedCompaction({ compaction: 'running', historyBaseIndex: 100 });
      onAgentEvent?.({
        type: 'compaction',
        identity: { sessionId: 'parent', generation: 'pg1' },
        seq: 1,
        state: 'end',
      });
      expect(
        sessionsModule.useSessionsStore.getState().conversations.parent.compactionNoticeAt
      ).toBe(105);
    });
  });

  it('发送首条带「从这里继续:」和 chat 引用块的消息时，暂存标题跳过引导词且总结源被清洗', async () => {
    const raw = [
      '从这里继续:',
      '[Referenced past chat "@旧会话" — transcript file: C:\\Users\\user\\s.jsonl (pi session jsonl; read it if relevant)]',
      '',
      '但是你说的这个都是针对性修改了吧，通用性会受影响吗？',
    ].join('\n');

    settingsModule.useSettingsStore.setState({ titleSummaryEnabled: true });
    summarizeTitle.mockClear();

    const id = await sessionsModule.useSessionsStore.getState().newConversation('project');
    expect(id).toBeTruthy();

    await sessionsModule.useSessionsStore
      .getState()
      .send(raw, { providerId: 'provider-1', modelId: 'model-1', cwd: '/project' });

    const conv = sessionsModule.useSessionsStore.getState().conversations[id!];
    // 暂存标题跳过「从这里继续:」，直接提取首条正文
    expect(conv.title).toBe('但是你说的这个都是针对性修改了吧，通用性会受影响吗？');

    // 送给 summarizeTitle 的文本清洗掉内部标签和引导行
    expect(summarizeTitle).toHaveBeenCalledWith(
      id,
      { kind: 'initial', text: '但是你说的这个都是针对性修改了吧，通用性会受影响吗？' },
      { providerId: 'provider-1', modelId: 'model-1' }
    );

    // title-generated 事件到达时，会话标题成功更新
    onAgentEvent?.({
      type: 'title-generated',
      conversationId: id!,
      title: '配置层通用性评估',
    });
    expect(sessionsModule.useSessionsStore.getState().conversations[id!].title).toBe(
      '配置层通用性评估'
    );
  });

  it('parent-ready 抢在 spawn IPC 返回之前写入 sessionFile 时，首条消息的标题总结仍然发起', async () => {
    settingsModule.useSettingsStore.setState({ titleSummaryEnabled: true });
    summarizeTitle.mockClear();

    const id = await sessionsModule.useSessionsStore.getState().newConversation('project');
    expect(id).toBeTruthy();

    // 真机时序：worker 的 parent-ready（带 sessionFile）在 spawn() promise resolve 之前就到达 renderer
    const spawn = (
      window as unknown as { electronAPI: { agent: { spawn: ReturnType<typeof vi.fn> } } }
    ).electronAPI.agent.spawn;
    spawn.mockImplementationOnce(async () => {
      onAgentEvent?.({
        type: 'parent-ready',
        identity: { sessionId: id!, generation: 'g1' },
        seq: 1,
        sessionFile: '/tmp/fresh-session.jsonl',
        model: { providerId: 'provider-1', modelId: 'model-1' },
      });
      return { ok: true };
    });

    await sessionsModule.useSessionsStore.getState().send('帮我看看这个竞态问题', {
      providerId: 'provider-1',
      modelId: 'model-1',
      cwd: '/project',
    });

    expect(sessionsModule.useSessionsStore.getState().conversations[id!].sessionFile).toBe(
      '/tmp/fresh-session.jsonl'
    );
    expect(summarizeTitle).toHaveBeenCalledWith(
      id,
      { kind: 'initial', text: '帮我看看这个竞态问题' },
      { providerId: 'provider-1', modelId: 'model-1' }
    );
  });
});

describe('IPC invoke 被拒时按失败分支收尾', () => {
  const target = { providerId: 'p1', modelId: 'm1', cwd: '/workspace' };

  function enableRewindResumeModel() {
    settingsModule.useSettingsStore.setState({
      projects: [{ id: 'project', name: 'Project', path: '/workspace' }],
      providers: [
        {
          id: 'p1',
          name: 'p1',
          api: 'openai-completions',
          apiKey: 'k',
          baseUrl: 'https://example.test/v1',
          enabled: true,
          models: [{ id: 'm1' }],
        },
      ],
      defaultModel: { providerId: 'p1', modelId: 'm1' },
    });
  }

  beforeAll(async () => {
    await loadSessionModules();
  });

  beforeEach(async () => {
    await resetSessionHarness();
  });

  // Main 目前都返回结构化结果；一旦 invoke 本身被拒，不收尾的话乐观气泡永久残留
  it('prompt 被拒：收回乐观气泡、原文退回输入框并报错', async () => {
    const store = sessionsModule.useSessionsStore;
    store.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: { ...state.conversations.parent, started: true, status: 'idle' as const },
      },
    }));
    agentPrompt.mockRejectedValueOnce(new Error('ipc closed'));
    const before = store.getState().conversations.parent.messages.length;
    const error = await store
      .getState()
      .send('hello', target, undefined, 'parent')
      .catch((thrown: unknown) => thrown);
    const after = store.getState().conversations.parent;
    expect(after.messages).toHaveLength(before);
    expect(after.draftText).toBe('hello');
    expect(after).toMatchObject({ started: false, status: 'failed', error: 'ipc closed' });
    expect(error).toBe('ipc closed');
  });

  it('首条消息 spawn 被拒：收回乐观气泡、清 spawning、原文退回输入框', async () => {
    const store = sessionsModule.useSessionsStore;
    agentSpawn.mockRejectedValueOnce(new Error('ipc closed'));
    const error = await store
      .getState()
      .send('hello', target, undefined, 'parent')
      .catch((thrown: unknown) => thrown);
    const after = store.getState().conversations.parent;
    expect(after.messages).toHaveLength(0);
    expect(after.spawning).toBe(false);
    expect(after.draftText).toBe('hello');
    expect(after).toMatchObject({ status: 'failed', error: 'ipc closed' });
    expect(agentPrompt).not.toHaveBeenCalled();
    expect(error).toBe('ipc closed');
  });

  it('resume 的 spawn 被拒：清 spawning 并标失败，之后可再次恢复', async () => {
    enableRewindResumeModel();
    const store = sessionsModule.useSessionsStore;
    store.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: false,
          spawning: false,
          status: 'idle' as const,
          sessionFile: '/tmp/cold.jsonl',
          lastProviderId: 'p1',
          lastModelId: 'm1',
        },
      },
    }));
    agentSpawn.mockRejectedValueOnce(new Error('ipc closed'));
    await store
      .getState()
      .resumeConversation('parent')
      .catch(() => undefined);
    expect(store.getState().conversations.parent).toMatchObject({
      spawning: false,
      started: false,
      status: 'failed',
      error: 'ipc closed',
    });
    await store.getState().resumeConversation('parent');
    expect(agentSpawn).toHaveBeenCalledTimes(2);
    expect(store.getState().conversations.parent.started).toBe(true);
  });
});
