import type { UpdateStatus } from '@shared/types/updater';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerUpdater, type ServerUpdaterDeps } from './serverUpdater';

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

  it('supervisor 下 restart 直接退出交给守护拉起', () => {
    const quit = vi.fn();
    const spawnReexec = vi.fn();
    updater({ quit, env: { ENSO_SUPERVISED: '1' }, spawnReexec }).restart();
    expect(quit).toHaveBeenCalledOnce();
    expect(spawnReexec).not.toHaveBeenCalled();
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

describe('ServerUpdater 重启能力与优雅应用', () => {
  it('restartMethod 按环境探测：systemd/pm2 是 supervisor，裸跑是 reexec，PID1 是 manual', () => {
    expect(updater({ env: { INVOCATION_ID: 'x' } }).state().restartMethod).toBe('supervisor');
    expect(updater({ env: { pm_id: '0' } }).state().restartMethod).toBe('supervisor');
    expect(updater({ env: {} }).state().restartMethod).toBe('reexec');
    expect(updater({ env: {}, pid: 1 }).state().restartMethod).toBe('manual');
  });

  it('canRestart 与 restartMethod 一致：manual 才算不能重启', () => {
    expect(updater({ env: {} }).state().canRestart).toBe(true);
    expect(updater({ env: {}, pid: 1 }).state().canRestart).toBe(false);
  });

  it('裸跑（reexec）restart 默认优雅：空闲时立即拉起替代进程后退出，不抛错', async () => {
    const quit = vi.fn();
    const spawnReexec = vi.fn();
    updater({ quit, env: {}, spawnReexec }).restart();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    expect(spawnReexec).toHaveBeenCalledOnce();
  });

  it('restart(true) 立即重启：有任务在跑也不等待', async () => {
    const quit = vi.fn();
    const u = updater({ quit, env: {}, spawnReexec: vi.fn(), busyCount: () => 3 });
    u.restart(true);
    expect(quit).toHaveBeenCalledOnce();
  });

  it('restart 默认优雅：有任务在跑时先广播 waiting-tasks，空闲后才退出', async () => {
    const now = { value: 1000 };
    let busy = 2;
    const quit = vi.fn();
    const u = updater({
      env: {},
      spawnReexec: vi.fn(),
      quit,
      now: () => now.value,
      busyCount: () => busy,
      waitForTasksMs: 60_000,
      waitPollMs: 10,
    });
    u.restart();
    await vi.waitFor(() => {
      expect(
        statuses.some((s) => s.status === 'applying' && s.applying?.stage === 'waiting-tasks')
      ).toBe(true);
    });
    expect(quit).not.toHaveBeenCalled();
    busy = 0;
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
  });

  it('manual（容器 PID1）restart 仍然抛错', () => {
    expect(() => updater({ env: {}, pid: 1 }).restart()).toThrow();
  });

  it('自动更新下载完成后立即优雅应用：不等空闲档位、不依赖 autoRestart 设置', async () => {
    const quit = vi.fn();
    const u = updater({ env: { INVOCATION_ID: 'x' }, quit });
    u.start(true, 'off');
    await u.checkForUpdates();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce(), { timeout: 5_000 });
    const stages = statuses.filter((s) => s.status === 'applying').map((s) => s.applying?.stage);
    expect(stages).toContain('installing');
  });

  it('manual 重启方式下自动更新只下载不应用：退出没人拉起，不能自杀', async () => {
    const quit = vi.fn();
    const u = updater({ env: {}, pid: 1, quit });
    u.start(true, 'immediate');
    await u.checkForUpdates();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(quit).not.toHaveBeenCalled();
    expect(statuses.at(-1)?.status).toBe('downloaded');
  });

  it('quitAndInstall 写健康检查标记并广播 installing/restarting 阶段', async () => {
    const writePending = vi.fn();
    const u = updater({ env: { INVOCATION_ID: 'x' }, writePending });
    await u.checkForUpdates();
    await u.downloadUpdate();
    await u.quitAndInstall();
    expect(writePending).toHaveBeenCalledWith({ from: '0.2.12', to: '0.3.0' });
    const stages = statuses.filter((s) => s.status === 'applying').map((s) => s.applying?.stage);
    expect(stages).toContain('installing');
    expect(stages.at(-1)).toBe('restarting');
  });

  it('有任务在跑时先广播 waiting-tasks 并携带 busyCount，空闲后继续安装', async () => {
    const now = { value: 1000 };
    let busy = 2;
    const u = updater({
      env: { INVOCATION_ID: 'x' },
      now: () => now.value,
      busyCount: () => busy,
    });
    await u.checkForUpdates();
    await u.downloadUpdate();
    const applying = u.quitAndInstall();
    await vi.waitFor(() => {
      const waiting = statuses.find(
        (s) => s.status === 'applying' && s.applying?.stage === 'waiting-tasks'
      );
      expect(waiting?.applying?.busyCount).toBe(2);
      expect(waiting?.applying?.deadlineMs).toBeGreaterThan(now.value);
    });
    expect(npm.install).not.toHaveBeenCalled();
    busy = 0;
    await applying;
    expect(npm.install).toHaveBeenCalledWith('@ensocode/server@0.3.0');
  });

  it('等待超过上限后仍然继续安装（turn 由退出时的安全中断机制兜底续跑）', async () => {
    const now = { value: 1000 };
    const u = updater({
      env: { INVOCATION_ID: 'x' },
      now: () => now.value,
      busyCount: () => 3,
      waitForTasksMs: 60_000,
      waitPollMs: 10,
    });
    await u.checkForUpdates();
    await u.downloadUpdate();
    const applying = u.quitAndInstall();
    await new Promise((r) => setTimeout(r, 30));
    now.value += 61_000;
    await applying;
    expect(npm.install).toHaveBeenCalled();
  });

  it('安装失败：清除健康检查标记，不误判下回启动为崩溃', async () => {
    const writePending = vi.fn();
    const clearPending = vi.fn();
    npm.install.mockRejectedValueOnce(new Error('EACCES'));
    const u = updater({ env: { INVOCATION_ID: 'x' }, writePending, clearPending });
    await u.checkForUpdates();
    await u.downloadUpdate();
    await u.quitAndInstall();
    expect(clearPending).toHaveBeenCalledOnce();
  });
});
