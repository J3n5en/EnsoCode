import { app } from 'electron';
import { registerSettingsHandlers } from './settings';
import { attachWindowStateEvents, registerWindowHandlers } from './window';

export function registerIpcHandlers(): void {
  registerSettingsHandlers();
  registerWindowHandlers();

  // 所有新建窗口自动挂载状态事件
  app.on('browser-window-created', (_, win) => {
    attachWindowStateEvents(win);
  });
}
