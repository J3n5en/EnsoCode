import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';
import { pushMcpWarmup } from '../services/agentHost';
import { authorizeMcpServer, revokeMcpServer } from '../services/mcpOAuth';
import { getMcpOAuthStore } from '../services/mcpOAuthStore';
import { mcpStatusSnapshot } from '../services/mcpStatusCache';
import { isMainWebContents } from '../windows/MainWindow';
import { isSettingsWebContents } from '../windows/SettingsWindow';

function isTrustedWindow(webContentsId: number): boolean {
  return isMainWebContents(webContentsId) || isSettingsWebContents(webContentsId);
}

export function registerMcpHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.MCP_AUTHORIZE, async (event, serverId: unknown) => {
    if (!isTrustedWindow(event.sender.id) || typeof serverId !== 'string') {
      return { ok: false, error: 'Invalid request.' };
    }
    // 授权成功后重新下发 warm-mcp，worker 侧状态自动从 unauthorized 转 ready
    return authorizeMcpServer(serverId, { onAuthorized: () => pushMcpWarmup() });
  });

  ipcMain.handle(IPC_CHANNELS.MCP_REVOKE, (event, serverId: unknown) => {
    if (!isTrustedWindow(event.sender.id) || typeof serverId !== 'string') return { ok: false };
    revokeMcpServer(serverId);
    pushMcpWarmup();
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.MCP_AUTH_STATE, (event) => {
    if (!isTrustedWindow(event.sender.id)) return {};
    return getMcpOAuthStore().authState();
  });

  ipcMain.handle(IPC_CHANNELS.MCP_STATUS_SNAPSHOT, (event) => {
    if (!isTrustedWindow(event.sender.id)) return [];
    return mcpStatusSnapshot();
  });
}
