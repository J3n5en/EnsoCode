import { ipcMain } from '@platform';
import { IPC_CHANNELS } from '@shared/types';
import { canAnswerElevation, elevationBroker } from '../services/elevation';

const MAX_PASSWORD = 1024;

function parsePassword(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PASSWORD)
    return undefined;
  // sudo 按行读口令，换行与 NUL 会截断或串到下一次读取
  return /[\r\n\0]/.test(value) ? undefined : value;
}

export function registerElevationHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.ELEVATION_PENDING, (event) =>
    canAnswerElevation(event.sender.id) ? elevationBroker.list() : []
  );
  ipcMain.handle(IPC_CHANNELS.ELEVATION_ANSWER, (event, id: unknown, password: unknown) => {
    if (!canAnswerElevation(event.sender.id) || typeof id !== 'string') return false;
    const parsed = parsePassword(password);
    return parsed === undefined ? false : elevationBroker.answer(id, parsed);
  });
}
