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
const createConversation = vi.fn(async () => {
  const value = {
    conversationId: 'parent',
    projectId: 'project',
    kind: 'root' as const,
    lifecycle: 'draft' as const,
    version: 1,
  };
  sourceProjection = {
    ...sourceProjection,
    conversations: [...sourceProjection.conversations, value],
  };
  return { accepted: true as const, value };
});
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
      dismissCoworker: vi.fn(async () => ({ ok: true })),
      abort: vi.fn(async () => ({ ok: true })),
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
      endConversation: vi.fn(),
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
