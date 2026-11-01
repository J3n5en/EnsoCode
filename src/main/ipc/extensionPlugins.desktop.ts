import { copyFile } from 'node:fs/promises';
import { ipcMain } from '@platform';
import { IPC_CHANNELS } from '@shared/types';
import { BrowserWindow, dialog, type OpenDialogOptions, type WebContents } from 'electron';
import { getExtensionPlugins } from '../services/extensionPlugins';
import { parsePickPathKind, savePluginArtifact } from './extensionPlugins';

/** 桌面壳：弹系统对话框选插件目录或 zip，再暂存。远端没有这个通道 */
export function registerExtensionPluginDesktopHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.EXTENSION_PLUGINS_PICK_AND_STAGE, async (event, kind: unknown) => {
    if (kind !== 'dir' && kind !== 'zip') return { ok: false, error: '参数不合法' };
    const win = BrowserWindow.fromWebContents(event.sender as unknown as WebContents);
    const owner = win && !win.isDestroyed() ? win : BrowserWindow.getFocusedWindow();
    const options: OpenDialogOptions = {
      properties: [kind === 'dir' ? 'openDirectory' : 'openFile'],
      ...(kind === 'zip' ? { filters: [{ name: 'ZIP', extensions: ['zip'] }] } : {}),
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    const picked = result.filePaths[0];
    if (result.canceled || !picked) return { ok: true, cancelled: true };
    return getExtensionPlugins().stage({ kind, path: picked });
  });

  ipcMain.handle(IPC_CHANNELS.EXTENSION_PLUGINS_PICK_PATH, async (event, kind: unknown) => {
    const parsed = parsePickPathKind(kind);
    if (!parsed) return { ok: false, error: '参数不合法' };
    const win = BrowserWindow.fromWebContents(event.sender as unknown as WebContents);
    const owner = win && !win.isDestroyed() ? win : BrowserWindow.getFocusedWindow();
    const options: OpenDialogOptions = {
      properties: [parsed === 'directory' ? 'openDirectory' : 'openFile'],
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    const picked = result.filePaths[0];
    if (result.canceled || !picked) return { ok: true, cancelled: true };
    return { ok: true, path: picked };
  });

  ipcMain.handle(IPC_CHANNELS.EXTENSION_PLUGINS_ARTIFACT_SAVE, async (event, id: unknown) => {
    return savePluginArtifact(
      getExtensionPlugins(),
      id,
      async (name) => {
        const win = BrowserWindow.fromWebContents(event.sender as unknown as WebContents);
        const owner = win && !win.isDestroyed() ? win : BrowserWindow.getFocusedWindow();
        const options = { defaultPath: name };
        const result = owner
          ? await dialog.showSaveDialog(owner, options)
          : await dialog.showSaveDialog(options);
        if (result.canceled || !result.filePath) return null;
        return result.filePath;
      },
      (from, to) => copyFile(from, to)
    );
  });
}
