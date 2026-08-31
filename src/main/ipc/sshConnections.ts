import { resolveSshTarget } from '@shared/ssh';
import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';
import { getSshConnectionStore, type SshConnectionUpsert } from '../services/sshConnectionStore';
import { sshListRemoteDirs, sshProbeLogin } from '../services/sshProbe';
import { isMainWebContents } from '../windows/MainWindow';
import { isSettingsWebContents } from '../windows/SettingsWindow';
import { getSourceAuthorityRegistry } from './agent';

function isTrustedWindow(webContentsId: number): boolean {
  return isMainWebContents(webContentsId) || isSettingsWebContents(webContentsId);
}

function parseUpsert(value: unknown): SshConnectionUpsert | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.name !== 'string' || typeof row.host !== 'string') return null;
  if (row.auth !== 'key' && row.auth !== 'password') return null;
  if (row.id !== undefined && typeof row.id !== 'string') return null;
  if (row.user !== undefined && typeof row.user !== 'string') return null;
  if (row.port !== undefined && typeof row.port !== 'number') return null;
  if (row.password !== undefined && typeof row.password !== 'string') return null;
  return {
    name: row.name,
    host: row.host,
    auth: row.auth,
    ...(typeof row.id === 'string' ? { id: row.id } : {}),
    ...(typeof row.user === 'string' ? { user: row.user } : {}),
    ...(typeof row.port === 'number' ? { port: row.port } : {}),
    ...(typeof row.password === 'string' ? { password: row.password } : {}),
  };
}

export function registerSshConnectionHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.SSH_CONNECTIONS_LIST, (event) => {
    if (!isTrustedWindow(event.sender.id)) return [];
    return getSshConnectionStore().list();
  });

  ipcMain.handle(IPC_CHANNELS.SSH_CONNECTIONS_UPSERT, (event, request: unknown) => {
    if (!isTrustedWindow(event.sender.id)) return { ok: false, error: 'Invalid request.' };
    const parsed = parseUpsert(request);
    if (!parsed) return { ok: false, error: 'Invalid SSH connection.' };
    return getSshConnectionStore().upsert(parsed);
  });

  ipcMain.handle(IPC_CHANNELS.SSH_CONNECTIONS_DELETE, (event, id: unknown) => {
    if (!isTrustedWindow(event.sender.id) || typeof id !== 'string') {
      return { ok: false, error: 'Invalid request.' };
    }
    const registry = getSourceAuthorityRegistry();
    if (registry?.sshConnectionInUse(id)) {
      return { ok: false, error: '仍有远程项目使用此连接,请先删除项目。' };
    }
    return getSshConnectionStore().delete(id);
  });

  ipcMain.handle(
    IPC_CHANNELS.SSH_CONNECTIONS_LIST_DIRS,
    async (event, id: unknown, remotePath: unknown) => {
      if (!isTrustedWindow(event.sender.id) || typeof id !== 'string') {
        return { ok: false, error: 'Invalid request.' };
      }
      if (remotePath !== undefined && typeof remotePath !== 'string') {
        return { ok: false, error: 'Invalid request.' };
      }
      const secret = getSshConnectionStore().getSecret(id);
      if (!secret) return { ok: false, error: '连接不存在。' };
      return sshListRemoteDirs(resolveSshTarget(secret), remotePath || undefined, {
        auth: secret.auth,
        port: secret.port,
        password: secret.password,
      });
    }
  );

  ipcMain.handle(IPC_CHANNELS.SSH_CONNECTIONS_TEST, async (event, id: unknown) => {
    if (!isTrustedWindow(event.sender.id) || typeof id !== 'string') {
      return { ok: false, error: 'Invalid request.' };
    }
    const secret = getSshConnectionStore().getSecret(id);
    if (!secret) return { ok: false, error: '连接不存在。' };
    const failure = await sshProbeLogin(resolveSshTarget(secret), {
      auth: secret.auth,
      port: secret.port,
      password: secret.password,
    });
    return failure ? { ok: false, error: failure } : { ok: true };
  });
}
