import { IPC_CHANNELS } from '@shared/types';
import { isUsageRangeDays } from '@shared/usage/types';
import { ipcMain } from 'electron';
import { getUsageSummary } from '../services/usage/usageService';

export function registerUsageHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.USAGE_SUMMARY, (_event, days: unknown) => {
    if (!isUsageRangeDays(days)) return { ok: false, error: 'Invalid range' };
    return getUsageSummary(days);
  });
}
