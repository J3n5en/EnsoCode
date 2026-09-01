import { statSync } from 'node:fs';
import path from 'node:path';
import { resolveSshTarget } from '@shared/ssh';
import type {
  FilesListResult,
  FilesReadRelResult,
  FilesWatchEvent,
  FilesWatchResult,
  FilesWriteResult,
} from '@shared/types';
import { IPC_CHANNELS } from '@shared/types';
import { app, type IpcMainInvokeEvent, ipcMain } from 'electron';
import { createSshExecutor } from '../../agent/ssh/executor';
import {
  EDITOR_MAX_BYTES,
  IGNORED_DIR_NAMES,
  listLocalDir,
  RefCountWatchers,
  readLocalFile,
  resolveUnderCwd,
  watchLocalFile,
  writeLocalFile,
} from '../services/filesWorkspace';
import { getSshConnectionStore } from '../services/sshConnectionStore';
import { pickSessionCwd } from '../services/terminalService';
import { getSourceAuthorityRegistry } from './agent';
import { sessionWorktree } from './worktree';

const watches = new RefCountWatchers();
const hookedSenders = new Set<number>();
const sshPollHashes = new Map<string, string>();

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

function parseRequest(
  request: unknown
): { conversationId: string; projectId: string; rel: string } | null {
  if (!request || typeof request !== 'object') return null;
  const conversationId = (request as { conversationId?: unknown }).conversationId;
  const projectId = (request as { projectId?: unknown }).projectId;
  const rel = (request as { rel?: unknown }).rel;
  if (!isNonEmptyString(conversationId) || !isNonEmptyString(projectId)) return null;
  if (rel !== undefined && typeof rel !== 'string') return null;
  return { conversationId, projectId, rel: typeof rel === 'string' ? rel : '' };
}

function resolveLocalCwd(conversationId: string, projectId: string): string | null {
  const project = getSourceAuthorityRegistry()?.project(projectId);
  if (project?.kind === 'ssh') return null;
  const worktreePath = sessionWorktree(conversationId)?.path;
  const projectPath = project?.state === 'active' ? project.canonicalPath : undefined;
  const cwd = pickSessionCwd({
    worktreePath,
    projectPath,
    home: '',
    exists: isDirectory,
  });
  return cwd || null;
}

function sshControlDir(): string {
  return path.join(app.getPath('userData'), 'agent', 'pi-agent', 'ssh');
}

function createProjectSsh(projectId: string) {
  const project = getSourceAuthorityRegistry()?.project(projectId);
  if (project?.kind !== 'ssh' || project.state !== 'active') return null;
  const secret = project.sshConnectionId
    ? getSshConnectionStore().getSecret(project.sshConnectionId)
    : undefined;
  const host = secret
    ? resolveSshTarget(secret)
    : project.sshHost
      ? resolveSshTarget({ host: project.sshHost })
      : undefined;
  if (!host) return null;
  const controlDir = sshControlDir();
  const executor = createSshExecutor(host, controlDir, undefined, {
    auth: secret?.auth ?? 'key',
    ...(secret?.port ? { port: secret.port } : {}),
    ...(secret?.password ? { password: secret.password } : {}),
  });
  return { executor, cwd: project.canonicalPath };
}

function hookDestroyed(event: IpcMainInvokeEvent): void {
  const id = event.sender.id;
  if (hookedSenders.has(id)) return;
  hookedSenders.add(id);
  event.sender.once('destroyed', () => {
    hookedSenders.delete(id);
    const prefix = `${id}:`;
    watches.releaseAll((key) => key.startsWith(prefix));
  });
}

function watchKey(senderId: number, conversationId: string, rel: string): string {
  return `${senderId}:${conversationId}:${rel}`;
}

export function registerFilesWorkspaceHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.FILES_LIST_DIR,
    async (_event, request: unknown): Promise<FilesListResult> => {
      const parsed = parseRequest(request);
      if (!parsed) return { ok: false, error: 'unavailable' };
      const ssh = createProjectSsh(parsed.projectId);
      if (ssh) {
        const abs = resolveUnderCwd(ssh.cwd, parsed.rel);
        if (!abs) return { ok: false, error: 'invalid-path' };
        const listed = await ssh.executor.exec(['ls', '-1Ap'], { cwd: abs, timeoutMs: 15_000 });
        if (listed.code !== 0) return { ok: false, error: 'unavailable' };
        const entries = listed.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((name) => name && name !== './' && name !== '../')
          .flatMap((name) => {
            const dir = name.endsWith('/');
            const base = dir ? name.slice(0, -1) : name;
            if (!base || base.startsWith('.')) return [];
            if (dir && IGNORED_DIR_NAMES.has(base)) return [];
            return [{ name: base, kind: dir ? ('dir' as const) : ('file' as const) }];
          });
        return { ok: true, entries };
      }
      const cwd = resolveLocalCwd(parsed.conversationId, parsed.projectId);
      if (!cwd) return { ok: false, error: 'unavailable' };
      const abs = resolveUnderCwd(cwd, parsed.rel);
      if (!abs) return { ok: false, error: 'invalid-path' };
      return { ok: true, entries: listLocalDir(abs) };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.FILES_READ_REL,
    async (_event, request: unknown): Promise<FilesReadRelResult> => {
      const parsed = parseRequest(request);
      if (!parsed?.rel) return { ok: false, error: 'unavailable' };
      const ssh = createProjectSsh(parsed.projectId);
      if (ssh) {
        const abs = resolveUnderCwd(ssh.cwd, parsed.rel);
        if (!abs) return { ok: false, error: 'invalid-path' };
        const sized = await ssh.executor.exec(['wc', '-c', '--', abs], { timeoutMs: 10_000 });
        const bytes = Number.parseInt(sized.stdout.trim().split(/\s+/)[0] ?? '', 10);
        if (Number.isFinite(bytes) && bytes > EDITOR_MAX_BYTES)
          return { ok: false, error: 'too-large' };
        const result = await ssh.executor.exec(['cat', '--', abs], { timeoutMs: 20_000 });
        if (result.code !== 0) return { ok: false, error: 'unavailable' };
        if (result.stdout.includes('\0')) return { ok: false, error: 'binary' };
        return { ok: true, content: result.stdout };
      }
      const cwd = resolveLocalCwd(parsed.conversationId, parsed.projectId);
      if (!cwd) return { ok: false, error: 'unavailable' };
      const abs = resolveUnderCwd(cwd, parsed.rel);
      if (!abs) return { ok: false, error: 'invalid-path' };
      return readLocalFile(abs);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.FILES_WRITE,
    async (_event, request: unknown): Promise<FilesWriteResult> => {
      const parsed = parseRequest(request);
      const content =
        request && typeof request === 'object'
          ? (request as { content?: unknown }).content
          : undefined;
      if (!parsed?.rel || typeof content !== 'string') return { ok: false, error: 'unavailable' };
      const ssh = createProjectSsh(parsed.projectId);
      if (ssh) {
        const abs = resolveUnderCwd(ssh.cwd, parsed.rel);
        if (!abs) return { ok: false, error: 'invalid-path' };
        const result = await ssh.executor.exec(['tee', '--', abs], {
          stdin: content,
          timeoutMs: 20_000,
        });
        if (result.code !== 0) return { ok: false, error: 'unavailable' };
        return { ok: true };
      }
      const cwd = resolveLocalCwd(parsed.conversationId, parsed.projectId);
      if (!cwd) return { ok: false, error: 'unavailable' };
      const abs = resolveUnderCwd(cwd, parsed.rel);
      if (!abs) return { ok: false, error: 'invalid-path' };
      if (!writeLocalFile(abs, content)) return { ok: false, error: 'unavailable' };
      return { ok: true };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.FILES_WATCH_START,
    async (event, request: unknown): Promise<FilesWatchResult> => {
      const parsed = parseRequest(request);
      if (!parsed?.rel) return { ok: false, error: 'unavailable' };
      hookDestroyed(event);
      const key = watchKey(event.sender.id, parsed.conversationId, parsed.rel);
      const ssh = createProjectSsh(parsed.projectId);
      if (ssh) {
        const abs = resolveUnderCwd(ssh.cwd, parsed.rel);
        if (!abs) return { ok: false, error: 'invalid-path' };
        watches.acquire(key, () => {
          let timer: ReturnType<typeof setInterval> | undefined;
          const tick = async () => {
            const result = await ssh.executor.exec(['cksum', '--', abs], { timeoutMs: 10_000 });
            if (result.code !== 0) return;
            const prev = sshPollHashes.get(key);
            if (prev === result.stdout) return;
            sshPollHashes.set(key, result.stdout);
            if (prev === undefined) return;
            if (event.sender.isDestroyed()) return;
            const payload: FilesWatchEvent = {
              conversationId: parsed.conversationId,
              rel: parsed.rel,
              type: 'change',
            };
            event.sender.send(IPC_CHANNELS.FILES_WATCH_EVENT, payload);
          };
          void tick();
          timer = setInterval(() => void tick(), 2000);
          return () => {
            if (timer) clearInterval(timer);
            sshPollHashes.delete(key);
          };
        });
        return { ok: true };
      }
      const cwd = resolveLocalCwd(parsed.conversationId, parsed.projectId);
      if (!cwd) return { ok: false, error: 'unavailable' };
      const abs = resolveUnderCwd(cwd, parsed.rel);
      if (!abs) return { ok: false, error: 'invalid-path' };
      watches.acquire(key, () =>
        watchLocalFile(abs, () => {
          if (event.sender.isDestroyed()) return;
          const payload: FilesWatchEvent = {
            conversationId: parsed.conversationId,
            rel: parsed.rel,
            type: 'change',
          };
          event.sender.send(IPC_CHANNELS.FILES_WATCH_EVENT, payload);
        })
      );
      return { ok: true };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.FILES_WATCH_STOP,
    async (event, request: unknown): Promise<FilesWatchResult> => {
      const parsed = parseRequest(request);
      if (!parsed?.rel) return { ok: false, error: 'unavailable' };
      watches.release(watchKey(event.sender.id, parsed.conversationId, parsed.rel));
      return { ok: true };
    }
  );
}
