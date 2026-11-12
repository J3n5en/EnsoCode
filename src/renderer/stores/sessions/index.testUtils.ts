import type {
  ChildHistoryResult,
  ConversationReloadResult,
  DispatchMainEvent,
  ParentHistoryTailResult,
  RendererAgentEvent,
  SourceAuthorityProjection,
} from '@shared/types/agent';
import { vi } from 'vitest';
import type * as SettingsModule from '../settings';
import type * as SessionsModule from './index';

export let onAgentEvent: ((event: RendererAgentEvent) => void) | undefined;
export let onDispatchEvent: ((event: DispatchMainEvent) => void) | undefined;

export interface SessionProjectionState {
  sourceProjection: SourceAuthorityProjection;
  nextConversationId: string;
}

let projection: SessionProjectionState = {
  sourceProjection: { projects: [], conversations: [] },
  nextConversationId: 'parent',
};

export function bindSessionProjection(state: SessionProjectionState) {
  projection = state;
}

export const agentPrompt = vi.fn(async () => ({ ok: true }));
export const agentWithdrawSteer = vi.fn(
  async (_id: string, _deliveryId: string): Promise<{ ok: boolean; error?: string }> => ({
    ok: true,
  })
);
export const agentSpawn = vi.fn(async () => ({ ok: true }));
export const reloadConversation = vi.fn(
  async (_conversationId: string): Promise<ConversationReloadResult> => ({
    ok: false,
    error: 'no',
  })
);
export const readParentHistoryTail = vi.fn(
  async (_conversationId?: string, _beforeIndex?: number): Promise<ParentHistoryTailResult> => ({
    ok: false,
    code: 'not-found',
    error: 'no',
  })
);
export const dispatch = vi.fn();
export const registerModelSelection = vi.fn(async () => ({
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
export const bindSource = vi.fn(async () => ({
  accepted: true as const,
  requestId: '123e4567-e89b-42d3-a456-426614174011',
  parentBindingId: 'parent-binding-1',
  expiresAt: Date.now() + 60_000,
}));
export const sourceRead = vi.fn(async () => projection.sourceProjection);
export const selectProject = vi.fn(async (request: { projectId: string }) => ({
  accepted: true as const,
  value: projection.sourceProjection.projects.find(
    (project) => project.projectId === request.projectId
  )!,
}));
export const selectConversation = vi.fn(async (request: { conversationId: string }) => ({
  accepted: true as const,
  value: projection.sourceProjection.conversations.find(
    (conversation) => conversation.conversationId === request.conversationId
  )!,
}));
export const createConversation = vi.fn(
  async (request?: { projectId?: string; conversationId?: string }) => {
    const value = {
      conversationId: request?.conversationId ?? projection.nextConversationId,
      projectId: request?.projectId ?? 'project',
      kind: 'root' as const,
      lifecycle: 'draft' as const,
      version: 1,
    };
    if (
      !projection.sourceProjection.conversations.some(
        (conversation) => conversation.conversationId === value.conversationId
      )
    ) {
      projection.sourceProjection = {
        ...projection.sourceProjection,
        conversations: [...projection.sourceProjection.conversations, value],
      };
    }
    return { accepted: true as const, value };
  }
);
export const updateConversationSelection = vi.fn(
  async (request: {
    conversationId: string;
    selection: { providerId: string; modelId: string };
  }) => {
    const current = projection.sourceProjection.conversations.find(
      (conversation) => conversation.conversationId === request.conversationId
    )!;
    const value = {
      ...current,
      version: current.version + 1,
      selection: { ...request.selection, revision: 1 },
    };
    projection.sourceProjection = {
      ...projection.sourceProjection,
      conversations: projection.sourceProjection.conversations.map((conversation) =>
        conversation.conversationId === value.conversationId ? value : conversation
      ),
    };
    return { accepted: true as const, value };
  }
);

export const readChildHistory = vi.fn(
  async (_conversationId: string): Promise<ChildHistoryResult> => ({
    ok: false as const,
    code: 'not-found' as const,
    error: 'none',
  })
);
export const readChildRun = vi.fn(async () => ({
  ok: false as const,
  code: 'not-found' as const,
  error: 'no',
}));
export const dismissCoworker = vi.fn(
  async (): Promise<{ ok: boolean; error?: string }> => ({
    ok: true,
  })
);
export const hireCoworker = vi.fn(
  async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })
);
export const summarizeTitle = vi.fn(
  async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })
);
export const agentAbort = vi.fn(async (_id: string) => ({ ok: true }));
export const agentRelease = vi.fn(async (_id: string) => ({ ok: true }));
export const btwSpawn = vi.fn(async () => ({ ok: true }));
export const btwDispose = vi.fn(async () => ({ ok: true }));
export const agentRewind = vi.fn(
  async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })
);
export const agentFork = vi.fn(async (_sourceId: string, _targetId: string, _anchor: unknown) => ({
  ok: true,
}));
export const requestSnapshot = vi.fn(async () => ({ ok: true }));
export const agentSetPlanMode = vi.fn(
  async (_id: string, _active: boolean) =>
    ({ ok: true }) as {
      ok: boolean;
      error?: string;
    }
);
export const agentSetApprovalMode = vi.fn(
  async (_id: string, _mode: string, _autoReject?: boolean) =>
    ({ ok: true }) as { ok: boolean; error?: string }
);

export function installSessionGlobals(options?: { captureAsks?: boolean }) {
  const onDispatch = options?.captureAsks
    ? vi.fn((callback: (event: DispatchMainEvent) => void) => {
        onDispatchEvent = callback;
        return vi.fn();
      })
    : vi.fn(() => vi.fn());
  vi.stubGlobal('navigator', { language: 'en-US' });
  vi.stubGlobal('document', {
    documentElement: {
      dataset: {},
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
      agent: {
        onFocusSession: vi.fn(),
        onEvent: vi.fn((callback: (event: RendererAgentEvent) => void) => {
          onAgentEvent = callback;
          return vi.fn();
        }),
        requestSnapshot,
        readParentHistoryTail,
        readChildHistory,
        readChildRun,
        reloadConversation,
        prompt: agentPrompt,
        summarizeTitle,
        spawn: agentSpawn,
        dismissCoworker,
        hireCoworker,
        abort: agentAbort,
        release: agentRelease,
        rewind: agentRewind,
        fork: agentFork,
        steer: vi.fn(async () => ({ ok: true })),
        withdrawSteer: agentWithdrawSteer,
        setPlanMode: agentSetPlanMode,
        setApprovalMode: agentSetApprovalMode,
      },
      btw: {
        spawn: btwSpawn,
        dispose: btwDispose,
        prompt: vi.fn(),
        abort: vi.fn(),
      },
      agentDispatch: {
        bindSource,
        registerModelSelection,
        dispatch,
        onEvent: onDispatch,
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
}

export let sessionsModule!: typeof SessionsModule;
export let settingsModule!: typeof SettingsModule;

export async function loadSessionModules() {
  // Store modules bind browser/Electron globals at module load, so this boundary is intentionally delayed.
  settingsModule ??= await import('../settings');
  sessionsModule ??= await import('./index');
}

export async function seedParent() {
  const draftId = await sessionsModule.useSessionsStore.getState().newConversation('project');
  if (!draftId) throw new Error('parent authority was not created');
  sessionsModule.useSessionsStore.setState((state) => ({
    conversations: {
      ...state.conversations,
      [draftId]: { ...state.conversations[draftId], title: 'Parent' },
    },
    order: [draftId],
    activeId: draftId,
  }));
}

export async function resetSessionHarness() {
  agentPrompt.mockClear();
  dispatch.mockReset();
  registerModelSelection.mockClear();
  bindSource.mockClear();
  selectProject.mockClear();
  selectConversation.mockClear();
  createConversation.mockClear();
  updateConversationSelection.mockClear();
  readChildHistory.mockClear();
  readChildRun.mockClear();
  readParentHistoryTail.mockReset();
  readParentHistoryTail.mockResolvedValue({
    ok: false,
    code: 'not-found',
    error: 'no',
  });
  agentSpawn.mockClear();
  agentRewind.mockClear();
  requestSnapshot.mockClear();
  projection.nextConversationId = 'parent';
  projection.sourceProjection = {
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
    workspaceRevisionByConversation: {},
  });
  settingsModule.useSettingsStore.setState({
    projects: [{ id: 'project', name: 'Project', path: '/workspace' }],
  });
  await seedParent();
}
