import type { ChildSessionIdentity } from '@shared/builtinAgents';
import type { CapabilityAskRequest } from '@shared/capabilities/types';
import type {
  DispatchMainEvent,
  RendererAgentEvent,
  SourceAuthorityProjection,
} from '@shared/types/agent';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SettingsModule from '../settings';
import type * as SessionsModule from './index';

let onCapabilityAsk: ((request: CapabilityAskRequest) => void) | undefined;
let onAgentEvent: ((event: RendererAgentEvent) => void) | undefined;
let onDispatchEvent: ((event: DispatchMainEvent) => void) | undefined;
let sourceProjection: SourceAuthorityProjection = { projects: [], conversations: [] };
const agentPrompt = vi.fn(async () => ({ ok: true }));
const dispatch = vi.fn();
const registerModelSelection = vi.fn(async () => ({
  accepted: true as const,
  binding: {
    selectionBindingId: 'selection-binding-1',
    parentBindingId: 'parent-binding-1',
    providerId: 'parent-provider',
    modelId: 'parent-model',
    mainRevision: 1,
    source: 'draft-selection' as const,
    issuedAt: Date.now(),
  },
}));
const bindSource = vi.fn(async () => ({
  accepted: true as const,
  requestId: '123e4567-e89b-42d3-a456-426614174011',
  parentBindingId: 'parent-binding-1',
  expiresAt: Date.now() + 60_000,
}));
const sourceRead = vi.fn(async () => sourceProjection);
const selectProject = vi.fn(async (request: { projectId: string }) => ({
  accepted: true as const,
  value: sourceProjection.projects.find((project) => project.projectId === request.projectId)!,
}));
const selectConversation = vi.fn(async (request: { conversationId: string }) => ({
  accepted: true as const,
  value: sourceProjection.conversations.find(
    (conversation) => conversation.conversationId === request.conversationId
  )!,
}));
const createConversation = vi.fn(
  async (request?: { projectId?: string; conversationId?: string }) => {
    const value = {
      conversationId: request?.conversationId ?? 'parent',
      projectId: request?.projectId ?? 'project',
      kind: 'root' as const,
      lifecycle: 'draft' as const,
      version: 1,
    };
    if (
      !sourceProjection.conversations.some(
        (conversation) => conversation.conversationId === value.conversationId
      )
    ) {
      sourceProjection = {
        ...sourceProjection,
        conversations: [...sourceProjection.conversations, value],
      };
    }
    return { accepted: true as const, value };
  }
);
const updateConversationSelection = vi.fn(
  async (request: {
    conversationId: string;
    selection: { providerId: string; modelId: string };
  }) => {
    const current = sourceProjection.conversations.find(
      (conversation) => conversation.conversationId === request.conversationId
    )!;
    const value = {
      ...current,
      version: current.version + 1,
      selection: { ...request.selection, revision: 1 },
    };
    sourceProjection = {
      ...sourceProjection,
      conversations: sourceProjection.conversations.map((conversation) =>
        conversation.conversationId === value.conversationId ? value : conversation
      ),
    };
    return { accepted: true as const, value };
  }
);

const readChildHistory = vi.fn(async (_conversationId: string) => ({
  ok: false as const,
  code: 'not-found' as const,
  error: 'none',
}));
const dismissCoworker = vi.fn(
  async (): Promise<{ ok: boolean; error?: string }> => ({
    ok: true,
  })
);
const hireCoworker = vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true }));
const agentAbort = vi.fn(async (_id: string) => ({ ok: true }));
const agentRelease = vi.fn(async (_id: string) => ({ ok: true }));

vi.stubGlobal('navigator', { language: 'en-US' });
vi.stubGlobal('document', {
  documentElement: {
    lang: 'en',
    classList: { toggle: vi.fn() },
    style: { setProperty: vi.fn(), removeProperty: vi.fn() },
  },
});
vi.stubGlobal('window', {
  matchMedia: () => ({ matches: false, addEventListener: vi.fn() }),
  electronAPI: {
    settings: {
      read: vi.fn(async () => null),
      writeKey: vi.fn(async () => true),
      onChanged: vi.fn(),
    },
    instructions: { delete: vi.fn(async () => ({ ok: true })) },
    capabilities: {
      onAsk: vi.fn((callback: (request: CapabilityAskRequest) => void) => {
        onCapabilityAsk = callback;
        return vi.fn();
      }),
      respond: vi.fn(async () => ({ ok: true, accepted: true })),
    },
    agent: {
      onFocusSession: vi.fn(),
      onEvent: vi.fn((callback: (event: RendererAgentEvent) => void) => {
        onAgentEvent = callback;
        return vi.fn();
      }),
      requestSnapshot: vi.fn(async () => ({ ok: true })),
      readChildHistory,
      prompt: agentPrompt,
      spawn: vi.fn(async () => ({ ok: true })),
      dismissCoworker,
      hireCoworker,
      abort: agentAbort,
      release: agentRelease,
      steer: vi.fn(async () => ({ ok: true })),
    },
    agentDispatch: {
      bindSource,
      registerModelSelection,
      dispatch,
      onEvent: vi.fn((callback: (event: DispatchMainEvent) => void) => {
        onDispatchEvent = callback;
        return vi.fn();
      }),
    },
    sourceAuthority: {
      read: sourceRead,
      onChanged: vi.fn(() => vi.fn()),
      createProject: vi.fn(),
      selectProject,
      removeProject: vi.fn(),
      createConversation,
      selectConversation,
      endConversation: vi.fn(async () => ({ accepted: false })),
      removeConversation: vi.fn(),
      updateConversationSelection,
    },
  },
});

let sessionsModule: typeof SessionsModule;
let settingsModule: typeof SettingsModule;

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

async function seedParent() {
  const draftId = await sessionsModule.useSessionsStore.getState().newConversation('project');
  if (!draftId) throw new Error('parent authority was not created');
  sessionsModule.useSessionsStore.setState((state) => ({
    conversations: {
      ...state.conversations,
      [draftId]: { ...state.conversations[draftId], title: 'Parent' },
    },
    order: [draftId],
    activeId: draftId,
    pendingAgentPrefill: undefined,
  }));
}

describe('typed Agent child projection', () => {
  beforeAll(async () => {
    // Store modules bind browser/Electron globals at module load, so this boundary is intentionally delayed.
    settingsModule = await import('../settings');
    sessionsModule = await import('./index');
  });

  beforeEach(async () => {
    agentPrompt.mockClear();
    dispatch.mockReset();
    registerModelSelection.mockClear();
    bindSource.mockClear();
    selectProject.mockClear();
    selectConversation.mockClear();
    createConversation.mockClear();
    updateConversationSelection.mockClear();
    readChildHistory.mockClear();
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
      pendingAgentPrefill: undefined,
    });
    settingsModule.useSettingsStore.setState({
      projects: [{ id: 'project', name: 'Project', path: '/workspace' }],
    });
    await seedParent();
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
    expect(state.conversations.parent.activeTabId).toBe('parent::cw-child-2');
    expect(state.conversations['parent::cw-child-1']).toMatchObject({
      spawning: true,
      child: { agentTypeKey: 'builtin:scout', agentInstanceName: 'Scout · a1' },
    });
    expect(state.conversations.parent.messages).toEqual([]);
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

  it('binds dangerous ASK and OAuth host to the exact child generation', async () => {
    onAgentEvent?.(reserve(1));
    const child = childIdentity(1);
    const request: CapabilityAskRequest = {
      child,
      turnId: 'turn-1',
      requestId: '123e4567-e89b-42d3-a456-426614174030',
      capabilityId: 'providers.oauth.login',
      summary: 'Open browser authorization for Anthropic',
      host: {
        kind: 'oauth-login',
        providerId: 'anthropic',
        providerLabel: 'Anthropic',
      },
    };
    onCapabilityAsk?.({ ...request, child: { ...child, generation: 'stale-generation' } });
    expect(
      sessionsModule.useSessionsStore.getState().conversations[child.sessionId]
        .pendingCapabilityAsks
    ).toBeUndefined();

    onCapabilityAsk?.(request);
    expect(
      sessionsModule.useSessionsStore.getState().conversations[child.sessionId]
        .pendingCapabilityAsks
    ).toEqual([request]);
    await sessionsModule.useSessionsStore
      .getState()
      .respondCapabilityAsk(child.sessionId, request.requestId, 'allow');
    expect(
      sessionsModule.useSessionsStore.getState().conversations[child.sessionId].activeOauthAsk
    ).toEqual(request);
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

    expect(agentPrompt).toHaveBeenCalledWith('parent', 'urgent', undefined);
    expect(
      sessionsModule.useSessionsStore.getState().conversations.parent.queuedMessages
    ).toHaveLength(0);
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

  it('summon only pre-fills the parent composer and never dispatches', () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: { ...state.conversations.parent, activeTabId: 'parent::cw-child-1' },
      },
    }));
    sessionsModule.useSessionsStore.getState().prefillAgent('agent:enso');
    expect(sessionsModule.useSessionsStore.getState().conversations.parent).toMatchObject({
      activeTabId: undefined,
      prefillAgentTypeKey: 'agent:enso',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
