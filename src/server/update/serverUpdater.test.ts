import type { UpdateStatus } from '@shared/types/updater';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerUpdater, type ServerUpdaterDeps } from './serverUpdater';

const idle = () => ({
  agentBusy: false,
  userActive: false,
  unsentDraft: false,
  windowFocused: false,
  queuedCount: 0,
  pendingAskCount: 0,
  pendingApprovalCount: 0,
});

const latest = (version: string) =>
  vi.fn(async (url: string, _init?: RequestInit) =>
    url.endsWith('/@ensocode%2fserver/latest')
      ? Response.json({ name: '@ensocode/server', version })
      : new Response('', { status: 404 })
  );

/** 两个 dist-tag 各自独立：latest 是正式版，beta 是内测版 */
const tags = (stable: string | null, beta: string | null) =>
  vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith('/@ensocode%2fserver/latest')) {
      return stable
        ? Response.json({ name: '@ensocode/server', version: stable })
        : new Response('', { status: 404 });
    }
    if (url.endsWith('/@ensocode%2fserver/beta')) {
      return beta
        ? Response.json({ name: '@ensocode/server', version: beta })
        : new Response('', { status: 404 });
    }
    return new Response('', { status: 404 });
  });

let statuses: UpdateStatus[];
let npm: {
  prefetch: ReturnType<typeof vi.fn<(spec: string) => Promise<void>>>;
  install: ReturnType<typeof vi.fn<(spec: string) => Promise<void>>>;
};

function updater(overrides: Partial<ServerUpdaterDeps> = {}): ServerUpdater {
  return new ServerUpdater({
    version: '0.2.12',
    packageName: '@ensocode/server',
    env: {},
    fetch: latest('0.3.0'),
    npm,
    broadcast: (status) => statuses.push(status),
    quit: vi.fn(),
    idle,
    ...overrides,
  });
}

beforeEach(() => {
  statuses = [];
  npm = { prefetch: vi.fn(async () => {}), install: vi.fn(async () => {}) };
});

describe('ServerUpdater (npm)', () => {
  it('prefetches the new version, then installs it globally and exits on apply', async () => {
    const quit = vi.fn();
    const u = updater({ quit, env: { INVOCATION_ID: 'x' } });
    expect(u.state()).toMatchObject({ host: 'server', mode: 'npm', canRestart: true });
    await u.checkForUpdates();
    expect(statuses.at(-1)).toMatchObject({ status: 'available', info: { version: '0.3.0' } });
    await u.downloadUpdate();
    expect(npm.prefetch).toHaveBeenCalledWith('@ensocode/server@0.3.0');
    expect(statuses.at(-1)).toMatchObject({ status: 'downloaded', info: { version: '0.3.0' } });
    await u.quitAndInstall();
    expect(npm.install).toHaveBeenCalledWith('@ensocode/server@0.3.0');
    expect(quit).toHaveBeenCalledOnce();
  });

  it('stays up and reports the error when npm install fails', async () => {
    const quit = vi.fn();
    npm.install.mockRejectedValueOnce(new Error('EACCES'));
    const u = updater({ quit });
    await u.checkForUpdates();
    await u.downloadUpdate();
    await u.quitAndInstall();
    expect(quit).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toMatchObject({ status: 'error', error: 'EACCES' });
  });

  it('only reports new versions when npm cannot install globally', async () => {
    const u = updater({ npm: null });
    expect(u.state().mode).toBe('manual');
    await u.checkForUpdates();
    await u.downloadUpdate();
    expect(statuses.at(-1)).toMatchObject({ status: 'error' });
  });

  it('says up to date when the registry is not newer', async () => {
    const u = updater({ fetch: latest('0.2.12') });
    await u.checkForUpdates();
    expect(statuses.at(-1)).toMatchObject({ status: 'not-available' });
  });

  it('uses a custom registry', async () => {
    const fetch = latest('0.3.0');
    const u = updater({ fetch, env: { ENSO_NPM_REGISTRY: 'http://127.0.0.1:4873' } });
    await u.checkForUpdates();
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:4873/@ensocode%2fserver/latest',
      expect.anything()
    );
  });

  it('restarts only under a supervisor', () => {
    const quit = vi.fn();
    expect(() => updater({ quit }).restart()).toThrow();
    updater({ quit, env: { ENSO_SUPERVISED: '1' } }).restart();
    expect(quit).toHaveBeenCalledOnce();
  });
});

describe('ServerUpdater 更新渠道', () => {
  it('默认 stable 渠道：只查 latest dist-tag，看不到 beta', async () => {
    const fetch = tags('0.3.0', '0.3.1-beta.5');
    const u = updater({ fetch });
    expect(u.state().channel).toBe('stable');
    await u.checkForUpdates();
    expect(statuses.at(-1)).toMatchObject({ status: 'available', info: { version: '0.3.0' } });
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/latest$/), expect.anything());
    expect(fetch).not.toHaveBeenCalledWith(expect.stringMatching(/\/beta$/), expect.anything());
  });

  it('stable 渠道不升到 beta：beta 更新也不选它', async () => {
    const u = updater({ fetch: tags('0.2.12', '0.9.9-beta.3') });
    await u.checkForUpdates();
    expect(statuses.at(-1)).toMatchObject({ status: 'not-available' });
  });

  it('beta 渠道取 beta 与 latest 中较新的那个', async () => {
    const u = updater({ fetch: tags('0.3.0', '0.3.1-beta.2') });
    u.setChannel('beta');
    expect(u.state().channel).toBe('beta');
    await u.checkForUpdates();
    expect(statuses.at(-1)).toMatchObject({
      status: 'available',
      info: { version: '0.3.1-beta.2' },
    });

    const newerStable = updater({ fetch: tags('0.4.0', '0.3.1-beta.9') });
    newerStable.setChannel('beta');
    await newerStable.checkForUpdates();
    expect(statuses.at(-1)).toMatchObject({ status: 'available', info: { version: '0.4.0' } });
  });

  it('beta 渠道在 beta dist-tag 不存在时回退到 latest', async () => {
    const u = updater({ fetch: tags('0.3.0', null) });
    u.setChannel('beta');
    await u.checkForUpdates();
    expect(statuses.at(-1)).toMatchObject({ status: 'available', info: { version: '0.3.0' } });
  });

  it('beta 渠道在 beta dist-tag 请求失败时仍用 latest，不报错', async () => {
    const fetch = vi.fn(async (url: string, _init?: RequestInit) =>
      url.endsWith('/latest')
        ? Response.json({ name: '@ensocode/server', version: '0.3.0' })
        : new Response('', { status: 500 })
    );
    const u = updater({ fetch });
    u.setChannel('beta');
    await u.checkForUpdates();
    expect(statuses.at(-1)).toMatchObject({ status: 'available', info: { version: '0.3.0' } });
  });

  it('从 beta 切回 stable 不降级：正式版更旧就报已是最新', async () => {
    const u = updater({ version: '0.3.1-beta.2', fetch: tags('0.3.0', '0.3.1-beta.9') });
    u.setChannel('beta');
    await u.checkForUpdates();
    expect(statuses.at(-1)).toMatchObject({
      status: 'available',
      info: { version: '0.3.1-beta.9' },
    });
    u.setChannel('stable');
    await u.checkForUpdates();
    expect(statuses.at(-1)).toMatchObject({ status: 'not-available' });
  });

  it('切换渠道重新检查，已下载但不属于新渠道的版本作废', async () => {
    const u = updater({ fetch: tags('0.3.0', '0.3.1-beta.5') });
    u.setChannel('beta');
    await u.checkForUpdates();
    await u.downloadUpdate();
    expect(statuses.at(-1)).toMatchObject({
      status: 'downloaded',
      info: { version: '0.3.1-beta.5' },
    });
    u.setChannel('stable');
    await vi.waitFor(() => {
      expect(statuses.at(-1)).toMatchObject({ status: 'available', info: { version: '0.3.0' } });
    });
    // 作废 beta 下载后，下载到的应是 stable 渠道的版本
    await u.downloadUpdate();
    expect(npm.prefetch).toHaveBeenLastCalledWith('@ensocode/server@0.3.0');
  });
});
