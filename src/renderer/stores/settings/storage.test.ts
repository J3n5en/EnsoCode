import { beforeEach, describe, expect, it, vi } from 'vitest';

const writeKey = vi.fn(async () => true);
let readSettings: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;

vi.stubGlobal('window', {
  electronAPI: {
    settings: {
      read: (...args: unknown[]) => readSettings(...args),
      writeKey,
    },
  },
});

const { createElectronPersistStorage, electronStorage, openPersistWriteGate } = await import(
  './storage'
);

const payload = (state: Record<string, unknown>) => JSON.stringify({ state, version: 2 });

describe('electronStorage hydration write gate', () => {
  beforeEach(() => {
    writeKey.mockClear();
    readSettings = vi.fn<(...args: unknown[]) => Promise<unknown>>();
  });

  it('getItem 返回不等于开闸：merge 前的 setItem / removeItem 一律丢弃', async () => {
    // 设置窗新进程先以 initialState 跑起来；从 read 回包到 persist merge 之间还有几个
    // microtask，此时的 setState 若落盘就会整包覆盖真实配置。开闸只能由 store 在 merge 后显式调用。
    readSettings.mockResolvedValue({
      'enso-settings-wipe': { state: { providers: [{ id: 'kept' }] }, version: 2 },
    });
    await electronStorage.getItem('enso-settings-wipe');

    await electronStorage.setItem('enso-settings-wipe', payload({ providers: [] }));
    await electronStorage.removeItem('enso-settings-wipe');

    expect(writeKey).not.toHaveBeenCalled();
  });

  it('开闸后 setItem / removeItem 走 writeKey', async () => {
    openPersistWriteGate('enso-settings-after');

    await electronStorage.setItem('enso-settings-after', payload({ theme: 'light' }));
    await electronStorage.removeItem('enso-settings-after');

    expect(writeKey).toHaveBeenNthCalledWith(1, 'enso-settings-after', {
      state: { theme: 'light' },
      version: 2,
    });
    expect(writeKey).toHaveBeenNthCalledWith(2, 'enso-settings-after', undefined);
  });

  it('不同 store 的闸门互不影响', async () => {
    openPersistWriteGate('enso-conversations-ready');

    await electronStorage.setItem('enso-conversations-ready', payload({ order: ['a'] }));
    await electronStorage.setItem('enso-settings-slow', payload({ providers: [] }));

    expect(writeKey).toHaveBeenCalledTimes(1);
    expect(writeKey).toHaveBeenCalledWith('enso-conversations-ready', {
      state: { order: ['a'] },
      version: 2,
    });
  });

  it('getItem 失败会向上抛，不会顺手开闸', async () => {
    readSettings.mockRejectedValue(new Error('ipc down'));
    await expect(electronStorage.getItem('enso-settings-fail')).rejects.toThrow('ipc down');

    await electronStorage.setItem('enso-settings-fail', payload({ providers: [] }));

    expect(writeKey).not.toHaveBeenCalled();
  });
});

describe('createElectronPersistStorage 确认号', () => {
  const deferred = () => {
    let resolve!: (value: boolean) => void;
    const promise = new Promise<boolean>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const value = (revision: number) => ({ state: { revision }, version: 1 });

  beforeEach(() => {
    writeKey.mockReset();
    writeKey.mockResolvedValue(true);
  });

  it('确认号在入队时绑定，合并待写值时取最后一次', async () => {
    let ackSeq = 3;
    const storage = createElectronPersistStorage<{ revision: number }>({ ackSeq: () => ackSeq });
    openPersistWriteGate('ack-bound');
    const first = deferred();
    writeKey.mockReturnValueOnce(first.promise);

    const drained = storage.setItem('ack-bound', value(1));
    ackSeq = 4;
    storage.setItem('ack-bound', value(2));
    expect(writeKey).toHaveBeenCalledWith('ack-bound', value(1), 3);

    first.resolve(true);
    await drained;
    expect(writeKey).toHaveBeenLastCalledWith('ack-bound', value(2), 4);
  });

  it('未配置确认号的 store 保持两参数 IPC', async () => {
    const storage = createElectronPersistStorage<{ revision: number }>();
    openPersistWriteGate('ack-none');

    await storage.setItem('ack-none', value(1));

    expect(writeKey).toHaveBeenCalledWith('ack-none', value(1));
  });
});
