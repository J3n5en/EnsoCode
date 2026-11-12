import type { ChildSessionIdentity } from '@shared/builtinAgents';
import type {
  ChildHistoryResult,
  RendererAgentEvent,
  SourceAuthorityProjection,
} from '@shared/types/agent';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentPrompt,
  bindSessionProjection,
  createConversation,
  dismissCoworker,
  hireCoworker,
  installSessionGlobals,
  loadSessionModules,
  onAgentEvent,
  readChildHistory,
  resetSessionHarness,
  selectConversation,
  sessionsModule,
  settingsModule,
  sourceRead,
  summarizeTitle,
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

const childIdentity = (
  index: number,
  generation = `11111111-1111-4111-8111-11111111110${index}`
): ChildSessionIdentity => ({
  sessionId: `parent::cw-child-${index}`,
  generation,
  parent: {
    sessionId: 'parent',
    generation: '22222222-2222-4222-8222-222222222222',
  },
  instanceId: `123e4567-e89b-42d3-a456-42661417400${index}`,
  instanceName: `Scout · a${index}`,
  typeKey: 'builtin:scout',
});

const reserve = (index: number): RendererAgentEvent => {
  const child = childIdentity(index);
  return {
    type: 'child-reserved',
    identity: child,
    seq: 1,
    requestId: `123e4567-e89b-42d3-a456-42661417401${index}`,
    metadata: {
      parentId: 'parent',
      childGeneration: child.generation,
      agentTypeKey: child.typeKey,
      agentInstanceId: child.instanceId,
      agentInstanceName: child.instanceName,
      dispatchOrigin: 'typed-mention',
    },
  };
};

describe('typed Agent child projection', () => {
  beforeAll(async () => {
    await loadSessionModules();
  });

  beforeEach(async () => {
    await resetSessionHarness();
  });

  describe('已结束 child 的只读回放', () => {
    const receipt = { receiptId: 'r1', summary: 'theme: system → dark' } as never;

    function endedChild() {
      sessionsModule.useSessionsStore.setState((state) => ({
        conversations: {
          ...state.conversations,
          ended: {
            ...state.conversations.parent,
            id: 'ended',
            parentId: 'parent',
            started: false,
            messages: [],
            customEntries: [],
            historyOnly: undefined,
            historyLoadAttempted: undefined,
          },
        },
      }));
    }

    it('切到已结束 child 时拉取历史并标记只读', async () => {
      endedChild();
      readChildHistory.mockResolvedValueOnce({
        ok: true,
        projection: {
          records: [
            { type: 'safe-user-text', text: '把主题改成暗色', at: 1 },
            { type: 'capability-receipt', receipt, at: 2 },
            { type: 'safe-assistant-text', text: '已完成', at: 3 },
          ],
          partial: false,
        },
      } as never);

      sessionsModule.useSessionsStore.getState().selectTab('parent', 'ended');
      await vi.waitFor(() =>
        expect(sessionsModule.useSessionsStore.getState().conversations.ended.historyOnly).toBe(
          true
        )
      );

      const conversation = sessionsModule.useSessionsStore.getState().conversations.ended;
      expect(conversation.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
      expect(conversation.customEntries).toEqual([{ kind: 'capability-receipt', receipt }]);
      expect(readChildHistory).toHaveBeenCalledTimes(1);
    });

    it('只读会话发不出消息，且文案说明实例已结束', async () => {
      endedChild();
      sessionsModule.useSessionsStore.setState((state) => ({
        conversations: {
          ...state.conversations,
          ended: { ...state.conversations.ended, historyOnly: true },
          parent: { ...state.conversations.parent, activeTabId: 'ended' },
        },
        activeId: 'parent',
      }));

      const before = sessionsModule.useSessionsStore.getState().conversations.ended.messages.length;
      const error = await sessionsModule.useSessionsStore
        .getState()
        .send('再来一次', { providerId: 'p', modelId: 'm', cwd: '/workspace' });

      expect(error).toContain('read-only');
      expect(agentPrompt).not.toHaveBeenCalled();
      // 关键：拦截要发生在乐观回显之前。只断言错误文案会放过“消息已入只读历史”这个 bug。
      expect(sessionsModule.useSessionsStore.getState().conversations.ended.messages).toHaveLength(
        before
      );
    });

    it('失败不重试，活会话不走这条路径', async () => {
      endedChild();
      sessionsModule.useSessionsStore.getState().selectTab('parent', 'ended');
      await vi.waitFor(() => expect(readChildHistory).toHaveBeenCalledTimes(1));
      sessionsModule.useSessionsStore.getState().selectTab('parent', 'ended');
      await Promise.resolve();
      expect(readChildHistory).toHaveBeenCalledTimes(1);

      readChildHistory.mockClear();
      sessionsModule.useSessionsStore.setState((state) => ({
        conversations: {
          ...state.conversations,
          live: { ...state.conversations.ended, id: 'live', started: true },
        },
      }));
      sessionsModule.useSessionsStore.getState().selectTab('parent', 'live');
      await Promise.resolve();
      expect(readChildHistory).not.toHaveBeenCalled();
    });

    it('回放完成前 worker 已写入正文，就不再盖成只读', async () => {
      let resolveHistory: (value: ChildHistoryResult) => void = () => {};
      readChildHistory.mockImplementationOnce(
        () =>
          new Promise<ChildHistoryResult>((resolve) => {
            resolveHistory = resolve;
          })
      );
      sessionsModule.useSessionsStore.setState((state) => ({
        conversations: {
          ...state.conversations,
          child: {
            ...state.conversations.parent,
            id: 'child',
            parentId: 'parent',
            started: true,
            spawning: false,
            status: 'idle' as const,
            sessionFile: '/tmp/child.jsonl',
            messages: [],
            historyOnly: undefined,
            historyLoadAttempted: undefined,
          },
        },
      }));
      sessionsModule.useSessionsStore.getState().selectTab('parent', 'child');
      sessionsModule.useSessionsStore.setState((state) => ({
        conversations: {
          ...state.conversations,
          child: {
            ...state.conversations.child,
            messages: [{ role: 'assistant', content: [{ type: 'text', text: 'live' }] }],
          },
        },
      }));
      resolveHistory({
        ok: true,
        projection: {
          records: [{ type: 'safe-assistant-text', text: 'file', at: 1 }],
          partial: false,
        },
      } as ChildHistoryResult);
      await vi.waitFor(() =>
        expect(
          sessionsModule.useSessionsStore.getState().conversations.child.historyLoading
        ).toBeUndefined()
      );
      const child = sessionsModule.useSessionsStore.getState().conversations.child;
      expect(child.historyOnly).toBeUndefined();
      expect(child.messages).toEqual([
        { role: 'assistant', content: [{ type: 'text', text: 'live' }] },
      ]);
    });

    it('worker 快照带回正文后收回只读标记', () => {
      const child = childIdentity(1);
      onAgentEvent?.(reserve(1));
      sessionsModule.useSessionsStore.setState((state) => ({
        conversations: {
          ...state.conversations,
          [child.sessionId]: {
            ...state.conversations[child.sessionId],
            historyOnly: true,
            historyLoadAttempted: true,
            sessionFile: '/tmp/child.jsonl',
            messages: [{ role: 'assistant', content: [{ type: 'text', text: 'file' }] }],
          },
        },
      }));
      sessionsModule.useSessionsStore.getState().selectTab('parent', child.sessionId);
      onAgentEvent?.({
        type: 'snapshot',
        partial: true,
        sessions: [
          {
            identity: child,
            status: 'idle',
            messages: [{ role: 'assistant', content: [{ type: 'text', text: 'worker' }] }],
            commands: [],
            child: {
              parentId: 'parent',
              childGeneration: child.generation,
              agentTypeKey: child.typeKey,
              agentInstanceId: child.instanceId,
              agentInstanceName: child.instanceName,
              dispatchOrigin: 'typed-mention',
            },
          },
        ],
      });
      const conversation =
        sessionsModule.useSessionsStore.getState().conversations[child.sessionId];
      expect(conversation.historyOnly).toBeUndefined();
      expect(conversation.messages[0]?.content).toEqual([{ type: 'text', text: 'worker' }]);
    });

    it('冷缓存清掉正文后清掉已尝试标记，再打开会重读', async () => {
      try {
        endedChild();
        readChildHistory.mockResolvedValue({
          ok: true,
          projection: {
            records: [{ type: 'safe-user-text', text: '把主题改成暗色', at: 1 }],
            partial: false,
          },
        } as never);
        sessionsModule.useSessionsStore.getState().selectTab('parent', 'ended');
        await vi.waitFor(() =>
          expect(
            sessionsModule.useSessionsStore.getState().conversations.ended.messages
          ).toHaveLength(1)
        );
        sessionsModule.useSessionsStore.getState().selectTab('parent', undefined);
        const leftAt = Date.now();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(leftAt + MESSAGE_CACHE_TTL_MS + 1);
        sessionsModule.useSessionsStore.setState((state) => ({
          conversations: {
            ...state.conversations,
            other: {
              ...state.conversations.parent,
              id: 'other',
              parentId: undefined,
              activeTabId: undefined,
            },
          },
        }));
        sessionsModule.useSessionsStore.getState().selectConversation('other');
        expect(sessionsModule.useSessionsStore.getState().conversations.ended.messages).toEqual([]);
        expect(
          sessionsModule.useSessionsStore.getState().conversations.ended.historyLoadAttempted
        ).toBeUndefined();
        readChildHistory.mockClear();
        sessionsModule.useSessionsStore.getState().selectTab('parent', 'ended');
        await vi.waitFor(() => expect(readChildHistory).toHaveBeenCalledTimes(1));
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('coworker dismiss 兑底与 ended 标记', () => {
    /** 在父会话下挂一个 coworker 会话（模拟重启后的持久化形状） */
    function seedCoworker(overrides: Record<string, unknown> = {}) {
      sessionsModule.useSessionsStore.setState((state) => ({
        conversations: {
          ...state.conversations,
          parent: {
            ...state.conversations.parent,
            coworkerIds: ['parent::cw-dead'],
            activeTabId: 'parent::cw-dead',
          },
          'parent::cw-dead': {
            ...state.conversations.parent,
            id: 'parent::cw-dead',
            parentId: 'parent',
            coworkerName: 'bob',
            coworkerIds: undefined,
            activeTabId: undefined,
            started: false,
            spawning: false,
            ...overrides,
          },
        },
      }));
    }

    it('死 tab（未 started）dismiss 失败时本地移除：删会话、收缩 coworkerIds、tab 回落', async () => {
      // 重启后 worker/Main 侧无实体，IPC 必然拒绝；不兑底就是永远关不掉的僵尸 tab。
      seedCoworker();
      dismissCoworker.mockResolvedValueOnce({ ok: false, error: 'not-found' });
      await sessionsModule.useSessionsStore
        .getState()
        .dismissCoworkerFromUI('parent', 'parent::cw-dead');
      const state = sessionsModule.useSessionsStore.getState();
      expect(state.conversations['parent::cw-dead']).toBeUndefined();
      expect(state.conversations.parent.coworkerIds).toEqual([]);
      expect(state.conversations.parent.activeTabId).toBeUndefined();
    });

    it('活 coworker（started）dismiss 失败时状态不动（不能静默吞掉活会话的 tab）', async () => {
      seedCoworker({ started: true });
      dismissCoworker.mockResolvedValueOnce({ ok: false, error: 'transient' });
      await sessionsModule.useSessionsStore
        .getState()
        .dismissCoworkerFromUI('parent', 'parent::cw-dead');
      const state = sessionsModule.useSessionsStore.getState();
      expect(state.conversations['parent::cw-dead']).toBeDefined();
      expect(state.conversations.parent.coworkerIds).toEqual(['parent::cw-dead']);
    });

    it('dismiss 成功时本地不动，tab 删除由 coworker-update 回流驱动（单一数据流）', async () => {
      seedCoworker({ started: true });
      dismissCoworker.mockResolvedValueOnce({ ok: true });
      await sessionsModule.useSessionsStore
        .getState()
        .dismissCoworkerFromUI('parent', 'parent::cw-dead');
      const state = sessionsModule.useSessionsStore.getState();
      expect(state.conversations['parent::cw-dead']).toBeDefined();
      expect(state.conversations.parent.coworkerIds).toEqual(['parent::cw-dead']);
    });

    it('coworker-update 复活清除 ended 标记，且 ended 随 partialize 落盘', () => {
      seedCoworker({ ended: true, generation: undefined });
      sessionsModule.useSessionsStore.setState((state) => ({
        conversations: {
          ...state.conversations,
          parent: { ...state.conversations.parent, generation: 'pg1' },
        },
      }));
      // 落盘验证：ended 必须进 partialize，否则重启后级联恢复无从筛选
      const partialize = sessionsModule.useSessionsStore.persist.getOptions().partialize;
      const persisted = partialize?.(sessionsModule.useSessionsStore.getState()) as {
        conversations: Record<string, { ended?: boolean }>;
      };
      expect(persisted.conversations['parent::cw-dead'].ended).toBe(true);

      onAgentEvent?.({
        type: 'coworker-update',
        identity: { sessionId: 'parent', generation: 'pg1' },
        seq: 1,
        coworker: {
          id: 'parent::cw-dead',
          name: 'bob',
          status: 'idle',
          modelId: 'm',
          sessionFile: '/tmp/coworker.jsonl',
          createdAt: 1,
        },
      });
      const conversation =
        sessionsModule.useSessionsStore.getState().conversations['parent::cw-dead'];
      expect(conversation.started).toBe(true);
      expect(conversation.ended).toBeUndefined();
    });

    describe('task 子代理结束后 tab 延迟收进历史', () => {
      const TASK = 'parent::cw-task';
      let seq = 0;
      const dismissedEvent = (): RendererAgentEvent => ({
        type: 'coworker-update',
        identity: { sessionId: 'parent', generation: 'pg1' },
        seq: ++seq,
        coworker: { id: TASK, name: 'bob', status: 'dismissed', createdAt: 0 },
      });
      const seedTask = (mode: 'task' | 'coworker' = 'task') => {
        sessionsModule.useSessionsStore.setState((state) => ({
          conversations: {
            ...state.conversations,
            parent: {
              ...state.conversations.parent,
              generation: 'pg1',
              coworkerIds: [TASK],
              activeTabId: TASK,
            },
            [TASK]: {
              ...state.conversations.parent,
              id: TASK,
              parentId: 'parent',
              coworkerIds: undefined,
              activeTabId: undefined,
              started: true,
              spawning: false,
              child: { mode } as never,
            },
          },
        }));
      };
      const tabs = () =>
        sessionsModule.useSessionsStore.getState().conversations.parent.coworkerIds;

      it('Main 自动回收的 task：先保留只读 tab，延迟后再移除', () => {
        vi.useFakeTimers();
        try {
          seedTask();
          onAgentEvent?.(dismissedEvent());
          const lingering = sessionsModule.useSessionsStore.getState().conversations[TASK];
          expect(tabs()).toEqual([TASK]);
          expect(lingering).toMatchObject({ started: false, ended: true, historyOnly: true });
          vi.advanceTimersByTime(60_000);
          const state = sessionsModule.useSessionsStore.getState();
          expect(state.conversations[TASK]).toBeUndefined();
          expect(tabs()).toEqual([]);
          expect(state.conversations.parent.activeTabId).toBeUndefined();
        } finally {
          vi.useRealTimers();
        }
      });

      it('用户手动解雇与 coworker 模式仍立即移除', async () => {
        seedTask();
        dismissCoworker.mockResolvedValueOnce({ ok: true });
        await sessionsModule.useSessionsStore.getState().dismissCoworkerFromUI('parent', TASK);
        onAgentEvent?.(dismissedEvent());
        expect(tabs()).toEqual([]);

        seedTask('coworker');
        onAgentEvent?.(dismissedEvent());
        expect(tabs()).toEqual([]);
      });
    });

    it('已预约的 coworker 收到模型后写入 lastModelId，输入栏能显示当前模型', () => {
      onAgentEvent?.(reserve(1));
      const child = childIdentity(1);
      onAgentEvent?.({
        type: 'coworker-update',
        identity: child.parent,
        seq: 2,
        coworker: {
          id: child.sessionId,
          child: {
            parentId: 'parent',
            childGeneration: child.generation,
            agentTypeKey: child.typeKey,
            agentInstanceId: child.instanceId,
            agentInstanceName: child.instanceName,
            dispatchOrigin: 'typed-mention',
          },
          name: child.instanceName,
          agentType: child.typeKey,
          status: 'running',
          modelId: 'claude-opus-5',
          createdAt: 1,
        },
      });
      expect(
        sessionsModule.useSessionsStore.getState().conversations[child.sessionId].lastModelId
      ).toBe('claude-opus-5');
    });

    it('worker 回流的 coworker-update 不带 mode 时保留 Main 预约的 task / coworker 模式', () => {
      const reserved = reserve(1);
      if (reserved.type !== 'child-reserved') throw new Error('expected reservation');
      onAgentEvent?.({ ...reserved, metadata: { ...reserved.metadata, mode: 'task' } });
      const child = childIdentity(1);
      onAgentEvent?.({
        type: 'coworker-update',
        identity: child.parent,
        seq: 2,
        coworker: {
          id: child.sessionId,
          child: { ...reserved.metadata },
          name: child.instanceName,
          agentType: child.typeKey,
          status: 'running',
          createdAt: 1,
        },
      });
      expect(
        sessionsModule.useSessionsStore.getState().conversations[child.sessionId].child?.mode
      ).toBe('task');
    });

    it('worker 回流的 metadata 来源恒为 typed-mention、不带 mode：落盘仍是 Main 预约的 agent-tool coworker，重启换代后也是', () => {
      const reserved = reserve(1);
      if (reserved.type !== 'child-reserved') throw new Error('expected reservation');
      onAgentEvent?.({
        ...reserved,
        metadata: { ...reserved.metadata, dispatchOrigin: 'agent-tool', mode: 'coworker' },
      });
      const child = childIdentity(1);
      const fromWorker = { ...reserved.metadata, dispatchOrigin: 'typed-mention' as const };
      const persistedChild = () => {
        const partialize = sessionsModule.useSessionsStore.persist.getOptions().partialize;
        const persisted = partialize?.(sessionsModule.useSessionsStore.getState()) as {
          conversations: Record<string, { child?: { dispatchOrigin?: string; mode?: string } }>;
        };
        return persisted.conversations[child.sessionId].child;
      };

      onAgentEvent?.({
        type: 'coworker-update',
        identity: child.parent,
        seq: 2,
        coworker: {
          id: child.sessionId,
          child: fromWorker,
          name: child.instanceName,
          agentType: child.typeKey,
          status: 'running',
          createdAt: 1,
        },
      });
      expect(persistedChild()).toMatchObject({ dispatchOrigin: 'agent-tool', mode: 'coworker' });

      onAgentEvent?.({
        type: 'snapshot',
        partial: true,
        sessions: [
          { identity: child, status: 'idle', messages: [], commands: [], child: fromWorker },
        ],
      });
      expect(persistedChild()).toMatchObject({ dispatchOrigin: 'agent-tool', mode: 'coworker' });

      // Main 重启后按落盘 metadata 恢复，worker 带着新 generation 回流
      const resumed = { ...fromWorker, childGeneration: '33333333-3333-4333-8333-333333333333' };
      onAgentEvent?.({
        type: 'coworker-update',
        identity: child.parent,
        seq: 3,
        coworker: {
          id: child.sessionId,
          child: resumed,
          name: child.instanceName,
          agentType: child.typeKey,
          status: 'idle',
          createdAt: 2,
        },
      });
      expect(persistedChild()).toMatchObject({
        childGeneration: resumed.childGeneration,
        dispatchOrigin: 'agent-tool',
        mode: 'coworker',
      });
    });
  });

  describe('手动雇佣委托 Main dispatch', () => {
    it('已启动父会话：委托 IPC，错误透传；未启动：不发 IPC', async () => {
      hireCoworker.mockClear();
      sessionsModule.useSessionsStore.setState((state) => ({
        conversations: {
          ...state.conversations,
          parent: { ...state.conversations.parent, started: true },
        },
      }));
      const ok = await sessionsModule.useSessionsStore
        .getState()
        .hireCoworker('parent', ' bob ', 'Scout');
      expect(ok).toBeNull();
      expect(hireCoworker).toHaveBeenCalledWith('parent', 'bob', 'Scout');

      hireCoworker.mockResolvedValueOnce({ ok: false, error: 'capacity reached' });
      const failed = await sessionsModule.useSessionsStore
        .getState()
        .hireCoworker('parent', 'bob2');
      expect(failed).toBe('capacity reached');

      hireCoworker.mockClear();
      sessionsModule.useSessionsStore.setState((state) => ({
        conversations: {
          ...state.conversations,
          parent: { ...state.conversations.parent, started: false },
        },
      }));
      const notStarted = await sessionsModule.useSessionsStore
        .getState()
        .hireCoworker('parent', 'bob');
      expect(notStarted).toBe('conversation not started');
      expect(hireCoworker).not.toHaveBeenCalled();
    });
  });

  describe('手机新建会话的 Source Authority', () => {
    const phoneSessionId = '77777777-7777-4777-8777-777777777777';
    const pairSession = {
      sessionId: phoneSessionId,
      projectId: 'project',
      providerId: 'p',
      modelId: 'm',
      reasoningEnabled: true,
      thinkingLevel: 'medium',
    };

    it('adoptPairSession 用手机 sessionId 登记 root 权威', async () => {
      createConversation.mockClear();
      sessionsModule.useSessionsStore.getState().adoptPairSession(pairSession);
      await vi.waitFor(() =>
        expect(createConversation).toHaveBeenCalledWith(
          expect.objectContaining({
            projectId: 'project',
            projectVersion: 1,
            conversationId: phoneSessionId,
          })
        )
      );
      expect(sessionsModule.useSessionsStore.getState().conversations[phoneSessionId]?.id).toBe(
        phoneSessionId
      );
    });

    it('点开未登记权威的手机会话会补登记，不标 history-only', async () => {
      sessionsModule.useSessionsStore.setState((state) => ({
        conversations: {
          ...state.conversations,
          [phoneSessionId]: {
            ...state.conversations.parent,
            id: phoneSessionId,
            title: 'from phone',
            started: true,
            parentId: undefined,
            error: undefined,
          },
        },
        order: [phoneSessionId, ...state.order],
      }));
      createConversation.mockClear();
      sessionsModule.useSessionsStore.getState().selectConversation(phoneSessionId);
      await vi.waitFor(() =>
        expect(createConversation).toHaveBeenCalledWith(
          expect.objectContaining({ conversationId: phoneSessionId, projectId: 'project' })
        )
      );
      expect(
        sessionsModule.useSessionsStore.getState().conversations[phoneSessionId]?.error
      ).toBeUndefined();
      expect(selectConversation).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: phoneSessionId })
      );
    });

    it('权威版本被抬高后重试激活，不把对话分支标成 history-only', async () => {
      const branchId = '33333333-3333-4333-8333-333333333333';
      let snapshotVersion = 1;
      const liveVersion = 2;
      sourceRead.mockImplementation(async () => ({
        projects: sourceProjection.projects,
        conversations: [
          ...sourceProjection.conversations.filter(
            (conversation) => conversation.conversationId !== branchId
          ),
          {
            conversationId: branchId,
            projectId: 'project',
            kind: 'root',
            lifecycle: 'ready',
            version: snapshotVersion,
          },
        ],
      }));
      selectConversation.mockImplementation(
        (request: { conversationId: string; version?: number }) => {
          if (request.conversationId === branchId && request.version !== liveVersion) {
            snapshotVersion = liveVersion;
            return Promise.resolve({
              accepted: false as const,
              error: 'Conversation authority is stale or unavailable.',
            }) as never;
          }
          return Promise.resolve({
            accepted: true as const,
            value: {
              conversationId: request.conversationId,
              projectId: 'project',
              kind: 'root' as const,
              lifecycle: 'ready' as const,
              version: request.version ?? liveVersion,
            },
          }) as never;
        }
      );
      sessionsModule.useSessionsStore.setState((state) => ({
        conversations: {
          ...state.conversations,
          [branchId]: {
            ...state.conversations.parent,
            id: branchId,
            title: 'Parent (分支)',
            started: false,
            sessionFile: '/tmp/branch.jsonl',
            forkedFromConversationId: 'parent',
            forkedFromEntryId: 'leaf-1',
            parentId: undefined,
            error: undefined,
          },
        },
        order: [branchId, ...state.order],
      }));

      selectConversation.mockClear();
      sessionsModule.useSessionsStore.getState().selectConversation(branchId);
      await vi.waitFor(() =>
        expect(
          selectConversation.mock.calls.filter((call) => call[0]?.conversationId === branchId)
            .length
        ).toBeGreaterThanOrEqual(2)
      );
      expect(
        sessionsModule.useSessionsStore.getState().conversations[branchId]?.error
      ).toBeUndefined();
    });

    it('手机端新建的会话在后台收到首条用户消息时自动生成截断标题并触发标题总结', async () => {
      const freshPhoneSessionId = '88888888-8888-4888-8888-888888888888';
      summarizeTitle.mockClear();
      settingsModule.useSettingsStore.setState({ titleSummaryEnabled: true });
      // 1. 手机新建会话：adoptPairSession 登记，此时无标题且未在桌面激活（activeId 是 parent，作为冷会话）
      sessionsModule.useSessionsStore.getState().adoptPairSession({
        ...pairSession,
        sessionId: freshPhoneSessionId,
      });
      sessionsModule.useSessionsStore.setState({ activeId: 'parent' });
      expect(
        sessionsModule.useSessionsStore.getState().conversations[freshPhoneSessionId]?.title
      ).toBe('');

      // 2. 手机端发送首条用户消息，worker 回传 message-upsert 事件
      onAgentEvent?.({
        type: 'message-upsert',
        identity: { sessionId: freshPhoneSessionId, generation: 'g1' },
        seq: 1,
        index: 0,
        message: {
          role: 'user',
          content: [{ type: 'text', text: '帮我写个贪吃蛇小游戏\n第二行内容' }],
        },
      });

      // 3. 验证冷会话也正确补全了截断标题，且触发了标题总结
      expect(
        sessionsModule.useSessionsStore.getState().conversations[freshPhoneSessionId]?.title
      ).toBe('帮我写个贪吃蛇小游戏');
      expect(summarizeTitle).toHaveBeenCalledWith(
        freshPhoneSessionId,
        { kind: 'initial', text: '帮我写个贪吃蛇小游戏\n第二行内容' },
        expect.objectContaining({ providerId: 'p', modelId: 'm' })
      );

      // 4. 当 title-generated 到达时，AI 标题覆盖基准截断标题
      onAgentEvent?.({
        type: 'title-generated',
        conversationId: freshPhoneSessionId,
        title: '贪吃蛇游戏开发',
      });
      expect(
        sessionsModule.useSessionsStore.getState().conversations[freshPhoneSessionId]?.title
      ).toBe('贪吃蛇游戏开发');
    });

    it('插件注入的消息也算首句，插件建的会话不会停在「新对话」', async () => {
      const pluginSessionId = '77777777-7777-4777-8777-777777777777';
      summarizeTitle.mockClear();
      settingsModule.useSettingsStore.setState({ titleSummaryEnabled: true });
      sessionsModule.useSessionsStore.getState().adoptPairSession({
        ...pairSession,
        sessionId: pluginSessionId,
      });
      sessionsModule.useSessionsStore.setState({ activeId: 'parent' });
      expect(sessionsModule.useSessionsStore.getState().conversations[pluginSessionId]?.title).toBe(
        ''
      );

      onAgentEvent?.({
        type: 'message-upsert',
        identity: { sessionId: pluginSessionId, generation: 'g1' },
        seq: 1,
        index: 0,
        message: {
          role: 'custom',
          content: [{ type: 'text', text: '你是这场战役的指挥官，先跑 engage_status' }],
          pluginSource: { pluginId: 'enso.hornet', pluginName: 'Hornet' },
        },
      });

      expect(sessionsModule.useSessionsStore.getState().conversations[pluginSessionId]?.title).toBe(
        '你是这场战役的指挥官，先跑 engage_status'
      );
      expect(summarizeTitle).toHaveBeenCalledWith(
        pluginSessionId,
        { kind: 'initial', text: '你是这场战役的指挥官，先跑 engage_status' },
        expect.objectContaining({ providerId: 'p', modelId: 'm' })
      );
    });

    it('标题总结关闭时冷会话保留截断标题，不调用 summarizeTitle', async () => {
      const disabledSessionId = '99999999-9999-4999-8999-999999999999';
      summarizeTitle.mockClear();
      settingsModule.useSettingsStore.setState({ titleSummaryEnabled: false });

      sessionsModule.useSessionsStore.getState().adoptPairSession({
        ...pairSession,
        sessionId: disabledSessionId,
      });
      sessionsModule.useSessionsStore.setState({ activeId: 'parent' });

      onAgentEvent?.({
        type: 'message-upsert',
        identity: { sessionId: disabledSessionId, generation: 'g1' },
        seq: 1,
        index: 0,
        message: {
          role: 'user',
          content: [{ type: 'text', text: '关闭总结时的标题测试' }],
        },
      });

      expect(
        sessionsModule.useSessionsStore.getState().conversations[disabledSessionId]?.title
      ).toBe('关闭总结时的标题测试');
      expect(summarizeTitle).not.toHaveBeenCalled();
    });

    it('热会话收到首条用户消息时同样补全标题并触发总结', async () => {
      const hotSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      summarizeTitle.mockClear();
      settingsModule.useSettingsStore.setState({ titleSummaryEnabled: true });

      sessionsModule.useSessionsStore.getState().adoptPairSession({
        ...pairSession,
        sessionId: hotSessionId,
      });
      // 设为热会话
      sessionsModule.useSessionsStore.setState({ activeId: hotSessionId });

      onAgentEvent?.({
        type: 'message-upsert',
        identity: { sessionId: hotSessionId, generation: 'g1' },
        seq: 1,
        index: 0,
        message: {
          role: 'user',
          content: [{ type: 'text', text: '热会话标题测试\n详细内容' }],
        },
      });

      expect(sessionsModule.useSessionsStore.getState().conversations[hotSessionId]?.title).toBe(
        '热会话标题测试'
      );
      expect(summarizeTitle).toHaveBeenCalledWith(
        hotSessionId,
        { kind: 'initial', text: '热会话标题测试\n详细内容' },
        expect.objectContaining({ providerId: 'p', modelId: 'm' })
      );
    });
  });
});
