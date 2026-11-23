import { describe, expect, it, vi } from 'vitest';

const writeKey = vi.hoisted(() => vi.fn(async (_name: string, _value: unknown) => true));

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
      read: vi.fn(async () => ({
        'enso-settings': {
          version: 18,
          state: {
            pinnedModels: ['a/x'],
            recentModels: [{ providerId: 'a', modelId: 'x' }, 'junk', { providerId: 'b' }],
          },
        },
      })),
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

const settings = await import('./index');
await vi.waitFor(() => expect(settings.useSettingsStore.persist.hasHydrated()).toBe(true));

function lastPersistedState(): Record<string, unknown> {
  const call = writeKey.mock.calls.filter(([name]) => name === 'enso-settings').at(-1);
  expect(call).toBeDefined();
  return ((call as [string, unknown])[1] as { state: Record<string, unknown> }).state;
}

describe('最近使用模型设置', () => {
  it('读入磁盘时丢弃脏条目', () => {
    expect(settings.useSettingsStore.getState().recentModels).toEqual([
      { providerId: 'a', modelId: 'x' },
    ]);
  });

  it('记录后排最前并落盘', () => {
    const store = settings.useSettingsStore;
    store.getState().recordRecentModel({ providerId: 'b', modelId: 'y' });
    expect(store.getState().recentModels).toEqual([
      { providerId: 'b', modelId: 'y' },
      { providerId: 'a', modelId: 'x' },
    ]);
    expect(lastPersistedState().recentModels).toEqual(store.getState().recentModels);
  });

  it('移除立即生效并持久化，不影响星标', () => {
    const store = settings.useSettingsStore;
    store.getState().removeRecentModel({ providerId: 'a', modelId: 'x' });
    expect(store.getState().recentModels).toEqual([{ providerId: 'b', modelId: 'y' }]);
    expect(store.getState().pinnedModels).toEqual(['a/x']);
    const persisted = lastPersistedState();
    expect(persisted.recentModels).toEqual([{ providerId: 'b', modelId: 'y' }]);
    expect(persisted.pinnedModels).toEqual(['a/x']);
  });
});
