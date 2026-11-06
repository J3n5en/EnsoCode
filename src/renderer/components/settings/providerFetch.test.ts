import type { ModelProvider } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchProviderModels } from './providerFetch';

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
