import { IPC_CHANNELS } from '@shared/types';
import {
  parseCreateProjectAuthorityRequest,
  parseRemoveProjectAuthorityRequest,
  parseSelectProjectAuthorityRequest,
} from '@shared/types/agent';
import { ipcMain } from 'electron';
import { getRecentProjects } from '../services/recentProjects';
import { isMainWebContents } from '../windows/MainWindow';
import { getSourceAuthorityRegistry } from './agent';

export function registerProjectHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.PROJECTS_GET_RECENT, async () => {
    try {
      return await getRecentProjects();
    } catch (error) {
      console.warn('[RecentProjects] Failed:', error);
      return [];
    }
  });

  ipcMain.handle(IPC_CHANNELS.SOURCE_PROJECT_CREATE, (event, request: unknown) => {
    const parsed = parseCreateProjectAuthorityRequest(request);
    const registry = getSourceAuthorityRegistry();
    return parsed && registry && isMainWebContents(event.sender.id)
      ? registry.createProject(parsed)
      : { accepted: false, error: 'Invalid project request.' };
  });
  ipcMain.handle(IPC_CHANNELS.SOURCE_PROJECT_SELECT, (event, request: unknown) => {
    const parsed = parseSelectProjectAuthorityRequest(request);
    const registry = getSourceAuthorityRegistry();
    return parsed && registry && isMainWebContents(event.sender.id)
      ? registry.selectProject(parsed)
      : { accepted: false, error: 'Invalid project request.' };
  });
  ipcMain.handle(IPC_CHANNELS.SOURCE_PROJECT_REMOVE, (event, request: unknown) => {
    const parsed = parseRemoveProjectAuthorityRequest(request);
    const registry = getSourceAuthorityRegistry();
    return parsed && registry && isMainWebContents(event.sender.id)
      ? registry.removeProject(parsed)
      : { accepted: false, error: 'Invalid project request.' };
  });
}
