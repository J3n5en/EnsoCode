import type { CatalogEntry, HostAppearance, ProjectEntry, ProviderEntry } from '@enso/pair';
import { IPC_CHANNELS } from '@shared/types';
import { BrowserWindow, ipcMain } from 'electron';
import {
  cancelPairing,
  getPairStatus,
  revokeDevice,
  setPairResumeListener,
  setPairStatusListener,
  setRelayUrl,
  startPairing,
  updatePairCatalog,
} from '../services/pairHost';

export function registerPairHandlers(): void {
  // 状态变化广播回设置页（配对成功、手机上下线、重连）
  setPairStatusListener(() => {
    const status = getPairStatus();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.PAIR_STATUS_CHANGED, status);
    }
  });

  // 手机订阅历史会话时，请渲染层按桌面同路径恢复（worker 里才有投影可发）
  setPairResumeListener((sessionId) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.PAIR_RESUME_SESSION, sessionId);
    }
  });

  ipcMain.handle(IPC_CHANNELS.PAIR_START, async () => startPairing());
  ipcMain.handle(IPC_CHANNELS.PAIR_CANCEL, () => {
    cancelPairing();
  });
  ipcMain.handle(IPC_CHANNELS.PAIR_REVOKE, async (_event, pairId: unknown) => {
    if (typeof pairId === 'string' && pairId) await revokeDevice(pairId);
  });
  ipcMain.handle(IPC_CHANNELS.PAIR_STATUS, () => getPairStatus());
  ipcMain.handle(IPC_CHANNELS.PAIR_SET_RELAY, (_event, url: unknown) => {
    if (typeof url === 'string') setRelayUrl(url);
    return getPairStatus();
  });

  // renderer 推目录：会话标题/项目/provider 只在 renderer 有，main 与 worker 都没有。
  // providers 必须已剥 apiKey/baseUrl；projectPaths 留在 main 侧用于 spawn 反查 cwd。
  ipcMain.on(IPC_CHANNELS.PAIR_CATALOG, (_event, payload: unknown) => {
    const p = payload as {
      catalog?: CatalogEntry[];
      projects?: ProjectEntry[];
      providers?: ProviderEntry[];
      projectPaths?: { id: string; path: string }[];
      theme?: HostAppearance;
    };
    if (!p || typeof p !== 'object') return;
    updatePairCatalog({
      catalog: Array.isArray(p.catalog) ? p.catalog : [],
      projects: Array.isArray(p.projects) ? p.projects : [],
      providers: Array.isArray(p.providers) ? p.providers : [],
      projectPaths: Array.isArray(p.projectPaths) ? p.projectPaths : [],
      theme: p.theme === 'light' || p.theme === 'dark' ? p.theme : 'system',
    });
  });
}
