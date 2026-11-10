import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ModelDirectorySnapshot } from '@shared/modelDirectory';
import { providerKeyFor } from '@shared/providers/providerKey';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  accumulateModelIds,
  installPushedCustomProviders,
  type ModelDirectoryPushState,
  parseModelDirectoryPush,
  parseWorkerCustomProviders,
  previewModelDirectoryPush,
  registerCustomProviderModels,
  resetCustomProviderRegistryForTests,
} from './customProviderRegistry';

const snapshot: ModelDirectorySnapshot = { revision: 1, generatedAt: 1, providers: [] };

function provider(models: { id: string; contextWindow?: number }[], apiKey = 'sk-push') {
  return {
    settingsId: 'settings-1',
    name: 'relay',
    api: 'openai-completions',
    baseUrl: 'https://gw.example/v1',
    apiKey,
    models,
  };
}

function mockRuntime() {
  const providers = new Map<string, { id: string; headers?: Record<string, string> }>();
  const registerProvider = vi.fn();
  registerProvider.mockImplementation(
    (id: string, config: { headers?: Record<string, string> }) => {
      providers.set(id, { id, ...config });
    }
  );
  const runtime = {
    getModels: () => [],
    getProvider: (id: string) => providers.get(id),
    registerProvider,
    registerNativeProvider: vi.fn(),
  } as unknown as ModelRuntime;
  return { runtime, registerProvider };
}

function registeredIds(registerProvider: ReturnType<typeof vi.fn>): string[] {
  const last = registerProvider.mock.calls.at(-1)?.[1] as { models?: { id: string }[] } | undefined;
  return (last?.models ?? []).map((model) => model.id);
}

describe('parseModelDirectoryPush', () => {
  it('坏快照、非法 api、models 非数组都拒绝', () => {
    expect(parseModelDirectoryPush({ revision: 'nope' }, [])).toEqual({
      ok: false,
      reason: 'snapshot',
    });
    expect(parseWorkerCustomProviders('nope')).toBeUndefined();
    expect(parseModelDirectoryPush(snapshot, { settingsId: 'a' })).toEqual({
      ok: false,
      reason: 'customProviders',
    });

    const parsed = parseWorkerCustomProviders([
      provider([{ id: 'keep' }]),
      { ...provider([{ id: 'x' }]), api: 'not-an-api' },
      { ...provider([]), models: 'nope' },
      {
        ...provider([]),
        settingsId: 'other',
        models: [{ id: '' }, { id: 'row' }, 'bad'],
      },
    ] as unknown[]);
    expect(parsed?.map((item) => item.settingsId)).toEqual(['settings-1', 'other']);
    expect(parsed?.[0]?.models.map((model) => model.id)).toEqual(['keep']);
    expect(parsed?.[1]?.models.map((model) => model.id)).toEqual(['row']);
  });

  it('收窄请求头：非法名称和换行丢掉，空结果不带键', () => {
    const parsed = parseWorkerCustomProviders([
      {
        ...provider([{ id: 'keep' }]),
        headers: { 'X-Ok': 'one', 'bad name': 'no', 'X-Break': 'a\nb' },
      },
      { ...provider([]), settingsId: 'empty', headers: { nope: 1 } },
    ]);
    expect(parsed?.[0]?.headers).toEqual({ 'X-Ok': 'one' });
    expect(parsed?.[1]).not.toHaveProperty('headers');
  });
});

describe('accumulateModelIds', () => {
  it('只追加没有的 id', () => {
    expect(accumulateModelIds(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(accumulateModelIds(['x'], ['a'])).toEqual(['x', 'a']);
  });
});

describe('installPushedCustomProviders', () => {
  beforeEach(() => {
    resetCustomProviderRegistryForTests();
  });

  it('先推 a,b 再推 b,c 时注册表保留 a,b,c', () => {
    const { runtime, registerProvider } = mockRuntime();
    installPushedCustomProviders(runtime, [provider([{ id: 'a' }, { id: 'b' }])]);
    installPushedCustomProviders(runtime, [provider([{ id: 'b' }, { id: 'c' }])]);
    expect(registeredIds(registerProvider)).toEqual(['a', 'b', 'c']);
  });

  it('spawn 已注册的模型不会被后续推送顶掉', () => {
    const { runtime, registerProvider } = mockRuntime();
    const endpoint = {
      api: 'openai-completions' as const,
      baseUrl: 'https://gw.example/v1',
      apiKey: 'sk-push',
    };
    registerCustomProviderModels(runtime, endpoint, [{ id: 'x', contextWindow: 1_000 }]);
    const spawnedCall = registerProvider.mock.calls[0]?.[1] as
      | { models: { id: string; contextWindow?: number }[] }
      | undefined;
    const spawned = spawnedCall?.models[0];
    installPushedCustomProviders(runtime, [
      provider([{ id: 'x', contextWindow: 9_000 }, { id: 'a' }]),
    ]);
    const pushedCall = registerProvider.mock.calls.at(-1)?.[1] as
      | { models: { id: string; contextWindow?: number }[] }
      | undefined;
    const models = pushedCall?.models ?? [];
    expect(models.map((model) => model.id)).toEqual(['x', 'a']);
    expect(models[0]).toBe(spawned);
    expect(models[0]?.contextWindow).toBe(1_000);
  });

  it('相同 payload 重复推送不重复注册', () => {
    const { runtime, registerProvider } = mockRuntime();
    const providers = [provider([{ id: 'a' }])];
    let state: ModelDirectoryPushState | undefined;
    const first = previewModelDirectoryPush(state, snapshot, providers);
    expect(first.status).toBe('apply');
    if (first.status !== 'apply') return;
    installPushedCustomProviders(runtime, first.parsed.providers);
    state = first.parsed;
    const again = previewModelDirectoryPush(state, snapshot, providers);
    expect(again.status).toBe('unchanged');
    if (again.status === 'apply') installPushedCustomProviders(runtime, again.parsed.providers);
    expect(registerProvider).toHaveBeenCalledTimes(1);
  });

  it('revision 倒退的晚到旧推送被丢弃', () => {
    const providers = [provider([{ id: 'a' }])];
    const first = previewModelDirectoryPush(undefined, snapshot, providers);
    expect(first.status).toBe('apply');
    if (first.status !== 'apply') return;
    const stale = {
      ...snapshot,
      revision: first.parsed.snapshot.revision - 1,
    };
    const out = previewModelDirectoryPush(first.parsed, stale, providers);
    expect(out).toEqual({ status: 'ignored', reason: 'stale-revision' });
  });
});

describe('registerCustomProviderModels headers', () => {
  beforeEach(() => {
    resetCustomProviderRegistryForTests();
  });

  it('注册后的 provider 带上 Enso User-Agent，用户头覆盖它，并把 $ 和 ! 转成字面量', () => {
    const { runtime } = mockRuntime();
    const endpoint = {
      api: 'openai-completions' as const,
      baseUrl: 'https://gw.example/v1',
      apiKey: 'sk-push',
    };
    registerCustomProviderModels(runtime, endpoint, [{ id: 'm' }]);
    const plain = runtime.getProvider(providerKeyFor(endpoint));
    expect(plain?.headers?.['User-Agent']).toMatch(/^enso-code\//);

    const custom = {
      ...endpoint,
      headers: { 'user-agent': 'custom', originator: '!rm', 'X-Home': '$HOME' },
    };
    registerCustomProviderModels(runtime, custom, [{ id: 'm' }]);
    expect(runtime.getProvider(providerKeyFor(custom))?.headers).toEqual({
      'user-agent': 'custom',
      originator: '$!rm',
      'X-Home': '$$HOME',
    });
  });

  it('请求头变化不会被当成相同推送', () => {
    const first = previewModelDirectoryPush(undefined, snapshot, [provider([{ id: 'a' }])]);
    expect(first.status).toBe('apply');
    if (first.status !== 'apply') return;
    const next = previewModelDirectoryPush(first.parsed, snapshot, [
      { ...provider([{ id: 'a' }]), headers: { 'X-Trace': '1' } },
    ]);
    expect(next.status).toBe('apply');
  });
});
