import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const userData = mkdtempSync(path.join(tmpdir(), 'enso-model-meta-'));

vi.mock('electron', () => ({
  app: { getPath: () => userData, getName: () => 'enso-code', on: () => {} },
  shell: { openExternal: () => {} },
}));

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
});

afterAll(() => {
  rmSync(userData, { recursive: true, force: true });
});

describe('queryModelMeta', () => {
  it('订阅条目按 catalog 取值，contextWindow 与 runtime.getModel 一致', async () => {
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

  it('API-key 反查命中时不带 reasoning / thinkingLevels', async () => {
    const { queryModelMeta } = await import('./modelMeta');
    const result = await queryModelMeta({ modelIds: ['claude-sonnet-4-5'] });
    expect(result.ok).toBe(true);
    expect(result.models[0]?.source).toBe('catalog-fallback');
    expect(result.models[0]).not.toHaveProperty('reasoning');
    expect(result.models[0]).not.toHaveProperty('thinkingLevels');
    expect(result.models[0]?.contextWindow).toBeGreaterThan(0);
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
