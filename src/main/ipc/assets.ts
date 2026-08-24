import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';
import { collectAssetImport, scanLocalAssets } from '../services/assetScan';
import {
  deleteInstruction,
  readInstruction,
  writeInstruction,
  writeInstructionSource,
} from '../services/instructionStore';

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

  ipcMain.handle(
    IPC_CHANNELS.INSTRUCTIONS_READ,
    (_event, id: unknown, local: unknown, sourcePath: unknown) => {
      if (typeof id !== 'string') return { ok: false, content: '', error: 'Invalid id' };
      return readInstruction(
        id,
        local === true,
        typeof sourcePath === 'string' ? sourcePath : undefined
      );
    }
  );

  ipcMain.handle(IPC_CHANNELS.INSTRUCTIONS_WRITE, (_event, id: unknown, content: unknown) => {
    if (typeof id !== 'string' || typeof content !== 'string') return { ok: false, bytes: 0 };
    return writeInstruction(id, content);
  });

  ipcMain.handle(
    IPC_CHANNELS.INSTRUCTIONS_WRITE_SOURCE,
    (_event, id: unknown, sourcePath: unknown, content: unknown) => {
      if (typeof id !== 'string' || typeof sourcePath !== 'string' || typeof content !== 'string') {
        return { ok: false, bytes: 0, error: 'Invalid arguments' };
      }
      return writeInstructionSource(id, sourcePath, content);
    }
  );

  ipcMain.handle(IPC_CHANNELS.INSTRUCTIONS_DELETE, (_event, id: unknown) => {
    if (typeof id === 'string') deleteInstruction(id);
  });
}
