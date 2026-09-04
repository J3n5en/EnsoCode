import { IPC_CHANNELS } from '@shared/types';
import type { McpStatusEvent } from '@shared/types/agent';
import { ipcMain } from 'electron';
import { pushMcpWarmup } from '../services/agentHost';
import {
  authorizeMcpServer,
  resolveServerFromSettings,
  revokeMcpServer,
} from '../services/mcpOAuth';
import { getMcpOAuthStore } from '../services/mcpOAuthStore';
import { mcpStatusSnapshot, recordMcpStatus } from '../services/mcpStatusCache';
import { isMainWebContents } from '../windows/MainWindow';
import { isSettingsWebContents } from '../windows/SettingsWindow';
import { pushMcpStatus } from './agent';

function isTrustedWindow(webContentsId: number): boolean {
  return isMainWebContents(webContentsId) || isSettingsWebContents(webContentsId);
}

function emitStatus(event: McpStatusEvent): void {
  recordMcpStatus(event);
  pushMcpStatus(event);
}

/**
 * 授权成功后按 serverId 定向 warm：走 enabledMcpServers 会漏掉被禁用 / 只被某 agentType
 * 引用的条目，UI 会一直卡 connecting。worker 没在跑时直接标记「已授权，待连接」。
 */
function warmAuthorizedServer(serverId: string): void {
  if (pushMcpWarmup(serverId)) return;
  const name = resolveServerFromSettings(serverId)?.name;
  if (name) emitStatus({ type: 'mcp-status', serverId, serverName: name, state: 'idle' });
}

export function registerMcpHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.MCP_AUTHORIZE, async (event, serverId: unknown) => {
    if (!isTrustedWindow(event.sender.id) || typeof serverId !== 'string') {
      return { ok: false, error: 'Invalid request.' };
    }
    return authorizeMcpServer(serverId, { onAuthorized: warmAuthorizedServer });
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
