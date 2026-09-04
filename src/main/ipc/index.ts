import { app } from 'electron';
import { registerAgentHandlers } from './agent';
import { registerAssetHandlers } from './assets';
import { registerBrowserHandlers } from './browser';
import { registerCapabilityHandlers } from './capabilities';
import { registerFileHandlers } from './files';
import { registerFilesWorkspaceHandlers } from './filesWorkspace';
import { registerGitHandlers } from './git';
import { registerMcpHandlers } from './mcp';
import { registerNodesHandlers } from './nodes';
import { registerPairHandlers } from './pair';
import { registerProjectHandlers } from './projects';
import { registerProviderHandlers } from './providers';
import { registerProxyHandlers } from './proxy';
import { registerSettingsHandlers } from './settings';
import { registerSshConnectionHandlers } from './sshConnections';
import { registerTerminalHandlers } from './terminal';
import { registerUpdaterHandlers } from './updater';
import { registerUsageHandlers } from './usage';
import { attachWindowStateEvents, registerWindowHandlers } from './window';
import { registerWorkspaceSearchHandlers } from './workspaceSearch';
import { registerWorktreeHandlers } from './worktree';

export function registerIpcHandlers(): void {
  registerSettingsHandlers();
  registerWindowHandlers();
  registerProviderHandlers();
  registerAssetHandlers();
  registerCapabilityHandlers();
  registerAgentHandlers();
  registerUpdaterHandlers();
  registerProxyHandlers();
  registerProjectHandlers();
  registerBrowserHandlers();
  registerSshConnectionHandlers();
  registerFileHandlers();
  registerFilesWorkspaceHandlers();
  registerGitHandlers();
  registerMcpHandlers();
  registerPairHandlers();
  registerNodesHandlers();
  registerWorktreeHandlers();
  registerTerminalHandlers();
  registerWorkspaceSearchHandlers();
  registerUsageHandlers();

  // 所有新建窗口自动挂载状态事件
  app.on('browser-window-created', (_, win) => {
    attachWindowStateEvents(win);
  });
}
