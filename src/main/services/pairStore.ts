import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PairedDevice } from '@enso/pair';
import { app, safeStorage } from 'electron';

/**
 * 已配对设备凭据落盘。contentKey 是端到端密钥，必须加密存储：
 * safeStorage 不可用（部分 Linux 无 keyring）时不静默明文落盘，由 UI 提示用户。
 */

function storePath(): string {
  return path.join(app.getPath('userData'), 'phone-pairing.bin');
}

export function isSecureStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

let cache: PairedDevice[] | null = null;

/** 新增或按 pairId 更新凭据；更新时保留自定义名与列表位置 */
export function upsertDevice(list: readonly PairedDevice[], device: PairedDevice): PairedDevice[] {
  const existing = list.find((d) => d.pairId === device.pairId);
  if (existing) {
    return list.map((d) =>
      d.pairId === device.pairId ? { ...device, deviceName: d.deviceName } : d
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
  if (cache) return cache;
  try {
    const file = storePath();
    if (!existsSync(file)) {
      cache = [];
      return cache;
    }
    const raw = readFileSync(file);
    const json = isSecureStorageAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf-8');
    const parsed = JSON.parse(json);
    cache = Array.isArray(parsed) ? (parsed as PairedDevice[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

/** 原子写：临时文件 + rename，避免崩溃损坏 */
export function saveDevices(devices: PairedDevice[]): void {
  cache = devices;
  try {
    const file = storePath();
    const json = JSON.stringify(devices);
    const data = isSecureStorageAvailable()
      ? safeStorage.encryptString(json)
      : Buffer.from(json, 'utf-8');
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  } catch (error) {
    console.warn('[pair] save devices failed', error);
  }
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
