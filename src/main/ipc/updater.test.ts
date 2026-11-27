import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  userData: '',
  channels: [] as string[],
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  check: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { getPath: () => m.userData },
  ipcMain: {
    handle: (channel: string, handler?: (...args: unknown[]) => unknown) => {
      m.channels.push(channel);
      if (handler) m.handlers.set(channel, handler);
    },
  },
}));
vi.mock('../services/updater/AutoUpdater', () => ({
  autoUpdaterService: { checkForUpdates: () => m.check() },
}));

import { registerUpdaterHandlers } from './updater';

const originalPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  delete process.env.APPIMAGE;
});

describe('更新重启的会话恢复只走 restart-manifest', () => {
  it('启动时删掉旧版留下的 interrupted-by-update.json，也不再开放取名单续跑的通道', () => {
    m.userData = mkdtempSync(path.join(tmpdir(), 'enso-updater-ipc-'));
    const legacy = path.join(m.userData, 'interrupted-by-update.json');
    writeFileSync(legacy, JSON.stringify({ v: 1, at: Date.now(), sessionIds: ['s1'] }));
    registerUpdaterHandlers();
    expect(existsSync(legacy)).toBe(false);
    expect(m.channels).not.toContain('updater:takeInterruptedSessions');
    expect(m.channels).not.toContain('updater:cancelRestart');
    expect(m.channels).toContain('updater:quitAndInstall');
  });
});

describe('检查更新 IPC 把结构化结果交回渲染层', () => {
  it('Linux 非 AppImage 返回 unsupported，不调用检查', async () => {
    m.userData = mkdtempSync(path.join(tmpdir(), 'enso-updater-ipc-'));
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    delete process.env.APPIMAGE;
    m.check.mockClear();
    registerUpdaterHandlers();
    await expect(m.handlers.get('updater:check')?.({})).resolves.toEqual({
      ok: true,
      status: 'unsupported',
    });
    expect(m.check).not.toHaveBeenCalled();
  });

  it('支持的平台原样透传成功与失败', async () => {
    m.userData = mkdtempSync(path.join(tmpdir(), 'enso-updater-ipc-'));
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    registerUpdaterHandlers();
    m.check.mockResolvedValue({ ok: true, status: 'available' });
    await expect(m.handlers.get('updater:check')?.({})).resolves.toEqual({
      ok: true,
      status: 'available',
    });
    m.check.mockResolvedValue({ ok: false, error: 'network down' });
    await expect(m.handlers.get('updater:check')?.({})).resolves.toEqual({
      ok: false,
      error: 'network down',
    });
  });

  it('Linux AppImage 仍走检查并透传结果', async () => {
    m.userData = mkdtempSync(path.join(tmpdir(), 'enso-updater-ipc-'));
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    process.env.APPIMAGE = '/tmp/EnsoCode.AppImage';
    registerUpdaterHandlers();
    m.check.mockResolvedValue({ ok: true, status: 'up-to-date' });
    await expect(m.handlers.get('updater:check')?.({})).resolves.toEqual({
      ok: true,
      status: 'up-to-date',
    });
  });
});
