import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';
import { collectAssetImport, scanLocalAssets } from '../services/assetScan';

export function registerAssetHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.ASSETS_SCAN_LOCAL, () => scanLocalAssets());

  ipcMain.handle(
    IPC_CHANNELS.ASSETS_COLLECT_IMPORT,
    (_event, scanId: unknown, candidateIds: unknown) => {
      if (typeof scanId !== 'string' || !Array.isArray(candidateIds)) return [];
      return collectAssetImport(
        scanId,
        candidateIds.filter((id): id is string => typeof id === 'string')
      );
    }
  );
}
