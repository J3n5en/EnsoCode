// 手动检查更新必须把结果交回调用方：有更新、已是最新、已下载、失败都不能再吞掉。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  version: '0.3.15-beta.319',
  handlers: new Map<string, (...args: unknown[]) => void>(),
  check: vi.fn(),
}));

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));
vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/enso-updater-check',
    getVersion: () => m.version,
    on: vi.fn(),
  },
  BrowserWindow: { getAllWindows: () => [{}], getFocusedWindow: () => null },
  autoUpdater: { on: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
}));
vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: {
      on: (event: string, handler: (...args: unknown[]) => void) => m.handlers.set(event, handler),
      checkForUpdates: () => m.check(),
      downloadUpdate: vi.fn(),
      quitAndInstall: vi.fn(),
    },
  },
}));
vi.mock('../../ipc/sessionIndex', () => ({ needsQuitCheckpoint: () => false }));
vi.mock('../../ipc/settings', () => ({
  flushSettings: vi.fn(),
  readLocale: () => 'zh',
  writeTrayReenterAfterUpdate: vi.fn(),
}));
vi.mock('../../windows/createAppWindow', () => ({ sendToWindow: vi.fn() }));
vi.mock('../exitInterruptHost', () => ({ markExitForUpdate: vi.fn() }));
vi.mock('../appQuitWatchdog', () => ({
  quitWatchdog: { begin: vi.fn(), step: vi.fn(), cancel: vi.fn() },
}));
vi.mock('./idleRestartSnapshot', () => ({ currentIdleRestartObservation: () => ({}) }));
vi.mock('../agentHost', () => ({
  prepareAgentWorkerForQuit: vi.fn(),
  cancelAgentQuitCheckpoint: vi.fn(),
}));
vi.mock('../../ipc/appRestart', () => ({ waitWithExitDialog: vi.fn() }));
vi.mock('../appServerMode', () => ({
  flushRendererPersist: async () => {},
  isServerMode: () => false,
  leaveServerMode: vi.fn(),
}));

async function fresh() {
  vi.resetModules();
  const { autoUpdaterService } = await import('./AutoUpdater');
  autoUpdaterService.init({ on: vi.fn(), once: vi.fn() } as never, false, 'off');
  return autoUpdaterService;
}

beforeEach(() => {
  m.version = '0.3.15-beta.319';
  m.handlers.clear();
  m.check.mockReset();
  Object.defineProperty(process, 'resourcesPath', { value: '', configurable: true });
});

describe('手动检查更新把结果交回调用方', () => {
  it('查到更高版本（含更高的 beta）返回 available', async () => {
    m.check.mockResolvedValue({ updateInfo: { version: '0.3.15-beta.331' } });
    const service = await fresh();
    await expect(service.checkForUpdates()).resolves.toEqual({ ok: true, status: 'available' });
  });

  it('没有更高版本、没有结果时返回 up-to-date', async () => {
    m.check.mockResolvedValue({ updateInfo: { version: '0.3.15-beta.319' } });
    const same = await fresh();
    await expect(same.checkForUpdates()).resolves.toEqual({ ok: true, status: 'up-to-date' });

    m.check.mockResolvedValue(null);
    const none = await fresh();
    await expect(none.checkForUpdates()).resolves.toEqual({ ok: true, status: 'up-to-date' });
  });

  it('已经下载好的更新不再空返回，而是 downloaded', async () => {
    const service = await fresh();
    m.handlers.get('update-downloaded')?.({ version: '0.3.15-beta.331' });
    await expect(service.checkForUpdates()).resolves.toEqual({ ok: true, status: 'downloaded' });
    expect(m.check).not.toHaveBeenCalled();
  });

  it('检查抛错时返回 ok:false，错误非空且不含密钥、超长被截断', async () => {
    const secret = `feed failed https://user:s3cret@updates.example/app sk-${'a'.repeat(24)} ${'x'.repeat(400)}`;
    m.check.mockRejectedValue(new Error(secret));
    const service = await fresh();
    const result = await service.checkForUpdates();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.length).toBeGreaterThan(0);
    expect(result.error).not.toContain('s3cret');
    expect(result.error).not.toContain('sk-');
    expect(result.error.length).toBeLessThanOrEqual(201);
  });
});
