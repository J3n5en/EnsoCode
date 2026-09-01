import { statSync } from 'node:fs';
import type { GitDiffResult } from '@shared/types';
import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';
import { diffHead, localGitDiffHost } from '../services/gitDiff';
import { pickSessionCwd } from '../services/terminalService';
import { getSourceAuthorityRegistry } from './agent';
import { sessionWorktree } from './worktree';

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function registerGitHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.GIT_DIFF_HEAD,
    async (_event, request: unknown): Promise<GitDiffResult> => {
      if (!request || typeof request !== 'object') return { ok: false, error: 'unavailable' };
      const conversationId = (request as { conversationId?: unknown }).conversationId;
      const projectId = (request as { projectId?: unknown }).projectId;
      if (!isNonEmptyString(conversationId) || !isNonEmptyString(projectId)) {
        return { ok: false, error: 'unavailable' };
      }

      const project = getSourceAuthorityRegistry()?.project(projectId);
      if (project?.kind === 'ssh') return { ok: false, error: 'unavailable' };

      const worktreePath = sessionWorktree(conversationId)?.path;
      const projectPath = project?.state === 'active' ? project.canonicalPath : undefined;
      const cwd = pickSessionCwd({
        worktreePath,
        projectPath,
        home: '',
        exists: isDirectory,
      });
      if (!cwd) return { ok: false, error: 'unavailable' };
      return diffHead(cwd, localGitDiffHost());
    }
  );
}
