import type { OauthCredentialAvailability } from '@shared/defaultModel';
import type { ModelProvider } from '@shared/types';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useOauthCredentialStore } from '@/stores/oauthCredentials';
import type * as SettingsModule from './index';

const writeKey = vi.fn(async () => undefined);
const readSettings = vi.fn(async (): Promise<Record<string, unknown> | null> => null);

vi.stubGlobal('navigator', { language: 'en-US' });
vi.stubGlobal('document', {
  documentElement: {
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
let settingsModule: typeof SettingsModule;

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

describe('settings default model actions', () => {
  beforeAll(async () => {
    // settings/index reads browser globals at module load; import only after this test installs them.
    settingsModule = await import('./index');
  });
  beforeEach(() => {
    useOauthCredentialStore.setState({
      snapshot: { revision: 0, availability: { status: 'unloaded' } },
    });
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
        notice: null,
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
      expect(result).toMatchObject({ status: 'deferred', writeback: false, notice: null });
      expect(settingsModule.useSettingsStore.getState().defaultModel).toEqual({
        providerId: oauth.id,
        modelId: 'model',
      });
    }
  });

  it('ready logout falls back in provider order and publishes previous to next notice', () => {
    const oauth = provider('oauth', { apiKey: '', oauthAccountKey: 'anthropic' });
    const fallback = provider('fallback');
    const snapshot = setSnapshot(2, {
      status: 'ready',
      authenticatedAccountKeys: new Set(),
    });
    settingsModule.useSettingsStore.setState({
      providers: [oauth, fallback],
      defaultModel: { providerId: oauth.id, modelId: 'model' },
    });

    const result = settingsModule.useSettingsStore.getState().revalidateDefaultModel(snapshot);
    expect(result).toEqual({
      status: 'sanitized',
      defaultModel: { providerId: fallback.id, modelId: 'model' },
      writeback: true,
      notice: {
        previous: { providerId: oauth.id, modelId: 'model' },
        next: { providerId: fallback.id, modelId: 'model' },
      },
    });
    expect(settingsModule.useSettingsStore.getState().defaultModel).toEqual(result.defaultModel);
    expect(settingsModule.useDefaultModelRevalidationStore.getState().latest).toEqual(result);
  });

  it('ready with no candidate clears the default', () => {
    const oauth = provider('oauth', { apiKey: '', oauthAccountKey: 'anthropic' });
    const snapshot = setSnapshot(1, {
      status: 'ready',
      authenticatedAccountKeys: new Set(),
    });
    settingsModule.useSettingsStore.setState({
      providers: [oauth],
      defaultModel: { providerId: oauth.id, modelId: 'model' },
    });

    expect(
      settingsModule.useSettingsStore.getState().revalidateDefaultModel(snapshot)
    ).toMatchObject({ status: 'sanitized', defaultModel: null, writeback: true });
    expect(settingsModule.useSettingsStore.getState().defaultModel).toBeNull();
  });

  it('revalidates a hydrated default when OAuth bootstrap became ready first', async () => {
    const oauth = provider('oauth', { apiKey: '', oauthAccountKey: 'anthropic' });
    const fallback = provider('fallback');
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
      providerId: fallback.id,
      modelId: 'model',
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
      notice: null,
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

  it('provider removal automatically revalidates with the current ready snapshot', () => {
    const removed = provider('removed');
    const fallback = provider('fallback');
    setSnapshot(1, { status: 'ready', authenticatedAccountKeys: new Set() });
    settingsModule.useSettingsStore.setState({
      providers: [removed, fallback],
      defaultModel: { providerId: removed.id, modelId: 'model' },
    });

    settingsModule.useSettingsStore.getState().removeProvider(removed.id);
    expect(settingsModule.useSettingsStore.getState().defaultModel).toEqual({
      providerId: fallback.id,
      modelId: 'model',
    });
  });
});
