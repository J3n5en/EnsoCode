import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isMediaPath } from '@shared/localImage';
import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';

export function registerFileHandlers(): void {
  // 枚举目录下的媒体文件（背景图「文件夹随机」模式用），返回绝对路径数组
  ipcMain.handle(IPC_CHANNELS.FILES_LIST_MEDIA, async (_event, dir: unknown): Promise<string[]> => {
    if (typeof dir !== 'string' || dir.length === 0) return [];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && isMediaPath(entry.name))
        .map((entry) => join(dir, entry.name));
    } catch {
      return [];
    }
  });
}
