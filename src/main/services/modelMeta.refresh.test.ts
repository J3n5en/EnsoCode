import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const catalog: Array<{
    id: string;
    contextWindow: number;
    maxTokens: number;
    reasoning: boolean;
  }> = [];
  return {
    catalog,
    getModels: vi.fn(() => catalog),
    ensureProviderModelsRefreshed: vi.fn<() => Promise<void>>(),
  };
});

vi.mock('./oauthProviders', () => ({
  getRuntime: vi.fn(async () => ({ getModels: state.getModels })),
  ensureProviderModelsRefreshed: state.ensureProviderModelsRefreshed,
  hasStoredAccount: vi.fn(async () => true),
}));

import { queryModelMeta } from './modelMeta';

describe('queryModelMeta extension catalog refresh', () => {
  beforeEach(() => {
    state.catalog.splice(0);
    state.getModels.mockClear();
    state.ensureProviderModelsRefreshed.mockReset();
  });

  it('waits for the first online refresh before reading a subscription catalog', async () => {
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    state.ensureProviderModelsRefreshed.mockImplementation(async () => {
      await refreshGate;
      state.catalog.push({
        id: 'cursor-live-model',
        contextWindow: 200_000,
        maxTokens: 32_000,
        reasoning: true,
      });
    });

    const pending = queryModelMeta({
      oauthAccountKey: 'cursor',
      modelIds: ['cursor-live-model'],
    });
    await Promise.resolve();

    expect(state.getModels).not.toHaveBeenCalled();
    releaseRefresh?.();
    await expect(pending).resolves.toMatchObject({
      ok: true,
      models: [
        {
          modelId: 'cursor-live-model',
          contextWindow: 200_000,
          maxTokens: 32_000,
          source: 'catalog',
        },
      ],
    });
  });
});
