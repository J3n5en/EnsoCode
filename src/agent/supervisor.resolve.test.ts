import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
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
  compat?: unknown;
  api?: string;
  baseUrl?: string;
  inputLimits?: { maxRequestBytes?: number };
};

// resolve 会装饰 native provider 的两条请求出口；纯 capability 测试不执行流。
function providerMethods() {
  return {
    getProvider: vi.fn(() => ({
      id: 'fixture',
      models: [],
      stream: vi.fn(() => {
        throw new Error('unused fixture stream');
      }),
      streamSimple: vi.fn(() => {
        throw new Error('unused fixture stream');
      }),
    })),
    registerNativeProvider: vi.fn(),
  };
}

function mockRuntime(options: {
  catalog?: CatalogRow[];
  oauthModel?: CatalogRow & { provider?: string };
}): ModelRuntime {
  const registered = new Map<string, CatalogRow>();
  const catalog = options.catalog ?? [];
  return {
    ...providerMethods(),
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
  it('同一端点与 key 的多个模型累积注册，后注册的不把先注册的挤出目录', () => {
    const calls: string[][] = [];
    const runtime = mockRuntime({ catalog: [] });
    const register = runtime.registerProvider.bind(runtime);
    (runtime as unknown as { registerProvider: typeof register }).registerProvider = (
      providerId,
      config
    ) => {
      calls.push((config.models ?? []).map((model) => model.id));
      register(providerId, config);
    };
    resolveBaseModel(runtime, { ...apiKeySpawn, apiKey: 'sk-accumulate', modelId: 'strong' });
    resolveBaseModel(runtime, { ...apiKeySpawn, apiKey: 'sk-accumulate', modelId: 'weak' });
    expect(calls.at(-1)).toEqual(['strong', 'weak']);
  });

  it('虚拟配置不能直接按真实模型解析', () => {
    expect(() =>
      resolveBaseModel(mockRuntime({}), {
        ...apiKeySpawn,
        virtual: { name: 'Auto', primary: apiKeySpawn, fallbacks: [] },
      })
    ).toThrow('resolveSessionModel');
  });

  it('同协议 catalog 的请求字节限制传给注册模型，不丢掉 pi 的限制元数据', () => {
    const runtime = mockRuntime({
      catalog: [
        {
          id: 'claude-sonnet-4',
          api: 'anthropic-messages',
          inputLimits: { maxRequestBytes: 1024 },
        },
      ],
    });
    expect(resolveBaseModel(runtime, apiKeySpawn).inputLimits?.maxRequestBytes).toBe(1024);
  });

  it('不把同名但其他协议的请求限制抄到当前模型', () => {
    const runtime = mockRuntime({
      catalog: [
        {
          id: 'claude-sonnet-4',
          api: 'openai-completions',
          inputLimits: { maxRequestBytes: 999_999_999 },
        },
      ],
    });
    expect(resolveBaseModel(runtime, apiKeySpawn).inputLimits).toBeUndefined();
  });

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
      ...providerMethods(),
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

  it('GLM 中转注册时关掉 developer 并带上 zai thinkingFormat', () => {
    const runtime = mockRuntime({
      catalog: [
        {
          id: 'glm-5.3-flash',
          reasoning: true,
          contextWindow: 1_000_000,
          maxTokens: 131_072,
          api: 'openai-completions',
          compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsReasoningEffort: true,
            maxTokensField: 'max_tokens',
            thinkingFormat: 'zai',
            zaiToolStream: true,
          },
        },
      ],
    });
    const model = resolveBaseModel(runtime, {
      api: 'openai-completions',
      baseUrl: 'https://new-api.jishu666.com/v1',
      apiKey: 'sk-gw',
      modelId: 'glm-5.3-flash',
      settingsProviderId: 'settings-provider',
    });
    expect(model.compat).toEqual({
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      maxTokensField: 'max_tokens',
      thinkingFormat: 'zai',
      zaiToolStream: true,
    });
  });

  it('未知中转模型默认关掉 developer', () => {
    const runtime = mockRuntime({ catalog: [] });
    const model = resolveBaseModel(runtime, {
      api: 'openai-completions',
      baseUrl: 'https://gw.example/v1',
      apiKey: 'sk-gw',
      modelId: 'my-private-gateway-model',
      settingsProviderId: 'settings-provider',
    });
    expect(model.compat).toEqual({ supportsDeveloperRole: false });
  });

  it('空 baseUrl 的 openai-completions 回落到官方 host，不关 developer', () => {
    const runtime = mockRuntime({ catalog: [] });
    const model = resolveBaseModel(runtime, {
      api: 'openai-completions',
      baseUrl: '',
      apiKey: 'sk-test',
      modelId: 'gpt-4.1',
      settingsProviderId: 'settings-provider',
    });
    expect(model.compat).toBeUndefined();
  });

  it('同 id 多 provider 冲突的中转不抄 wire compat', () => {
    const runtime = mockRuntime({
      catalog: [
        {
          id: 'zai-org/GLM-5.2',
          api: 'openai-completions',
          baseUrl: 'https://inference.baseten.co/v1',
          compat: {
            thinkingFormat: 'baseten',
            chatTemplateArgs: { enable_thinking: true },
            supportsDeveloperRole: false,
          },
        },
        {
          id: 'zai-org/GLM-5.2',
          api: 'openai-completions',
          baseUrl: 'https://api.together.xyz/v1',
          compat: { thinkingFormat: 'together', supportsDeveloperRole: false },
        },
      ],
    });
    const model = resolveBaseModel(runtime, {
      api: 'openai-completions',
      baseUrl: 'https://gw.example/v1',
      apiKey: 'sk-gw',
      modelId: 'zai-org/GLM-5.2',
      settingsProviderId: 'settings-provider',
    });
    expect(model.compat).toEqual({ supportsDeveloperRole: false });
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
      ...providerMethods(),
      getModels: vi.fn((providerId?: string) => {
        if (!providerId) throw new Error('oauth 不应走全局 catalog 反查');
        return [];
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

  it('xAI 订阅 catalog 没有 grok-4.7 时按 grok-4.6 克隆解析', () => {
    const grok46 = {
      id: 'grok-4.6',
      name: 'Grok 4.6',
      reasoning: true,
      thinkingLevelMap: { xhigh: 'xhigh' },
      contextWindow: 500_000,
      maxTokens: 500_000,
      provider: 'xai',
      api: 'openai-responses',
    };
    const registerProvider = vi.fn();
    const runtime = {
      ...providerMethods(),
      getModels: vi.fn((providerId?: string) => {
        if (providerId !== 'xai') throw new Error('oauth 不应走全局 catalog 反查');
        return [grok46];
      }),
      getModel: vi.fn(() => undefined),
      registerProvider,
    } as unknown as ModelRuntime;

    const resolved = resolveBaseModel(runtime, {
      api: 'openai-completions',
      baseUrl: '',
      apiKey: '',
      modelId: 'grok-4.7',
      settingsProviderId: 'settings-provider',
      oauthAccountKey: 'xai',
    });

    expect(resolved).toMatchObject({
      id: 'grok-4.7',
      name: 'Grok 4.7',
      provider: 'xai',
      api: 'openai-responses',
      reasoning: true,
      contextWindow: 500_000,
    });
    expect(registerProvider).not.toHaveBeenCalled();
  });

  it('xAI 手填未知 id 克隆同厂模板，其它订阅仍报缺失', () => {
    const grok46 = { id: 'grok-4.6', name: 'Grok 4.6', provider: 'xai', reasoning: true };
    const xaiRuntime = {
      ...providerMethods(),
      getModels: vi.fn(() => [grok46]),
      getModel: vi.fn(() => undefined),
      registerProvider: vi.fn(),
    } as unknown as ModelRuntime;
    expect(
      resolveBaseModel(xaiRuntime, {
        api: 'openai-completions',
        baseUrl: '',
        apiKey: '',
        modelId: 'grok-build-0.1',
        settingsProviderId: 'settings-provider',
        oauthAccountKey: 'xai',
      })
    ).toMatchObject({ id: 'grok-build-0.1', name: 'grok-build-0.1', provider: 'xai' });

    const anthropicRuntime = {
      getModels: vi.fn(() => [{ id: 'claude-sonnet-4-5' }]),
      getModel: vi.fn(() => undefined),
      registerProvider: vi.fn(),
    } as unknown as ModelRuntime;
    expect(() =>
      resolveBaseModel(anthropicRuntime, {
        api: 'anthropic-messages',
        baseUrl: '',
        apiKey: '',
        modelId: 'claude-mystery',
        settingsProviderId: 'settings-provider',
        oauthAccountKey: 'anthropic',
      })
    ).toThrow('oauth model not found: anthropic/claude-mystery');
  });

  it('xAI 克隆模型补进 provider 目录，虚拟模型路由能按目录取到', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'enso-xai-clone-'));
    const runtime = await ModelRuntime.create({
      authPath: path.join(dir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const spawn = {
      api: 'openai-completions' as const,
      baseUrl: '',
      apiKey: '',
      modelId: 'grok-4.7-build-fast',
      settingsProviderId: 'settings-provider',
      oauthAccountKey: 'xai',
    };
    const before = runtime.getModels('xai').length;
    expect(runtime.getPhysicalModel('xai', spawn.modelId)).toBeUndefined();

    const resolved = resolveBaseModel(runtime, spawn);
    resolveBaseModel(runtime, spawn);

    expect(runtime.getPhysicalModel('xai', spawn.modelId)).toEqual(resolved);
    expect(resolved).toMatchObject({ id: spawn.modelId, provider: 'xai' });
    expect(runtime.getModels('xai')).toHaveLength(before + 1);
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
      ...providerMethods(),
      getModels: vi.fn(() => []),
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
      ...providerMethods(),
      getModels: vi.fn(() => []),
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
      getModels: vi.fn(() => []),
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
    const runtime = {
      ...providerMethods(),
      getModel: vi.fn(() => hit),
      refresh,
    } as unknown as ModelRuntime;

    await expect(resolveBaseModelOrRefresh(runtime, spawn)).resolves.toBe(hit);
    expect(refresh).not.toHaveBeenCalled();
  });
});
