import { ipcMain } from '@platform';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { pushAgyConfig } from '../services/agentHost';
import { cachedAgyModels, detectAgyAuth } from '../services/agyProbe';
import { readSettingsState } from './settings';

function binaryPathFromSettings(): string {
  const agy = readSettingsState().agy as { binaryPath?: unknown } | undefined;
  return typeof agy?.binaryPath === 'string' ? agy.binaryPath : '';
}

export function registerAgyHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.AGY_AUTH_STATUS, async (_event, refresh: unknown) => {
    const status = await detectAgyAuth(binaryPathFromSettings(), refresh === true);
    // worker 的 agy provider / 子代理模型枚举只认 set-agy-config；探测后立即同步
    pushAgyConfig();
    return status;
  });
  // 只读缓存，绝不探测：启动、窗口聚焦都可以调
  ipcMain.handle(IPC_CHANNELS.AGY_CACHED_MODELS, () => {
    return cachedAgyModels();
  });
}
