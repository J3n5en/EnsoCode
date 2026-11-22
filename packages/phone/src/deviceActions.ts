import { revokePairing } from '@enso/pair';
import { pickActive, removeDevice, renameDevice, type StoredDevice } from './deviceList';
import { clearDeviceData, saveActiveDeviceId, saveDevices } from './storage';

/** 精简版与完整版壳共用的配对管理：落盘与清理都在这里，界面只管状态 */

export interface DeviceStoreDeps {
  saveDevices(devices: StoredDevice[]): void;
  saveActiveDeviceId(pairId: string | null): void;
  clearDeviceData(pairId: string): void;
  revoke(device: StoredDevice): Promise<void>;
}

export const deviceStore: DeviceStoreDeps = {
  saveDevices,
  saveActiveDeviceId,
  clearDeviceData,
  revoke: (device) => revokePairing(device.relayUrl, device.pairId, device.token),
};

export interface UnpairOutcome {
  devices: StoredDevice[];
  /** 取消的是当前这台时回落到的下一台（没有了为 null）；不是当前这台时不给 */
  fallback?: StoredDevice | null;
  /** 中继上的配对清理，失败也算完成 */
  revoked: Promise<void>;
}

/** 调用方若持有该台的连接，须先停掉再调用：别让缓存在清理后又被写回 */
export function unpairStoredDevice(
  devices: readonly StoredDevice[],
  pairId: string,
  activeId: string | null,
  deps: DeviceStoreDeps = deviceStore
): UnpairOutcome {
  const target = devices.find((d) => d.pairId === pairId);
  // 手机侧持 deviceToken，可一并清掉中继房间（桌面重连即被拒）；已被对端解绑时失败无妨
  const revoked = target ? deps.revoke(target).catch(() => {}) : Promise.resolve();
  deps.clearDeviceData(pairId);
  const next = removeDevice(devices, pairId);
  deps.saveDevices(next);
  if (pairId !== activeId) return { devices: next, revoked };
  const fallback = pickActive(next, null);
  deps.saveActiveDeviceId(fallback?.pairId ?? null);
  return { devices: next, fallback, revoked };
}

export function renameStoredDevice(
  devices: readonly StoredDevice[],
  pairId: string,
  label: string,
  save: (devices: StoredDevice[]) => void = saveDevices
): StoredDevice[] {
  const next = renameDevice(devices, pairId, label);
  save(next);
  return next;
}
