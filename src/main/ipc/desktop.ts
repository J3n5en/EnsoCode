import { app, type BrowserWindow } from 'electron';
import { registerNodeRemoteHandlers } from '../services/nodeRemote';
import { registerBrowserHandlers } from './browser';
import { registerComputerHandlers } from './computer';
import { registerConfigSyncHandlers } from './configSync';
import { registerExtensionPluginDesktopHandlers } from './extensionPlugins.desktop';
import { registerUpdaterHandlers } from './updater';
import { attachWindowStateEvents, registerWindowHandlers } from './window';

/** 只有桌面壳有窗口、内嵌浏览器、桌面控制和自动更新。 */
export function registerDesktopIpcHandlers(): void {
  registerWindowHandlers();
  registerConfigSyncHandlers();
  registerUpdaterHandlers();
  registerBrowserHandlers();
  registerExtensionPluginDesktopHandlers();
  registerComputerHandlers();
  registerNodeRemoteHandlers();
  app.on('browser-window-created', (_event, win: BrowserWindow) => {
    attachWindowStateEvents(win);
  });
}
