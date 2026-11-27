import { beforeEach, describe, expect, it, vi } from 'vitest';

const models = [{ id: 'gemini-3-pro', name: 'Gemini 3 Pro' }];

function installApi(agy: Record<string, unknown> | undefined): void {
  vi.stubGlobal('window', { electronAPI: agy ? { agy } : {} });
}

async function loadStore() {
  vi.resetModules();
  return import('./agyAuth');
}

describe('agy 模型 store', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('启动只读 Main 缓存，不调用探测', async () => {
    const authStatus = vi.fn();
    const cachedModels = vi.fn(async () => models);
    installApi({ authStatus, cachedModels });
    const { bootstrapAgyModels, useAgyAuthStore, agyModelsFromState } = await loadStore();

    bootstrapAgyModels();
    bootstrapAgyModels();
    await vi.waitFor(() => expect(agyModelsFromState(useAgyAuthStore.getState())).toEqual(models));
    expect(cachedModels).toHaveBeenCalledOnce();
    expect(authStatus).not.toHaveBeenCalled();
  });

  it('脏数据当空清单', async () => {
    installApi({ authStatus: vi.fn(), cachedModels: vi.fn(async () => ({ models })) });
    const { bootstrapAgyModels, useAgyAuthStore, agyModelsFromState } = await loadStore();
    bootstrapAgyModels();
    await Promise.resolve();
    await Promise.resolve();
    expect(agyModelsFromState(useAgyAuthStore.getState())).toEqual([]);
  });

  it('preload 缺出口时静默降级', async () => {
    installApi(undefined);
    const { bootstrapAgyModels, useAgyAuthStore, agyModelsFromState } = await loadStore();
    expect(() => bootstrapAgyModels()).not.toThrow();
    expect(agyModelsFromState(useAgyAuthStore.getState())).toEqual([]);
  });

  it('探测结果覆盖启动缓存：登录用新清单，未登录只剩默认', async () => {
    installApi({ authStatus: vi.fn(), cachedModels: vi.fn(async () => models) });
    const { bootstrapAgyModels, useAgyAuthStore, agyModelsFromState } = await loadStore();
    bootstrapAgyModels();
    await vi.waitFor(() => expect(agyModelsFromState(useAgyAuthStore.getState())).toEqual(models));

    const next = [{ id: 'gemini-4', name: 'Gemini 4' }];
    useAgyAuthStore.getState().setStatus({ status: 'signed-in', version: '1.5.18', models: next });
    expect(agyModelsFromState(useAgyAuthStore.getState())).toEqual(next);

    useAgyAuthStore.getState().setStatus({ status: 'unknown' });
    expect(agyModelsFromState(useAgyAuthStore.getState())).toEqual(next);

    useAgyAuthStore.getState().setStatus({ status: 'signed-out', version: '1.5.18' });
    expect(agyModelsFromState(useAgyAuthStore.getState())).toEqual([]);
  });

  it('缓存晚到不覆盖已有的探测结果', async () => {
    let resolve: (value: unknown) => void = () => {};
    const pending = new Promise<unknown>((r) => {
      resolve = r;
    });
    installApi({ authStatus: vi.fn(), cachedModels: vi.fn(() => pending) });
    const { bootstrapAgyModels, useAgyAuthStore, agyModelsFromState } = await loadStore();
    bootstrapAgyModels();
    const live = [{ id: 'gemini-4', name: 'Gemini 4' }];
    useAgyAuthStore.getState().setStatus({ status: 'signed-in', version: '1.5.18', models: live });
    resolve(models);
    await pending;
    await Promise.resolve();
    useAgyAuthStore.getState().setStatus({ status: 'unknown' });
    expect(agyModelsFromState(useAgyAuthStore.getState())).toEqual(live);
  });
});
