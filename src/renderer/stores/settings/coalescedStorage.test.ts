import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as storageModule from './storage';

const writeKey = vi.fn<(name: string, value: unknown) => Promise<boolean>>();
const read = vi.fn<() => Promise<unknown>>();
vi.stubGlobal('window', { electronAPI: { settings: { read, writeKey } } });

const storage = storageModule.createElectronPersistStorage<{ revision: number }>();
const value = (revision: number) => ({ state: { revision }, version: 1 });
const deferred = () => {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('对象级会话持久化', () => {
  beforeEach(() => {
    writeKey.mockReset();
    read.mockReset();
  });

  it('流式突发只发送首值和最新值，同键最多一个在途写入', async () => {
    storageModule.openPersistWriteGate('burst');
    const first = deferred();
    writeKey.mockReturnValueOnce(first.promise).mockResolvedValue(true);
    const drained = storage.setItem('burst', value(0));
    for (let revision = 1; revision <= 600; revision++) {
      storage.setItem('burst', value(revision));
    }
    expect(writeKey).toHaveBeenCalledTimes(1);
    first.resolve(true);
    await drained;
    expect(writeKey).toHaveBeenCalledTimes(2);
    expect(writeKey).toHaveBeenLastCalledWith('burst', value(600));
  });

  it('主进程拒绝写入可观察，并继续保存最新值及后续批次', async () => {
    storageModule.openPersistWriteGate('failure');
    const first = deferred();
    writeKey.mockReturnValueOnce(first.promise).mockResolvedValue(true);
    const drained = storage.setItem('failure', value(1));
    storage.setItem('failure', value(2));
    first.resolve(false);
    await expect(drained).rejects.toThrow('failure');
    expect(writeKey).toHaveBeenLastCalledWith('failure', value(2));
    await storage.setItem('failure', value(3));
    expect(writeKey).toHaveBeenLastCalledWith('failure', value(3));
  });

  it('读取等待该键最新状态写完，不能水合回在途更新之前的旧值', async () => {
    storageModule.openPersistWriteGate('read-after-write');
    const first = deferred();
    writeKey.mockReturnValueOnce(first.promise).mockResolvedValue(true);
    read.mockResolvedValue({ 'read-after-write': value(2) });
    storage.setItem('read-after-write', value(1));
    storage.setItem('read-after-write', value(2));
    const reading = storage.getItem('read-after-write');
    expect(read).not.toHaveBeenCalled();
    first.resolve(true);
    await expect(reading).resolves.toEqual(value(2));
  });

  it('同批次共享完成结果，删除覆盖待写更新，删除之后可以重新写入', async () => {
    storageModule.openPersistWriteGate('delete');
    const first = deferred();
    writeKey.mockReturnValueOnce(first.promise).mockResolvedValue(true);
    const drained = storage.setItem('delete', value(1));
    expect(storage.setItem('delete', value(2))).toBe(drained);
    expect(storage.removeItem('delete')).toBe(drained);
    first.resolve(true);
    await drained;
    expect(writeKey).toHaveBeenCalledTimes(2);
    expect(writeKey).toHaveBeenLastCalledWith('delete', undefined);
    await storage.setItem('delete', value(3));
    expect(writeKey).toHaveBeenLastCalledWith('delete', value(3));
  });

  it('待写删除之后的新状态覆盖删除，各个键独立推进', async () => {
    storageModule.openPersistWriteGate('replace-delete');
    storageModule.openPersistWriteGate('independent');
    const first = deferred();
    writeKey.mockReturnValueOnce(first.promise).mockResolvedValue(true);
    const drained = storage.setItem('replace-delete', value(1));
    storage.removeItem('replace-delete');
    storage.setItem('replace-delete', value(3));
    await storage.setItem('independent', value(9));
    expect(writeKey).toHaveBeenLastCalledWith('independent', value(9));
    first.resolve(true);
    await drained;
    expect(writeKey.mock.calls).toEqual([
      ['replace-delete', value(1)],
      ['independent', value(9)],
      ['replace-delete', value(3)],
    ]);
  });

  it('读回不提前开闸，水合前写入丢弃且不会在开闸后补写', async () => {
    read.mockResolvedValue({ gated: value(7) });
    expect(await storage.getItem('gated')).toEqual(value(7));
    const generation = storageModule.getWriteGeneration();
    await storage.setItem('gated', value(0));
    await storage.removeItem('gated');
    expect(storageModule.getWriteGeneration()).toBe(generation);
    storageModule.openPersistWriteGate('gated');
    expect(writeKey).not.toHaveBeenCalled();
    writeKey.mockResolvedValue(true);
    await storage.setItem('gated', value(8));
    expect(writeKey).toHaveBeenCalledExactlyOnceWith('gated', value(8));
  });

  it('合并中的每次本地更新都计入同步代数，其他键的闸门仍关闭', async () => {
    storageModule.openPersistWriteGate('generation');
    const first = deferred();
    writeKey.mockReturnValueOnce(first.promise).mockResolvedValue(true);
    const generation = storageModule.getWriteGeneration();
    const drained = storage.setItem('generation', value(1));
    storage.setItem('generation', value(2));
    storage.removeItem('generation');
    storage.setItem('still-closed', value(5));
    expect(storageModule.getWriteGeneration()).toBe(generation + 3);
    first.resolve(true);
    await drained;
  });

  it('IPC 拒绝与同步抛错均不会锁住队列，后续写入仍然成功', async () => {
    storageModule.openPersistWriteGate('ipc-error');
    writeKey.mockRejectedValueOnce(new Error('ipc down')).mockResolvedValue(true);
    await expect(storage.setItem('ipc-error', value(1))).rejects.toThrow('ipc down');
    writeKey.mockImplementationOnce(() => {
      throw new Error('bridge down');
    });
    await expect(storage.setItem('ipc-error', value(2))).rejects.toThrow('bridge down');
    await storage.setItem('ipc-error', value(3));
    expect(writeKey).toHaveBeenLastCalledWith('ipc-error', value(3));
  });
});
