import { IPC_CHANNELS } from '@shared/types';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  queryModelMeta: vi.fn(async () => ({ ok: true, models: [] })),
  readStoredOauthCredentialKeys: vi.fn(async () => new Set(['anthropic', 'anthropic#2'])),
  startOauthLogin: vi.fn(() => ({
    status: 'started' as const,
    locator: {
      flowId: '11111111-1111-4111-8111-111111111111',
      host: 'provider-wizard' as const,
      ownerWebContentsId: 7,
    },
  })),
  respondOauthPrompt: vi.fn(() => true),
  cancelOauthLogin: vi.fn(() => true),
  reopenOauthLogin: vi.fn(() => true),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../services/modelMeta', () => ({ queryModelMeta: mocks.queryModelMeta }));
vi.mock('../services/oauthProviders', () => ({
  cancelOauthLogin: mocks.cancelOauthLogin,
  getOauthAccountUsage: vi.fn(),
  listOauthProviders: vi.fn(),
  readStoredOauthCredentialKeys: mocks.readStoredOauthCredentialKeys,
  oauthLogout: vi.fn(),
  reopenOauthLogin: mocks.reopenOauthLogin,
  respondOauthPrompt: mocks.respondOauthPrompt,
  startOauthLogin: mocks.startOauthLogin,
}));
vi.mock('../services/providerApi', () => ({ listModels: vi.fn(), testProvider: vi.fn() }));
vi.mock('../services/providerScan', () => ({
  collectImport: vi.fn(),
  scanLocalProviders: vi.fn(),
}));

import { registerProviderHandlers } from './providers';

function modelMetaHandler(): (...args: unknown[]) => unknown {
  const handler = mocks.handlers.get(IPC_CHANNELS.PROVIDERS_MODEL_META);
  if (!handler) throw new Error('model meta handler not registered');
  return handler;
}

beforeAll(() => {
  registerProviderHandlers();
});

beforeEach(() => {
  mocks.queryModelMeta.mockClear();
  mocks.readStoredOauthCredentialKeys.mockClear();
  mocks.startOauthLogin.mockClear();
  mocks.respondOauthPrompt.mockClear();
  mocks.cancelOauthLogin.mockClear();
  mocks.reopenOauthLogin.mockClear();
});

describe('providers:model-meta query limits', () => {
  it.each([
    ['model count', { modelIds: Array.from({ length: 257 }, (_, index) => `model-${index}`) }],
    ['single id length', { modelIds: ['x'.repeat(257)] }],
    ['total id characters', { modelIds: Array.from({ length: 129 }, () => 'x'.repeat(256)) }],
    ['empty custom query', { modelIds: [] }],
  ])('rejects an over-limit %s before calling the service', async (_name, query) => {
    expect(await modelMetaHandler()({}, query)).toEqual({
      ok: false,
      models: [],
      error: 'Invalid query',
    });
    expect(mocks.queryModelMeta).not.toHaveBeenCalled();
  });

  it('allows an empty list only when an account key is present for service authorization', async () => {
    expect(await modelMetaHandler()({}, { oauthAccountKey: 'cursor', modelIds: [] })).toEqual({
      ok: true,
      models: [],
    });
    expect(mocks.queryModelMeta).toHaveBeenCalledWith({ oauthAccountKey: 'cursor', modelIds: [] });
  });
});

describe('oauth:credential-keys-list', () => {
  it('returns only the public account keys from the lightweight service', async () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.OAUTH_CREDENTIAL_KEYS_LIST);
    if (!handler) throw new Error('OAuth credential keys handler not registered');
    await expect(handler({})).resolves.toEqual(['anthropic', 'anthropic#2']);
    expect(mocks.readStoredOauthCredentialKeys).toHaveBeenCalledOnce();
  });
});

describe('OAuth flow IPC ownership', () => {
  const sender = { id: 7 };
  const flowId = '11111111-1111-4111-8111-111111111111';

  it('wizard start strict解析并把event.sender交给service生成owner flow', async () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.OAUTH_LOGIN);
    if (!handler) throw new Error('OAuth login handler not registered');
    expect(await handler({ sender }, { providerId: 'anthropic', extra: true })).toMatchObject({
      status: 'failed',
      code: 'invalid-request',
    });
    expect(mocks.startOauthLogin).not.toHaveBeenCalled();
    expect(await handler({ sender }, { providerId: 'anthropic' })).toEqual({
      status: 'started',
      locator: { flowId, host: 'provider-wizard', ownerWebContentsId: 7 },
    });
    expect(mocks.startOauthLogin).toHaveBeenCalledWith('anthropic', sender);
  });

  it('prompt/cancel/reopen只转发sender匹配的完整exact locator', async () => {
    const prompt = mocks.handlers.get(IPC_CHANNELS.OAUTH_LOGIN_RESPOND);
    const cancel = mocks.handlers.get(IPC_CHANNELS.OAUTH_LOGIN_CANCEL);
    const reopen = mocks.handlers.get(IPC_CHANNELS.OAUTH_LOGIN_REOPEN);
    if (!prompt || !cancel || !reopen) throw new Error('OAuth flow handlers missing');
    const locator = { flowId, host: 'provider-wizard', ownerWebContentsId: 7 } as const;

    await prompt({ sender }, { locator, requestId: 'prompt-1', value: 'answer' });
    await cancel({ sender }, { locator });
    await reopen({ sender }, { locator });
    expect(mocks.respondOauthPrompt).toHaveBeenCalledWith(locator, 'prompt-1', 'answer');
    expect(mocks.cancelOauthLogin).toHaveBeenCalledWith(locator);
    expect(mocks.reopenOauthLogin).toHaveBeenCalledWith(locator);

    await cancel({ sender }, { locator: { ...locator, ownerWebContentsId: 8 } });
    expect(mocks.cancelOauthLogin).toHaveBeenCalledTimes(1);
  });
});
