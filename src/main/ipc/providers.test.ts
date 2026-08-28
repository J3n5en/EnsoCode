import { IPC_CHANNELS } from '@shared/types';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  queryModelMeta: vi.fn(async () => ({ ok: true, models: [] })),
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
  cancelOauthLogin: vi.fn(),
  getOauthAccountUsage: vi.fn(),
  listOauthProviders: vi.fn(),
  oauthLogout: vi.fn(),
  reopenOauthLogin: vi.fn(),
  respondOauthPrompt: vi.fn(),
  startOauthLogin: vi.fn(),
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
