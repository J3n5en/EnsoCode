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
