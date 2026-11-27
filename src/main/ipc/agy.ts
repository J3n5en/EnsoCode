import { ipcMain } from '@platform';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { detectAgyAuth } from '../services/agyProbe';
import { readSettingsState } from './settings';

function binaryPathFromSettings(): string {
  const agy = readSettingsState().agy as { binaryPath?: unknown } | undefined;
  return typeof agy?.binaryPath === 'string' ? agy.binaryPath : '';
}

export function registerAgyHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.AGY_AUTH_STATUS, async (_event, refresh: unknown) => {
    return detectAgyAuth(binaryPathFromSettings(), refresh === true);
  });
}
