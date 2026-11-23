import type {
  ConfigSyncCommitOptions,
  ConfigSyncCommitResult,
  ConfigSyncExportOptions,
  ConfigSyncExportResult,
  ConfigSyncOpenResult,
  ConfigSyncPreviewOptions,
  ConfigSyncPreviewResult,
} from '@shared/types';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import {
  cancelImportForSender,
  commitImportForSender,
  exportConfigToPath,
  openImportForSender,
  previewImportForSender,
} from '../services/configSync';

function asExportOptions(value: unknown): ConfigSyncExportOptions | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (typeof input.includeSecrets !== 'boolean') return null;
  if (input.password !== undefined && typeof input.password !== 'string') return null;
  return {
    includeSecrets: input.includeSecrets,
    ...(input.password ? { password: input.password } : {}),
  };
}

function asPreviewOptions(value: unknown): ConfigSyncPreviewOptions | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (typeof input.token !== 'string' || (input.mode !== 'merge' && input.mode !== 'replace'))
    return null;
  if (input.password !== undefined && typeof input.password !== 'string') return null;
  return {
    token: input.token,
    mode: input.mode,
    ...(input.password ? { password: input.password } : {}),
  };
}

function asCommitOptions(value: unknown): ConfigSyncCommitOptions | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (typeof input.token !== 'string' || (input.mode !== 'merge' && input.mode !== 'replace'))
    return null;
  return { token: input.token, mode: input.mode };
}

function senderWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win && !win.isDestroyed() ? win : null;
}

export function registerConfigSyncHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.CONFIG_SYNC_EXPORT,
    async (event, raw: unknown): Promise<ConfigSyncExportResult> => {
      const options = asExportOptions(raw);
      const win = senderWindow(event);
      if (!options || !win) return { ok: false, error: 'Invalid export request.' };
      const result = await dialog.showSaveDialog(win, {
        title: 'Export EnsoCode Configuration',
        defaultPath: 'ensocode-settings.enso-config',
        filters: [{ name: 'EnsoCode Configuration', extensions: ['enso-config'] }],
      });
      if (result.canceled || !result.filePath) {
        return { ok: false, error: 'Export cancelled.', cancelled: true };
      }
      const filePath = result.filePath.endsWith('.enso-config')
        ? result.filePath
        : `${result.filePath}.enso-config`;
      return exportConfigToPath(options, filePath);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CONFIG_SYNC_OPEN_IMPORT,
    async (event): Promise<ConfigSyncOpenResult> => {
      const win = senderWindow(event);
      if (!win) return { ok: false, error: 'Invalid import request.' };
      const result = await dialog.showOpenDialog(win, {
        title: 'Import EnsoCode Configuration',
        properties: ['openFile'],
        filters: [{ name: 'EnsoCode Configuration', extensions: ['enso-config'] }],
      });
      return openImportForSender(
        event.sender.id,
        result.canceled ? null : (result.filePaths[0] ?? null)
      );
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CONFIG_SYNC_PREVIEW_IMPORT,
    (event, raw: unknown): Promise<ConfigSyncPreviewResult> => {
      const options = asPreviewOptions(raw);
      if (!options) return Promise.resolve({ ok: false, error: 'Invalid import preview request.' });
      return previewImportForSender(event.sender.id, options.token, options.password, options.mode);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CONFIG_SYNC_COMMIT_IMPORT,
    (event, raw: unknown): Promise<ConfigSyncCommitResult> => {
      const options = asCommitOptions(raw);
      if (!options) return Promise.resolve({ ok: false, error: 'Invalid import commit request.' });
      return commitImportForSender(event.sender.id, options.token, options.mode);
    }
  );

  ipcMain.handle(IPC_CHANNELS.CONFIG_SYNC_CANCEL_IMPORT, (event, token: unknown): void => {
    if (typeof token === 'string') cancelImportForSender(event.sender.id, token);
  });
}
