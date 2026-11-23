import { app, ipcMain } from '@platform';
import { IPC_CHANNELS } from '@shared/types/ipc';
import {
  flushModelDirectoryCache,
  getModelDirectorySnapshot,
  refreshModelDirectory,
} from '../services/modelDirectory';
import { onOauthCatalogChanged } from '../services/oauthProviders';

export function registerModelDirectoryHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.MODEL_DIRECTORY_GET, () => getModelDirectorySnapshot());

  app.on('before-quit', () => {
    flushModelDirectoryCache({ retry: false });
  });

  onOauthCatalogChanged(() => {
    void refreshModelDirectory().catch(() => {});
  });

  // 升级后首启没有磁盘缓存，OAuth 分区只能靠 runtime 合成；不主动刷新的话
  // picker 面对空分区、默认模型校验也只能 defer。后台异步进行，失败由
  // refreshModelDirectory 内部的缓存兜底吸收。
  void refreshModelDirectory();
}
