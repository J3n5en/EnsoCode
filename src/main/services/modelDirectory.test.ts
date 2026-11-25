import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DirectoryProvider } from '@shared/modelDirectory';
import type { ModelProvider } from '@shared/types';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DirectoryOAuthSource, synthesizeModelDirectory } from './modelDirectory';

const userData = mkdtempSync(path.join(tmpdir(), 'enso-model-directory-'));
const cachePath = path.join(userData, 'model-directory-cache.json');

const mocks = vi.hoisted(() => {
  const send = vi.fn();
  return {
    send,
    settings: null as Record<string, unknown> | null,
    getRuntime: vi.fn(),
    windows: [
      {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send },
      },
    ],
  };
});

vi.mock('electron', () => ({
  app: { getPath: () => userData, on: vi.fn() },
  BrowserWindow: { getAllWindows: () => mocks.windows },
}));

vi.mock('./uiHost', async () =>
  (await import('../../../test/helpers/localUi')).mockUiHost(() => mocks.windows)
);

vi.mock('../ipc/settings', () => ({
  readSettings: () => mocks.settings,
}));

vi.mock('./oauthProviders', () => ({
  getRuntime: () => mocks.getRuntime(),
}));

await import('./modelDirectory');

const customProvider = (models: ModelProvider['models']): ModelProvider => ({
  id: 'custom-1',
  name: '我的中转',
  api: 'openai-completions',
  apiKey: 'sk-test',
  baseUrl: 'https://example.com/v1',
  enabled: true,
  models,
});

const cachedOAuth: DirectoryProvider = {
  key: 'google-antigravity',
  kind: 'oauth',
  label: '旧标签',
  models: [{ id: 'gemini-3-pro', label: 'Cached Pro' }],
  discoveredAt: 1_700_000_000_000,
};

function settingsWith(providers: unknown[]): Record<string, unknown> {
  return { 'enso-settings': { version: 14, state: { providers } } };
}

describe('synthesizeModelDirectory', () => {
  const now = 1_800_000_000_000;

  it('extraOauthModels 并入对应分区（去重、保持目录顺序、追加在末尾）', () => {
    const snapshot = synthesizeModelDirectory({
      oauthProviders: [
        {
          id: 'xai',
          label: 'xAI',
          models: [{ id: 'grok-4.6', name: 'Grok 4.6' }],
        },
      ],
      customProviders: [],
      extraOauthModels: new Map([
        ['xai', [{ id: 'grok-4.6' }, { id: 'grok-4.7', label: 'Grok 4.7' }]],
        ['other', [{ id: 'ignored' }]],
      ]),
      revision: 1,
      now,
    });
    expect(snapshot.providers[0]?.models).toEqual([
      { id: 'grok-4.6', label: 'Grok 4.6' },
      { id: 'grok-4.7', label: 'Grok 4.7' },
    ]);
    expect(snapshot.providers).toHaveLength(1);
  });

  it('live 为空时 extraOauthModels 也能撑起分区（缓存兜底路径同样合并）', () => {
    const snapshot = synthesizeModelDirectory({
      oauthProviders: [{ id: 'xai', label: 'xAI', models: [] }],
      customProviders: [],
      cached: [
        {
          key: 'xai',
          kind: 'oauth',
          label: 'xAI',
          models: [{ id: 'grok-4.6' }],
          discoveredAt: now - 1000,
        },
      ],
      extraOauthModels: new Map([['xai', [{ id: 'grok-4.8' }]]]),
      revision: 1,
      now,
    });
    expect(snapshot.providers[0]?.models.map((model) => model.id)).toEqual([
      'grok-4.6',
      'grok-4.8',
    ]);
    expect(snapshot.providers[0]?.discoveredAt).toBe(now - 1000);
  });

  it('oauth 分区用入参 label，name 非空且不等于 id 时才写成 label', () => {
    const oauth: DirectoryOAuthSource[] = [
      {
        id: 'google-antigravity',
        label: 'Google Antigravity',
        models: [
          { id: 'gemini-3-pro', name: 'Gemini 3 Pro' },
          { id: 'raw-id', name: 'raw-id' },
          { id: 'blank', name: '' },
        ],
      },
    ];
    const snapshot = synthesizeModelDirectory({
      oauthProviders: oauth,
      customProviders: [],
      revision: 4,
      now,
    });
    expect(snapshot.revision).toBe(4);
    expect(snapshot.generatedAt).toBe(now);
    expect(snapshot.providers[0]).toEqual({
      key: 'google-antigravity',
      kind: 'oauth',
      label: 'Google Antigravity',
      models: [{ id: 'gemini-3-pro', label: 'Gemini 3 Pro' }, { id: 'raw-id' }, { id: 'blank' }],
      discoveredAt: now,
    });
  });

  it('自定义分区用条目 id/name，并跳过带 oauthAccountKey 的行', () => {
    const custom = customProvider([{ id: 'm1', label: '别名' }, { id: 'm2' }]);
    const oauthEntry: ModelProvider = {
      ...custom,
      id: 'oauth-entry',
      oauthAccountKey: 'google-antigravity',
    };
    const snapshot = synthesizeModelDirectory({
      oauthProviders: [],
      customProviders: [custom, oauthEntry],
      revision: 1,
      now,
    });
    expect(snapshot.providers).toEqual([
      {
        key: 'custom-1',
        kind: 'custom',
        label: '我的中转',
        models: [{ id: 'm1', label: '别名' }, { id: 'm2' }],
      },
    ]);
  });

  it('live 为空且缓存有同 key 分区时沿用缓存 models 与 discoveredAt', () => {
    const snapshot = synthesizeModelDirectory({
      oauthProviders: [{ id: 'google-antigravity', label: 'Google Antigravity', models: [] }],
      customProviders: [],
      cached: [cachedOAuth],
      revision: 2,
      now,
    });
    expect(snapshot.providers[0]).toEqual({
      ...cachedOAuth,
      label: 'Google Antigravity',
    });
  });

  it('live 非空仍保留缓存独有 ID，同 ID 使用 live 标签', () => {
    const snapshot = synthesizeModelDirectory({
      oauthProviders: [
        {
          id: 'google-antigravity',
          label: 'Google Antigravity',
          models: [
            { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
            { id: 'shared', name: 'Live label' },
          ],
        },
      ],
      customProviders: [],
      cached: [{ ...cachedOAuth, models: [...cachedOAuth.models, { id: 'shared', label: 'Old' }] }],
      revision: 3,
      now,
    });
    expect(snapshot.providers[0]).toEqual({
      key: 'google-antigravity',
      kind: 'oauth',
      label: 'Google Antigravity',
      models: [
        { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
        { id: 'shared', label: 'Live label' },
        ...cachedOAuth.models,
      ],
      discoveredAt: now,
    });
  });
});

describe('model directory service', () => {
  beforeEach(async () => {
    const previous = await import('./modelDirectory');
    previous.flushModelDirectoryCache();
    vi.resetModules();
    vi.useRealTimers();
    mocks.send.mockClear();
    mocks.getRuntime.mockReset();
    mocks.settings = null;
    rmSync(cachePath, { force: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function runtimeWith(models: { id: string; name?: string }[]): { getProviders: () => unknown[] } {
    return {
      getProviders: () => [
        {
          id: 'google-antigravity',
          name: 'Antigravity',
          auth: { oauth: { name: 'Google Antigravity' } },
          getModels: () => models,
        },
        {
          id: 'google-antigravity#2',
          name: 'clone',
          auth: { oauth: { name: 'clone' } },
          getModels: () => [{ id: 'hidden' }],
        },
        {
          id: 'openai',
          name: 'OpenAI',
          auth: { apiKey: true },
          getModels: () => [{ id: 'gpt-4.1', name: 'GPT' }],
        },
      ],
    };
  }

  it('从 Pi 内置目录把 GPT‑6.2 Sol 和 Astra 加入 Codex 订阅清单', { timeout: 20_000 }, async () => {
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    mocks.getRuntime.mockResolvedValue(
      await ModelRuntime.create({
        authPath: path.join(userData, 'auth.json'),
        modelsPath: null,
        refreshOnCreate: false,
      })
    );

    const mod = await import('./modelDirectory');
    await mod.refreshModelDirectory();
    const codex = mod
      .getModelDirectorySnapshot()
      .providers.find(({ key }) => key === 'openai-codex');

    expect(codex?.models.map(({ id }) => id)).toEqual(
      expect.arrayContaining(['gpt-6.2-sol', 'gpt-6.2-astra'])
    );
  });

  it('refresh 合成 oauth + custom，内容不变不 bump，变化才广播并防抖写 oauth 缓存', async () => {
    mocks.settings = settingsWith([
      customProvider([{ id: 'm1', label: '别名' }]),
      {
        id: 'frozen',
        name: '账号',
        oauthAccountKey: 'google-antigravity',
        models: [{ id: 'stale' }],
      },
    ]);
    mocks.getRuntime.mockResolvedValue(
      runtimeWith([
        { id: 'gemini-3-pro', name: 'Gemini 3 Pro' },
        { id: 'raw-id', name: 'raw-id' },
      ])
    );

    const mod = await import('./modelDirectory');
    await mod.refreshModelDirectory();
    const first = mod.getModelDirectorySnapshot();
    expect(first.revision).toBe(1);
    expect(first.providers.map((provider) => provider.key)).toEqual([
      'google-antigravity',
      'custom-1',
    ]);
    expect(first.providers[0]?.models).toEqual([
      { id: 'gemini-3-pro', label: 'Gemini 3 Pro' },
      { id: 'raw-id' },
    ]);
    expect(first.providers[1]).toMatchObject({ kind: 'custom', label: '我的中转' });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.MODEL_DIRECTORY_CHANGED, first);
    expect(existsSync(cachePath)).toBe(false);

    await mod.refreshModelDirectory();
    expect(mod.getModelDirectorySnapshot().revision).toBe(1);
    expect(mocks.send).toHaveBeenCalledTimes(1);

    mocks.getRuntime.mockResolvedValue(runtimeWith([{ id: 'gemini-3.8-flash', name: 'Flash' }]));
    await mod.refreshModelDirectory();
    const next = mod.getModelDirectorySnapshot();
    expect(next.revision).toBe(2);
    const merged = [
      { id: 'gemini-3.8-flash', label: 'Flash' },
      { id: 'gemini-3-pro', label: 'Gemini 3 Pro' },
      { id: 'raw-id' },
    ];
    expect(next.providers[0]?.models).toEqual(merged);
    expect(mocks.send).toHaveBeenCalledTimes(2);

    await vi.waitFor(() => expect(existsSync(cachePath)).toBe(true));
    const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      providers: DirectoryProvider[];
    };
    expect(cached.providers.map((provider) => provider.kind)).toEqual(['oauth']);
    expect(cached.providers[0]?.models).toEqual(merged);
  });

  it('runtime 失败时用缓存兜底，重载后 get 不打 runtime', async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        providers: [
          cachedOAuth,
          { key: 'custom-1', kind: 'custom', label: '不该读回', models: [] },
        ],
      })
    );
    mocks.settings = settingsWith([customProvider([{ id: 'm1' }])]);
    mocks.getRuntime.mockRejectedValue(new Error('offline'));

    const mod = await import('./modelDirectory');
    await mod.refreshModelDirectory();
    const refreshed = mod.getModelDirectorySnapshot();
    expect(refreshed.providers[0]).toMatchObject({
      key: 'google-antigravity',
      models: cachedOAuth.models,
      discoveredAt: cachedOAuth.discoveredAt,
      label: '旧标签',
    });
    expect(refreshed.providers[1]?.kind).toBe('custom');

    vi.resetModules();
    mocks.getRuntime.mockClear();
    const reloaded = await import('./modelDirectory');
    const offline = reloaded.getModelDirectorySnapshot();
    expect(mocks.getRuntime).not.toHaveBeenCalled();
    expect(offline.providers.map((provider) => provider.key)).toEqual([
      'google-antigravity',
      'custom-1',
    ]);
    expect(offline.providers[0]?.models).toEqual(cachedOAuth.models);
  });

  it('xAI 动态发现落盘后重启，非空静态清单不能抹掉动态 ID', async () => {
    mocks.getRuntime.mockResolvedValue({
      getProviders: () => [
        {
          id: 'xai',
          name: 'xAI',
          auth: { oauth: { name: 'xAI' } },
          getModels: () => [{ id: 'grok-static' }],
        },
      ],
    });
    const first = await import('./modelDirectory');
    await first.refreshModelDirectory();
    first.noteDiscoveredOauthModels('xai', [{ id: 'grok-dynamic', label: 'Dynamic' }]);
    first.flushModelDirectoryCache();
    vi.resetModules();
    const restarted = await import('./modelDirectory');
    await restarted.refreshModelDirectory();
    expect(restarted.getModelDirectorySnapshot().providers[0]?.models).toEqual([
      { id: 'grok-static' },
      { id: 'grok-dynamic', label: 'Dynamic' },
    ]);
    restarted.flushModelDirectoryCache();
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).providers[0].models).toEqual([
      { id: 'grok-static' },
      { id: 'grok-dynamic', label: 'Dynamic' },
    ]);
  });

  it('settings 通知只替换自定义分区，不打 runtime', async () => {
    mocks.getRuntime.mockResolvedValue(runtimeWith([{ id: 'gemini-3-pro', name: 'Gemini 3 Pro' }]));
    mocks.settings = settingsWith([customProvider([{ id: 'm1' }])]);
    const mod = await import('./modelDirectory');
    await mod.refreshModelDirectory();
    mocks.getRuntime.mockClear();
    mocks.send.mockClear();

    mocks.settings = settingsWith([
      { ...customProvider([{ id: 'm2', label: '新' }]), name: '改名' },
    ]);
    mod.notifyModelDirectorySettingsChanged();

    expect(mocks.getRuntime).not.toHaveBeenCalled();
    const next = mod.getModelDirectorySnapshot();
    expect(next.revision).toBe(2);
    expect(next.providers[0]?.models).toEqual([{ id: 'gemini-3-pro', label: 'Gemini 3 Pro' }]);
    expect(next.providers[1]).toMatchObject({
      label: '改名',
      models: [{ id: 'm2', label: '新' }],
    });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('内容变化通知订阅者，订阅者抛错不阻断提交，退订后不再通知', async () => {
    mocks.settings = settingsWith([customProvider([{ id: 'm1' }])]);
    mocks.getRuntime.mockResolvedValue(runtimeWith([{ id: 'gemini-3-pro', name: 'Gemini 3 Pro' }]));
    const mod = await import('./modelDirectory');
    const revisions: number[] = [];
    const stop = mod.onModelDirectoryChanged((next) => {
      revisions.push(next.revision);
    });
    mod.onModelDirectoryChanged(() => {
      throw new Error('listener failed');
    });

    await mod.refreshModelDirectory();
    expect(revisions).toEqual([1]);
    expect(mod.getModelDirectorySnapshot().revision).toBe(1);

    await mod.refreshModelDirectory();
    expect(revisions).toEqual([1]);

    stop();
    mocks.getRuntime.mockResolvedValue(runtimeWith([{ id: 'other', name: 'Other' }]));
    await mod.refreshModelDirectory();
    expect(revisions).toEqual([1]);
    expect(mod.getModelDirectorySnapshot().revision).toBe(2);
  });
});

afterAll(() => {
  rmSync(userData, { recursive: true, force: true });
});
