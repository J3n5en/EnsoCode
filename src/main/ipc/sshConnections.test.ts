import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  getSecret: vi.fn(),
  probeLogin: vi.fn(),
  listDirs: vi.fn(),
  keyscan: vi.fn(),
  knownHostsFile: '',
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
  },
}));
vi.mock('../services/renderers', () => ({
  isMainRenderer: (id: number) => id === 1,
  isSettingsRenderer: () => false,
}));
vi.mock('../services/sshConnectionStore', () => ({
  getSshConnectionStore: () => ({ getSecret: mocks.getSecret }),
}));
vi.mock('../services/sshProbe', () => ({
  sshProbeLogin: mocks.probeLogin,
  sshListRemoteDirs: mocks.listDirs,
}));
vi.mock('./agent', () => ({ getSourceAuthorityRegistry: () => null }));
vi.mock('../services/sshHostKey', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/sshHostKey')>();
  return {
    ...actual,
    // 真实的重扫比对与写入；只把 known_hosts 换成临时文件、ssh-keyscan 换成桩
    trustSshHostKey: (confirmed: Parameters<typeof actual.trustSshHostKey>[0]) =>
      actual.trustSshHostKey(confirmed, mocks.knownHostsFile, mocks.keyscan),
  };
});

import { IPC_CHANNELS } from '@shared/types';
import { sshKeyFingerprint } from '../services/sshHostKey';
import { registerSshConnectionHandlers } from './sshConnections';

const KEY_A = Buffer.from('enso-host-key-A').toString('base64');
const KEY_B = Buffer.from('enso-host-key-B').toString('base64');
const event = { sender: { id: 1 } };

const invoke = (channel: string, ...args: unknown[]) =>
  Promise.resolve(mocks.handlers.get(channel)?.(event, ...args));

const knownHosts = () =>
  existsSync(mocks.knownHostsFile) ? readFileSync(mocks.knownHostsFile, 'utf8') : '';

const acceptNewLogins = () =>
  mocks.probeLogin.mock.calls.filter(
    ([, options]) => (options as { strictHostKeyChecking?: string })?.strictHostKeyChecking
  );

function untrustedChallenge(key: string | null) {
  return {
    error: 'SSH 主机密钥未信任。',
    hostKey: {
      host: 'dev.example',
      port: 22,
      keyType: key ? 'ssh-ed25519' : '',
      fingerprint: key ? sshKeyFingerprint(key) : '',
    },
  };
}

/** 「测试连接」时主机未信任：界面拿到并展示的是这次 keyscan 的指纹 */
async function testShowsHostKey(id: string, key: string | null) {
  mocks.probeLogin.mockResolvedValueOnce(untrustedChallenge(key));
  return invoke(IPC_CHANNELS.SSH_CONNECTIONS_TEST, id);
}

describe('SSH 信任主机', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'enso-ssh-trust-'));
    mocks.knownHostsFile = path.join(tmp, '.ssh', 'known_hosts');
    mocks.handlers.clear();
    mocks.getSecret
      .mockReset()
      .mockImplementation((id: string) => ({ id, name: 'dev', host: 'dev.example', auth: 'key' }));
    mocks.probeLogin.mockReset().mockResolvedValue(null);
    mocks.listDirs.mockReset();
    mocks.keyscan.mockReset();
    registerSshConnectionHandlers();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmp, { recursive: true, force: true });
  });

  // 背景：用户在弹窗里确认的是指纹 A，点「信任」前服务器出示的密钥已被换成 B（中间人）
  it('信任时重扫到的密钥与界面展示的指纹不一致：拒绝，不写 known_hosts 也不走 accept-new', async () => {
    await testShowsHostKey('conn-swapped', KEY_A);
    mocks.keyscan.mockResolvedValue({ stdout: `dev.example ssh-ed25519 ${KEY_B}` });

    const result = await invoke(IPC_CHANNELS.SSH_CONNECTIONS_TRUST_HOST, 'conn-swapped');

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/重新测试/) });
    expect(knownHosts()).toBe('');
    expect(acceptNewLogins()).toHaveLength(0);
  });

  it('重扫指纹与展示一致：只把这把密钥写入 known_hosts，再不带 accept-new 登录验证', async () => {
    await testShowsHostKey('conn-same', KEY_A);
    mocks.keyscan.mockResolvedValue({ stdout: `dev.example ssh-ed25519 ${KEY_A}` });

    const result = await invoke(IPC_CHANNELS.SSH_CONNECTIONS_TRUST_HOST, 'conn-same');

    expect(result).toEqual({ ok: true });
    expect(knownHosts()).toBe(`dev.example ssh-ed25519 ${KEY_A}\n`);
    expect(mocks.probeLogin).toHaveBeenCalledTimes(2);
    expect(acceptNewLogins()).toHaveLength(0);
  });

  // 背景：添加项目时「浏览目录」也会弹同一个信任框，挑战来自 listDirs
  it('列目录时展示的指纹同样作为信任依据', async () => {
    mocks.listDirs.mockResolvedValueOnce({ ok: false, ...untrustedChallenge(KEY_A) });
    await invoke(IPC_CHANNELS.SSH_CONNECTIONS_LIST_DIRS, 'conn-browse');
    mocks.keyscan.mockResolvedValue({ stdout: `dev.example ssh-ed25519 ${KEY_A}` });

    const result = await invoke(IPC_CHANNELS.SSH_CONNECTIONS_TRUST_HOST, 'conn-browse');

    expect(result).toEqual({ ok: true });
    expect(knownHosts()).toBe(`dev.example ssh-ed25519 ${KEY_A}\n`);
  });

  it('没测试过（Main 没记下展示给用户的指纹）就信任：要求先测试，不连主机', async () => {
    mocks.keyscan.mockResolvedValue({ stdout: `dev.example ssh-ed25519 ${KEY_A}` });

    const result = await invoke(IPC_CHANNELS.SSH_CONNECTIONS_TRUST_HOST, 'conn-untested');

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/测试/) });
    expect(mocks.probeLogin).not.toHaveBeenCalled();
    expect(knownHosts()).toBe('');
  });

  it('展示后超过有效期才点信任：要求重新测试', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-12T08:00:00Z'));
    await testShowsHostKey('conn-stale', KEY_A);
    vi.setSystemTime(new Date('2026-11-12T08:11:00Z'));
    mocks.keyscan.mockResolvedValue({ stdout: `dev.example ssh-ed25519 ${KEY_A}` });

    const result = await invoke(IPC_CHANNELS.SSH_CONNECTIONS_TRUST_HOST, 'conn-stale');

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/测试/) });
    expect(knownHosts()).toBe('');
  });

  // 背景：扫描失败时回退 accept-new 等于接受连接那一刻的任意密钥，用户核对过的指纹形同虚设
  it('展示过指纹但信任时扫不到密钥：报错，不静默回退 accept-new', async () => {
    await testShowsHostKey('conn-scan-lost', KEY_A);
    mocks.keyscan.mockRejectedValue(new Error('ssh-keyscan failed'));

    const result = await invoke(IPC_CHANNELS.SSH_CONNECTIONS_TRUST_HOST, 'conn-scan-lost');

    expect(result).toEqual({ ok: false, error: expect.any(String) });
    expect(acceptNewLogins()).toHaveLength(0);
  });

  // 背景：ssh config 别名等 keyscan 解析不了的主机，弹窗只有主机名没有指纹，用户确认的就是首次信任
  it('测试时就拿不到指纹：保留 accept-new 首次信任', async () => {
    await testShowsHostKey('conn-alias', null);
    mocks.keyscan.mockResolvedValue({ stdout: '' });

    const result = await invoke(IPC_CHANNELS.SSH_CONNECTIONS_TRUST_HOST, 'conn-alias');

    expect(result).toEqual({ ok: true });
    expect(acceptNewLogins()).toHaveLength(1);
  });
});
