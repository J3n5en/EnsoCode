import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IPC_CHANNELS } from '@shared/types/ipc';
import type { WebContents } from 'electron';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const userData = mkdtempSync(path.join(tmpdir(), 'enso-settings-'));
const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const sends = [vi.fn(), vi.fn()];
  return {
    handlers,
    sends,
    onAppEvent: vi.fn(),
    syncBotModeServices: vi.fn(),
    syncBotDiscussMode: vi.fn(),
    pluginLogs: {
      setLoggingEnabled: vi.fn(),
      syncLoggingEnabled: vi.fn(),
    },
    listModels: vi.fn(),
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
vi.mock('../services/extensionPlugins', () => ({
  peekExtensionPlugins: () => mocks.pluginLogs,
}));

// scheduleWrite 成功后会动态通知统一模型目录；mock 掉避免动态 import 链
// （modelDirectory → 本模块 → oauthProviders）把无关模块拉进测试的注册表。
vi.mock('../services/modelDirectory', () => ({
  notifyModelDirectorySettingsChanged: () => {},
}));
vi.mock('../services/providerApi', () => ({ listModels: mocks.listModels }));

vi.mock('electron', () => ({
  app: { getPath: () => userData, on: mocks.onAppEvent },
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

  it('秘书开关：本机字段、不参与同步，落盘后可重读', async () => {
    vi.resetModules();
    const settings = await import('./settings');
    expect(settings.SETTINGS_STATE_FIELDS).toContain('secretaryEnabled');
    expect(settings.CONFIG_SYNC_COMMIT_FIELDS).not.toContain('secretaryEnabled');
    expect(settings.patchSettingsState('secretaryEnabled', true)).toMatchObject({ ok: true });
    settings.flushSettings();
    expect(
      JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf8'))['enso-settings'].state
        .secretaryEnabled
    ).toBe(true);
    vi.resetModules();
    const reloaded = await import('./settings');
    expect(reloaded.readSettings()?.['enso-settings']).toMatchObject({
      state: { secretaryEnabled: true },
    });
    reloaded.patchSettingsState('secretaryEnabled', false);
    reloaded.flushSettings();
  });

  it('应用日志开关是本机字段，写入即切换 Main 落盘', async () => {
    vi.resetModules();
    const settings = await import('./settings');
    const { isAppLoggingEnabled } = await import('@shared/appLogFile');
    expect(settings.SETTINGS_STATE_FIELDS).toContain('appLoggingEnabled');
    expect(settings.CONFIG_SYNC_COMMIT_FIELDS).not.toContain('appLoggingEnabled');
    expect(isAppLoggingEnabled()).toBe(false);
    expect(settings.patchSettingsState('appLoggingEnabled', true)).toMatchObject({ ok: true });
    expect(isAppLoggingEnabled()).toBe(true);
    expect(settings.patchSettingsState('appLoggingEnabled', false)).toMatchObject({ ok: true });
    expect(isAppLoggingEnabled()).toBe(false);
    settings.flushSettings();
  });

  it('插件日志开关是本机字段，变化时热通知插件服务', async () => {
    vi.resetModules();
    mocks.pluginLogs.setLoggingEnabled.mockClear();
    mocks.pluginLogs.syncLoggingEnabled.mockClear();
    const settings = await import('./settings');
    expect(settings.SETTINGS_STATE_FIELDS).toContain('pluginLoggingEnabled');
    expect(settings.CONFIG_SYNC_COMMIT_FIELDS).not.toContain('pluginLoggingEnabled');
    expect(settings.patchSettingsState('pluginLoggingEnabled', true)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(mocks.pluginLogs.setLoggingEnabled).toHaveBeenCalledWith(true));
    settings.patchSettingsState('pluginLoggingEnabled', true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.pluginLogs.setLoggingEnabled).toHaveBeenCalledTimes(1);
    expect(settings.patchSettingsState('pluginLoggingEnabled', false)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(mocks.pluginLogs.setLoggingEnabled).toHaveBeenCalledWith(false));
    settings.flushSettings();
    mocks.pluginLogs.syncLoggingEnabled.mockClear();
    expect(settings.reloadSettingsFromDisk()).toBe(true);
    await vi.waitFor(() => expect(mocks.pluginLogs.syncLoggingEnabled).toHaveBeenCalled());
  });

  it('秘书开关关掉后落盘为 false，重启重读仍是关', async () => {
    vi.resetModules();
    const settings = await import('./settings');
    settings.patchSettingsState('secretaryEnabled', true);
    expect(settings.patchSettingsState('secretaryEnabled', false)).toMatchObject({ ok: true });
    settings.flushSettings();
    expect(
      JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf8'))['enso-settings'].state
        .secretaryEnabled
    ).toBe(false);
    vi.resetModules();
    const { secretaryEnabled } = await import('../services/secretary/enabled');
    expect(secretaryEnabled()).toBe(false);
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

  it('restores background-added models over a stale renderer snapshot and re-syncs the sender', async () => {
    const settings = await import('./settings');
    settings.registerSettingsHandlers();
    const write = mocks.handlers.get(IPC_CHANNELS.SETTINGS_WRITE_KEY);
    const writeAll = mocks.handlers.get(IPC_CHANNELS.SETTINGS_WRITE);
    const event = { sender: mocks.windows[0].webContents };
    const provider = { id: 'custom', apiKey: 'test', models: [{ id: 'manual' }] };
    const refreshed = {
      ...provider,
      models: [...provider.models, { id: 'new', enabled: false }],
      knownModelIds: ['manual', 'new'],
      modelRefreshStatus: { ok: true, at: 1 },
    };
    try {
      settings.patchSettingsState('providers', [refreshed]);

      mocks.sends[0].mockClear();
      expect(
        await write?.(event, 'enso-settings', {
          state: { theme: 'light', providers: [{ ...provider, name: 'edited' }] },
        })
      ).toBe(true);
      expect(settings.readSettingsState()).toMatchObject({
        theme: 'light',
        providers: [{ ...refreshed, name: 'edited' }],
      });
      expect(mocks.sends[0]).toHaveBeenCalledWith(IPC_CHANNELS.SETTINGS_CHANGED);

      // 已同步过的快照里删掉 new：照删，且不再打扰 sender
      mocks.sends[0].mockClear();
      const deleted = { ...refreshed, name: 'edited', models: provider.models };
      expect(await write?.(event, 'enso-settings', { state: { providers: [deleted] } })).toBe(true);
      expect(settings.readSettingsState().providers).toEqual([deleted]);
      expect(mocks.sends[0]).not.toHaveBeenCalled();

      settings.patchSettingsState('providers', [refreshed]);
      expect(
        await writeAll?.(event, { 'enso-settings': { state: { providers: [provider] } } })
      ).toBe(true);
      expect(settings.readSettingsState().providers).toEqual([refreshed]);
    } finally {
      settings.patchSettingsState('providers', []);
      settings.patchSettingsState('theme', 'dark');
    }
  });

  it('updates active schedules for ordinary writes, sync commits and disk reloads', async () => {
    const settings = await import('./settings');
    const hour = 60 * 60 * 1000;
    const first = {
      id: 'schedule-first',
      name: 'First',
      api: 'openai-completions',
      apiKey: 'test',
      baseUrl: 'https://first.example/v1',
      enabled: true,
      models: [],
    };
    const second = { ...first, id: 'schedule-second', baseUrl: 'https://second.example/v1' };
    const activate = () => vi.advanceTimersByTimeAsync(0);
    const requested = () => mocks.listModels.mock.calls.map(([config]) => config.baseUrl);
    settings.flushSettings();
    vi.useFakeTimers();
    mocks.listModels.mockResolvedValue({ ok: true, models: [] });
    try {
      writeFileSync(
        path.join(userData, 'settings.json'),
        JSON.stringify({
          'enso-settings': {
            version: 18,
            state: {
              providers: [{ ...first, autoFetchModels: true, modelRefreshIntervalHours: 2 }],
            },
          },
        })
      );
      expect(settings.reloadSettingsFromDisk()).toBe(true);
      settings.startProviderModelRefresh();
      await activate();
      expect(requested()).toEqual([first.baseUrl]);
      const saved = { ...first, autoFetchModels: true, modelRefreshIntervalHours: 2 };
      expect(settings.patchSettingsState('providers', [saved, second]).ok).toBe(true);
      await activate();
      expect(requested()).toEqual([first.baseUrl]);
      const enabledSecond = { ...second, autoFetchModels: true };
      expect(settings.patchSettingsState('providers', [saved, enabledSecond]).ok).toBe(true);
      await activate();
      expect(requested()).toEqual([first.baseUrl, second.baseUrl]);

      await vi.advanceTimersByTimeAsync(hour / 2);
      expect(
        settings.commitSettingsTransaction(settings.settingsFingerprint(settings.readSettings()), {
          providers: [{ ...saved, modelRefreshIntervalHours: 3 }, enabledSecond],
        }).ok
      ).toBe(true);
      await vi.advanceTimersByTimeAsync(1.5 * hour);
      expect(requested()).toEqual([first.baseUrl, second.baseUrl, second.baseUrl, second.baseUrl]);

      settings.flushSettings();
      const disk = JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf-8'));
      const reloaded = { ...enabledSecond, baseUrl: 'https://reloaded.example/v1' };
      disk['enso-settings'].state.providers = [reloaded];
      writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(disk));
      expect(settings.reloadSettingsFromDisk()).toBe(true);
      await activate();
      expect(requested().at(-1)).toBe(reloaded.baseUrl);
      await vi.advanceTimersByTimeAsync(2 * hour);
      expect(requested().slice(-3)).toEqual([reloaded.baseUrl, reloaded.baseUrl, reloaded.baseUrl]);
    } finally {
      settings.patchSettingsState('providers', []);
      settings.flushSettings();
      vi.useRealTimers();
    }
  });

  it('keeps a model fetch running if the app stays open after before-quit', async () => {
    const settings = await import('./settings');
    const provider = {
      id: 'keep-running',
      api: 'openai-completions',
      apiKey: 'test',
      baseUrl: 'https://keep-running.example/v1',
      enabled: true,
      autoFetchModels: true,
      models: [],
    };
    const response = Promise.withResolvers<{ ok: true; models: [] }>();
    const emit = (name: string) =>
      mocks.onAppEvent.mock.calls.findLast(([event]) => event === name)?.[1]();
    mocks.onAppEvent.mockClear();
    mocks.listModels.mockClear().mockReturnValueOnce(response.promise);
    try {
      settings.registerSettingsHandlers();
      expect(settings.patchSettingsState('providers', [provider]).ok).toBe(true);
      settings.startProviderModelRefresh();
      await vi.waitFor(() => expect(mocks.listModels).toHaveBeenCalledTimes(1));
      const signal = mocks.listModels.mock.calls[0][1];

      emit('before-quit');
      expect(signal.aborted).toBe(false);

      emit('will-quit');
      expect(signal.aborted).toBe(true);
    } finally {
      response.resolve({ ok: true, models: [] });
      settings.patchSettingsState('providers', []);
      settings.flushSettings();
    }
  });

  it('ignores a malformed saved switch while another provider updates and saves fetched models', async () => {
    const settings = await import('./settings');
    const active = {
      id: 'valid-switch',
      api: 'openai-completions',
      apiKey: 'test',
      baseUrl: 'https://active.example/v1',
      enabled: true,
      autoFetchModels: true,
      models: [],
    };
    const malformed = {
      ...active,
      id: 'malformed-switch',
      baseUrl: 'https://malformed.example/v1',
      autoFetchModels: 'true',
    };
    settings.flushSettings();
    vi.useFakeTimers();
    mocks.listModels.mockClear().mockResolvedValue({ ok: true, models: [{ id: 'discovered' }] });
    try {
      writeFileSync(
        path.join(userData, 'settings.json'),
        JSON.stringify({
          'enso-settings': { version: 18, state: { providers: [malformed, active] } },
        })
      );
      expect(settings.reloadSettingsFromDisk()).toBe(true);
      settings.startProviderModelRefresh();
      await vi.advanceTimersByTimeAsync(0);

      expect(mocks.listModels.mock.calls.map(([config]) => config.baseUrl)).toEqual([
        active.baseUrl,
      ]);
      const refreshed = {
        ...active,
        models: [{ id: 'discovered', enabled: false }],
        knownModelIds: ['discovered'],
        modelRefreshStatus: { ok: true, at: Date.now() },
      };
      expect(settings.readSettingsState().providers).toEqual([malformed, refreshed]);
      const edited = { ...refreshed, modelRefreshIntervalHours: 2 };
      expect(settings.patchSettingsState('providers', [malformed, edited]).ok).toBe(true);
      expect(settings.readSettingsState().providers).toEqual([malformed, edited]);
      expect(settings.flushSettings()).toBe(true);
      const persisted = JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf8'));
      expect(persisted['enso-settings'].state.providers).toEqual([malformed, edited]);
    } finally {
      settings.patchSettingsState('providers', []);
      settings.flushSettings();
      vi.useRealTimers();
    }
  });

  it('会话写入对远端不再触发整份 settings 重读（主界面走补丁，设置页不消费会话）', async () => {
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
    expect(settingsSends).not.toHaveBeenCalledWith(IPC_CHANNELS.SETTINGS_CHANGED);

    mainSends.mockClear();
    settingsSends.mockClear();
    await handler({ sender: owner.webContents }, 'enso-settings', { state: { theme: 'dark' } });
    expect(mainSends).toHaveBeenCalledWith(IPC_CHANNELS.SETTINGS_CHANGED);
    expect(settingsSends).toHaveBeenCalledWith(IPC_CHANNELS.SETTINGS_CHANGED);
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

  it('会话读回带序号，旧确认号的写回不会抹掉 Main 插入的行', async () => {
    const settings = await import('./settings');
    settings.registerSettingsHandlers();
    const write = mocks.handlers.get(IPC_CHANNELS.SETTINGS_WRITE_KEY);
    const read = mocks.handlers.get(IPC_CHANNELS.CONVERSATIONS_READ);
    if (!write || !read) throw new Error('conversations handlers missing');
    const [owner] = mocks.windows;
    const sender = { sender: owner.webContents };
    type Conversations = { state: { conversations: Record<string, unknown>; order: string[] } };

    await write(
      sender,
      'enso-conversations',
      { state: { conversations: { a: { id: 'a', title: 'x' } }, order: ['a'] } },
      0
    );
    const first = (await read(sender)) as { value: Conversations; seq: number };
    expect(first.value.state.conversations).toHaveProperty('a');
    expect(Number.isInteger(first.seq)).toBe(true);

    expect(
      settings.patchConversationsState((state) => {
        state.conversations.m = { id: 'm', title: 'main' };
        state.order.unshift('m');
      })
    ).toBe(true);
    expect(settings.readPersistedConversations().m).toEqual({ id: 'm', title: 'main' });

    await write(sender, 'enso-conversations', first.value, first.seq);
    const second = (await read(sender)) as { value: Conversations; seq: number };
    expect(second.value.state.conversations).toHaveProperty('m');
    expect(second.value.state.conversations).toHaveProperty('a');
  });

  it('整表删除写回被拒并要求重读；明确删除最后一个会话落盘为空；undefined 删除整个键', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const settings = await import('./settings');
    settings.registerSettingsHandlers();
    const write = mocks.handlers.get(IPC_CHANNELS.SETTINGS_WRITE_KEY);
    const read = mocks.handlers.get(IPC_CHANNELS.CONVERSATIONS_READ);
    const remove = mocks.handlers.get(IPC_CHANNELS.CONVERSATIONS_REMOVE);
    if (!write || !read || !remove) throw new Error('conversations handlers missing');
    const [owner] = mocks.windows;
    const sender = { sender: owner.webContents };
    const empty = { state: { conversations: {}, order: [] }, version: 3 };
    const disk = () => {
      settings.flushSettings();
      return JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf8'))[
        'enso-conversations'
      ] as { state: { conversations: Record<string, unknown>; order: string[] } } | undefined;
    };

    settings.patchConversationsState((state) => {
      for (const id of Object.keys(state.conversations)) delete state.conversations[id];
      state.conversations.a = { id: 'a', title: 'a' };
      state.order = ['a'];
    });
    const { seq } = (await read(sender)) as { seq: number };

    mocks.sends[0].mockClear();
    await write(sender, 'enso-conversations', empty, seq);
    expect(disk()?.state.conversations).toEqual({ a: { id: 'a', title: 'a' } });
    expect(mocks.sends[0]).toHaveBeenCalledWith(IPC_CHANNELS.CONVERSATIONS_RESYNC);

    const removed = vi.fn();
    settings.onConversationsRemoved(removed);
    expect(await remove(sender, ['a'])).toBe(true);
    expect(removed).toHaveBeenCalledWith(['a']);
    await write(sender, 'enso-conversations', empty, seq);
    expect(disk()?.state).toMatchObject({ conversations: {}, order: [] });

    await write(sender, 'enso-conversations', undefined, seq);
    expect(settings.readSettings()).not.toHaveProperty('enso-conversations');
    expect(disk()).toBeUndefined();
    warn.mockRestore();
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
