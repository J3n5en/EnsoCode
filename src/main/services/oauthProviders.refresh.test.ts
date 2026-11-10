import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { ANTIGRAVITY_PROVIDER_ID } from '@shared/providers/antigravity';
import { describe, expect, it, vi } from 'vitest';

type RefreshResult = {
  aborted: boolean;
  errors: ReadonlyMap<string, Error>;
};

const mocks = vi.hoisted(() => {
  const refresh = vi.fn();
  return {
    refresh,
    runtime: {
      refresh,
      registerProvider: vi.fn(),
      listCredentials: vi.fn(async () => []),
      getProviders: vi.fn(() => []),
      getProvider: vi.fn(),
      unregisterProvider: vi.fn(),
      registerNativeProvider: vi.fn(),
    },
    loadCursorProvider: vi.fn(async () => {}),
  };
});

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/enso-model-refresh', getName: () => 'enso-code', on: () => {} },
  shell: { openExternal: vi.fn(async () => {}) },
}));
vi.mock('./proxyConfig', () => ({
  getProxyConfig: () => ({ whenReady: async () => true }),
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  ModelRuntime: { create: vi.fn(async () => mocks.runtime) },
}));

vi.mock('../../agent/cursor/loadProvider', () => ({
  CURSOR_PROVIDER_ID: 'cursor',
  loadCursorProvider: mocks.loadCursorProvider,
}));

function deferredRefresh(): {
  promise: Promise<RefreshResult>;
  resolve: (result: RefreshResult) => void;
} {
  let resolve: ((result: RefreshResult) => void) | undefined;
  const promise = new Promise<RefreshResult>((done) => {
    resolve = done;
  });
  return { promise, resolve: (result) => resolve?.(result) };
}

function callsFor(providerId: string): number {
  return mocks.refresh.mock.calls.filter(([options]) => options.providers?.[0] === providerId)
    .length;
}

describe('extension model catalog refresh', () => {
  it('deduplicates concurrent attempts, retries only the failed provider, and caches success', async () => {
    const antigravityFirst = deferredRefresh();
    const antigravityRetry = deferredRefresh();
    const cursorFirst = deferredRefresh();
    mocks.refresh.mockImplementation(({ providers }: { providers: readonly string[] }) => {
      const providerId = providers[0];
      if (providerId === 'cursor') return cursorFirst.promise;
      if (providerId !== ANTIGRAVITY_PROVIDER_ID) {
        return Promise.resolve({ aborted: false, errors: new Map() });
      }
      return callsFor(ANTIGRAVITY_PROVIDER_ID) === 1
        ? antigravityFirst.promise
        : antigravityRetry.promise;
    });

    const { ensureProviderModelsRefreshed, getRuntime } = await import('./oauthProviders');
    const runtime = (await getRuntime()) as ModelRuntime;
    const antigravityWaiter = ensureProviderModelsRefreshed(runtime, ANTIGRAVITY_PROVIDER_ID);
    const cursorWaiter = ensureProviderModelsRefreshed(runtime, 'cursor');

    expect(callsFor(ANTIGRAVITY_PROVIDER_ID)).toBe(1);
    expect(callsFor('cursor')).toBe(1);
    antigravityFirst.resolve({
      aborted: false,
      errors: new Map([[ANTIGRAVITY_PROVIDER_ID, new Error('offline')]]),
    });
    cursorFirst.resolve({ aborted: false, errors: new Map() });
    await Promise.all([antigravityWaiter, cursorWaiter]);

    const retryA = ensureProviderModelsRefreshed(runtime, ANTIGRAVITY_PROVIDER_ID);
    const retryB = ensureProviderModelsRefreshed(runtime, ANTIGRAVITY_PROVIDER_ID);
    expect(callsFor(ANTIGRAVITY_PROVIDER_ID)).toBe(2);
    expect(callsFor('cursor')).toBe(1);
    antigravityRetry.resolve({ aborted: false, errors: new Map() });
    await Promise.all([retryA, retryB]);

    await ensureProviderModelsRefreshed(runtime, ANTIGRAVITY_PROVIDER_ID);
    await ensureProviderModelsRefreshed(runtime, 'cursor');
    expect(callsFor(ANTIGRAVITY_PROVIDER_ID)).toBe(2);
    expect(callsFor('cursor')).toBe(1);
  });

  it('bypasses provider freshness, expires cached success, and lets an explicit pull refetch', async () => {
    mocks.refresh.mockReset();
    mocks.refresh.mockResolvedValue({ aborted: false, errors: new Map() });
    const { ensureProviderModelsRefreshed, getRuntime } = await import('./oauthProviders');
    const runtime = (await getRuntime()) as ModelRuntime;

    await ensureProviderModelsRefreshed(runtime, 'cursor');
    expect(callsFor('cursor')).toBe(0);

    await ensureProviderModelsRefreshed(runtime, 'cursor', { force: true });
    expect(callsFor('cursor')).toBe(1);
    expect(mocks.refresh).toHaveBeenLastCalledWith(
      expect.objectContaining({ providers: ['cursor'], allowNetwork: true, force: true })
    );

    await ensureProviderModelsRefreshed(runtime, 'cursor');
    expect(callsFor('cursor')).toBe(1);

    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 7 * 60 * 60 * 1000);
    try {
      await ensureProviderModelsRefreshed(runtime, 'cursor');
      expect(callsFor('cursor')).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });
  it('Qoder 两个地区均注册自定义协议，并可按地区强制刷新目录', async () => {
    mocks.refresh.mockResolvedValue({ aborted: false, errors: new Map() });
    const { ensureProviderModelsRefreshed, getRuntime } = await import('./oauthProviders');
    const runtime = await getRuntime();
    for (const id of ['qoder', 'qoder-cn']) {
      expect(runtime.registerProvider).toHaveBeenCalledWith(
        id,
        expect.objectContaining({ api: 'qoder-api', streamSimple: expect.any(Function) })
      );
      const before = callsFor(id);
      await ensureProviderModelsRefreshed(runtime, `${id}#2`, { force: true });
      expect(callsFor(id)).toBe(before + 1);
    }
  });
});
