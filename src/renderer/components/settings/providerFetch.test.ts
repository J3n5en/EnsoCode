import type { ModelProvider } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyFetchedModels, fetchAllProviderModels, fetchProviderModels } from './providerFetch';

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
