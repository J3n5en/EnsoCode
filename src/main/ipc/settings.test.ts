import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IPC_CHANNELS } from '@shared/types';
import type { WebContents } from 'electron';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const userData = mkdtempSync(path.join(tmpdir(), 'enso-settings-'));
const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const sends = [vi.fn(), vi.fn()];
  return {
    handlers,
    sends,
    windows: [] as Array<{
      isDestroyed: () => boolean;
      webContents: { id: number; send: (channel: string) => void };
    }>,
  };
});

vi.mock('electron', () => ({
  app: { getPath: () => userData, on: vi.fn() },
  BrowserWindow: { getAllWindows: () => mocks.windows },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler),
  },
}));

beforeAll(() => {
  mocks.windows.push(
    { isDestroyed: () => false, webContents: { id: 1, send: mocks.sends[0] } },
    { isDestroyed: () => false, webContents: { id: 2, send: mocks.sends[1] } }
  );
});

afterAll(async () => {
  const { flushSettings } = await import('./settings');
  flushSettings();
  rmSync(userData, { recursive: true, force: true });
});

describe('settings广播策略', () => {
  it('Gateway写广播全部renderer，包含发起窗口', async () => {
    const { patchSettingsState } = await import('./settings');
    const [owner] = mocks.windows;
    const ownerWebContents = owner.webContents as unknown as WebContents;
    expect(patchSettingsState('theme', 'dark', ownerWebContents)).toMatchObject({
      ok: true,
    });
    expect(mocks.sends[0]).toHaveBeenCalledWith(IPC_CHANNELS.SETTINGS_CHANGED);
    expect(mocks.sends[1]).toHaveBeenCalledWith(IPC_CHANNELS.SETTINGS_CHANGED);
  });

  it('普通renderer SETTINGS_WRITE_KEY仍排除sender', async () => {
    const { registerSettingsHandlers } = await import('./settings');
    registerSettingsHandlers();
    const [owner] = mocks.windows;
    mocks.sends[0].mockClear();
    mocks.sends[1].mockClear();
    const handler = mocks.handlers.get(IPC_CHANNELS.SETTINGS_WRITE_KEY);
    if (!handler) throw new Error('SETTINGS_WRITE_KEY handler missing');

    await handler({ sender: owner.webContents }, 'enso-settings', { state: { theme: 'light' } });

    expect(mocks.sends[0]).not.toHaveBeenCalled();
    expect(mocks.sends[1]).toHaveBeenCalledWith(IPC_CHANNELS.SETTINGS_CHANGED);
  });
});
