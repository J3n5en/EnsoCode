import { IPC_CHANNELS } from '@shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  spawnSession: vi.fn(),
  setAgentEventListener: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../windows/MainWindow', () => ({ isMainWebContents: vi.fn(() => true) }));
vi.mock('../services/oauthProviders', () => ({
  readStoredOauthCredentialKeys: vi.fn(async () => new Set<string>()),
}));
vi.mock('../services/agentHost', () => ({
  abortSession: vi.fn(),
  agentTypeRegistrySnapshot: vi.fn(() => ({
    revision: 1,
    candidates: [
      {
        typeKey: 'agent:enso',
        displayName: 'Enso',
        description: 'System Agent',
        source: 'system',
        locked: true,
        canDisable: false,
        canEdit: false,
      },
    ],
  })),
  appendSessionCustomEntry: vi.fn(),
  dismissChildSession: vi.fn(),
  promptChildSession: vi.fn(),
  promptSession: vi.fn(),
  requestSnapshot: vi.fn(),
  resolveAgentTypeSpawnConfig: vi.fn(),
  resolveModelSelection: vi.fn(),
  respondApproval: vi.fn(),
  respondAsk: vi.fn(),
  rewindSession: vi.fn(),
  setAgentEventListener: mocks.setAgentEventListener,
  setSessionApprovalMode: vi.fn(),
  setSessionReasoning: vi.fn(),
  setSessionThinking: vi.fn(),
  spawnChildSession: vi.fn(),
  spawnSession: mocks.spawnSession,
  steerSession: vi.fn(),
  stopBackgroundTask: vi.fn(),
}));
vi.mock('./capabilities', () => ({
  agentSessionIndex: {
    currentIdentity: vi.fn(),
    prepareParent: vi.fn(),
    observe: vi.fn(),
    reserveChild: vi.fn(),
    releaseChild: vi.fn(),
    resolveTeamTarget: vi.fn(),
    persistedConversation: vi.fn(),
  },
  capabilityGateway: {
    registerInvocation: vi.fn(() => true),
    terminateGeneration: vi.fn(),
  },
  handleCapabilityInvoke: vi.fn(),
}));
vi.mock('./settings', () => ({ readSettings: vi.fn(() => null) }));
vi.mock('../services/fileSearch', () => ({ searchFiles: vi.fn(() => []) }));
vi.mock('../services/sessionImport', () => ({
  importExternalSession: vi.fn(),
  listExternalSessions: vi.fn(() => []),
  readExternalSession: vi.fn(() => []),
}));

import { registerAgentHandlers } from './agent';

const sender = {
  id: 1,
  once: vi.fn(),
};
const event = { sender };

describe('agent IPC Main identity boundary', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.spawnSession.mockReset();
    registerAgentHandlers();
  });

  it('rejects plain spawn attempts for the removed global/reserved Enso identity', async () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.AGENT_SPAWN);
    expect(handler).toBeDefined();
    await expect(
      handler!(event, {
        sessionId: 'builtin-agent:enso',
        providerId: 'provider',
        modelId: 'model',
        cwd: '/workspace',
      })
    ).resolves.toEqual({ ok: false, error: 'invalid spawn request' });
    expect(mocks.spawnSession).not.toHaveBeenCalled();
  });

  it('rejects dispatch payloads that forge profile, target, or reserved identity fields', async () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.AGENT_DISPATCH);
    expect(handler).toBeDefined();
    const base = {
      requestId: 'request',
      bindingId: 'binding',
      typeKey: 'agent:enso',
      task: { text: 'task', images: [], fileMentions: [] },
    };
    for (const forged of [
      { profileId: 'enso-locked-v1' },
      { sessionId: 'builtin-agent:enso' },
      { conversationId: 'other' },
      { projectPath: '/other' },
    ]) {
      await expect(handler!(event, { ...base, ...forged })).resolves.toMatchObject({
        accepted: false,
        code: 'invalid-request',
      });
    }
  });
});
