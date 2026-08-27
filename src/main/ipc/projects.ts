import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';
import { getRecentProjects } from '../services/recentProjects';

export function registerProjectHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.PROJECTS_GET_RECENT, () => {
    try {
      return getRecentProjects();
    } catch (error) {
      console.warn('[RecentProjects] Failed:', error);
      return [];
    }
  });
}
