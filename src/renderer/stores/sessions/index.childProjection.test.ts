import type { ChildSessionIdentity } from '@shared/builtinAgents';
import type { RendererAgentEvent, SourceAuthorityProjection } from '@shared/types/agent';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentPrompt,
  agentSpawn,
  bindSessionProjection,
  bindSource,
  createConversation,
  dispatch,
  installSessionGlobals,
  loadSessionModules,
  onAgentEvent,
  onDispatchEvent,
  registerModelSelection,
  resetSessionHarness,
  selectConversation,
  sessionsModule,
  settingsModule,
  updateConversationSelection,
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
installSessionGlobals({ captureAsks: true });

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

describe('typed Agent child projection', () => {
  beforeAll(async () => {
    await loadSessionModules();
  });

  beforeEach(async () => {
    await resetSessionHarness();
  });

  it('已归档的空会话不会被新建会话复用', async () => {
    nextConversationId = 'archived-empty';
    const archivedId = await sessionsModule.useSessionsStore.getState().newConversation('project');
    expect(archivedId).toBe('archived-empty');

    sessionsModule.useSessionsStore.getState().toggleArchiveConversation(archivedId!);
    sessionsModule.useSessionsStore.getState().selectConversation('parent');
    nextConversationId = 'fresh-empty';

    const createdId = await sessionsModule.useSessionsStore.getState().newConversation('project');
    expect(createdId).toBe('fresh-empty');
    const conversations = sessionsModule.useSessionsStore.getState().conversations;
    expect(conversations[createdId!].archived).not.toBe(true);
    expect(conversations[archivedId!].archived).toBe(true);
  });

  it('未归档的空会话仍会被新建会话复用', async () => {
    nextConversationId = 'reusable-empty';
    const emptyId = await sessionsModule.useSessionsStore.getState().newConversation('project');
    sessionsModule.useSessionsStore.getState().selectConversation('parent');
    createConversation.mockClear();

    const reusedId = await sessionsModule.useSessionsStore.getState().newConversation('project');
    expect(reusedId).toBe(emptyId);
    expect(createConversation).not.toHaveBeenCalled();
  });

  it('点击系统通知按正常选中流程打开会话：激活权威选择并清未读', async () => {
    const onFocusSession = vi.mocked(window.electronAPI.agent.onFocusSession);
    const focus = onFocusSession.mock.calls[0]?.[0] as (sessionId: string) => void;
    sessionsModule.useSessionsStore.setState((state) => ({
      activeId: null,
      conversations: {
        ...state.conversations,
        parent: { ...state.conversations.parent, unread: true },
      },
    }));
    selectConversation.mockClear();

    focus('parent');

    const state = sessionsModule.useSessionsStore.getState();
    expect(state.activeId).toBe('parent');
    expect(state.conversations.parent.unread).toBe(false);
    await vi.waitFor(() =>
      expect(selectConversation).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'parent' })
      )
    );
  });

  it('worker snapshot 恢复命令但会话持久化不保存命令列表', async () => {
    const commands = [{ name: 'review', description: '检查当前改动' }];
    onAgentEvent?.({
      type: 'snapshot',
      partial: true,
      sessions: [
        {
          identity: { sessionId: 'parent', generation: 'command-generation' },
          status: 'idle',
          messages: [],
          commands,
        },
      ],
    });
    expect(sessionsModule.useSessionsStore.getState().conversations.parent.commands).toEqual(
      commands
    );
    const storage = sessionsModule.useSessionsStore.persist.getOptions().storage!;
    await storage.getItem('enso-conversations');
    const calls = vi.mocked(window.electronAPI.settings.writeKey).mock.calls;
    const saved = calls.filter(([name]) => name === 'enso-conversations').at(-1)?.[1];
    expect(saved).toMatchObject({ state: { conversations: { parent: { commands: [] } } } });
  });

  it('冷会话已有标题时连续后台消息不触发持久化', async () => {
    const store = sessionsModule.useSessionsStore;
    store.setState((state) => ({
      conversations: {
        ...state.conversations,
        cold: { ...state.conversations.parent, id: 'cold', title: '后台会话' },
      },
    }));
    const storage = store.persist.getOptions().storage!;
    await storage.getItem('enso-conversations');
    const write = vi.spyOn(storage, 'setItem');
    const before = store.getState().conversations.cold;
    for (let seq = 1; seq <= 100; seq++) {
      onAgentEvent?.({
        type: 'message-upsert',
        identity: { sessionId: 'cold', generation: 'g1' },
        seq,
        index: 0,
        message: { role: 'assistant', content: [{ type: 'text', text: `片段 ${seq}` }] },
      });
    }
    expect(store.getState().conversations.cold).toBe(before);
    expect(write.mock.calls.length).toBe(0);
    write.mockRestore();
  });

  it('冷会话无标题时助手消息与空用户消息也不触发持久化', async () => {
    const store = sessionsModule.useSessionsStore;
    store.setState((state) => ({
      conversations: {
        ...state.conversations,
        untitled: { ...state.conversations.parent, id: 'untitled', title: '' },
      },
    }));
    const storage = store.persist.getOptions().storage!;
    await storage.getItem('enso-conversations');
    const write = vi.spyOn(storage, 'setItem');
    for (const role of ['assistant', 'user'] as const) {
      onAgentEvent?.({
        type: 'message-upsert',
        identity: { sessionId: 'untitled', generation: 'g1' },
        seq: 1,
        index: 0,
        message: { role, content: [{ type: 'text', text: '' }] },
      });
    }
    expect(write.mock.calls.length).toBe(0);
    write.mockRestore();
  });

  it('会话 store 连续更新合并在 IPC 之前，并保存最终元数据', async () => {
    const store = sessionsModule.useSessionsStore;
    const storage = store.persist.getOptions().storage!;
    await storage.getItem('enso-conversations');
    const writeKey = vi.mocked(window.electronAPI.settings.writeKey);
    writeKey.mockClear();
    let finish!: (value: boolean) => void;
    writeKey.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      })
    );
    for (let index = 0; index <= 600; index++) {
      store.setState((state) => ({
        conversations: {
          ...state.conversations,
          parent: { ...state.conversations.parent, title: `标题 ${index}` },
        },
      }));
    }
    expect(writeKey.mock.calls.length).toBe(1);
    finish(true);
    await storage.getItem('enso-conversations');
    expect(writeKey.mock.calls.length).toBe(2);
    expect(writeKey.mock.calls.at(-1)?.[1]).toMatchObject({
      state: { conversations: { parent: { title: '标题 600' } } },
    });
  });

  it('parent-rejected clears started and lands failed so retry can spawn again', () => {
    // spawn IPC ack 后 store 乐观置 started:true；若 rejected 到达时不清回 false，
    // 重发会走 prompt 分支打到 worker 里不存在的会话，重试彻底无声。
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          spawning: false,
          generation: 'pg1',
        },
      },
    }));
    onAgentEvent?.({
      type: 'parent-rejected',
      identity: { sessionId: 'parent', generation: 'pg1' },
      seq: 0,
      reason: 'no api key',
    });
    const conversation = sessionsModule.useSessionsStore.getState().conversations.parent;
    expect(conversation.started).toBe(false);
    expect(conversation.status).toBe('failed');
    expect(conversation.error).toBe('no api key');
    expect(conversation.generation).toBeUndefined();
  });

  it('worker 已不持有会话时拒绝的消息自动 resume 后重投，不要求手动重新恢复', async () => {
    enableRewindResumeModel();
    agentSpawn.mockResolvedValue({ ok: true });
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          spawning: false,
          status: 'idle' as const,
          generation: 'pg1',
          sessionFile: '/tmp/evicted.jsonl',
          lastProviderId: 'p1',
          lastModelId: 'm1',
          messages: [
            {
              role: 'user' as const,
              content: [{ type: 'text' as const, text: 'hello again' }],
              optimistic: true,
              deliveryId: 'd1',
            },
          ],
        },
      },
    }));
    onAgentEvent?.({
      type: 'parent-rejected',
      identity: { sessionId: 'parent', generation: 'pg1' },
      seq: 0,
      reason: 'unknown or stale session generation: parent',
    });
    await vi.waitFor(() =>
      expect(agentPrompt).toHaveBeenCalledWith(
        'parent',
        'hello again',
        undefined,
        expect.any(String)
      )
    );
    expect(agentSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'parent', resumeFile: '/tmp/evicted.jsonl' })
    );
    const conversation = sessionsModule.useSessionsStore.getState().conversations.parent;
    expect(conversation.started).toBe(true);
    expect(conversation.error).toBeUndefined();
    expect(conversation.queuedMessages ?? []).toEqual([]);
    expect(
      conversation.messages.filter((message) => message.role === 'user').map((m) => m.content)
    ).toEqual([[{ type: 'text', text: 'hello again' }]]);

    // 恢复后仍被同因拒绝：不再无限重试，落 failed 交给手动恢复
    agentSpawn.mockClear();
    onAgentEvent?.({
      type: 'parent-rejected',
      identity: { sessionId: 'parent', generation: 'pg1' },
      seq: 0,
      reason: 'unknown or stale session generation: parent',
    });
    await Promise.resolve();
    const after = sessionsModule.useSessionsStore.getState().conversations.parent;
    expect(agentSpawn).not.toHaveBeenCalled();
    expect(after.started).toBe(false);
    expect(after.status).toBe('failed');
    expect(after.error).toBe('unknown or stale session generation: parent');
  });

  it('partialize never persists started and resets stale running status to idle', () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          status: 'running' as const,
          sessionFile: '/tmp/parent.jsonl',
        },
        orphan: {
          ...state.conversations.parent,
          id: 'orphan',
          started: true,
          status: 'running' as const,
          sessionFile: undefined,
        },
      },
    }));
    const partialize = sessionsModule.useSessionsStore.persist.getOptions().partialize;
    const persisted = partialize?.(sessionsModule.useSessionsStore.getState()) as {
      conversations: Record<
        string,
        { started: boolean; status: string; error?: string; sessionFile?: string }
      >;
    };
    // started 是运行态，永不落盘；有 sessionFile 的降为 idle 等回放，
    // 无 sessionFile 的无从回放，直接落终态带错误文案。
    expect(persisted.conversations.parent).toMatchObject({ started: false, status: 'idle' });
    expect(persisted.conversations.orphan).toMatchObject({
      started: false,
      status: 'failed',
      error: 'Session ended — history not restored',
    });
  });

  it('creates and selects a fresh placeholder for every reservation without adding the task to parent messages', () => {
    onAgentEvent?.(reserve(1));
    onAgentEvent?.(reserve(2));
    const state = sessionsModule.useSessionsStore.getState();
    expect(state.conversations.parent.coworkerIds).toEqual([
      'parent::cw-child-1',
      'parent::cw-child-2',
    ]);
    expect(state.activeId).toBe('parent');
    expect(state.conversations.parent.activeTabId).toBeUndefined();
    expect(state.conversations['parent::cw-child-1']).toMatchObject({
      spawning: true,
      child: { agentTypeKey: 'builtin:scout', agentInstanceName: 'Scout · a1' },
    });
    expect(state.conversations.parent.messages).toEqual([]);
  });

  it('本窗口手动派发才聚焦新 child；正在看别的会话或别的 child 时不抢', async () => {
    let requestId = '';
    dispatch.mockImplementation(async (request: { requestId: string }) => {
      requestId = request.requestId;
      return {
        accepted: true,
        requestId,
        dispatchId: '123e4567-e89b-42d3-a456-426614174021',
        child: childIdentity(1),
      };
    });
    const accepted = await sessionsModule.useSessionsStore
      .getState()
      .dispatchAgent(
        'builtin:scout',
        { text: 'inspect the project', images: [], fileMentions: [] },
        { providerId: 'parent-provider', modelId: 'parent-model' }
      );
    expect(accepted.accepted).toBe(true);
    const first = reserve(1);
    if (first.type !== 'child-reserved') throw new Error('expected reservation');
    onAgentEvent?.({ ...first, requestId });
    expect(sessionsModule.useSessionsStore.getState().conversations.parent.activeTabId).toBe(
      'parent::cw-child-1'
    );

    sessionsModule.useSessionsStore.setState((state) => ({
      activeId: 'other',
      conversations: {
        ...state.conversations,
        other: {
          ...state.conversations.parent,
          id: 'other',
          parentId: undefined,
          activeTabId: undefined,
        },
        parent: { ...state.conversations.parent, activeTabId: 'parent::cw-child-1' },
      },
    }));
    dispatch.mockImplementation(async (request: { requestId: string }) => {
      requestId = request.requestId;
      return {
        accepted: true,
        requestId,
        dispatchId: '123e4567-e89b-42d3-a456-426614174022',
        child: childIdentity(2),
      };
    });
    sessionsModule.useSessionsStore.setState({ activeId: 'parent' });
    await sessionsModule.useSessionsStore
      .getState()
      .dispatchAgent(
        'builtin:scout',
        { text: 'second', images: [], fileMentions: [] },
        { providerId: 'parent-provider', modelId: 'parent-model' }
      );
    sessionsModule.useSessionsStore.setState({ activeId: 'other' });
    const second = reserve(2);
    if (second.type !== 'child-reserved') throw new Error('expected reservation');
    onAgentEvent?.({ ...second, requestId });
    expect(sessionsModule.useSessionsStore.getState().activeId).toBe('other');
    expect(sessionsModule.useSessionsStore.getState().conversations.parent.activeTabId).toBe(
      'parent::cw-child-1'
    );
    expect(sessionsModule.useSessionsStore.getState().conversations.parent.coworkerIds).toContain(
      'parent::cw-child-2'
    );
  });

  it('后到的旧 select 不再写回 fork 来源', async () => {
    const original = selectConversation.getMockImplementation();
    let releaseOld: () => void = () => {};
    sourceProjection = {
      ...sourceProjection,
      conversations: [
        ...sourceProjection.conversations,
        {
          conversationId: 'old',
          projectId: 'project',
          kind: 'root' as const,
          lifecycle: 'ready' as const,
          version: 1,
        },
      ],
    };
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        old: { ...state.conversations.parent, id: 'old' },
      },
    }));
    selectConversation.mockImplementation(async (request: { conversationId: string }) => {
      if (request.conversationId === 'old') {
        return new Promise((resolve) => {
          releaseOld = () =>
            resolve({
              accepted: true,
              value: {
                conversationId: 'old',
                projectId: 'project',
                kind: 'root',
                lifecycle: 'ready',
                version: 1,
                forkedFrom: { conversationId: 'origin-conversation', entryId: 'entry-1' },
              },
            });
        });
      }
      return {
        accepted: true as const,
        value: sourceProjection.conversations.find(
          (conversation) => conversation.conversationId === request.conversationId
        )!,
      };
    });
    try {
      sessionsModule.useSessionsStore.getState().selectConversation('old');
      sessionsModule.useSessionsStore.getState().selectConversation('parent');
      await vi.waitFor(() =>
        expect(selectConversation).toHaveBeenCalledWith(
          expect.objectContaining({ conversationId: 'parent', selectionEpoch: expect.any(Number) })
        )
      );
      releaseOld();
      await Promise.resolve();
      expect(
        sessionsModule.useSessionsStore.getState().conversations.old.forkedFromConversationId
      ).toBeUndefined();
    } finally {
      if (original) selectConversation.mockImplementation(original);
    }
  });

  it('keeps child task, ASK, receipt history, and stale generation handling in the child TAB', () => {
    onAgentEvent?.(reserve(1));
    const child = childIdentity(1);
    onAgentEvent?.({
      type: 'child-ready',
      identity: child,
      seq: 2,
      sessionFile: '/tmp/child.jsonl',
    });
    onAgentEvent?.({
      type: 'message-upsert',
      identity: child,
      seq: 3,
      index: 0,
      message: { role: 'user', content: [{ type: 'text', text: 'child task' }], timestamp: 10 },
    });
    onAgentEvent?.({
      type: 'ask-request',
      identity: child,
      seq: 4,
      ask: { requestId: 'ask-1', question: 'Continue?' },
    });
    onAgentEvent?.({
      type: 'session-custom-entry',
      identity: child,
      seq: 5,
      entry: {
        kind: 'capability-receipt',
        receipt: {
          receiptId: '123e4567-e89b-42d3-a456-426614174050',
          operationId: '123e4567-e89b-42d3-a456-426614174051',
          child,
          turnId: 'turn-1',
          requestId: '123e4567-e89b-42d3-a456-426614174052',
          capabilityId: 'appearance.theme',
          risk: 'reversible',
          subject: { kind: 'setting', id: 'theme', label: 'Theme' },
          outcome: 'succeeded',
          summary: 'Theme changed to dark',
          changes: [{ field: 'theme', previous: 'light', value: 'dark' }],
          occurredAt: 20,
          sequence: 1,
        },
      },
    });
    onAgentEvent?.({
      type: 'message-upsert',
      identity: { ...child, generation: 'stale-generation' },
      seq: 99,
      index: 0,
      message: { role: 'user', content: [{ type: 'text', text: 'stale task' }] },
    });
    const state = sessionsModule.useSessionsStore.getState();
    const projected = state.conversations[child.sessionId];
    expect(projected).toMatchObject({
      started: true,
      spawning: false,
      sessionFile: '/tmp/child.jsonl',
    });
    expect(projected.messages[0].content).toEqual([{ type: 'text', text: 'child task' }]);
    expect(projected.pendingAsks).toEqual([{ requestId: 'ask-1', question: 'Continue?' }]);
    expect(projected.customEntries).toHaveLength(1);
    expect(state.conversations.parent.messages).toEqual([]);
  });

  it('dispatches through Main binding only and waits for child-reserved before creating a TAB', async () => {
    dispatch.mockResolvedValue({
      accepted: true,
      requestId: '123e4567-e89b-42d3-a456-426614174020',
      dispatchId: '123e4567-e89b-42d3-a456-426614174021',
      child: childIdentity(1),
    });
    const result = await sessionsModule.useSessionsStore.getState().dispatchAgent(
      'builtin:scout',
      {
        text: 'inspect the project',
        images: [],
        fileMentions: [],
      },
      { providerId: 'parent-provider', modelId: 'parent-model' }
    );
    expect(result.accepted).toBe(true);
    expect(registerModelSelection).toHaveBeenCalledWith({
      parentBindingId: 'parent-binding-1',
      selection: { providerId: 'parent-provider', modelId: 'parent-model' },
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        selectionBindingId: 'selection-binding-1',
        typeKey: 'builtin:scout',
        task: { text: 'inspect the project', images: [], fileMentions: [] },
      })
    );
    expect(dispatch.mock.calls[0]?.[0]).not.toHaveProperty('selectedModel');
    expect(
      sessionsModule.useSessionsStore.getState().conversations.parent.coworkerIds
    ).toBeUndefined();
    expect(agentPrompt).not.toHaveBeenCalled();
  });

  it('persists the draft model before dispatching an Agent from a new conversation', async () => {
    dispatch.mockResolvedValue({
      accepted: true,
      requestId: '123e4567-e89b-42d3-a456-426614174080',
      dispatchId: '123e4567-e89b-42d3-a456-426614174081',
      child: childIdentity(1),
    });
    const task = { text: 'inspect from a new chat', images: [], fileMentions: [] };
    const result = await sessionsModule.useSessionsStore
      .getState()
      .dispatchAgent('builtin:scout', task, {
        providerId: 'project-provider',
        modelId: 'project-model',
      });
    expect(result.accepted).toBe(true);
    expect(updateConversationSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'parent',
        selection: { providerId: 'project-provider', modelId: 'project-model' },
      })
    );
    expect(registerModelSelection).toHaveBeenCalledWith({
      parentBindingId: 'parent-binding-1',
      selection: { providerId: 'project-provider', modelId: 'project-model' },
    });
    expect(sessionsModule.useSessionsStore.getState().conversations.parent).toMatchObject({
      lastProviderId: 'project-provider',
      lastModelId: 'project-model',
    });
  });

  it('keeps the settings provider id after parent-ready exposes a different runtime provider', async () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          lastProviderId: 'settings-provider-entry',
          lastModelId: 'logical-model',
        },
      },
    }));
    onAgentEvent?.({
      type: 'parent-ready',
      identity: {
        sessionId: 'parent',
        generation: '33333333-3333-4333-8333-333333333333',
      },
      seq: 1,
      sessionFile: '/tmp/parent.jsonl',
      model: { providerId: 'anthropic#oauth-account', modelId: 'logical-model' },
    });
    expect(sessionsModule.useSessionsStore.getState().conversations.parent).toMatchObject({
      lastProviderId: 'settings-provider-entry',
      lastModelId: 'logical-model',
    });

    dispatch.mockResolvedValue({
      accepted: true,
      requestId: '123e4567-e89b-42d3-a456-426614174070',
      dispatchId: '123e4567-e89b-42d3-a456-426614174071',
      child: childIdentity(1),
    });
    const task = { text: 'use the selected settings entry', images: [], fileMentions: [] };
    const result = await sessionsModule.useSessionsStore
      .getState()
      .dispatchAgent('builtin:scout', task, {
        providerId: 'settings-provider-entry',
        modelId: 'logical-model',
      });

    expect(result.accepted).toBe(true);
    expect(registerModelSelection).toHaveBeenLastCalledWith({
      parentBindingId: 'parent-binding-1',
      selection: { providerId: 'settings-provider-entry', modelId: 'logical-model' },
    });
    expect(dispatch).toHaveBeenLastCalledWith({
      requestId: expect.any(String),
      selectionBindingId: 'selection-binding-1',
      typeKey: 'builtin:scout',
      task,
    });
  });

  it('rejects a forged persisted conversation that Main source authority does not project', async () => {
    sourceProjection = { ...sourceProjection, conversations: [] };
    bindSource.mockClear();
    const result = await sessionsModule.useSessionsStore
      .getState()
      .dispatchAgent(
        'builtin:scout',
        { text: 'must not run', images: [], fileMentions: [] },
        { providerId: 'parent-provider', modelId: 'parent-model' }
      );
    expect(result).toMatchObject({ accepted: false, code: 'invalid-binding' });
    expect(bindSource).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('buffers the independent Main stream and rejects cross-child, stale generation, and post-terminal events', () => {
    const childA = childIdentity(1);
    const childB = childIdentity(2);
    const dispatchId = '123e4567-e89b-42d3-a456-426614174060';
    onDispatchEvent?.({
      dispatchId,
      child: childA,
      mainSeq: 1,
      phase: 'running',
    });
    onAgentEvent?.(reserve(1));
    onAgentEvent?.(reserve(2));
    onDispatchEvent?.({
      dispatchId,
      child: childA,
      mainSeq: 2,
      phase: 'terminal',
      terminal: 'failed',
      receiptSummary: 'Capability failed',
    });
    onDispatchEvent?.({
      dispatchId,
      child: childA,
      mainSeq: 3,
      phase: 'running',
    });
    onDispatchEvent?.({
      dispatchId,
      child: { ...childA, generation: 'stale-generation' },
      mainSeq: 4,
      phase: 'terminal',
      terminal: 'completed',
    });
    const state = sessionsModule.useSessionsStore.getState();
    expect(state.conversations[childA.sessionId]).toMatchObject({
      status: 'failed',
      error: 'Capability failed',
      dispatchMainEvents: {
        [dispatchId]: { mainSeq: 2, phase: 'terminal', terminal: 'failed' },
      },
    });
    expect(state.conversations[childB.sessionId].dispatchMainEvents).toEqual({});
  });

  it('persists child metadata only, then restores child history and a new generation from snapshot', () => {
    onAgentEvent?.(reserve(1));
    const child = childIdentity(1);
    const before = sessionsModule.useSessionsStore.getState().conversations[child.sessionId];
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        [child.sessionId]: {
          ...before,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'ephemeral' }] }],
          customEntries: [
            {
              kind: 'agent-dispatch',
              child: {
                sessionId: child.sessionId,
                generation: child.generation,
                instanceId: child.instanceId,
                instanceName: child.instanceName,
                typeKey: child.typeKey,
              },
              at: 1,
            },
          ],
        },
      },
    }));
    const partialize = sessionsModule.useSessionsStore.persist.getOptions().partialize;
    const persisted = partialize?.(sessionsModule.useSessionsStore.getState()) as {
      conversations: Record<
        string,
        {
          child?: { agentTypeKey: string };
          generation?: string;
          messages: unknown[];
          customEntries: unknown[];
        }
      >;
    };
    expect(persisted.conversations[child.sessionId]).toMatchObject({
      child: { agentTypeKey: 'builtin:scout' },
      generation: undefined,
      messages: [],
      customEntries: [],
    });

    const restored = childIdentity(1, 'child-g2');
    onAgentEvent?.({
      type: 'snapshot',
      partial: true,
      sessions: [
        {
          identity: restored,
          status: 'idle',
          messages: [{ role: 'assistant', content: [{ type: 'text', text: 'restored history' }] }],
          commands: [],
          child: {
            parentId: 'parent',
            childGeneration: restored.generation,
            agentTypeKey: restored.typeKey,
            agentInstanceId: restored.instanceId,
            agentInstanceName: restored.instanceName,
            dispatchOrigin: 'typed-mention',
          },
          customEntries: [
            {
              kind: 'agent-completed',
              child: {
                sessionId: restored.sessionId,
                generation: restored.generation,
                instanceId: restored.instanceId,
                instanceName: restored.instanceName,
                typeKey: restored.typeKey,
              },
              receiptSummary: 'Restored safe summary',
              at: 20,
            },
          ],
        },
      ],
    });
    const conversation =
      sessionsModule.useSessionsStore.getState().conversations[restored.sessionId];
    expect(conversation).toMatchObject({
      generation: 'child-g2',
      child: { childGeneration: 'child-g2', agentTypeKey: 'builtin:scout' },
    });
    expect(conversation.messages[0].content).toEqual([{ type: 'text', text: 'restored history' }]);
    expect(conversation.customEntries).toHaveLength(1);
  });
});
