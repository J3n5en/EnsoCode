import { IPC_CHANNELS } from '@shared/types';
import { BrowserWindow, ipcMain } from 'electron';
import {
  getNodesStatus,
  pairNode,
  removeNode,
  renameNode,
  sendToNode,
  setNodesMessageListener,
  setNodesStatusListener,
} from '../services/pairGuest';
import { parseGuestOutbound } from '../services/pairGuestPolicy';
import { isMainWebContents } from '../windows/MainWindow';

/** 「连接到节点」：本机作为 guest 连别的 EnsoCode 桌面 */
export function registerNodesHandlers(): void {
  setNodesStatusListener((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.NODES_STATUS_CHANGED, status);
    }
  });
  // 下行帧只给主窗口：设置窗口不渲染会话
  setNodesMessageListener((message) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && isMainWebContents(win.webContents.id)) {
        win.webContents.send(IPC_CHANNELS.NODES_MESSAGE, message);
      }
    }
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
  ipcMain.handle(IPC_CHANNELS.NODES_SEND, (event, nodeId: unknown, command: unknown) => {
    if (!isMainWebContents(event.sender.id)) {
      return { ok: false, error: 'Only MainWindow can talk to nodes.' };
    }
    if (typeof nodeId !== 'string' || !nodeId) return { ok: false, error: 'invalid nodeId' };
    const parsed = parseGuestOutbound(command);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    return sendToNode(nodeId, parsed.command);
  });
}
