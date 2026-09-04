import path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { IPC_CHANNELS } from '@shared/types';
import { parseWorkspaceSearchQueryRequest } from '@shared/workspaceSearchQuery';
import { app, ipcMain } from 'electron';
import { queryWorkspaceSearchIndex } from '../services/workspaceSearchIndex';
import { isMainWebContents } from '../windows/MainWindow';
import { getSourceAuthorityRegistry } from './agent';

export function registerWorkspaceSearchHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_SEARCH_QUERY, async (event, request: unknown) => {
    const parsed = parseWorkspaceSearchQueryRequest(request);
    const registry = getSourceAuthorityRegistry();
    if (!parsed || !registry || !isMainWebContents(event.sender.id)) {
      return { hits: [] };
    }
    const projection = registry.projection();
    const projectName = new Map(
      projection.projects.map((project) => {
        const base =
          project.canonicalPath.split(/[\\/]/).filter(Boolean).at(-1) ?? project.projectId;
        return [project.projectId, base] as const;
      })
    );
    const sessionDir = path.join(app.getPath('userData'), 'agent', 'sessions');
    const hits = await queryWorkspaceSearchIndex(parsed, {
      sessionDir,
      listReady: () =>
        projection.conversations.flatMap((conversation) => {
          if (conversation.lifecycle !== 'ready' || !conversation.sessionFile) return [];
          return [
            {
              conversationId: conversation.conversationId,
              projectId: conversation.projectId,
              projectName: projectName.get(conversation.projectId) ?? conversation.projectId,
              sessionFile: conversation.sessionFile,
            },
          ];
        }),
      listSessions: async (dir) => {
        const listed = await SessionManager.listAll(dir);
        return listed.map((info) => ({
          path: info.path,
          name: info.name,
          firstMessage: info.firstMessage,
          allMessagesText: info.allMessagesText,
          modified: info.modified,
        }));
      },
    });
    return { hits };
  });
}
