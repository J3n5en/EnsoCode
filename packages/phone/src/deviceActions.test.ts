import { describe, expect, it, vi } from 'vitest';
import { type DeviceStoreDeps, renameStoredDevice, unpairStoredDevice } from './deviceActions';
import type { StoredDevice } from './deviceList';

const device = (pairId: string, label = pairId) =>
  ({
    pairId,
    label,
    token: `t-${pairId}`,
    relayUrl: 'https://relay',
    contentKey: 'k',
  }) as StoredDevice;

function fakeStore() {
  const calls: string[] = [];
  const deps: DeviceStoreDeps = {
    saveDevices: vi.fn((list: StoredDevice[]) => {
      calls.push(`save:${list.map((d) => d.pairId).join(',')}`);
    }),
    saveActiveDeviceId: vi.fn((id: string | null) => {
      calls.push(`active:${id}`);
    }),
    clearDeviceData: vi.fn((id: string) => {
      calls.push(`clear:${id}`);
    }),
    revoke: vi.fn(async (d: StoredDevice) => {
      calls.push(`revoke:${d.pairId}:${d.token}`);
    }),
  };
  return { deps, calls };
}

describe('unpairStoredDevice', () => {
  it('取消当前这台：清中继与本地数据，回落到下一台', async () => {
    const { deps, calls } = fakeStore();
    const out = unpairStoredDevice([device('a'), device('b')], 'a', 'a', deps);
    await out.revoked;
    expect(out.devices.map((d) => d.pairId)).toEqual(['b']);
    expect(out.fallback?.pairId).toBe('b');
    expect(calls).toEqual(['revoke:a:t-a', 'clear:a', 'save:b', 'active:b']);
  });

  it('取消最后一台：没有可回落的', () => {
    const { deps, calls } = fakeStore();
    const out = unpairStoredDevice([device('a')], 'a', 'a', deps);
    expect(out.fallback).toBeNull();
    expect(calls.at(-1)).toBe('active:null');
  });

  it('取消别的电脑：当前这台不变', () => {
    const { deps } = fakeStore();
    const out = unpairStoredDevice([device('a'), device('b')], 'b', 'a', deps);
    expect(out.fallback).toBeUndefined();
    expect(deps.saveActiveDeviceId).not.toHaveBeenCalled();
  });

  it('中继解绑失败不影响本地删除', async () => {
    const { deps } = fakeStore();
    deps.revoke = () => Promise.reject(new Error('offline'));
    const out = unpairStoredDevice([device('a')], 'a', 'a', deps);
    await expect(out.revoked).resolves.toBeUndefined();
    expect(out.devices).toEqual([]);
  });
});

describe('renameStoredDevice', () => {
  it('改名并落盘，空名不改', () => {
    const save = vi.fn();
    const next = renameStoredDevice([device('a', '电脑 1')], 'a', '  家里 Mac ', save);
    expect(next[0].label).toBe('家里 Mac');
    expect(save).toHaveBeenCalledWith(next);
    expect(renameStoredDevice(next, 'a', '   ', save)[0].label).toBe('家里 Mac');
  });
});
