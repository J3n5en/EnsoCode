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
