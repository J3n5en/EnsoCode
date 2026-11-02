import type { ModelProvider } from '@shared/types';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useOauthCredentialStore } from '@/stores/oauthCredentials';
import type * as SettingsModule from '../settings';
import type * as SessionsModule from './index';

const calls: string[] = [];
const spawn = vi.fn(async () => {
  calls.push('spawn');
  return { ok: true };
});
const release = vi.fn(async (): Promise<{ ok: boolean; error?: string }> => {
  calls.push('release');
  return { ok: true };
});
let conversationCounter = 0;
const sourceProjection = {
  projects: [
    { projectId: 'project', canonicalPath: '/workspace', state: 'active' as const, version: 1 },
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
      writeKey: vi.fn(async () => undefined),
      onChanged: vi.fn(),
    },
    instructions: { delete: vi.fn(async () => ({ ok: true })) },
    capabilities: { onAsk: vi.fn(), respond: vi.fn(async () => ({ ok: true, accepted: true })) },
    agent: {
      onFocusSession: vi.fn(),
      onEvent: vi.fn(),
      requestSnapshot: vi.fn(async () => ({ ok: true })),
      spawn,
      release,
    },
    agentDispatch: { onEvent: vi.fn() },
    sourceAuthority: {
      read: vi.fn(async () => sourceProjection),
      onChanged: vi.fn(() => vi.fn()),
      selectProject: vi.fn(async () => ({ accepted: true, value: sourceProjection.projects[0] })),
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
      updateConversationSelection: vi.fn(async () => ({ accepted: true })),
    },
  },
});

let sessionsModule: typeof SessionsModule;
let settingsModule: typeof SettingsModule;

const provider: ModelProvider = {
  id: 'p',
  name: 'p',
  api: 'openai-completions',
  apiKey: 'key',
  baseUrl: 'https://example.test/v1',
  enabled: true,
  models: [{ id: 'model' }],
};

async function seed(overrides: Record<string, unknown> = {}): Promise<string> {
  const id = await sessionsModule.useSessionsStore.getState().newConversation('project');
  if (!id) throw new Error('conversation authority was not created');
  const conversation = sessionsModule.useSessionsStore.getState().conversations[id];
  sessionsModule.useSessionsStore.setState({
    conversations: {
      [id]: {
        ...conversation,
        title: 'restartable',
        sessionFile: '/tmp/session.jsonl',
        lastProviderId: provider.id,
        lastModelId: 'model',
        started: true,
        status: 'idle',
        ...overrides,
      },
    },
    order: [id],
    activeId: id,
  });
  return id;
}

const state = (id: string) => sessionsModule.useSessionsStore.getState().conversations[id];

describe('restartConversation', () => {
  beforeAll(async () => {
    settingsModule = await import('../settings');
    sessionsModule = await import('./index');
  });

  beforeEach(() => {
    calls.length = 0;
    spawn.mockClear();
    release.mockClear();
    sourceProjection.conversations = [];
    sessionsModule.useSessionsStore.setState({ conversations: {}, order: [], activeId: null });
    settingsModule.useSettingsStore.setState({
      providers: [provider],
      defaultModel: null,
      projects: [{ id: 'project', name: 'Project', path: '/workspace' }],
      loadLocalSkills: true,
    });
    useOauthCredentialStore.setState({
      snapshot: {
        revision: 1,
        availability: { status: 'ready', authenticatedAccountKeys: new Set() },
      },
    });
  });

  it('releases the live session, then respawns it from jsonl', async () => {
    const id = await seed();
    const error = await sessionsModule.useSessionsStore.getState().restartConversation(id);
    expect(error).toBeNull();
    expect(release).toHaveBeenCalledWith(id);
    expect(calls).toEqual(['release', 'spawn']);
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: id, resumeFile: '/tmp/session.jsonl' })
    );
    expect(state(id).started).toBe(true);
  });

  it('refuses while a turn is running without releasing', async () => {
    const id = await seed({ status: 'running' });
    const error = await sessionsModule.useSessionsStore.getState().restartConversation(id);
    expect(error).toBeTruthy();
    expect(release).not.toHaveBeenCalled();
    expect(state(id).started).toBe(true);
  });

  it('refuses coworker sessions', async () => {
    const id = await seed({ parentId: 'root' });
    expect(await sessionsModule.useSessionsStore.getState().restartConversation(id)).toBeTruthy();
    expect(release).not.toHaveBeenCalled();
  });

  it('keeps the session when release fails', async () => {
    release.mockResolvedValueOnce({ ok: false, error: 'busy' });
    const id = await seed();
    expect(await sessionsModule.useSessionsStore.getState().restartConversation(id)).toBe('busy');
    expect(spawn).not.toHaveBeenCalled();
    expect(state(id).started).toBe(true);
  });

  it('reports when the remembered model is no longer usable', async () => {
    const id = await seed();
    settingsModule.useSettingsStore.setState({ providers: [{ ...provider, enabled: false }] });
    expect(await sessionsModule.useSessionsStore.getState().restartConversation(id)).toBeTruthy();
    expect(release).toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(state(id).started).toBe(false);
  });

  it('skips release for a session that is not loaded yet', async () => {
    const id = await seed({ started: false });
    expect(await sessionsModule.useSessionsStore.getState().restartConversation(id)).toBeNull();
    expect(release).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalled();
  });
});
