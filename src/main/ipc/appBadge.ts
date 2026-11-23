import { app, ipcMain } from '@platform';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { isMainRenderer } from '../services/renderers';

export function toBadgeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 999
    ? value
    : null;
}

export function registerAppBadgeHandlers(): void {
  ipcMain.on(IPC_CHANNELS.APP_SET_BADGE_COUNT, (event, value: unknown) => {
    if (!isMainRenderer(event.sender.id)) return;
    const count = toBadgeCount(value);
    if (count !== null) app.setBadgeCount(count);
  });
}
