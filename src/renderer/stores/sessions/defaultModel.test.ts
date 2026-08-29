import type { OauthCredentialAvailability } from '@shared/defaultModel';
import type { ModelProvider } from '@shared/types';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as OauthStoreModule from '@/stores/oauthCredentials';
import { useOauthCredentialStore } from '@/stores/oauthCredentials';
import type * as SettingsModule from '../settings';
import type * as SessionsModule from './index';

const spawn = vi.fn(async () => ({ ok: true }));
let conversationCounter = 0;
let sourceProjection = {
  projects: [
    {
      projectId: 'project',
      canonicalPath: '/workspace',
      state: 'active' as const,
      version: 1,
    },
  ],
  conversations: [] as Array<{
    conversationId: string;
    projectId: string;
    kind: 'root';
    lifecycle: 'draft';
    version: number;
  }>,
};

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
      writeKey: vi.fn(async () => undefined),
      onChanged: vi.fn(),
    },
    instructions: { delete: vi.fn(async () => ({ ok: true })) },
    capabilities: {
      onAsk: vi.fn(),
      respond: vi.fn(async () => ({ ok: true, accepted: true })),
    },
    agent: {
      onFocusSession: vi.fn(),
      onEvent: vi.fn(),
      requestSnapshot: vi.fn(async () => ({ ok: true })),
      spawn,
    },
    agentDispatch: { onEvent: vi.fn() },
    sourceAuthority: {
      read: vi.fn(async () => sourceProjection),
      onChanged: vi.fn(() => vi.fn()),
      selectProject: vi.fn(async () => ({
        accepted: true,
        value: sourceProjection.projects[0],
      })),
      selectConversation: vi.fn(async (request: { conversationId: string }) => ({
        accepted: true,
        value: sourceProjection.conversations.find(
          (conversation) => conversation.conversationId === request.conversationId
        ),
      })),
      createConversation: vi.fn(async () => {
        const value = {
          conversationId: `conversation-${++conversationCounter}`,
          projectId: 'project',
          kind: 'root' as const,
          lifecycle: 'draft' as const,
          version: 1,
        };
        sourceProjection.conversations.push(value);
        return { accepted: true, value };
      }),
    },
  },
});

let sessionsModule: typeof SessionsModule;
let settingsModule: typeof SettingsModule;

function provider(id: string, overrides: Partial<ModelProvider> = {}): ModelProvider {
  return {
    id,
    name: id,
    api: 'openai-completions',
    apiKey: `key-${id}`,
    baseUrl: 'https://example.test/v1',
    enabled: true,
    models: [{ id: 'model' }],
    ...overrides,
  };
}

function setSnapshot(revision: number, availability: OauthCredentialAvailability) {
  const snapshot: OauthStoreModule.OauthCredentialSnapshot = { revision, availability };
  useOauthCredentialStore.setState({ snapshot });
}

async function resumableConversation(
  lastProviderId?: string,
  lastModelId?: string
): Promise<string> {
  const id = await sessionsModule.useSessionsStore.getState().newConversation('project');
  if (!id) throw new Error('conversation authority was not created');
  const conversation = sessionsModule.useSessionsStore.getState().conversations[id];
  sessionsModule.useSessionsStore.setState({
    conversations: {
      [id]: {
        ...conversation,
        title: 'resumable',
        sessionFile: '/tmp/session.jsonl',
        ...(lastProviderId ? { lastProviderId } : {}),
        ...(lastModelId ? { lastModelId } : {}),
      },
    },
    order: [id],
    activeId: id,
  });
  return id;
}

describe('resumeConversation model resolution', () => {
  beforeAll(async () => {
    // Both stores bind Electron/browser globals at module load; import after this test installs stubs.
    settingsModule = await import('../settings');
    sessionsModule = await import('./index');
  });

  beforeEach(() => {
    spawn.mockClear();
    conversationCounter = 0;
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
    sessionsModule.useSessionsStore.setState({ conversations: {}, order: [], activeId: null });
    settingsModule.useSettingsStore.setState({
      providers: [],
      defaultModel: null,
      projects: [{ id: 'project', name: 'Project', path: '/workspace' }],
      loadLocalSkills: true,
    });
    setSnapshot(1, { status: 'ready', authenticatedAccountKeys: new Set() });
  });

  it('keeps a still-usable remembered session model ahead of the global default', async () => {
    const remembered = provider('remembered');
    const global = provider('global');
    settingsModule.useSettingsStore.setState({
      providers: [global, remembered],
      defaultModel: { providerId: global.id, modelId: 'model' },
    });
    const id = await resumableConversation(remembered.id, 'model');

    await sessionsModule.useSessionsStore.getState().resumeConversation(id);
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: remembered.id, modelId: 'model' })
    );
  });

  it('uses the explicit global default when an imported conversation has no last model', async () => {
    const first = provider('first');
    const global = provider('global');
    settingsModule.useSettingsStore.setState({
      providers: [first, global],
      defaultModel: { providerId: global.id, modelId: 'model' },
    });
    const id = await resumableConversation();

    await sessionsModule.useSessionsStore.getState().resumeConversation(id);
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: global.id, modelId: 'model' })
    );
  });

  it('does not silently spawn a global fallback after the remembered OAuth account logs out', async () => {
    const oauth = provider('oauth', { apiKey: '', oauthAccountKey: 'anthropic' });
    const global = provider('global');
    settingsModule.useSettingsStore.setState({
      providers: [oauth, global],
      defaultModel: { providerId: global.id, modelId: 'model' },
    });
    const id = await resumableConversation(oauth.id, 'model');

    await sessionsModule.useSessionsStore.getState().resumeConversation(id);
    expect(spawn).not.toHaveBeenCalled();
    expect(sessionsModule.useSessionsStore.getState().conversations[id].started).toBe(false);
  });

  it('fails closed while remembered OAuth credentials are loading instead of using API fallback', async () => {
    const oauth = provider('oauth', { apiKey: '', oauthAccountKey: 'anthropic' });
    const global = provider('global');
    settingsModule.useSettingsStore.setState({
      providers: [oauth, global],
      defaultModel: { providerId: global.id, modelId: 'model' },
    });
    setSnapshot(2, { status: 'loading' });
    const id = await resumableConversation(oauth.id, 'model');

    await sessionsModule.useSessionsStore.getState().resumeConversation(id);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('keeps lastProviderId and lastModelId in the restart persistence projection', async () => {
    const id = await resumableConversation('remembered', 'model');
    const partialize = sessionsModule.useSessionsStore.persist.getOptions().partialize;
    expect(partialize).toBeTypeOf('function');
    const persisted = partialize?.(sessionsModule.useSessionsStore.getState()) as {
      conversations: Record<string, { lastProviderId?: string; lastModelId?: string }>;
    };
    expect(persisted.conversations[id]).toMatchObject({
      lastProviderId: 'remembered',
      lastModelId: 'model',
    });
  });
});
