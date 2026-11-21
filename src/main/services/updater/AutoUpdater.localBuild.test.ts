import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { UpdateStatus } from '@shared/types/updater';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
  updater: {} as Record<string, unknown>,
  sent: [] as UpdateStatus[],
  signature: 'developer-id' as string,
  inspect: vi.fn(),
  download: vi.fn(),
  userData: '',
}));
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));
vi.mock('electron', () => ({
  app: { getPath: () => m.userData, on: vi.fn() },
  autoUpdater: { on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [{}] },
}));
vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: Object.assign(m.updater, {
      on: (event: string, handler: (...args: unknown[]) => void) => m.handlers.set(event, handler),
      checkForUpdates: vi.fn(),
      downloadUpdate: m.download,
      quitAndInstall: vi.fn(),
    }),
  },
}));
vi.mock('./localBuildInstall', async (importActual) => ({
  ...(await importActual<typeof import('./localBuildInstall')>()),
  inspectAppSignature: m.inspect,
}));
vi.mock('../../ipc/sessionIndex', () => ({
  needsQuitCheckpoint: () => false,
}));
vi.mock('../../ipc/settings', () => ({
  flushSettings: vi.fn(),
  writeTrayReenterAfterUpdate: vi.fn(),
}));
vi.mock('../../windows/createAppWindow', () => ({
  sendToWindow: (_win: unknown, _channel: string, status: UpdateStatus) => m.sent.push(status),
}));
vi.mock('../exitInterruptHost', () => ({ markExitForUpdate: vi.fn() }));
vi.mock('./idleRestartSnapshot', () => ({ currentIdleRestartObservation: () => ({}) }));
vi.mock('../agentHost', () => ({
  prepareAgentWorkerForQuit: vi.fn(),
  cancelAgentQuitCheckpoint: vi.fn(),
}));
vi.mock('../../ipc/appRestart', () => ({ waitWithExitDialog: vi.fn() }));

const SIGNATURE_ERROR =
  'Code signature at URL file:///tmp/EnsoCode.app/ did not pass validation: code failed to satisfy specified code requirement(s)';
const INFO = { version: '0.3.12', files: [{ url: 'EnsoCode-0.3.12-arm64.dmg' }] };
const originalPlatform = process.platform;
const originalArch = process.arch;
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'enso-updater-local-'));
  dirs.push(dir);
  return dir;
}

async function initService(withAppUpdateYml: boolean, channel: 'stable' | 'beta' = 'stable') {
  const resources = tempDir();
  if (withAppUpdateYml) writeFileSync(path.join(resources, 'app-update.yml'), 'provider: github\n');
  Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true });
  vi.resetModules();
  const { autoUpdaterService } = await import('./AutoUpdater');
  autoUpdaterService.init({ on: vi.fn(), once: vi.fn() } as never, true, 'off', channel);
  await autoUpdaterService.checkForUpdates();
  return autoUpdaterService;
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
  for (const key of [
    'updateConfigPath',
    'autoDownload',
    'autoInstallOnAppQuit',
    'allowPrerelease',
    'allowDowngrade',
  ]) {
    delete m.updater[key];
  }
  m.handlers.clear();
  m.sent.length = 0;
  m.download.mockReset();
  m.userData = tempDir();
  m.inspect.mockReset().mockImplementation(async () => m.signature);
});

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  Object.defineProperty(process, 'arch', { value: originalArch, configurable: true });
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('本地 --dir 构建的自动更新', () => {
  it('缺 app-update.yml：改用 userData 下的回退配置检查更新', async () => {
    m.signature = 'developer-id';
    await initService(false);
    expect(m.updater.updateConfigPath).toBe(path.join(m.userData, 'updater', 'app-update.yml'));
    expect(m.updater.autoDownload).toBe(true);
    m.handlers.get('update-available')?.(INFO);
    expect(m.sent.at(-1)).toEqual({ status: 'available', info: { version: '0.3.12' } });
  });

  it('ad-hoc 签名：不自动下载，发现新版时给出 Release / DMG 入口', async () => {
    m.signature = 'adhoc';
    const service = await initService(false);
    expect(m.inspect).toHaveBeenCalledOnce();
    expect(m.updater.autoDownload).toBe(false);
    expect(m.updater.autoInstallOnAppQuit).toBe(false);
    m.handlers.get('update-available')?.(INFO);
    expect(m.sent.at(-1)).toMatchObject({
      status: 'available',
      manualInstall: {
        releaseUrl: 'https://github.com/J3n5en/EnsoCode/releases/tag/v0.3.12',
        downloadUrl:
          'https://github.com/J3n5en/EnsoCode/releases/download/v0.3.12/EnsoCode-0.3.12-arm64.dmg',
      },
    });
    await service.downloadUpdate();
    expect(m.download).not.toHaveBeenCalled();
    // 关掉再开自动更新也不会重新打开自动下载
    service.setAutoUpdateEnabled(true);
    expect(m.updater.autoDownload).toBe(false);
  });

  it('下载后 Squirrel.Mac 拒装：撤掉「重启更新」，改报本地构建并给手动入口', async () => {
    m.signature = 'developer-id';
    await initService(false);
    m.handlers.get('update-available')?.(INFO);
    m.handlers.get('update-downloaded')?.(INFO);
    expect(m.sent.at(-1)?.status).toBe('downloaded');
    m.handlers.get('error')?.(new Error(SIGNATURE_ERROR));
    expect(m.sent.at(-1)).toMatchObject({
      status: 'error',
      error: SIGNATURE_ERROR,
      manualInstall: { version: '0.3.12' },
    });
    expect(m.updater.autoDownload).toBe(false);
    // 网络错误照常显示为普通失败
    m.handlers.get('error')?.(new Error('net::ERR_INTERNET_DISCONNECTED'));
    expect(m.sent.at(-1)).toEqual({ status: 'error', error: 'net::ERR_INTERNET_DISCONNECTED' });
  });

  it('正式包（有 app-update.yml）：不改 feed、不查签名，错误原样上报', async () => {
    m.signature = 'adhoc';
    await initService(true);
    expect(m.updater.updateConfigPath).toBeUndefined();
    expect(m.inspect).not.toHaveBeenCalled();
    expect(m.updater.autoDownload).toBe(true);
    m.handlers.get('update-available')?.(INFO);
    expect(m.sent.at(-1)).toEqual({ status: 'available', info: { version: '0.3.12' } });
    m.handlers.get('update-downloaded')?.(INFO);
    m.handlers.get('error')?.(new Error(SIGNATURE_ERROR));
    // 下载完成后不再发别的状态（原行为）
    expect(m.sent.at(-1)?.status).toBe('downloaded');
  });

  it('本地构建同样遵守所选渠道，运行中可切换且不允许降级', async () => {
    m.signature = 'developer-id';
    const service = await initService(false, 'beta');
    expect(m.updater.updateConfigPath).toBe(path.join(m.userData, 'updater', 'app-update.yml'));
    expect(m.updater).toMatchObject({ allowPrerelease: true, allowDowngrade: false });
    const check = m.updater.checkForUpdates as ReturnType<typeof vi.fn>;
    check.mockClear();
    service.setChannel('stable');
    expect(m.updater).toMatchObject({ allowPrerelease: false, allowDowngrade: false });
    await vi.waitFor(() => expect(check).toHaveBeenCalledOnce());
  });

  it('默认稳定版：即便当前是预发布版本也关掉 allowPrerelease', async () => {
    m.updater.allowPrerelease = true;
    await initService(true);
    expect(m.updater).toMatchObject({ allowPrerelease: false, allowDowngrade: false });
  });
});
