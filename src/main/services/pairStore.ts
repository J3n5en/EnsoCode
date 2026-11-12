import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  type PairedDevice,
  parseRelayHostCache,
  type RelayHostAddress,
  serializeRelayHostCache,
} from '@enso/pair';
import { app } from '@platform';
import { SecureJsonFile } from './secureFile';

/**
 * 已配对设备凭据落盘。contentKey 是端到端密钥，必须加密存储：
 * safeStorage 不可用（部分 Linux 无 keyring）时不静默明文落盘，由 UI 提示用户。
 */

const devices = new SecureJsonFile<PairedDevice[]>(
  () => path.join(app.getPath('userData'), 'phone-pairing.bin'),
  () => [],
  (raw) => (Array.isArray(raw) ? (raw as PairedDevice[]) : [])
);

export function devicesReady(): Promise<void> {
  return devices.ready();
}

export function isSecureStorageAvailable(): boolean {
  return devices.isSecure();
}

/** 新增或按 pairId 更新凭据；更新时保留自定义名与列表位置 */
export function upsertDevice(list: readonly PairedDevice[], device: PairedDevice): PairedDevice[] {
  const existing = list.find((d) => d.pairId === device.pairId);
  if (existing) {
    return list.map((d) =>
      d.pairId === device.pairId
        ? { ...device, deviceName: d.deviceName, ...(d.scope ? { scope: d.scope } : {}) }
        : d
    );
  }
  return [...list, device];
}

export function renameDevice(
  list: readonly PairedDevice[],
  pairId: string,
  deviceName: string
): PairedDevice[] {
  const trimmed = deviceName.trim();
  if (!trimmed) return [...list];
  return list.map((d) => (d.pairId === pairId ? { ...d, deviceName: trimmed } : d));
}

export function loadDevices(): PairedDevice[] {
  return devices.get();
}

export function saveDevices(list: PairedDevice[]): Promise<void> {
  return devices.set(list);
}

/*
 * 中继地址：非机密，单独存明文 JSON，不塞进上面那个加密文件——
 * 一来 safeStorage 不可用时它也该能读写，二来不必为它改动凭据的存储格式。
 */
function relayPath(): string {
  return path.join(app.getPath('userData'), 'phone-relay.json');
}

export function loadRelayUrl(): string | null {
  try {
    const file = relayPath();
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { relayUrl?: unknown };
    return typeof parsed.relayUrl === 'string' && parsed.relayUrl ? parsed.relayUrl : null;
  } catch {
    return null;
  }
}

export function saveRelayUrl(relayUrl: string | null): void {
  try {
    const file = relayPath();
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ relayUrl }));
    renameSync(tmp, file);
  } catch (error) {
    console.warn('[pair] save relay url failed', error);
  }
}

function relayHostCachePath(): string {
  return path.join(app.getPath('userData'), 'relay-host-cache.json');
}

export function loadRelayHostCache(): Record<string, RelayHostAddress> {
  try {
    const file = relayHostCachePath();
    if (!existsSync(file)) return {};
    return Object.fromEntries(parseRelayHostCache(JSON.parse(readFileSync(file, 'utf-8'))));
  } catch {
    return {};
  }
}

export function saveRelayHostCache(cache: Map<string, RelayHostAddress>): void {
  try {
    const file = relayHostCachePath();
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, serializeRelayHostCache(parseRelayHostCache(Object.fromEntries(cache))));
    renameSync(tmp, file);
  } catch (error) {
    console.warn('[pair] save relay host cache failed', error);
  }
}
