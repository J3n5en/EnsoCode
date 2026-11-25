import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  MODELS_DEV_CACHE_NAME,
  MODELS_DEV_SCHEMA_VERSION,
  MODELS_DEV_URL,
  type ModelsDevCache,
} from '@shared/modelsDevCatalog';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const userData = mkdtempSync(path.join(tmpdir(), 'enso-model-meta-'));
const modelsDevOnlyId = 'codex/test-models-dev-reasoning';
const nonReasoningModelsDevOnlyId = 'test-models-dev-chat';

vi.mock('electron', () => ({
  app: { getPath: () => userData, getName: () => 'enso-code', on: () => {} },
  shell: { openExternal: () => {} },
}));

// catalog 联网刷新走真实 fetch：测试用的是假 token，线上本来就秒回 401，
// 单测不该为网络时延付 1-17s（本机慢链路下会贴到 20s 超时上限）。
// 用确定性 401 复刻同一行为路径——刷新失败后回退到内置兜底清单，
// 正是这些用例一直在断言的 catalog 内容。
vi.stubGlobal(
  'fetch',
  async () =>
    new Response(JSON.stringify({ error: { type: 'authentication_error' } }), { status: 401 })
);

beforeAll(() => {
  const dir = path.join(userData, 'agent', 'pi-agent');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'auth.json'),
    JSON.stringify({
      anthropic: {
        type: 'oauth',
        access: 'sk-ant-oat01-meta',
        refresh: 'r1',
        expires: Date.now() + 3_600_000,
      },
    })
  );
  const modelsDevCache: ModelsDevCache = {
    schemaVersion: MODELS_DEV_SCHEMA_VERSION,
    source: MODELS_DEV_URL,
    fetchedAt: Date.now(),
    models: [
      {
        id: modelsDevOnlyId,
        provider: 'codex',
        reasoning: true,
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      },
      { id: nonReasoningModelsDevOnlyId, provider: 'test-provider', reasoning: false },
    ],
  };
  writeFileSync(path.join(userData, MODELS_DEV_CACHE_NAME), JSON.stringify(modelsDevCache));
});

afterAll(() => {
  rmSync(userData, { recursive: true, force: true });
});

describe('queryModelMeta', () => {
  it('订阅条目按 catalog 取值，contextWindow 与 runtime.getModel 一致', {
    timeout: 20_000,
  }, async () => {
    const { queryModelMeta } = await import('./modelMeta');
    const { getRuntime } = await import('./oauthProviders');
    const runtime = await getRuntime();
    const catalog = runtime.getModel('anthropic', 'claude-sonnet-4-5');
    expect(catalog).toBeDefined();

    const result = await queryModelMeta({
      oauthAccountKey: 'anthropic',
      modelIds: ['claude-sonnet-4-5'],
    });
    expect(result.ok).toBe(true);
    expect(result.models).toHaveLength(1);
    const meta = result.models[0];
    expect(meta.source).toBe('catalog');
    expect(meta.modelId).toBe('claude-sonnet-4-5');
    expect(meta.contextWindow).toBe(catalog?.contextWindow);
    expect(meta.maxTokens).toBe(catalog?.maxTokens);
    expect(typeof meta.reasoning).toBe('boolean');
    expect(Array.isArray(meta.thinkingLevels)).toBe(true);
  });

  it('API-key 反查命中时带 catalog 的 reasoning / thinkingLevels（与 spawn 同表）', async () => {
    const { queryModelMeta } = await import('./modelMeta');
    const { getRuntime } = await import('./oauthProviders');
    const runtime = await getRuntime();
    const catalog = runtime.getModels().find((entry) => entry.id === 'claude-sonnet-4-5');
    expect(catalog).toBeDefined();

    const result = await queryModelMeta({ modelIds: ['claude-sonnet-4-5'] });
    expect(result.ok).toBe(true);
    expect(result.models[0]?.source).toBe('catalog-fallback');
    expect(result.models[0]?.reasoning).toBe(catalog?.reasoning);
    expect(result.models[0]?.thinkingLevels).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(result.models[0]?.contextWindow).toBe(catalog?.contextWindow);
  });

  it('仅被 models.dev 收录的自定义推理模型保留窗口且省略未知档位', async () => {
    const { queryModelMeta } = await import('./modelMeta');

    const result = await queryModelMeta({ modelIds: [modelsDevOnlyId] });

    expect(result).toMatchObject({
      ok: true,
      models: [
        {
          modelId: modelsDevOnlyId,
          source: 'catalog-fallback',
          reasoning: true,
          contextWindow: 1_000_000,
          maxTokens: 128_000,
        },
      ],
    });
    expect(result.models[0]).not.toHaveProperty('thinkingLevels');
  });

  it('仅被 models.dev 收录且明确不支持推理的模型返回空档位', async () => {
    const { queryModelMeta } = await import('./modelMeta');

    const result = await queryModelMeta({ modelIds: [nonReasoningModelsDevOnlyId] });

    expect(result).toMatchObject({
      ok: true,
      models: [
        {
          modelId: nonReasoningModelsDevOnlyId,
          source: 'catalog-fallback',
          reasoning: false,
          thinkingLevels: [],
        },
      ],
    });
  });

  it('catalog 未命中时 source=unknown，可选字段缺失', async () => {
    const { queryModelMeta } = await import('./modelMeta');
    const result = await queryModelMeta({ modelIds: ['not-a-real-model-id'] });
    expect(result.models[0]).toEqual({ modelId: 'not-a-real-model-id', source: 'unknown' });
  });

  it('不存在的合成账号在注册克隆和刷新 catalog 前被泛化拒绝', async () => {
    const { queryModelMeta } = await import('./modelMeta');
    const { getRuntime } = await import('./oauthProviders');
    const runtime = await getRuntime();
    const registerSpy = vi.spyOn(runtime, 'registerNativeProvider');
    const refreshSpy = vi.spyOn(runtime, 'refresh');

    const result = await queryModelMeta({
      oauthAccountKey: 'google-antigravity#999',
      modelIds: [],
    });

    expect(result).toEqual({ ok: false, models: [], error: 'Invalid query' });
    expect(runtime.getProvider('google-antigravity#999')).toBeUndefined();
    expect(registerSpy).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
    registerSpy.mockRestore();
    refreshSpy.mockRestore();
  });

  it('空 modelIds 只允许已授权订阅账号列出完整 catalog', async () => {
    const { queryModelMeta } = await import('./modelMeta');

    await expect(queryModelMeta({ modelIds: [] })).resolves.toEqual({
      ok: false,
      models: [],
      error: 'Invalid query',
    });
    const authorized = await queryModelMeta({ oauthAccountKey: 'anthropic', modelIds: [] });
    expect(authorized.ok).toBe(true);
    expect(authorized.models.length).toBeGreaterThan(0);
  });
});
