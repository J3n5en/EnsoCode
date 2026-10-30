import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';
import { computerHost } from '../services/computerHost';
import { isMainRenderer, isSettingsRenderer } from '../services/renderers';

const MAX_APP_KEY_CHARS = 1024;

function trusted(senderId: number): boolean {
  return isMainRenderer(senderId) || isSettingsRenderer(senderId);
}

export function registerComputerHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.COMPUTER_CAPABILITIES, async () => {
    try {
      return { ok: true as const, capabilities: await computerHost.capabilities() };
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  ipcMain.handle(IPC_CHANNELS.COMPUTER_OPEN_PERMISSIONS, (_event, kind: unknown) => {
    if (kind !== 'screen' && kind !== 'accessibility') {
      return { ok: false as const, error: 'Invalid permission kind' };
    }
    return computerHost.openPermissionSettings(kind);
  });
  ipcMain.handle(IPC_CHANNELS.COMPUTER_ALLOWED_APPS, (event) =>
    trusted(event.sender.id) ? computerHost.allowedApps() : []
  );
  ipcMain.handle(IPC_CHANNELS.COMPUTER_REVOKE_APP, (event, key: unknown) => {
    if (!trusted(event.sender.id)) return { ok: false };
    if (typeof key !== 'string' || !key || key.length > MAX_APP_KEY_CHARS) return { ok: false };
    return { ok: computerHost.revokeApp(key) };
  });
}
