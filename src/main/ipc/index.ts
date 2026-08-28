import { app } from 'electron';
import { registerAgentHandlers } from './agent';
import { registerAssetHandlers } from './assets';
import { registerPairHandlers } from './pair';
import { registerProjectHandlers } from './projects';
import { registerProviderHandlers } from './providers';
import { registerSettingsHandlers } from './settings';
import { registerUpdaterHandlers } from './updater';
import { attachWindowStateEvents, registerWindowHandlers } from './window';

export function registerIpcHandlers(): void {
  registerSettingsHandlers();
  registerWindowHandlers();
  registerProviderHandlers();
  registerAssetHandlers();
  registerAgentHandlers();
  registerUpdaterHandlers();
  registerProjectHandlers();
  registerPairHandlers();

  // 所有新建窗口自动挂载状态事件
  app.on('browser-window-created', (_, win) => {
    attachWindowStateEvents(win);
  });
}
