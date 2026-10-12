import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_VERSION } from './migrate';

let persisted: Record<string, unknown> | null = null;
const writeKey = vi.fn(async (name: string, value: unknown) => {
  persisted = { ...persisted, [name]: value };
  return true;
});

beforeEach(() => {
  vi.resetModules();
  persisted = null;
  writeKey.mockClear();
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
        read: async () => persisted,
        writeKey,
        onChanged: vi.fn(),
      },
      sourceAuthority: {
        read: async () => ({ projects: [], conversations: [] }),
        onChanged: vi.fn(),
      },
      instructions: { delete: vi.fn(async () => ({ ok: true })) },
    },
  });
});

async function loadStore(state: Record<string, unknown> = {}) {
  persisted = { 'enso-settings': { version: SETTINGS_VERSION, state } };
  const { useSettingsStore } = await import('./index');
  await vi.waitFor(() => expect(useSettingsStore.persist.hasHydrated()).toBe(true));
  return useSettingsStore;
}

describe('Bot 讨论模式开关（实验性）', () => {
  it('旧配置缺少字段时默认关闭', async () => {
    const store = await loadStore();
    expect(store.getState().botDiscussModeEnabled).toBe(false);
  });

  it('开启后沿现有设置通道保存并可恢复', async () => {
    const store = await loadStore();
    store.getState().setBotDiscussModeEnabled(true);
    expect(store.getState().botDiscussModeEnabled).toBe(true);
    expect(persisted).toMatchObject({
      'enso-settings': { state: { botDiscussModeEnabled: true } },
    });
    const saved = persisted;
    store.setState({ botDiscussModeEnabled: false });
    persisted = saved;
    await store.persist.rehydrate();
    expect(store.getState().botDiscussModeEnabled).toBe(true);
  });

  it.each([[null], ['true'], [1], [{}], [[]]])('磁盘非布尔值 %j 归一为关闭', async (value) => {
    const store = await loadStore({ botDiscussModeEnabled: value });
    expect(store.getState().botDiscussModeEnabled).toBe(false);
  });
});
