import { ipcMain } from '@platform';
import { IPC_CHANNELS } from '@shared/types/ipc';
import {
  listPrivacyMaskRecords,
  PRIVACY_RECORD_DAYS,
  type PrivacyRecordDays,
} from '../services/privacyMask';

export function registerPrivacyMaskHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.PRIVACY_MASK_RECORDS, (_event, days: unknown) => {
    if (!(PRIVACY_RECORD_DAYS as readonly unknown[]).includes(days)) return [];
    return listPrivacyMaskRecords(days as PrivacyRecordDays);
  });
}
