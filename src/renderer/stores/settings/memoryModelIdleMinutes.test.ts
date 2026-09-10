import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_VERSION } from './migrate';

let persisted: Record<string, unknown> | null = null;
let onChanged: (() => void) | undefined;
const writeKey = vi.fn(async (name: string, value: unknown) => {
  persisted = { ...persisted, [name]: value };
  return true;
});

beforeEach(() => {
  vi.resetModules();
  persisted = null;
  onChanged = undefined;
  writeKey.mockClear();
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
        read: async () => persisted,
        writeKey,
        onChanged: (listener: () => void) => {
          onChanged = listener;
        },
      },
      sourceAuthority: {
        read: async () => ({ projects: [], conversations: [] }),
        onChanged: vi.fn(),
      },
    },
  });
});

async function loadStore(state: Record<string, unknown> = {}) {
  persisted = { 'enso-settings': { version: SETTINGS_VERSION, state } };
  const { useSettingsStore } = await import('./index');
  await vi.waitFor(() => expect(useSettingsStore.persist.hasHydrated()).toBe(true));
  return useSettingsStore;
}

describe('记忆模型空闲卸载设置', () => {
  it('旧配置缺少字段时默认 10 分钟', async () => {
    const store = await loadStore();
    expect(store.getState().memoryModelIdleMinutes).toBe(10);
  });

  it.each([5, 10, 30, 0])('选择 %i 分钟沿现有设置通道保存并恢复', async (minutes) => {
    const store = await loadStore();
    expect(store.getState().setMemoryModelIdleMinutes).toBeTypeOf('function');
    store.getState().setMemoryModelIdleMinutes(minutes);
    expect(store.getState().memoryModelIdleMinutes).toBe(minutes);
    expect(persisted).toMatchObject({
      'enso-settings': { state: { memoryModelIdleMinutes: minutes } },
    });
    const saved = persisted;
    store.setState({ memoryModelIdleMinutes: 99 });
    persisted = saved;
    await store.persist.rehydrate();
    expect(store.getState().memoryModelIdleMinutes).toBe(minutes);
  });

  it.each([null, -1, 1.5, '30', 99])('磁盘非法值 %j 回退默认值', async (value) => {
    const store = await loadStore({ memoryModelIdleMinutes: value });
    expect(store.getState().memoryModelIdleMinutes).toBe(10);
  });

  it('其他窗口关闭卸载后同步为 0，且不回写形成同步循环', async () => {
    const store = await loadStore();
    writeKey.mockClear();
    persisted = {
      'enso-settings': { version: SETTINGS_VERSION, state: { memoryModelIdleMinutes: 0 } },
    };
    onChanged?.();
    await vi.waitFor(() => expect(store.getState().memoryModelIdleMinutes).toBe(0));
    expect(writeKey).not.toHaveBeenCalled();
  });
});
