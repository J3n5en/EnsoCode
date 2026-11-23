import type { RestartOverlayState } from '@shared/types/ipc';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  updaterEvents: new Map<string, (...args: unknown[]) => void>(),
  overlays: [] as Array<RestartOverlayState | null>,
  present: vi.fn(),
  quitAndInstall: vi.fn(),
  finishTool: () => {},
  mainWindow: { isDestroyed: () => false },
}));
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/enso-overlay-entries', on: vi.fn() },
  autoUpdater: { on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      m.handlers.set(channel, handler),
    on: vi.fn(),
  },
}));
vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: {
      on: (event: string, handler: (...args: unknown[]) => void) =>
        m.updaterEvents.set(event, handler),
      quitAndInstall: m.quitAndInstall,
      checkForUpdates: vi.fn(),
    },
  },
}));
vi.mock('../../windows/createAppWindow', () => ({
  sendToWindow: (_win: unknown, channel: string, payload: unknown) => {
    if (channel === 'app:restart-waiting') m.overlays.push(payload as RestartOverlayState | null);
  },
}));
vi.mock('../../windows/MainWindow', () => ({ getMainWindow: () => m.mainWindow }));
vi.mock('../../windows/verifyLaunch', () => ({ presentWindow: m.present }));
vi.mock('../nodeRemote', () => ({ switchNode: vi.fn() }));
vi.mock('../renderers', () => ({
  anyRendererFocused: () => true,
  isMainRenderer: () => true,
  localMainContents: () => null,
}));
vi.mock('../../ipc/sessionIndex', () => ({ needsQuitCheckpoint: () => true }));
vi.mock('../../ipc/settings', () => ({
  flushSettings: vi.fn(),
  writeTrayReenterAfterUpdate: vi.fn(),
}));
vi.mock('../exitInterruptHost', () => ({ markExitForUpdate: vi.fn() }));
vi.mock('./idleRestartSnapshot', () => ({ currentIdleRestartObservation: () => ({}) }));
vi.mock('./updateFeed', () => ({ ensureFallbackUpdateConfig: () => null }));
vi.mock('../appServerMode', () => ({
  flushRendererPersist: async () => {},
  isServerMode: () => false,
}));
// 有工具在跑：worker 报告推迟，工具结束后才到安全点
vi.mock('../agentHost', () => ({
  cancelAgentQuitCheckpoint: vi.fn(),
  prepareAgentWorkerForQuit: (options: { onWaitingForTools?: (reason: string) => void }) => {
    options.onWaitingForTools?.('tool');
    return new Promise((resolve) => {
      m.finishTool = () => resolve('checkpointed');
    });
  },
}));

import { setRestartOverlay } from '../../ipc/appRestart';
import { registerUpdaterHandlers } from '../../ipc/updater';
import { prepareAgentWorkerForQuit } from '../agentHost';
import { createAppRestart, restartOverlayFor } from '../appRestart';
import { autoUpdaterService } from './AutoUpdater';

const waitingFor = (exit: string) => ({ phase: 'waiting', reason: 'tool', exit });

beforeEach(() => {
  setRestartOverlay(null);
  m.overlays.length = 0;
  m.present.mockClear();
});

describe('有工具在跑时三个重启入口都显示同一个等待蒙版', () => {
  it('横幅「重启更新」与设置页更新按钮（同一个 IPC，不管哪个窗口发）：等命令蒙版并唤起主窗口', async () => {
    if (process.platform === 'linux') process.env.APPIMAGE ??= '/tmp/enso.AppImage';
    registerUpdaterHandlers();
    autoUpdaterService.init({ on: vi.fn(), once: vi.fn() } as never, false, 'off');
    m.updaterEvents.get('update-downloaded')?.({ version: '9.9.9' });
    const settingsSender = { sender: { id: 42 } };
    // 受理结果等整条安装链路走完才回：工具结束前一直挂着
    const accepted = m.handlers.get('updater:quitAndInstall')?.(settingsSender);
    await vi.waitFor(() => expect(m.overlays).toContainEqual(waitingFor('update')));
    expect(m.present).toHaveBeenCalledExactlyOnceWith(m.mainWindow);
    m.finishTool();
    await vi.waitFor(() => expect(m.quitAndInstall).toHaveBeenCalledOnce());
    await expect(accepted).resolves.toEqual({ ok: true });
    expect(m.overlays.at(-1)).toBeNull();
  });

  it('菜单「重启」：同一个等待蒙版并唤起主窗口', async () => {
    const restart = createAppRestart({
      relaunch: vi.fn(),
      allowQuit: vi.fn(),
      quit: vi.fn(),
      prepareQuit: (onWaitingForTools) =>
        prepareAgentWorkerForQuit({
          reason: 'quit',
          hasRunningSessions: () => true,
          onWaitingForTools,
        }),
      stateChanged: (state, reason, blockers) =>
        setRestartOverlay(restartOverlayFor(state, reason, blockers)),
      abandonPrepare: vi.fn(),
    });
    restart.restart();
    expect(m.overlays).toContainEqual(waitingFor('restart'));
    expect(m.present).toHaveBeenCalledExactlyOnceWith(m.mainWindow);
    m.finishTool();
  });
});
