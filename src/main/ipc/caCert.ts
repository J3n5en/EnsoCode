import { ipcMain } from '@platform';
import type { CaCertStatus } from '@shared/caCert';
import { IPC_CHANNELS } from '@shared/types';
import { getCaCertConfig } from '../services/caCert';

export function registerCaCertHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.CA_CERT_STATUS, (): CaCertStatus => getCaCertConfig().status());
  ipcMain.handle(
    IPC_CHANNELS.CA_CERT_APPLY,
    async (_event, raw: unknown): Promise<CaCertStatus> => {
      const config = getCaCertConfig();
      if (typeof raw !== 'string') return { ...config.status(), error: 'not-found' };
      return config.setCustomPath(raw);
    }
  );
}
