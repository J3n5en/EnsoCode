import { beforeEach, describe, expect, it, vi } from 'vitest';

const writeKey = vi.fn(async () => undefined);
let readSettings: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;

vi.stubGlobal('window', {
  electronAPI: {
    settings: {
      read: (...args: unknown[]) => readSettings(...args),
      writeKey,
    },
  },
});

const { electronStorage } = await import('./storage');

describe('electronStorage hydration write gate', () => {
  beforeEach(() => {
    writeKey.mockClear();
    readSettings = vi.fn<(...args: unknown[]) => Promise<unknown>>();
  });

  it('水合完成前的 setItem 不得把空默认值写回 settings.json', async () => {
    // 设置窗新进程会先以 initialState 跑起来；source-authority 投影等 setState
    // 会触发 persist 落盘。若赶在 settings:read 返回前写入，会整包覆盖真实配置。
    let resolveRead: (value: Record<string, unknown>) => void = () => {};
    readSettings.mockImplementation(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          resolveRead = resolve;
        })
    );

    const hydration = electronStorage.getItem('enso-settings-wipe');
    await electronStorage.setItem(
      'enso-settings-wipe',
      JSON.stringify({ state: { providers: [], onboarded: false }, version: 2 })
    );

    expect(writeKey).not.toHaveBeenCalled();

    resolveRead({
      'enso-settings-wipe': { state: { providers: [{ id: 'kept' }], onboarded: true }, version: 2 },
    });
    await hydration;
  });

  it('水合完成后再写入会走 writeKey', async () => {
    readSettings.mockResolvedValue({
      'enso-settings-after': { state: { theme: 'dark' }, version: 2 },
    });
    await electronStorage.getItem('enso-settings-after');

    await electronStorage.setItem(
      'enso-settings-after',
      JSON.stringify({ state: { theme: 'light' }, version: 2 })
    );

    expect(writeKey).toHaveBeenCalledWith('enso-settings-after', {
      state: { theme: 'light' },
      version: 2,
    });
  });

  it('读到空文件也视为已水合，允许首次落盘', async () => {
    readSettings.mockResolvedValue(null);
    await electronStorage.getItem('enso-settings-fresh');

    await electronStorage.setItem(
      'enso-settings-fresh',
      JSON.stringify({ state: { onboarded: false }, version: 2 })
    );

    expect(writeKey).toHaveBeenCalledTimes(1);
  });

  it('不同 store 的水合闸门互不影响', async () => {
    readSettings.mockResolvedValue({
      'enso-conversations-ready': { state: { order: [] }, version: 1 },
    });
    await electronStorage.getItem('enso-conversations-ready');

    let resolveSettings: (value: null) => void = () => {};
    readSettings.mockImplementation(
      () =>
        new Promise<null>((resolve) => {
          resolveSettings = resolve;
        })
    );
    const settingsHydration = electronStorage.getItem('enso-settings-slow');

    await electronStorage.setItem(
      'enso-conversations-ready',
      JSON.stringify({ state: { order: ['a'] }, version: 1 })
    );
    await electronStorage.setItem(
      'enso-settings-slow',
      JSON.stringify({ state: { providers: [] }, version: 2 })
    );

    expect(writeKey).toHaveBeenCalledTimes(1);
    expect(writeKey).toHaveBeenCalledWith('enso-conversations-ready', {
      state: { order: ['a'] },
      version: 1,
    });

    resolveSettings(null);
    await settingsHydration;
  });

  it('水合完成前的 removeItem 同样不得动磁盘', async () => {
    readSettings.mockImplementation(() => new Promise(() => {}));
    void electronStorage.getItem('enso-settings-remove');

    await electronStorage.removeItem('enso-settings-remove');

    expect(writeKey).not.toHaveBeenCalled();
  });

  it('getItem 失败时不得开闸，避免空默认值落盘', async () => {
    readSettings.mockRejectedValue(new Error('ipc down'));
    await expect(electronStorage.getItem('enso-settings-fail')).rejects.toThrow('ipc down');

    await electronStorage.setItem(
      'enso-settings-fail',
      JSON.stringify({ state: { providers: [] }, version: 2 })
    );

    expect(writeKey).not.toHaveBeenCalled();
  });
});
