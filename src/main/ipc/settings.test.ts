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
      webContents: { id: number; isDestroyed: () => boolean; send: (channel: string) => void };
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
    {
      isDestroyed: () => false,
      webContents: { id: 1, isDestroyed: () => false, send: mocks.sends[0] },
    },
    {
      isDestroyed: () => false,
      webContents: { id: 2, isDestroyed: () => false, send: mocks.sends[1] },
    }
  );
});

afterAll(async () => {
  const { flushSettings } = await import('./settings');
  flushSettings();
  rmSync(userData, { recursive: true, force: true });
});

describe('settings广播策略', () => {
  it('设置白名单同时保留 canonical editMode 与只读迁移用旧字段', async () => {
    const { CONFIG_SYNC_COMMIT_FIELDS, SETTINGS_STATE_FIELDS } = await import('./settings');
    expect(SETTINGS_STATE_FIELDS).toContain('editMode');
    expect(SETTINGS_STATE_FIELDS).toContain('rtkEnabled');
    expect(SETTINGS_STATE_FIELDS).toContain('hashlineEditEnabled');
    expect(CONFIG_SYNC_COMMIT_FIELDS).toContain('editMode');
    expect(CONFIG_SYNC_COMMIT_FIELDS).not.toContain('hashlineEditEnabled');
  });

  it('旧字段写请求收敛到 canonical mode，不形成双状态', async () => {
    const { patchSettingsState, readSettings } = await import('./settings');
    expect(patchSettingsState('hashlineEditEnabled', true)).toMatchObject({
      ok: true,
      value: 'apply_patch',
    });
    const persisted = readSettings()?.['enso-settings'] as
      | { state?: Record<string, unknown> }
      | undefined;
    expect(persisted?.state).toMatchObject({ editMode: 'apply_patch' });
    expect(persisted?.state).not.toHaveProperty('hashlineEditEnabled');
  });

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

  it('托盘休眠策略写入不会清掉更新后回托盘标记', async () => {
    const {
      consumeTrayReenterAfterUpdate,
      readTraySleepPolicy,
      writeTrayReenterAfterUpdate,
      writeTraySleepPolicy,
    } = await import('./settings');
    expect(writeTrayReenterAfterUpdate(true)).toBe(true);
    expect(writeTraySleepPolicy('never')).toBe(true);
    expect(readTraySleepPolicy()).toBe('never');
    expect(consumeTrayReenterAfterUpdate()).toBe(true);
    expect(consumeTrayReenterAfterUpdate()).toBe(false);
  });
});
