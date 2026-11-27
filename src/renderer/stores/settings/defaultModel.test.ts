import type { OauthCredentialAvailability } from '@shared/defaultModel';
import type { ModelProvider } from '@shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useModelDirectoryStore } from '@/stores/modelDirectory';
import { useOauthCredentialStore } from '@/stores/oauthCredentials';

const writeKey = vi.fn(async () => undefined);
const readSettings = vi.fn(async (): Promise<Record<string, unknown> | null> => null);

vi.stubGlobal('navigator', { language: 'en-US' });
vi.stubGlobal('document', {
  documentElement: {
    dataset: {},
    lang: 'en',
    classList: { toggle: vi.fn() },
    style: { setProperty: vi.fn(), removeProperty: vi.fn() },
  },
});
vi.stubGlobal('window', {
  matchMedia: () => ({ matches: false, addEventListener: vi.fn() }),
  electronAPI: {
    settings: {
      read: readSettings,
      writeKey,
      onChanged: vi.fn(),
    },
    sourceAuthority: {
      read: vi.fn(async () => ({ projects: [], conversations: [] })),
      onChanged: vi.fn(() => vi.fn()),
    },
    instructions: { delete: vi.fn(async () => ({ ok: true })) },
  },
});
const settingsModule = await import('./index');

function provider(id: string, overrides: Partial<ModelProvider> = {}): ModelProvider {
  return {
    id,
    name: id,
    api: 'openai-completions',
    apiKey: `key-${id}`,
    baseUrl: 'https://example.test/v1',
    enabled: true,
    models: [{ id: 'model' }],
    ...overrides,
  };
}

function setSnapshot(revision: number, availability: OauthCredentialAvailability) {
  const snapshot = { revision, availability };
  useOauthCredentialStore.setState({ snapshot });
  return snapshot;
}

let directoryRevision = 0;
/** 给目录服务喂 OAuth 分区；sections 缺省 = 目录冷态（升级首启） */
function setDirectory(sections?: { key: string; modelIds: string[] }[]) {
  directoryRevision += 1;
  useModelDirectoryStore.setState({
    snapshot: sections
      ? {
          revision: directoryRevision,
          generatedAt: Date.now(),
          providers: sections.map((section) => ({
            key: section.key,
            kind: 'oauth' as const,
            label: section.key,
            models: section.modelIds.map((id) => ({ id })),
          })),
        }
      : undefined,
  });
}

describe('settings default model actions', () => {
  beforeEach(() => {
    useOauthCredentialStore.setState({
      snapshot: { revision: 0, availability: { status: 'unloaded' } },
    });
    setDirectory(undefined);
    readSettings.mockResolvedValue(null);
    settingsModule.useSettingsStore.setState({ providers: [], defaultModel: null });
    settingsModule.useDefaultModelRevalidationStore.setState({ latest: null });
    writeKey.mockClear();
  });

  it('setDefaultModel stores only provider/model and clears an old notice', () => {
    settingsModule.useDefaultModelRevalidationStore.setState({
      latest: {
        status: 'stale',
        defaultModel: null,
        writeback: false,
      },
    });
    settingsModule.useSettingsStore.getState().setDefaultModel({
      providerId: 'chosen',
      modelId: 'model',
    });
    expect(settingsModule.useSettingsStore.getState().defaultModel).toEqual({
      providerId: 'chosen',
      modelId: 'model',
    });
    expect(settingsModule.useDefaultModelRevalidationStore.getState().latest).toBeNull();
    expect('snapshot' in settingsModule.useSettingsStore.getState()).toBe(false);
  });

  it('OAuth loading/error defers an OAuth default without writeback', () => {
    const oauth = provider('oauth', { apiKey: '', oauthAccountKey: 'anthropic' });
    for (const availability of [
      { status: 'loading' as const },
      { status: 'error' as const, error: 'auth read failed' },
    ]) {
      const snapshot = setSnapshot(1, availability);
      settingsModule.useSettingsStore.setState({
        providers: [oauth, provider('fallback')],
        defaultModel: { providerId: oauth.id, modelId: 'model' },
      });
      const result = settingsModule.useSettingsStore.getState().revalidateDefaultModel(snapshot);
      expect(result).toMatchObject({ status: 'deferred', writeback: false });
      expect(settingsModule.useSettingsStore.getState().defaultModel).toEqual({
        providerId: oauth.id,
        modelId: 'model',
      });
    }
  });

  it('目录冷态（升级首启）defer OAuth 默认模型且不写回；分区到达后闭环为 unchanged', () => {
    const oauth = provider('oauth', {
      apiKey: '',
      oauthAccountKey: 'anthropic',
      models: [], // v16 稀疏覆盖表：无任何意图行
    });
    const snapshot = setSnapshot(1, {
      status: 'ready',
      authenticatedAccountKeys: new Set(['anthropic']),
    });
    settingsModule.useSettingsStore.setState({
      providers: [oauth],
      defaultModel: { providerId: oauth.id, modelId: 'model' },
    });

    // 目录冷态：section 缺失 → defer，默认模型原样保留，绝不写回
    setDirectory(undefined);
    const cold = settingsModule.useSettingsStore.getState().revalidateDefaultModel(snapshot);
    expect(cold).toMatchObject({ status: 'deferred', writeback: false });
    expect(settingsModule.useSettingsStore.getState().defaultModel).toEqual({
      providerId: oauth.id,
      modelId: 'model',
    });

    // 空分区（发现从未成功）同样视为冷态
    setDirectory([{ key: 'anthropic', modelIds: [] }]);
    expect(
      settingsModule.useSettingsStore.getState().revalidateDefaultModel(snapshot)
    ).toMatchObject({ status: 'deferred', writeback: false });

    // 分区到达：物化视图含该模型，闭环为 unchanged
    setDirectory([{ key: 'anthropic', modelIds: ['model'] }]);
    const warm = settingsModule.useSettingsStore.getState().revalidateDefaultModel(snapshot);
    expect(warm).toEqual({
      status: 'unchanged',
      defaultModel: { providerId: oauth.id, modelId: 'model' },
      writeback: false,
    });
  });

  it('虚拟默认模型的 OAuth 成员分区冷态时同样 defer（Major-1 逃生口）', () => {
    const oauth = provider('oauth', {
      apiKey: '',
      oauthAccountKey: 'anthropic',
      models: [],
    });
    const virtualEntry = {
      id: 'auto',
      name: 'Auto',
      enabled: true,
      primary: { providerId: oauth.id, modelId: 'model' },
      fallbacks: [],
    };
    const snapshot = setSnapshot(1, {
      status: 'ready',
      authenticatedAccountKeys: new Set(['anthropic']),
    });
    settingsModule.useSettingsStore.setState({
      providers: [oauth],
      virtualModels: [virtualEntry],
      defaultModel: { providerId: 'enso-virtual', modelId: 'auto' },
    });

    // 目录冷态：虚拟默认经 primary 解析到 OAuth 成员，分区缺失 → defer 不写回
    setDirectory(undefined);
    const cold = settingsModule.useSettingsStore.getState().revalidateDefaultModel(snapshot);
    expect(cold).toMatchObject({ status: 'deferred', writeback: false });
    expect(settingsModule.useSettingsStore.getState().defaultModel).toEqual({
      providerId: 'enso-virtual',
      modelId: 'auto',
    });

    // 分区到达后闭环
    setDirectory([{ key: 'anthropic', modelIds: ['model'] }]);
    const warm = settingsModule.useSettingsStore.getState().revalidateDefaultModel(snapshot);
    expect(warm.status).toBe('unchanged');
  });

  it.each(['before', 'after'] as const)(
    'v15 无目录缓存升级：静态分区在水合 %s 到达，延迟发现前后均保留旧动态默认',
    async (order) => {
      const oauth = provider('oauth', {
        apiKey: '',
        oauthAccountKey: 'xai',
        models: [{ id: 'grok-static' }, { id: 'grok-dynamic' }, { id: 'unselected-old' }],
      });
      const chosen = { providerId: oauth.id, modelId: 'grok-dynamic' };
      const credentials = setSnapshot(1, {
        status: 'ready',
        authenticatedAccountKeys: new Set(['xai']),
      });
      const oldState = { providers: [oauth], defaultModel: chosen, onboarded: true };
      readSettings.mockResolvedValueOnce({ 'enso-settings': { version: 15, state: oldState } });
      if (order === 'before') setDirectory([{ key: 'xai', modelIds: ['grok-static'] }]);
      await settingsModule.useSettingsStore.persist.rehydrate();
      if (order === 'after') setDirectory([{ key: 'xai', modelIds: ['grok-static'] }]);
      expect(settingsModule.useSettingsStore.getState().defaultModel).toEqual(chosen);
      // 无意图的旧完整清单不能重新冻结进设置。
      expect(
        settingsModule.useSettingsStore.getState().providers[0]?.models.map((model) => model.id)
      ).not.toContain('unselected-old');
      settingsModule.useSettingsStore.getState().setDefaultReasoningEnabled(true);
      await Promise.resolve();
      const persisted = writeKey.mock.calls
        .map((call) => call as unknown[])
        .filter(([key]) => key === 'enso-settings')
        .map(([, value]) => value as { state: { defaultModel: unknown } });
      expect(persisted.length).toBeGreaterThan(0);
      expect(
        persisted.every(
          (value) => JSON.stringify(value.state.defaultModel) === JSON.stringify(chosen)
        )
      ).toBe(true);
      // 发现尚未到达时重读已升级设置，选型意图仍在，不依赖本次迁移的内存。
      readSettings.mockResolvedValueOnce({ 'enso-settings': persisted.at(-1) });
      await settingsModule.useSettingsStore.persist.rehydrate();
      expect(settingsModule.useSettingsStore.getState().defaultModel).toEqual(chosen);

      // 在线发现晚一个异步阶段到达，不能靠事后用户重选修复已被清空的引用。
      await Promise.resolve();
      setDirectory([{ key: 'xai', modelIds: ['grok-static', 'grok-dynamic', 'brand-new'] }]);
      expect(
        settingsModule.useSettingsStore.getState().revalidateDefaultModel(credentials)
      ).toMatchObject({
        status: 'unchanged',
        defaultModel: chosen,
        writeback: false,
      });
    }
  );

  it('ready logout：OAuth 默认原样保留、标记不可用，不换成别的服务商', () => {
    const oauth = provider('oauth', { apiKey: '', oauthAccountKey: 'anthropic' });
    const fallback = provider('fallback');
    setDirectory([{ key: 'anthropic', modelIds: ['model'] }]);
    const snapshot = setSnapshot(2, {
      status: 'ready',
      authenticatedAccountKeys: new Set(),
    });
    const chosen = { providerId: oauth.id, modelId: 'model' };
    settingsModule.useSettingsStore.setState({
      providers: [oauth, fallback],
      defaultModel: chosen,
    });

    const result = settingsModule.useSettingsStore.getState().revalidateDefaultModel(snapshot);
    expect(result).toEqual({
      status: 'unavailable',
      defaultModel: chosen,
      reason: 'oauth-account-missing',
      writeback: false,
    });
    expect(settingsModule.useSettingsStore.getState().defaultModel).toEqual(chosen);
    expect(settingsModule.useDefaultModelRevalidationStore.getState().latest).toEqual(result);
  });

  it('(a) API-key 默认失效（magpie 无 key）：不写回、不落盘替换，只标记不可用', async () => {
    const magpie = provider('magpie', { apiKey: '', models: [{ id: 'devin/swe-2-1' }] });
    const max = provider('max', { models: [{ id: 'claude-fable-5' }] });
    const chosen = { providerId: magpie.id, modelId: 'devin/swe-2-1' };
    const snapshot = setSnapshot(1, { status: 'ready', authenticatedAccountKeys: new Set() });
    settingsModule.useSettingsStore.setState({ providers: [magpie, max], defaultModel: chosen });
    writeKey.mockClear();

    const result = settingsModule.useSettingsStore.getState().revalidateDefaultModel(snapshot);
    expect(result).toEqual({
      status: 'unavailable',
      defaultModel: chosen,
      reason: 'api-key-missing',
      writeback: false,
    });
    expect(settingsModule.useSettingsStore.getState().defaultModel).toEqual(chosen);
    await Promise.resolve();
    const persistedDefaults = writeKey.mock.calls
      .map((call) => call as unknown[])
      .filter(([key]) => key === 'enso-settings')
      .map(([, value]) => (value as { state: { defaultModel: unknown } }).state.defaultModel);
    expect(
      persistedDefaults.every((value) => JSON.stringify(value) === JSON.stringify(chosen))
    ).toBe(true);
  });

  it('(b) 凭证补上后同一默认自动恢复为 unchanged', () => {
    const magpie = provider('magpie', { apiKey: '', models: [{ id: 'devin/swe-2-1' }] });
    const chosen = { providerId: magpie.id, modelId: 'devin/swe-2-1' };
    const snapshot = setSnapshot(1, { status: 'ready', authenticatedAccountKeys: new Set() });
    settingsModule.useSettingsStore.setState({
      providers: [magpie, provider('max')],
      defaultModel: chosen,
    });
    expect(settingsModule.useSettingsStore.getState().revalidateDefaultModel(snapshot).status).toBe(
      'unavailable'
    );
    settingsModule.useSettingsStore.getState().updateProvider(magpie.id, { apiKey: 'key-magpie' });
    expect(settingsModule.useDefaultModelRevalidationStore.getState().latest).toEqual({
      status: 'unchanged',
      defaultModel: chosen,
      writeback: false,
    });
    expect(settingsModule.useSettingsStore.getState().defaultModel).toEqual(chosen);
  });

  it('进入不可用只记一次日志，反复快照不刷屏；恢复后再失效会再记', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const magpie = provider('magpie', { apiKey: '' });
      const snapshot = setSnapshot(1, { status: 'ready', authenticatedAccountKeys: new Set() });
      settingsModule.useSettingsStore.setState({
        providers: [magpie],
        defaultModel: { providerId: magpie.id, modelId: 'model' },
      });
      const store = settingsModule.useSettingsStore.getState();
      store.revalidateDefaultModel(snapshot);
      store.revalidateDefaultModel(snapshot);
      setDirectory([{ key: 'other', modelIds: ['x'] }]);
      store.revalidateDefaultModel(snapshot);
      const unavailableLogs = () =>
        warn.mock.calls.filter((call) => String(call[0]).includes('[default-model]'));
      expect(unavailableLogs()).toHaveLength(1);
      expect(unavailableLogs()[0]?.join(' ')).toContain('magpie/model');
      expect(unavailableLogs()[0]?.join(' ')).toContain('api-key-missing');

      store.updateProvider(magpie.id, { apiKey: 'key' });
      expect(info.mock.calls.some((call) => String(call[0]).includes('[default-model]'))).toBe(
        true
      );
      store.updateProvider(magpie.id, { enabled: false });
      expect(unavailableLogs()).toHaveLength(2);
      expect(unavailableLogs()[1]?.join(' ')).toContain('provider-disabled');
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });

  it('水合时 OAuth 已 ready 但账号缺失：保留水合出的默认，不改成 fallback', async () => {
    const oauth = provider('oauth', { apiKey: '', oauthAccountKey: 'anthropic' });
    const fallback = provider('fallback');
    setDirectory([{ key: 'anthropic', modelIds: ['model'] }]);
    setSnapshot(5, { status: 'ready', authenticatedAccountKeys: new Set() });
    readSettings.mockResolvedValueOnce({
      'enso-settings': {
        state: {
          providers: [oauth, fallback],
          defaultModel: { providerId: oauth.id, modelId: 'model' },
        },
        version: 2,
      },
    });

    await settingsModule.useSettingsStore.persist.rehydrate();
    expect(settingsModule.useSettingsStore.getState().defaultModel).toEqual({
      providerId: oauth.id,
      modelId: 'model',
    });
    expect(settingsModule.useDefaultModelRevalidationStore.getState().latest).toMatchObject({
      status: 'unavailable',
      reason: 'oauth-account-missing',
    });
  });

  it('an API-key default remains usable while OAuth snapshot is error', () => {
    const api = provider('api');
    const snapshot = setSnapshot(3, { status: 'error', error: 'auth read failed' });
    settingsModule.useSettingsStore.setState({
      providers: [api],
      defaultModel: { providerId: api.id, modelId: 'model' },
    });

    expect(settingsModule.useSettingsStore.getState().revalidateDefaultModel(snapshot)).toEqual({
      status: 'unchanged',
      defaultModel: { providerId: api.id, modelId: 'model' },
      writeback: false,
    });
  });

  it('rejects a stale snapshot before sanitize', () => {
    setSnapshot(4, { status: 'loading' });
    settingsModule.useSettingsStore.setState({
      providers: [provider('api')],
      defaultModel: { providerId: 'missing', modelId: 'model' },
    });
    expect(
      settingsModule.useSettingsStore.getState().revalidateDefaultModel({
        revision: 3,
        availability: { status: 'ready', authenticatedAccountKeys: new Set() },
      })
    ).toMatchObject({ status: 'stale', writeback: false });
    expect(settingsModule.useSettingsStore.getState().defaultModel).toEqual({
      providerId: 'missing',
      modelId: 'model',
    });
  });

  it('删除默认所属服务商：默认原样保留并标记 provider-missing', () => {
    const removed = provider('removed');
    const fallback = provider('fallback');
    setSnapshot(1, { status: 'ready', authenticatedAccountKeys: new Set() });
    settingsModule.useSettingsStore.setState({
      providers: [removed, fallback],
      defaultModel: { providerId: removed.id, modelId: 'model' },
    });

    settingsModule.useSettingsStore.getState().removeProvider(removed.id);
    expect(settingsModule.useSettingsStore.getState().defaultModel).toEqual({
      providerId: removed.id,
      modelId: 'model',
    });
    expect(settingsModule.useDefaultModelRevalidationStore.getState().latest).toMatchObject({
      status: 'unavailable',
      reason: 'provider-missing',
    });
  });

  it('停用默认所属服务商：默认原样保留并标记 provider-disabled', () => {
    const chosen = provider('chosen');
    setSnapshot(1, { status: 'ready', authenticatedAccountKeys: new Set() });
    settingsModule.useSettingsStore.setState({
      providers: [chosen, provider('fallback')],
      defaultModel: { providerId: chosen.id, modelId: 'model' },
    });
    settingsModule.useSettingsStore.getState().updateProvider(chosen.id, { enabled: false });
    expect(settingsModule.useSettingsStore.getState().defaultModel).toEqual({
      providerId: chosen.id,
      modelId: 'model',
    });
    expect(settingsModule.useDefaultModelRevalidationStore.getState().latest).toMatchObject({
      status: 'unavailable',
      reason: 'provider-disabled',
    });
  });

  it('setDefaultModelFollowLast stores the follow-last preference', () => {
    settingsModule.useSettingsStore.getState().setDefaultModelFollowLast(true);
    expect(settingsModule.useSettingsStore.getState().defaultModelFollowLast).toBe(true);
    settingsModule.useSettingsStore.getState().setDefaultModelFollowLast(false);
    expect(settingsModule.useSettingsStore.getState().defaultModelFollowLast).toBe(false);
  });

  it('setDefaultModel pins a model and turns off follow-last', () => {
    settingsModule.useSettingsStore.setState({
      defaultModelFollowLast: true,
      defaultModel: { providerId: 'old', modelId: 'model' },
    });
    settingsModule.useSettingsStore.getState().setDefaultModel({
      providerId: 'chosen',
      modelId: 'next',
    });
    expect(settingsModule.useSettingsStore.getState()).toMatchObject({
      defaultModel: { providerId: 'chosen', modelId: 'next' },
      defaultModelFollowLast: false,
    });
  });

  it('rememberDefaultModelFromSelection writes only while follow-last is on', () => {
    settingsModule.useSettingsStore.setState({
      defaultModelFollowLast: false,
      defaultModel: { providerId: 'pinned', modelId: 'model' },
    });
    settingsModule.useSettingsStore.getState().rememberDefaultModelFromSelection({
      providerId: 'next',
      modelId: 'model',
    });
    expect(settingsModule.useSettingsStore.getState().defaultModel).toEqual({
      providerId: 'pinned',
      modelId: 'model',
    });

    settingsModule.useSettingsStore.setState({ defaultModelFollowLast: true });
    settingsModule.useSettingsStore.getState().rememberDefaultModelFromSelection({
      providerId: 'next',
      modelId: 'model',
    });
    expect(settingsModule.useSettingsStore.getState()).toMatchObject({
      defaultModel: { providerId: 'next', modelId: 'model' },
      defaultModelFollowLast: true,
    });
  });
});
