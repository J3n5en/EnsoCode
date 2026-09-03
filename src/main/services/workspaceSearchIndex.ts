import path from 'node:path';
import {
  searchWorkspace,
  type WorkspaceSearchDoc,
  type WorkspaceSearchHit,
} from '@shared/workspaceSearch';
import type { WorkspaceSearchQueryRequest } from '@shared/workspaceSearchQuery';

export interface ListedSessionInfo {
  path: string;
  name?: string;
  firstMessage: string;
  allMessagesText: string;
  modified: Date;
}

export interface WorkspaceSearchReadyRow {
  conversationId: string;
  projectId: string;
  projectName: string;
  sessionFile: string;
}

export interface WorkspaceSearchIndexDeps {
  sessionDir: string;
  listReady: () => WorkspaceSearchReadyRow[];
  listSessions: (sessionDir: string) => Promise<ListedSessionInfo[]>;
  resolvePath?: (value: string) => string;
}

function resolveDefault(value: string): string {
  return path.resolve(value);
}

export function buildColdSearchDocs(
  ready: WorkspaceSearchReadyRow[],
  infos: ListedSessionInfo[],
  sessionDir: string,
  resolve = resolveDefault
): WorkspaceSearchDoc[] {
  const root = resolve(sessionDir);
  const byPath = new Map(infos.map((info) => [resolve(info.path), info] as const));
  const docs: WorkspaceSearchDoc[] = [];
  for (const row of ready) {
    const file = resolve(row.sessionFile);
    if (!(file === root || file.startsWith(`${root}${path.sep}`))) continue;
    const info = byPath.get(file);
    if (!info) continue;
    const title = info.name?.trim() || info.firstMessage.trim() || row.conversationId;
    docs.push({
      conversationId: row.conversationId,
      projectId: row.projectId,
      projectName: row.projectName,
      title,
      lastActiveAt: info.modified.getTime(),
      fields: [
        { field: 'title', text: title },
        { field: 'project', text: row.projectName },
        { field: 'id', text: row.conversationId },
        { field: 'body', text: info.allMessagesText },
      ],
    });
  }
  return docs;
}

export async function queryWorkspaceSearchIndex(
  request: WorkspaceSearchQueryRequest,
  deps: WorkspaceSearchIndexDeps
): Promise<WorkspaceSearchHit[]> {
  const infos = await deps.listSessions(deps.sessionDir);
  const docs = buildColdSearchDocs(deps.listReady(), infos, deps.sessionDir, deps.resolvePath);
  return searchWorkspace(docs, request.query, {
    currentProjectId: request.currentProjectId,
    scope: request.scope,
  });
}
