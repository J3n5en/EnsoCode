import { readdir } from 'node:fs/promises';
import path, { join } from 'node:path';
import { app, ipcMain } from '@platform';
import { isMediaPath } from '@shared/localImage';
import type { PastedTextFileResult } from '@shared/pastedText';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { savePastedTextFile } from '../services/pastedTextFiles';
import { isMainRenderer } from '../services/renderers';
import { getSourceAuthorityRegistry } from './agent';

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

  // 超长粘贴落盘：目录由 Main 按会话推导；ssh 项目的模型读不到本地文件，拒绝
  ipcMain.handle(
    IPC_CHANNELS.FILES_SAVE_PASTED_TEXT,
    async (event, request: unknown): Promise<PastedTextFileResult> => {
      if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'unavailable' };
      const input =
        request && typeof request === 'object' ? (request as Record<string, unknown>) : {};
      const { conversationId, text } = input;
      if (typeof conversationId !== 'string' || typeof text !== 'string')
        return { ok: false, error: 'invalid-request' };
      const registry = getSourceAuthorityRegistry();
      const conversation = registry?.conversation(conversationId);
      const project = conversation ? registry?.project(conversation.projectId) : undefined;
      if (!project || project.kind === 'ssh') return { ok: false, error: 'unsupported' };
      try {
        return await savePastedTextFile(
          path.join(app.getPath('userData'), 'agent', 'sessions'),
          conversationId,
          text
        );
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'write-failed' };
      }
    }
  );
}
