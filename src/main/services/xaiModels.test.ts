import { beforeEach, describe, expect, it, vi } from 'vitest';

const listModels = vi.hoisted(() => vi.fn());

vi.mock('./providerApi', () => ({ listModels }));

import { fetchXaiSubscriptionModels, XAI_API_BASE, XAI_CLI_BASE } from './xaiModels';

describe('fetchXaiSubscriptionModels', () => {
  beforeEach(() => {
    listModels.mockReset();
  });

  it('并行打官方 API 与 Grok CLI，去重后只留对话模型', async () => {
    listModels.mockImplementation(async (config: { baseUrl: string }) => {
      if (config.baseUrl === XAI_API_BASE) {
        return {
          ok: true,
          models: [{ id: 'grok-4.6' }, { id: 'grok-4.7' }, { id: 'grok-imagine-image' }],
        };
      }
      return { ok: true, models: [{ id: 'grok-4.7' }, { id: 'grok-build-0.1' }] };
    });

    await expect(fetchXaiSubscriptionModels(' tok ')).resolves.toEqual([
      { id: 'grok-4.6' },
      { id: 'grok-4.7' },
      { id: 'grok-build-0.1' },
    ]);
    expect(listModels).toHaveBeenCalledWith({
      api: 'openai-completions',
      apiKey: 'tok',
      baseUrl: XAI_API_BASE,
    });
    expect(listModels).toHaveBeenCalledWith({
      api: 'openai-completions',
      apiKey: 'tok',
      baseUrl: XAI_CLI_BASE,
      headers: { Accept: 'application/json', 'X-XAI-Token-Auth': 'xai-grok-cli' },
    });
  });

  it('一侧失败仍用另一侧，空 token 不发请求', async () => {
    listModels.mockImplementation(async (config: { baseUrl: string }) =>
      config.baseUrl === XAI_CLI_BASE
        ? { ok: true, models: [{ id: 'grok-4.7' }] }
        : { ok: false, models: [], error: 'HTTP 401' }
    );
    await expect(fetchXaiSubscriptionModels('tok')).resolves.toEqual([{ id: 'grok-4.7' }]);
    await expect(fetchXaiSubscriptionModels('  ')).resolves.toEqual([]);
    expect(listModels).toHaveBeenCalledTimes(2);
  });
});
