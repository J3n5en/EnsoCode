import path from 'node:path';
import { ipcMain, shell } from '@platform';
import { type LogExportResult, parseLogExportHours, parseLogSummaryLevel } from '@shared/appLog';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { app, BrowserWindow, dialog, type WebContents } from 'electron';
import { collectErrorSummary, ERROR_SUMMARY_LIMIT, exportLogs } from '../services/appLogs';
import { isMainRenderer, isSettingsRenderer } from '../services/renderers';

/** 最近一次导出的位置：「打开所在文件夹」只认它，renderer 不传路径 */
let lastExportPath: string | null = null;

function assertTrusted(webContentsId: number): void {
  if (!isMainRenderer(webContentsId) && !isSettingsRenderer(webContentsId)) {
    throw new Error('Untrusted sender');
  }
}

function defaultExportName(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `enso-logs-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.zip`;
}

/** 设置 → 日志：错误汇总、脱敏导出。保存对话框只有桌面壳有 */
export function registerLogHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.LOGS_ERRORS, (event, minLevel: unknown) => {
    assertTrusted(event.sender.id);
    return collectErrorSummary(app.getPath('userData'), {
      minLevel: parseLogSummaryLevel(minLevel),
      limit: ERROR_SUMMARY_LIMIT,
    });
  });

  ipcMain.handle(
    IPC_CHANNELS.LOGS_EXPORT,
    async (event, hours: unknown): Promise<LogExportResult> => {
      assertTrusted(event.sender.id);
      const window = parseLogExportHours(hours);
      if (window === null) return { ok: false, error: 'invalid-hours' };
      const win = BrowserWindow.fromWebContents(event.sender as unknown as WebContents);
      const owner = win && !win.isDestroyed() ? win : BrowserWindow.getFocusedWindow();
      const options = {
        defaultPath: path.join(app.getPath('downloads'), defaultExportName(new Date())),
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      };
      const picked = owner
        ? await dialog.showSaveDialog(owner, options)
        : await dialog.showSaveDialog(options);
      if (picked.canceled || !picked.filePath) return { ok: true, cancelled: true };
      try {
        const result = await exportLogs(app.getPath('userData'), picked.filePath, {
          hours: window,
          appInfo: { version: app.getVersion(), platform: process.platform, arch: process.arch },
        });
        lastExportPath = picked.filePath;
        return { ok: true, path: picked.filePath, files: result.files };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.LOGS_REVEAL_EXPORT, (event) => {
    assertTrusted(event.sender.id);
    if (lastExportPath) shell.showItemInFolder(lastExportPath);
  });
}
