import { ipcMain } from '@platform';
import { resolveSshTarget } from '@shared/ssh';
import { IPC_CHANNELS, type SshHostKeyChallenge } from '@shared/types';
import { isMainRenderer, isSettingsRenderer } from '../services/renderers';
import { getSshConnectionStore, type SshConnectionUpsert } from '../services/sshConnectionStore';
import { trustSshHostKey } from '../services/sshHostKey';
import { type SshProbeError, sshListRemoteDirs, sshProbeLogin } from '../services/sshProbe';
import { getSourceAuthorityRegistry } from './agent';

/** 展示过的主机密钥在这段时间内可凭它信任，过期须重新测试 */
const SHOWN_HOST_KEY_TTL_MS = 10 * 60_000;

/**
 * 测试连接 / 列目录时展示给用户的主机密钥，按连接 id 记在 Main。
 * 渲染层「信任」只传 id，Main 必须以用户核对过的指纹为准，而不是信任那一刻服务器出示的任意密钥。
 */
const shownHostKeys = new Map<string, { challenge: SshHostKeyChallenge; at: number }>();

function rememberShownHostKey(id: string, challenge: SshHostKeyChallenge | undefined): void {
  if (challenge) shownHostKeys.set(id, { challenge, at: Date.now() });
}

function shownHostKey(id: string): SshHostKeyChallenge | null {
  const shown = shownHostKeys.get(id);
  if (!shown || Date.now() - shown.at > SHOWN_HOST_KEY_TTL_MS) return null;
  return shown.challenge;
}

/** 信任后的登录：仍卡在主机密钥才算失败；认证等其它错误留给随后的重新测试展示 */
function trustOutcome(failure: SshProbeError | null): { ok: true } | { ok: false; error: string } {
  if (!failure || (!failure.hostKey && !/主机密钥未信任/.test(failure.error))) {
    return { ok: true };
  }
  return { ok: false, error: failure.error };
}

function isTrustedWindow(webContentsId: number): boolean {
  return isMainRenderer(webContentsId) || isSettingsRenderer(webContentsId);
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
    const result = getSshConnectionStore().upsert(parsed);
    if (result.ok) getSourceAuthorityRegistry()?.notifyProjection();
    return result;
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
      const result = await sshListRemoteDirs(resolveSshTarget(secret), remotePath || undefined, {
        auth: secret.auth,
        port: secret.port,
        password: secret.password,
        keyscanHost: secret.host,
      });
      // 添加项目「浏览目录」同样会弹信任框
      if (!result.ok) rememberShownHostKey(id, result.hostKey);
      return result;
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
      keyscanHost: secret.host,
    });
    rememberShownHostKey(id, failure?.hostKey);
    return failure ? { ok: false, ...failure } : { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.SSH_CONNECTIONS_TRUST_HOST, async (event, id: unknown) => {
    if (!isTrustedWindow(event.sender.id) || typeof id !== 'string') {
      return { ok: false, error: 'Invalid request.' };
    }
    const secret = getSshConnectionStore().getSecret(id);
    if (!secret) return { ok: false, error: '连接不存在。' };
    const shown = shownHostKey(id);
    if (!shown) return { ok: false, error: '请先测试连接并核对主机密钥。' };
    const target = resolveSshTarget(secret);
    const login = { auth: secret.auth, port: secret.port, password: secret.password };
    const trusted = await trustSshHostKey(shown);
    // 写入后不带 accept-new 再登录一次，确认 ssh 认这条记录（别名与 HostName 对不上时会失败）
    if (trusted.ok) return trustOutcome(await sshProbeLogin(target, login));
    // 取舍：弹窗没有指纹（keyscan 扫不到，常见于 ssh config 别名）时，用户确认的本就是
    // 「信任首次出示的密钥」，保留 accept-new；展示过指纹则绝不回退，否则等于放过中间人
    if (trusted.reason === 'unavailable' && !shown.fingerprint) {
      return trustOutcome(
        await sshProbeLogin(target, { ...login, strictHostKeyChecking: 'accept-new' })
      );
    }
    return { ok: false, error: trusted.error };
  });
}
