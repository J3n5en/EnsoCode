import type { ModelProvider } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/modelMeta', () => ({
  invalidateModelMeta: vi.fn(),
}));

import {
  applyFetchedModels,
  fetchAllProviderModels,
  fetchProviderModels,
  providerFetchStates,
  refreshProvider,
  resetProviderFetchStates,
  summarizeFetchOutcomes,
} from './providerFetch';

const listModels = vi.fn();
const modelMeta = vi.fn();

const apiProvider = (overrides: Partial<ModelProvider> = {}): ModelProvider => ({
  id: 'p1',
  name: 'OpenAI',
  api: 'openai-completions',
  apiKey: 'sk-test',
  baseUrl: 'https://api.openai.com/v1',
  enabled: false,
  models: [
    { id: 'kept', enabled: false, label: '保留' },
    { id: 'gone', enabled: true },
  ],
  ...overrides,
});

beforeEach(() => {
  vi.stubGlobal('window', { electronAPI: { providers: { listModels, modelMeta } } });
});

afterEach(() => {
  listModels.mockReset();
  modelMeta.mockReset();
  vi.unstubAllGlobals();
});

describe('fetchProviderModels', () => {
  it('API Key 条目把端点交给 listModels，并按上游清单合并本地模型', async () => {
    listModels.mockResolvedValue({
      ok: true,
      models: [{ id: 'kept', contextWindow: 128000 }, { id: 'new' }],
    });

    const outcome = await fetchProviderModels(apiProvider());

    expect(listModels).toHaveBeenCalledWith({
      api: 'openai-completions',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(modelMeta).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      status: 'ok',
      count: 2,
      models: [
        { id: 'kept', enabled: false, label: '保留', contextWindow: 128000 },
        { id: 'new', enabled: true },
      ],
    });
  });

  it('拉模型带上供应商请求头', async () => {
    listModels.mockResolvedValue({ ok: true, models: [] });
    await fetchProviderModels(apiProvider({ headers: { originator: 'enso' } }));
    expect(listModels).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { originator: 'enso' } })
    );
  });

  it('拉模型带上供应商独立代理，跟随全局时不带', async () => {
    listModels.mockResolvedValue({ ok: true, models: [] });
    await fetchProviderModels(apiProvider({ proxy: { mode: 'none' } }));
    expect(listModels).toHaveBeenLastCalledWith(
      expect.objectContaining({ proxy: { mode: 'none' } })
    );
    await fetchProviderModels(apiProvider());
    expect(listModels.mock.calls.at(-1)?.[0]).not.toHaveProperty('proxy');
  });

  it('listModels 失败时透传 message，且没有 models', async () => {
    listModels.mockResolvedValue({ ok: false, models: [{ id: 'new' }], error: 'unauthorized' });

    const outcome = await fetchProviderModels(apiProvider());

    expect(outcome).toEqual({ status: 'failed', message: 'unauthorized' });
    expect(outcome).not.toHaveProperty('models');
  });

  it('订阅条目用空 modelIds 重拉目录，count 不含 unknown，且不返回 models', async () => {
    modelMeta.mockResolvedValue({
      ok: true,
      models: [
        { modelId: 'opus', source: 'catalog' },
        { modelId: 'missing', source: 'unknown' },
        { modelId: 'alias', source: 'catalog-fallback' },
      ],
    });

    const outcome = await fetchProviderModels(
      apiProvider({ oauthAccountKey: 'anthropic#2', apiKey: '', baseUrl: '' })
    );

    expect(modelMeta).toHaveBeenCalledWith({ oauthAccountKey: 'anthropic#2', modelIds: [] });
    expect(listModels).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: 'ok', count: 2 });
    expect(outcome).not.toHaveProperty('models');
  });

  it('modelMeta 失败时返回 failed', async () => {
    modelMeta.mockResolvedValue({ ok: false, models: [], error: 'Invalid query' });

    const outcome = await fetchProviderModels(apiProvider({ oauthAccountKey: 'cursor' }));

    expect(outcome).toEqual({ status: 'failed', message: 'Invalid query' });
    expect(outcome).not.toHaveProperty('models');
  });

  it('IPC 抛错时返回 failed，不把异常抛给调用方', async () => {
    listModels.mockRejectedValue(new Error('list down'));
    await expect(fetchProviderModels(apiProvider())).resolves.toEqual({
      status: 'failed',
      message: 'list down',
    });

    modelMeta.mockRejectedValue(new Error('meta down'));
    await expect(fetchProviderModels(apiProvider({ oauthAccountKey: 'cursor' }))).resolves.toEqual({
      status: 'failed',
      message: 'meta down',
    });
  });
});

describe('fetchAllProviderModels', () => {
  it('并发拉取全部条目，单个条目失败不影响其他结果', async () => {
    listModels.mockImplementation(({ baseUrl }: { baseUrl: string }) =>
      baseUrl === 'https://down'
        ? Promise.resolve({ ok: false, models: [], error: 'unauthorized' })
        : Promise.resolve({ ok: true, models: [{ id: 'gpt' }] })
    );

    const outcomes = await fetchAllProviderModels([
      apiProvider({ id: 'ok', baseUrl: 'https://ok' }),
      apiProvider({ id: 'down', baseUrl: 'https://down' }),
    ]);

    expect(outcomes.ok).toEqual({ status: 'ok', count: 1, models: [{ id: 'gpt', enabled: true }] });
    expect(outcomes.down).toEqual({ status: 'failed', message: 'unauthorized' });
  });
});

describe('applyFetchedModels', () => {
  it('只回写带清单的成功结果；订阅条目与失败条目不写 settings', () => {
    const updateProvider = vi.fn();

    applyFetchedModels(
      {
        api: { status: 'ok', count: 1, models: [{ id: 'gpt' }] },
        subscription: { status: 'ok', count: 3 },
        failed: { status: 'failed', message: 'down' },
      },
      updateProvider
    );

    expect(updateProvider).toHaveBeenCalledTimes(1);
    expect(updateProvider).toHaveBeenCalledWith('api', { models: [{ id: 'gpt' }] });
  });
});

describe('summarizeFetchOutcomes', () => {
  it('统计成功条目数、模型总数、失败数，并只取第一个失败原因', () => {
    expect(
      summarizeFetchOutcomes({
        api: { status: 'ok', count: 2, models: [{ id: 'a' }, { id: 'b' }] },
        down: { status: 'failed', message: 'unauthorized' },
        subscription: { status: 'ok', count: 3 },
        timeout: { status: 'failed', message: 'timeout' },
      })
    ).toEqual({ okCount: 2, failedCount: 2, modelCount: 5, firstError: 'unauthorized' });
  });

  it('全部成功或没有条目时 firstError 为 null', () => {
    expect(summarizeFetchOutcomes({ api: { status: 'ok', count: 1 } })).toEqual({
      okCount: 1,
      failedCount: 0,
      modelCount: 1,
      firstError: null,
    });
    expect(summarizeFetchOutcomes({})).toEqual({
      okCount: 0,
      failedCount: 0,
      modelCount: 0,
      firstError: null,
    });
  });
});

describe('refreshProvider', () => {
  beforeEach(() => {
    resetProviderFetchStates();
  });

  const flush = () => vi.waitFor(() => expect(listModels).toHaveBeenCalled());

  it('刷新单个条目：成功时回写 models，其他条目状态不受影响', async () => {
    listModels.mockResolvedValue({ ok: true, models: [{ id: 'gpt' }] });
    const updateProvider = vi.fn();

    await refreshProvider(apiProvider({ id: 'one' }), updateProvider);

    expect(listModels).toHaveBeenCalledTimes(1);
    expect(updateProvider).toHaveBeenCalledWith('one', {
      models: [{ id: 'gpt', enabled: true }],
    });
    expect(providerFetchStates().one).toMatchObject({ refreshing: false, error: null });
    expect(providerFetchStates().other).toBeUndefined();
  });

  it('刷新中只有这一条目转动，结束后回到非转动态', async () => {
    let release!: () => void;
    listModels.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ ok: true, models: [] });
      })
    );

    const pending = refreshProvider(apiProvider({ id: 'spin' }), vi.fn());
    await flush();
    expect(providerFetchStates().spin).toMatchObject({ refreshing: true, error: null });
    expect(providerFetchStates().other).toBeUndefined();

    release();
    await pending;
    expect(providerFetchStates().spin).toMatchObject({ refreshing: false });
  });

  it('重复触发同一条目去重：拉取只调用一次', async () => {
    let release!: () => void;
    listModels.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ ok: true, models: [] });
      })
    );

    const provider = apiProvider({ id: 'dup' });
    const first = refreshProvider(provider, vi.fn());
    const second = refreshProvider(provider, vi.fn());
    await flush();
    release();
    await Promise.all([first, second]);

    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it('失败时记录 message 在本条目上，其他条目没有失败状态', async () => {
    listModels.mockImplementation(({ baseUrl }: { baseUrl: string }) =>
      baseUrl === 'https://down'
        ? Promise.resolve({ ok: false, models: [], error: 'unauthorized' })
        : Promise.resolve({ ok: true, models: [{ id: 'gpt' }] })
    );

    await refreshProvider(apiProvider({ id: 'bad', baseUrl: 'https://down' }), vi.fn());
    await refreshProvider(apiProvider({ id: 'good', baseUrl: 'https://ok' }), vi.fn());

    expect(providerFetchStates().bad).toMatchObject({ refreshing: false, error: 'unauthorized' });
    expect(providerFetchStates().good).toMatchObject({ refreshing: false, error: null });
  });

  it('再次刷新成功后清除本条目之前的失败状态', async () => {
    listModels.mockResolvedValueOnce({ ok: false, models: [], error: 'unauthorized' });

    await refreshProvider(apiProvider({ id: 'retry' }), vi.fn());
    expect(providerFetchStates().retry).toMatchObject({ error: 'unauthorized' });

    listModels.mockResolvedValueOnce({ ok: true, models: [{ id: 'gpt' }] });
    await refreshProvider(apiProvider({ id: 'retry' }), vi.fn());
    expect(providerFetchStates().retry).toMatchObject({ refreshing: false, error: null });
  });

  it('订阅条目刷新走重拉目录路径，不回写 settings', async () => {
    modelMeta.mockResolvedValue({ ok: true, models: [{ modelId: 'opus', source: 'catalog' }] });
    const updateProvider = vi.fn();

    await refreshProvider(
      apiProvider({ id: 'sub', oauthAccountKey: 'anthropic#1' }),
      updateProvider
    );

    expect(modelMeta).toHaveBeenCalledWith({ oauthAccountKey: 'anthropic#1', modelIds: [] });
    expect(updateProvider).not.toHaveBeenCalled();
    expect(providerFetchStates().sub).toMatchObject({ refreshing: false, error: null });
  });
});
