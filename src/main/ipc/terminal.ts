import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSshPtyArgs, resolveSshTarget } from '@shared/ssh';
import type { TerminalCreateRequest, TerminalCreateResult } from '@shared/types';
import { IPC_CHANNELS } from '@shared/types';
import { app, ipcMain } from 'electron';
import { resolveSshControlPath, sshPasswordEnv } from '../../agent/ssh/executor';
import { getSshConnectionStore } from '../services/sshConnectionStore';
import {
  createTerminal,
  disposeTerminal,
  localShellSpec,
  pickSessionCwd,
  resizeTerminal,
  type TerminalSpawnSpec,
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

function sshControlDir(): string {
  return path.join(app.getPath('userData'), 'agent', 'pi-agent', 'ssh');
}

function resolveSpawnSpec(conversationId?: string, projectId?: string): TerminalSpawnSpec {
  const project = projectId ? getSourceAuthorityRegistry()?.project(projectId) : undefined;
  if (project?.kind === 'ssh' && project.state === 'active') {
    const secret = project.sshConnectionId
      ? getSshConnectionStore().getSecret(project.sshConnectionId)
      : undefined;
    const host = secret
      ? resolveSshTarget(secret)
      : project.sshHost
        ? resolveSshTarget({ host: project.sshHost })
        : undefined;
    if (host) {
      const controlDir = sshControlDir();
      const auth = secret?.auth ?? 'key';
      const args = buildSshPtyArgs(host, {
        cwd: project.canonicalPath,
        controlPath: resolveSshControlPath(controlDir),
        auth,
        ...(secret?.port ? { port: secret.port } : {}),
      });
      const env =
        auth === 'password' && secret?.password
          ? (sshPasswordEnv(controlDir, secret.password) as Record<string, string>)
          : ({ ...process.env, TERM: 'xterm-256color', TERM_PROGRAM: 'EnsoCode' } as Record<
              string,
              string
            >);
      if (env) {
        env.TERM = 'xterm-256color';
        env.TERM_PROGRAM = 'EnsoCode';
      }
      return { file: 'ssh', args, cwd: os.homedir(), env };
    }
  }
  const worktree = conversationId ? sessionWorktree(conversationId) : undefined;
  const cwd = pickSessionCwd({
    worktreePath: worktree?.path,
    projectPath: project?.state === 'active' ? project.canonicalPath : undefined,
    ssh: project?.kind === 'ssh',
    home: os.homedir(),
    exists: isDirectory,
  });
  return localShellSpec(cwd);
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
      resolveSpawnSpec(parsed.conversationId, parsed.projectId)
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
