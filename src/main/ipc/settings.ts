import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@shared/types';
import { app, BrowserWindow, ipcMain } from 'electron';

function getSettingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

// 内存缓存和防抖配置
let cachedSettings: Record<string, unknown> | null = null;
let pendingWrite: NodeJS.Timeout | null = null;
let maxWaitTimer: NodeJS.Timeout | null = null;
let isDirty = false;

const DEBOUNCE_MS = 500;
const MAX_WAIT_MS = 5000;

export function readSettings(): Record<string, unknown> | null {
  if (cachedSettings !== null) {
    return cachedSettings;
  }

  try {
    const settingsPath = getSettingsPath();
    if (existsSync(settingsPath)) {
      cachedSettings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      return cachedSettings;
    }
  } catch {}
  cachedSettings = null;
  return null;
}

// 原子写入：先写临时文件再重命名，避免崩溃导致文件损坏
function atomicWriteSettings(data: Record<string, unknown>): boolean {
  try {
    const settingsPath = getSettingsPath();
    const tempPath = `${settingsPath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tempPath, settingsPath);
    return true;
  } catch {
    return false;
  }
}

export function flushSettings(): boolean {
  if (pendingWrite) {
    clearTimeout(pendingWrite);
    pendingWrite = null;
  }
  if (maxWaitTimer) {
    clearTimeout(maxWaitTimer);
    maxWaitTimer = null;
  }

  if (isDirty && cachedSettings !== null) {
    isDirty = false;
    return atomicWriteSettings(cachedSettings);
  }
  return true;
}

export function registerSettingsHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.SETTINGS_READ, async () => {
    return readSettings();
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_WRITE, async (event, data: unknown) => {
    try {
      cachedSettings = data as Record<string, unknown>;
      isDirty = true;

      // 多窗口同步：广播给除发起窗口外的所有窗口
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.webContents !== event.sender && !win.isDestroyed()) {
          win.webContents.send(IPC_CHANNELS.SETTINGS_CHANGED);
        }
      }

      if (pendingWrite) {
        clearTimeout(pendingWrite);
      }

      if (!maxWaitTimer) {
        maxWaitTimer = setTimeout(() => {
          if (cachedSettings !== null) {
            isDirty = false;
            atomicWriteSettings(cachedSettings);
          }
          maxWaitTimer = null;
          pendingWrite = null;
        }, MAX_WAIT_MS);
      }

      pendingWrite = setTimeout(() => {
        if (maxWaitTimer) {
          clearTimeout(maxWaitTimer);
          maxWaitTimer = null;
        }
        if (cachedSettings !== null) {
          isDirty = false;
          atomicWriteSettings(cachedSettings);
        }
        pendingWrite = null;
      }, DEBOUNCE_MS);

      return true;
    } catch {
      return false;
    }
  });

  app.on('before-quit', () => {
    flushSettings();
  });
}
