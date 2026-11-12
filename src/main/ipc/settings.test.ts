import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
    syncBotModeServices: vi.fn(),
    syncBotDiscussMode: vi.fn(),
    windows: [] as Array<{
      isDestroyed: () => boolean;
      webContents: { id: number; isDestroyed: () => boolean; send: (channel: string) => void };
    }>,
  };
});

vi.mock('./bots', () => ({
  syncBotModeServices: mocks.syncBotModeServices,
  syncBotDiscussMode: mocks.syncBotDiscussMode,
}));

// scheduleWrite 成功后会动态通知统一模型目录；mock 掉避免动态 import 链
// （modelDirectory → 本模块 → oauthProviders）把无关模块拉进测试的注册表。
vi.mock('../services/modelDirectory', () => ({
  notifyModelDirectorySettingsChanged: () => {},
}));

vi.mock('electron', () => ({
  app: { getPath: () => userData, on: vi.fn() },
  BrowserWindow: { getAllWindows: () => mocks.windows },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler),
  },
}));

vi.mock('../services/uiHost', async () =>
  (await import('../../../test/helpers/localUi')).mockUiHost(() => mocks.windows)
);

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
  it('右键打开配置落盘但不跨设备同步，非法应用配置不能覆盖已保存值', async () => {
    const settings = await import('./settings');
    settings.patchSettingsState('contextMenuOpen', []);
    const fingerprint = settings.settingsFingerprint(settings.readSettings());
    expect(settings.CONFIG_SYNC_COMMIT_FIELDS).not.toContain('contextMenuOpen');
    const config = [{ id: 'vscode', target: 'vscode', enabled: true }];
    expect(settings.patchSettingsState('contextMenuOpen', config)).toMatchObject({
      ok: true,
    });
    expect(
      settings.patchSettingsState('contextMenuOpen', [
        {
          id: 'custom',
          enabled: true,
          target: 'application',
          applicationPath: 'editor.exe --run',
        },
      ])
    ).toMatchObject({ ok: false });
    expect(settings.readContextMenuOpen()).toEqual(config);
    expect(settings.settingsFingerprint(settings.readSettings())).toBe(fingerprint);
    settings.flushSettings();
    expect(
      JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf8'))['enso-settings'].state
        .contextMenuOpen
    ).toEqual(config);
  });

  it('文件打开规则允许持久化规范化值，但禁止同步到其他设备', async () => {
    const settings = await import('./settings');
    expect(settings.SETTINGS_STATE_FIELDS).toContain('fileOpenRules');
    expect(settings.CONFIG_SYNC_COMMIT_FIELDS).not.toContain('fileOpenRules');
    const rules = [{ extension: '*.MD', target: 'reveal' }];
    expect(settings.patchSettingsState('fileOpenRules', rules)).toMatchObject({
      ok: true,
      value: [{ extension: '.md', target: 'reveal' }],
    });
    expect(
      settings.patchSettingsState('fileOpenRules', [{ extension: '../md', target: 'system' }])
    ).toMatchObject({ ok: false });
    expect(settings.readSettings()?.['enso-settings']).toMatchObject({
      state: { fileOpenRules: [{ extension: '.md', target: 'reveal' }] },
    });
    const fingerprint = settings.settingsFingerprint(settings.readSettings());
    settings.patchSettingsState('fileOpenRules', [
      {
        extension: 'PDF',
        target: 'application',
        applicationPath: path.join(userData, 'Reader.exe'),
      },
    ]);
    expect(settings.settingsFingerprint(settings.readSettings())).toBe(fingerprint);
    settings.flushSettings();
    expect(
      JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf8'))['enso-settings'].state
        .fileOpenRules
    ).toEqual(settings.readFileOpenRules());
  });

  it('renderer 持久化入口同样拒绝脏规则，不覆盖上一份本机规则', async () => {
    const settings = await import('./settings');
    settings.registerSettingsHandlers();
    const event = { sender: mocks.windows[0].webContents };
    const writeKey = mocks.handlers.get(IPC_CHANNELS.SETTINGS_WRITE_KEY);
    const write = mocks.handlers.get(IPC_CHANNELS.SETTINGS_WRITE);
    expect(
      await writeKey?.(event, 'enso-settings', {
        state: {
          fileOpenRules: [
            { extension: 'md', target: 'application', applicationPath: '/bin/editor --run' },
          ],
        },
      })
    ).toBe(false);
    expect(
      await write?.(event, {
        'enso-settings': {
          state: { fileOpenRules: [{ extension: 'md', target: 'system', command: 'bad' }] },
        },
      })
    ).toBe(false);
    expect(
      await writeKey?.(event, 'enso-settings', {
        state: { fileOpenRules: [{ extension: 'TXT', target: 'internal' }] },
      })
    ).toBe(true);
    expect(settings.readSettings()?.['enso-settings']).toMatchObject({
      state: { fileOpenRules: [{ extension: '.txt', target: 'internal' }] },
    });
  });

  it('persists local Bot capacity across reload and notifies the scheduler on changes only', async () => {
    const settings = await import('./settings');
    expect(settings.SETTINGS_STATE_FIELDS).toContain('botMaxRunningTurns');
    expect(settings.CONFIG_SYNC_COMMIT_FIELDS).not.toContain('botMaxRunningTurns');
    mocks.syncBotModeServices.mockClear();
    expect(settings.patchSettingsState('botMaxRunningTurns', 2)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(mocks.syncBotModeServices).toHaveBeenCalledTimes(1));
    settings.flushSettings();
    expect(
      JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf8'))['enso-settings'].state
        .botMaxRunningTurns
    ).toBe(2);
    vi.resetModules();
    const reloaded = await import('./settings');
    expect(reloaded.readSettings()?.['enso-settings']).toMatchObject({
      state: { botMaxRunningTurns: 2 },
    });
    reloaded.patchSettingsState('theme', 'dark');
    reloaded.flushSettings();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.syncBotModeServices).toHaveBeenCalledTimes(1);
  });

  it('讨论模式开关：本机字段、不参与同步，变化只通知 syncBotDiscussMode', async () => {
    vi.resetModules();
    const settings = await import('./settings');
    expect(settings.SETTINGS_STATE_FIELDS).toContain('botDiscussModeEnabled');
    expect(settings.CONFIG_SYNC_COMMIT_FIELDS).not.toContain('botDiscussModeEnabled');
    mocks.syncBotModeServices.mockClear();
    mocks.syncBotDiscussMode.mockClear();
    expect(settings.patchSettingsState('botDiscussModeEnabled', true)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(mocks.syncBotDiscussMode).toHaveBeenCalledTimes(1));
    settings.patchSettingsState('botDiscussModeEnabled', true);
    settings.patchSettingsState('theme', 'light');
    settings.flushSettings();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.syncBotDiscussMode).toHaveBeenCalledTimes(1);
    // 讨论开关不能走 syncBotModeServices：后者关闭时会销毁整套 Bot 服务
    expect(mocks.syncBotModeServices).not.toHaveBeenCalled();
    settings.patchSettingsState('botDiscussModeEnabled', false);
    await vi.waitFor(() => expect(mocks.syncBotDiscussMode).toHaveBeenCalledTimes(2));
    settings.flushSettings();
  });

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

  it('会话写入对远端主界面只推补丁，不再触发整份 settings 重读', async () => {
    const { registerSettingsHandlers } = await import('./settings');
    const { addRemoteSender, RemoteSender } = await import('../services/remoteRenderer/senders');
    registerSettingsHandlers();
    const remote = new RemoteSender('pair-s', 'cid-s', 'main', () => {});
    const remoteSettings = new RemoteSender('pair-s', 'cid-t', 'settings', () => {});
    addRemoteSender(remote);
    addRemoteSender(remoteSettings);
    const mainSends = vi.spyOn(remote, 'send');
    const settingsSends = vi.spyOn(remoteSettings, 'send');
    const handler = mocks.handlers.get(IPC_CHANNELS.SETTINGS_WRITE_KEY);
    if (!handler) throw new Error('SETTINGS_WRITE_KEY handler missing');
    const [owner] = mocks.windows;

    await handler({ sender: owner.webContents }, 'enso-conversations', {
      state: { conversations: { a: { id: 'a', title: 'x' } }, order: ['a'] },
    });
    const mainChannels = mainSends.mock.calls.map(([channel]) => channel);
    expect(mainChannels).not.toContain(IPC_CHANNELS.SETTINGS_CHANGED);
    expect(settingsSends).toHaveBeenCalledWith(IPC_CHANNELS.SETTINGS_CHANGED);

    mainSends.mockClear();
    await handler({ sender: owner.webContents }, 'enso-settings', { state: { theme: 'dark' } });
    expect(mainSends).toHaveBeenCalledWith(IPC_CHANNELS.SETTINGS_CHANGED);
    remote.destroy();
    remoteSettings.destroy();
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

  it('阻止息屏开关与休眠策略互不覆盖', async () => {
    const {
      readTrayPreventDisplaySleep,
      readTraySleepPolicy,
      writeTrayPreventDisplaySleep,
      writeTraySleepPolicy,
    } = await import('./settings');
    expect(writeTrayPreventDisplaySleep(true)).toBe(true);
    expect(writeTraySleepPolicy('never')).toBe(true);
    expect(readTrayPreventDisplaySleep()).toBe(true);
    expect(readTraySleepPolicy()).toBe('never');
    expect(writeTrayPreventDisplaySleep(false)).toBe(true);
    expect(readTraySleepPolicy()).toBe('never');
    expect(readTrayPreventDisplaySleep()).toBe(false);
  });
});

// settings.json 里有 providers 的 apiKey、MCP env 明文；默认 0644 时本机其他用户都能读到
describe.skipIf(process.platform === 'win32')('settings 落盘权限', () => {
  it('落盘后的 settings.json 只有本人可读写（0600）', async () => {
    const settings = await import('./settings');
    expect(settings.patchSettingsState('theme', 'light')).toMatchObject({ ok: true });
    expect(settings.flushSettings()).toBe(true);
    expect(statSync(path.join(userData, 'settings.json')).mode & 0o777).toBe(0o600);
  });

  it('残留的 0644 临时文件再次落盘后收紧为 0600', async () => {
    const settings = await import('./settings');
    const file = path.join(userData, 'settings.json');
    const tmp = `${file}.tmp`;
    writeFileSync(file, '{"stale":true}\n', { mode: 0o644 });
    chmodSync(file, 0o644);
    writeFileSync(tmp, 'leftover', { mode: 0o644 });
    chmodSync(tmp, 0o644);
    expect(statSync(tmp).mode & 0o777).toBe(0o644);
    expect(settings.patchSettingsState('theme', 'dark')).toMatchObject({ ok: true });
    expect(settings.flushSettings()).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
