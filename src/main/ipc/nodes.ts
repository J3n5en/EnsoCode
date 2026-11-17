import { ipcMain } from '@platform';
import { IPC_CHANNELS } from '@shared/types';
import {
  getNodesStatus,
  pairNode,
  removeNode,
  renameNode,
  setNodesStatusListener,
} from '../services/pairGuest';
import { broadcastToRenderers } from '../services/renderers';

/**
 * 「连接到节点」：本机作为 guest 连别的 EnsoCode 桌面。
 * 主窗口 UI 跑在独立的顶层 WebContentsView 里，`win.webContents` 是没有 preload 监听的空壳；
 * 推送一律走 sendToWindow / getWindowWebContents，否则渲染层收不到状态。
 */
export function registerNodesHandlers(): void {
  setNodesStatusListener((status) => {
    broadcastToRenderers(IPC_CHANNELS.NODES_STATUS_CHANGED, status);
  });

  ipcMain.handle(IPC_CHANNELS.NODES_LIST, () => getNodesStatus());
  ipcMain.handle(IPC_CHANNELS.NODES_PAIR, async (_event, uri: unknown) => {
    if (typeof uri !== 'string' || !uri.trim()) return { ok: false, error: 'invalid-uri' };
    return pairNode(uri.trim());
  });
  ipcMain.handle(IPC_CHANNELS.NODES_REMOVE, async (_event, nodeId: unknown) => {
    if (typeof nodeId !== 'string' || !nodeId) return { ok: false, error: 'invalid nodeId' };
    return removeNode(nodeId);
  });
  ipcMain.handle(IPC_CHANNELS.NODES_RENAME, (_event, nodeId: unknown, label: unknown) => {
    if (typeof nodeId !== 'string' || !nodeId || typeof label !== 'string') {
      return { ok: false, error: 'invalid arguments' };
    }
    return renameNode(nodeId, label);
  });
}
