import { describe, expect, it, vi } from 'vitest';
import type { DeviceStoreDeps } from '../deviceActions';
import type { StoredDevice } from '../deviceList';
import { PAIR_FROM_DESK_URL, PHONE_URL } from '../uiMode';
import { createDeskDevices, type DeskDevicesDeps, toggleDeskPush } from './devices';

const device = (pairId: string, scope?: 'read' | 'operate') =>
  ({
    pairId,
    label: pairId,
    token: 't',
    relayUrl: 'https://relay',
    contentKey: 'k',
    scope,
  }) as StoredDevice;

function setup(list: StoredDevice[], currentId = 'a') {
  let devices = list;
  const order: string[] = [];
  const store: DeviceStoreDeps = {
    saveDevices: (next) => {
      devices = next;
    },
    saveActiveDeviceId: vi.fn(),
    clearDeviceData: (id) => order.push(`clear:${id}`),
    revoke: async () => {},
  };
  const deps = {
    currentId,
    load: () => devices,
    store,
    navigate: vi.fn(),
    saveUiMode: vi.fn(),
    onCurrentLabel: vi.fn(),
    stopCurrent: vi.fn(() => order.push('stop')),
    forgetDesk: vi.fn(),
    revokeWaitMs: 10,
  } satisfies DeskDevicesDeps;
  return { deps, store, order, devices: () => devices, api: createDeskDevices(deps) };
}

describe('createDeskDevices', () => {
  it('切换电脑：记下当前这台，带新的 ?device= 整页重载', () => {
    const { api, deps, store } = setup([device('a'), device('b/c')]);
    api.switchTo('b/c');
    expect(store.saveActiveDeviceId).toHaveBeenCalledWith('b/c');
    expect(deps.navigate).toHaveBeenCalledWith('/desk?device=b%2Fc');
  });

  it('点当前这台或已不存在的不动；只读的落到精简版', () => {
    const { api, deps } = setup([device('a'), device('r', 'read')]);
    api.switchTo('a');
    api.switchTo('gone');
    expect(deps.navigate).not.toHaveBeenCalled();
    api.switchTo('r');
    expect(deps.navigate).toHaveBeenCalledWith(PHONE_URL);
  });

  it('重命名落盘；改的是当前这台时更新链路里的名字', () => {
    const { api, deps, devices } = setup([device('a'), device('b')]);
    api.rename('b', ' 公司 ');
    expect(devices().find((d) => d.pairId === 'b')?.label).toBe('公司');
    expect(deps.onCurrentLabel).not.toHaveBeenCalled();
    api.rename('a', '家里');
    expect(deps.onCurrentLabel).toHaveBeenCalledWith('家里');
    api.rename('a', '  ');
    expect(deps.onCurrentLabel).toHaveBeenCalledTimes(1);
  });

  it('取消当前这台：先停链再清数据，切到下一台', async () => {
    const { api, deps, order, devices } = setup([device('a'), device('b')]);
    await api.unpair('a');
    expect(order).toEqual(['stop', 'clear:a']);
    expect(deps.forgetDesk).toHaveBeenCalledWith('a');
    expect(devices().map((d) => d.pairId)).toEqual(['b']);
    expect(deps.navigate).toHaveBeenCalledWith('/desk?device=b');
    expect(deps.saveUiMode).not.toHaveBeenCalled();
  });

  it('取消最后一台：回精简版', async () => {
    const { api, deps } = setup([device('a')]);
    await api.unpair('a');
    expect(deps.saveUiMode).toHaveBeenCalledWith('phone');
    expect(deps.navigate).toHaveBeenCalledWith(PHONE_URL);
  });

  it('取消别的电脑：留在本页', async () => {
    const { api, deps, devices } = setup([device('a'), device('b')]);
    await api.unpair('b');
    expect(deps.stopCurrent).not.toHaveBeenCalled();
    expect(deps.navigate).not.toHaveBeenCalled();
    expect(devices().map((d) => d.pairId)).toEqual(['a']);
  });

  it('中继迟迟不回也会离开', async () => {
    const { api, deps, store } = setup([device('a'), device('b')]);
    store.revoke = () => new Promise(() => {});
    await api.unpair('a');
    expect(deps.navigate).toHaveBeenCalledWith('/desk?device=b');
  });

  it('配对新电脑去精简版配对页', () => {
    const { api, deps } = setup([device('a')]);
    api.pairNew();
    expect(deps.navigate).toHaveBeenCalledWith(PAIR_FROM_DESK_URL);
  });
});

describe('toggleDeskPush', () => {
  const pushDeps = (enabled: boolean, ok: boolean) => ({
    enabled: () => enabled,
    vapidPublicKey: () => 'vapid',
    setPending: vi.fn(),
    turnOn: vi.fn(async () =>
      ok
        ? {
            ok: true as const,
            subscription: { endpoint: 'e', keys: { p256dh: 'p', auth: 'a' } },
          }
        : { ok: false as const, reason: 'service-unreachable' as const }
    ),
    turnOff: vi.fn(),
  });

  it('开着就关', async () => {
    const deps = pushDeps(true, true);
    await toggleDeskPush(deps);
    expect(deps.turnOff).toHaveBeenCalled();
    expect(deps.turnOn).not.toHaveBeenCalled();
  });

  it('开启：先显示正在开启，成功后落定', async () => {
    const deps = pushDeps(false, true);
    await toggleDeskPush(deps);
    expect(deps.turnOn).toHaveBeenCalledWith('vapid');
    expect(deps.setPending.mock.calls).toEqual([
      [{ busy: true, enabled: true, error: null }],
      [{ busy: false, enabled: true, error: null }],
    ]);
  });

  it('开启失败：开关回落并带原因', async () => {
    const deps = pushDeps(false, false);
    await toggleDeskPush(deps);
    expect(deps.setPending).toHaveBeenLastCalledWith({
      busy: false,
      enabled: false,
      error: 'service-unreachable',
    });
  });

  it('还没拿到桌面公钥时不动', async () => {
    const deps = { ...pushDeps(false, true), vapidPublicKey: () => null };
    await toggleDeskPush(deps);
    expect(deps.turnOn).not.toHaveBeenCalled();
    expect(deps.setPending).not.toHaveBeenCalled();
  });
});
