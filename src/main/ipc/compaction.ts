import path from 'node:path';
import { app, ipcMain } from '@platform';
import { IPC_CHANNELS } from '@shared/types';
import {
  readCompactReserveTokens,
  writeCompactReserveTokens,
} from '../services/piCompactionSettings';
import { isMainRenderer, isSettingsRenderer } from '../services/renderers';

/** worker 的 PI_CODING_AGENT_DIR 下的 pi 全局设置；会话启动时由 pi 读取 */
const piSettingsPath = (): string =>
  path.join(app.getPath('userData'), 'agent', 'pi-agent', 'settings.json');

export function registerCompactionHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.COMPACTION_RESERVE_TOKENS_GET, (event) =>
    isMainRenderer(event.sender.id) || isSettingsRenderer(event.sender.id)
      ? readCompactReserveTokens(piSettingsPath())
      : null
  );
  ipcMain.handle(IPC_CHANNELS.COMPACTION_RESERVE_TOKENS_SET, (event, value: unknown) =>
    isMainRenderer(event.sender.id) || isSettingsRenderer(event.sender.id)
      ? writeCompactReserveTokens(piSettingsPath(), value)
      : { ok: false, error: 'forbidden' }
  );
}
