import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { MOCK_API_ID, MOCK_API_KEY, MOCK_BASE_URL, MOCK_CHAT_MODEL_ID } from '@shared/mockProvider';
import { describe, expect, it, vi } from 'vitest';
import { resolveBaseModel, resolveBaseModelOrRefresh } from './supervisor';

vi.mock('@shared/piAccounts', () => ({
  ensureAccountProvider: vi.fn(),
}));

type CatalogRow = {
  id: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null | undefined>;
  contextWindow?: number;
  maxTokens?: number;
};

function mockRuntime(options: {
  catalog?: CatalogRow[];
  oauthModel?: CatalogRow & { provider?: string };
}): ModelRuntime {
  const registered = new Map<string, CatalogRow>();
  const catalog = options.catalog ?? [];
  return {
    getModels: () => catalog,
    getModel: (providerId: string, modelId: string) => {
      if (options.oauthModel && providerId === 'anthropic' && modelId === options.oauthModel.id) {
        return options.oauthModel;
      }
      return registered.get(`${providerId}:${modelId}`);
    },
    registerProvider: (providerId: string, config: { models: CatalogRow[] }) => {
      for (const model of config.models) {
        registered.set(`${providerId}:${model.id}`, model);
      }
    },
  } as unknown as ModelRuntime;
}

const apiKeySpawn = {
  api: 'anthropic-messages' as const,
  baseUrl: 'https://relay.example/v1',
  apiKey: 'sk-relay',
  modelId: 'claude-sonnet-4',
  settingsProviderId: 'settings-provider',
};

describe('resolveBaseModel apiKey', () => {
  it('catalog 命中官方 id 时用 catalog，不再无条件 {max:max}', () => {
    const runtime = mockRuntime({
      catalog: [
        {
          id: 'claude-sonnet-4',
          reasoning: true,
          contextWindow: 200_000,
          maxTokens: 64_000,
        },
      ],
    });
    const model = resolveBaseModel(runtime, apiKeySpawn);
    expect(model.reasoning).toBe(true);
    expect(model.thinkingLevelMap).toBeUndefined();
    expect(model.contextWindow).toBe(200_000);
    expect(model.maxTokens).toBe(64_000);
  });

  it('catalog 未命中保持乐观默认', () => {
    const runtime = mockRuntime({ catalog: [] });
    const model = resolveBaseModel(runtime, {
      ...apiKeySpawn,
      modelId: 'my-private-gateway-model',
      settingsProviderId: 'settings-provider',
    });
    expect(model.reasoning).toBe(true);
    expect(model.thinkingLevelMap).toEqual({ xhigh: 'xhigh', max: 'max' });
    expect(model.contextWindow).toBe(128_000);
    expect(model.maxTokens).toBe(32_000);
  });

  it('行覆盖压过 catalog', () => {
    const runtime = mockRuntime({
      catalog: [
        {
          id: 'claude-sonnet-4',
          reasoning: true,
          thinkingLevelMap: { max: 'max' },
          contextWindow: 200_000,
          maxTokens: 64_000,
        },
      ],
    });
    const model = resolveBaseModel(runtime, {
      ...apiKeySpawn,
      reasoning: 'off',
      thinkingLevel: 'low',
      contextWindow: 80_000,
      maxTokens: 8_000,
    });
    expect(model.reasoning).toBe(false);
    expect(model.thinkingLevelMap).toBeUndefined();
    expect(model.contextWindow).toBe(80_000);
    expect(model.maxTokens).toBe(8_000);
  });

  it('google-generative-ai 缺 v1beta 时补上再注册', () => {
    const registerProvider = vi.fn();
    const runtime = {
      getModels: () => [],
      getModel: () => ({ id: 'gemini-2.5-flash' }),
      registerProvider,
    } as unknown as ModelRuntime;

    resolveBaseModel(runtime, {
      api: 'google-generative-ai',
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'k',
      modelId: 'gemini-2.5-flash',
      settingsProviderId: 'settings-provider',
    });

    expect(registerProvider).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        api: 'google-generative-ai',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      })
    );
  });

  it('mock 哨兵配置注册 streamSimple，不走 HTTP api', () => {
    const registerProvider = vi.fn();
    const runtime = {
      getModels: () => [],
      getModel: () => ({ id: MOCK_CHAT_MODEL_ID }),
      registerProvider,
    } as unknown as ModelRuntime;

    const resolved = resolveBaseModel(runtime, {
      api: 'openai-completions',
      baseUrl: MOCK_BASE_URL,
      apiKey: MOCK_API_KEY,
      modelId: MOCK_CHAT_MODEL_ID,
      settingsProviderId: 'settings-provider',
    });

    expect(resolved).toEqual({ id: MOCK_CHAT_MODEL_ID });
    expect(registerProvider).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        api: MOCK_API_ID,
        baseUrl: MOCK_BASE_URL,
        streamSimple: expect.any(Function),
      })
    );
  });

  it('空覆盖跟随 catalog', () => {
    const runtime = mockRuntime({
      catalog: [
        {
          id: 'gpt-4.1',
          reasoning: false,
          contextWindow: 1_047_576,
          maxTokens: 32_768,
        },
      ],
    });
    const model = resolveBaseModel(runtime, {
      api: 'openai-completions',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      modelId: 'gpt-4.1',
      settingsProviderId: 'settings-provider',
    });
    expect(model.reasoning).toBe(false);
    expect(model.thinkingLevelMap).toBeUndefined();
    expect(model.contextWindow).toBe(1_047_576);
  });
});

describe('resolveBaseModel oauth', () => {
  it('订阅路径仍直取 catalog，忽略行覆盖字段', () => {
    const oauthModel = {
      id: 'claude-sonnet-4-5',
      reasoning: true,
      thinkingLevelMap: { max: 'max' },
      contextWindow: 200_000,
      maxTokens: 64_000,
      provider: 'anthropic',
    };
    const registerProvider = vi.fn();
    const runtime = {
      getModels: vi.fn(() => {
        throw new Error('oauth 不应走全局 catalog 反查');
      }),
      getModel: vi.fn(() => oauthModel),
      registerProvider,
    } as unknown as ModelRuntime;

    const resolved = resolveBaseModel(runtime, {
      api: 'anthropic-messages',
      baseUrl: '',
      apiKey: '',
      modelId: 'claude-sonnet-4-5',
      settingsProviderId: 'settings-provider',
      oauthAccountKey: 'anthropic',
      reasoning: 'off',
      thinkingLevel: 'low',
      contextWindow: 1,
      maxTokens: 1,
    });

    expect(resolved).toBe(oauthModel);
    expect(runtime.getModel).toHaveBeenCalledWith('anthropic', 'claude-sonnet-4-5');
    expect(registerProvider).not.toHaveBeenCalled();
  });
});

describe('resolveBaseModelOrRefresh', () => {
  const spawn = {
    api: 'anthropic-messages' as const,
    baseUrl: '',
    apiKey: '',
    modelId: 'gemini-3.8-flash-tiered',
    settingsProviderId: 'settings-provider',
    oauthAccountKey: 'google-antigravity#2',
  };

  it('worker 清单过期漏掉后端新模型时，联网刷新基础 provider 后重试', async () => {
    const late = { id: 'gemini-3.8-flash-tiered', provider: 'google-antigravity#2' };
    let refreshed = false;
    const refresh = vi.fn(async () => {
      refreshed = true;
      return { aborted: false, errors: new Map() };
    });
    const runtime = {
      getModel: vi.fn(() => (refreshed ? late : undefined)),
      refresh,
    } as unknown as ModelRuntime;

    await expect(resolveBaseModelOrRefresh(runtime, spawn)).resolves.toBe(late);
    expect(refresh).toHaveBeenCalledWith({
      providers: ['google-antigravity'],
      allowNetwork: true,
      force: true,
    });
  });

  it('Cursor 无 force 只返回兜底清单时，miss 刷新必须 force 才能解析新模型', async () => {
    const late = { id: 'claude-fable-5-1', provider: 'cursor' };
    let catalog: typeof late | undefined;
    const refresh = vi.fn(async (options: { force?: boolean }) => {
      if (options.force) catalog = late;
      return { aborted: false, errors: new Map() };
    });
    const runtime = {
      getModel: vi.fn((providerId: string, modelId: string) =>
        providerId === 'cursor' && modelId === late.id ? catalog : undefined
      ),
      refresh,
    } as unknown as ModelRuntime;

    await expect(
      resolveBaseModelOrRefresh(runtime, {
        api: 'openai-completions',
        baseUrl: '',
        apiKey: '',
        modelId: 'claude-fable-5-1',
        settingsProviderId: 'settings-provider',
        oauthAccountKey: 'cursor',
      })
    ).resolves.toBe(late);
    expect(refresh).toHaveBeenCalledWith({
      providers: ['cursor'],
      allowNetwork: true,
      force: true,
    });
  });

  it('刷新后仍缺才报错，且刷新失败不吞掉原始错误', async () => {
    const runtime = {
      getModel: vi.fn(() => undefined),
      refresh: vi.fn(async () => {
        throw new Error('offline');
      }),
    } as unknown as ModelRuntime;

    await expect(resolveBaseModelOrRefresh(runtime, spawn)).rejects.toThrow(
      'oauth model not found: google-antigravity#2/gemini-3.8-flash-tiered'
    );
  });

  it('首次命中不触发刷新', async () => {
    const hit = { id: 'gemini-3.8-flash-tiered' };
    const refresh = vi.fn();
    const runtime = { getModel: vi.fn(() => hit), refresh } as unknown as ModelRuntime;

    await expect(resolveBaseModelOrRefresh(runtime, spawn)).resolves.toBe(hit);
    expect(refresh).not.toHaveBeenCalled();
  });
});
