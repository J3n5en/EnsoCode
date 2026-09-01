import { statSync } from 'node:fs';
import os from 'node:os';
import type { TerminalCreateRequest, TerminalCreateResult } from '@shared/types';
import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';
import {
  createTerminal,
  disposeTerminal,
  pickSessionCwd,
  resizeTerminal,
  writeTerminal,
} from '../services/terminalService';
import { getSourceAuthorityRegistry } from './agent';
import { sessionWorktree } from './worktree';

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function resolveSessionCwd(conversationId?: string, projectId?: string): string {
  const worktree = conversationId ? sessionWorktree(conversationId) : undefined;
  const project = projectId ? getSourceAuthorityRegistry()?.project(projectId) : undefined;
  return pickSessionCwd({
    worktreePath: worktree?.path,
    projectPath: project?.state === 'active' ? project.canonicalPath : undefined,
    ssh: project?.kind === 'ssh',
    home: os.homedir(),
    exists: isDirectory,
  });
}

function toCreateRequest(value: unknown): TerminalCreateRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.termId !== 'string' || v.termId.length === 0) return null;
  return {
    termId: v.termId,
    conversationId: typeof v.conversationId === 'string' ? v.conversationId : undefined,
    projectId: typeof v.projectId === 'string' ? v.projectId : undefined,
    cols: typeof v.cols === 'number' ? v.cols : undefined,
    rows: typeof v.rows === 'number' ? v.rows : undefined,
  };
}

export function registerTerminalHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.TERMINAL_CREATE, (event, request: unknown): TerminalCreateResult => {
    const parsed = toCreateRequest(request);
    if (!parsed) return { ok: false, error: 'Invalid request' };
    return createTerminal(
      parsed,
      event.sender,
      resolveSessionCwd(parsed.conversationId, parsed.projectId)
    );
  });

  ipcMain.handle(IPC_CHANNELS.TERMINAL_WRITE, (_event, termId: unknown, data: unknown): void => {
    if (typeof termId !== 'string' || typeof data !== 'string') return;
    writeTerminal(termId, data);
  });

  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_RESIZE,
    (_event, termId: unknown, cols: unknown, rows: unknown): void => {
      if (typeof termId !== 'string' || typeof cols !== 'number' || typeof rows !== 'number')
        return;
      resizeTerminal(termId, Math.floor(cols), Math.floor(rows));
    }
  );

  ipcMain.handle(IPC_CHANNELS.TERMINAL_DISPOSE, (_event, termId: unknown): void => {
    if (typeof termId !== 'string') return;
    disposeTerminal(termId);
  });
}
