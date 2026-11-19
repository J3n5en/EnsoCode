import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
  order: [] as string[],
  quitAndInstall: vi.fn(),
  prepare: vi.fn(),
  cancel: vi.fn(),
  record: vi.fn(),
  needsCheckpoint: true,
}));
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/enso-updater-test', on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: {
      on: (event: string, handler: (...args: unknown[]) => void) => m.handlers.set(event, handler),
      quitAndInstall: m.quitAndInstall,
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
    },
  },
}));
vi.mock('../../ipc/sessionIndex', () => ({
  agentSessionIndex: { runningRootSessionIds: () => ['running-1'] },
  needsQuitCheckpoint: () => m.needsCheckpoint,
}));
vi.mock('../../ipc/settings', () => ({
  flushSettings: vi.fn(),
  writeTrayReenterAfterUpdate: vi.fn(),
}));
vi.mock('../../windows/createAppWindow', () => ({ sendToWindow: vi.fn() }));
vi.mock('../exitInterruptHost', () => ({ markExitForUpdate: vi.fn() }));
vi.mock('./idleRestartSnapshot', () => ({ currentIdleRestartObservation: () => ({}) }));
vi.mock('./interruptedSessions', () => ({ recordInterruptedSessions: m.record }));
vi.mock('../agentHost', () => ({
  prepareAgentWorkerForQuit: m.prepare,
  cancelAgentQuitCheckpoint: m.cancel,
}));
vi.mock('../../ipc/appRestart', () => ({
  waitWithExitDialog: async (
    exit: string,
    prepare: (onWaiting: (reason: string) => void) => Promise<unknown>
  ) => {
    try {
      return await prepare((reason) => m.order.push(`dialog-open:${exit}:${reason}`));
    } finally {
      m.order.push(`dialog-close:${exit}`);
    }
  },
}));
vi.mock('../appServerMode', () => ({
  flushRendererPersist: async () => {},
  isServerMode: () => false,
}));

import { autoUpdaterService } from './AutoUpdater';

autoUpdaterService.init({ on: vi.fn(), once: vi.fn() } as never, false, false);
m.handlers.get('update-downloaded')?.({ version: '9.9.9' });

beforeEach(() => {
  m.order.length = 0;
  m.quitAndInstall.mockReset().mockImplementation(() => m.order.push('quitAndInstall'));
  m.record.mockReset().mockImplementation(() => m.order.push('record'));
  m.cancel.mockReset().mockImplementation(() => m.order.push('cancel'));
});

describe('安装更新走优雅重启的安全点', () => {
  it('先等 worker 到安全点（断点与恢复清单落盘），再 quitAndInstall', async () => {
    let release!: (value: string) => void;
    m.prepare.mockReset().mockImplementation((options: { reason: string }) => {
      m.order.push(`prepare:${options.reason}`);
      return new Promise((resolve) => (release = resolve));
    });
    autoUpdaterService.requestRestart(true);
    await vi.waitFor(() => expect(m.prepare).toHaveBeenCalledOnce());
    expect(m.prepare.mock.calls[0][0].hasRunningSessions()).toBe(true);
    // 要不要等安全点看的是「有回合在跑或有后台命令在跑」，不是只看在跑的回合
    m.needsCheckpoint = false;
    expect(m.prepare.mock.calls[0][0].hasRunningSessions()).toBe(false);
    m.needsCheckpoint = true;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(m.quitAndInstall).not.toHaveBeenCalled();
    release('checkpointed');
    await vi.waitFor(() => expect(m.quitAndInstall).toHaveBeenCalledOnce());
    expect(m.order).toEqual(['prepare:update', 'dialog-close:update', 'record', 'quitAndInstall']);
    // 已在退出流程里：再点重启不叠加
    autoUpdaterService.requestRestart(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(m.prepare).toHaveBeenCalledOnce();
  });
});

describe('安装更新的等待弹层', () => {
  it('有命令在跑：开「等完安装更新」弹层；命令结束先关弹层再安装；强制退出（等待按超时结束）同样接着安装', async () => {
    vi.resetModules();
    const { autoUpdaterService: service } = await import('./AutoUpdater');
    service.init({ on: vi.fn(), once: vi.fn() } as never, false, false);
    m.handlers.get('update-downloaded')?.({ version: '9.9.9' });
    let release!: (value: string) => void;
    m.prepare.mockReset().mockImplementation(
      (options: { onWaitingForTools: (reason: string) => void }) =>
        new Promise((resolve) => {
          release = resolve;
          options.onWaitingForTools('tool');
        })
    );
    service.requestRestart(true);
    await vi.waitFor(() => expect(m.order).toEqual(['dialog-open:update:tool']));
    expect(m.quitAndInstall).not.toHaveBeenCalled();
    // 弹层上点「强制退出」→ forceAgentWorkerQuit 让等待以超时结束
    release('timeout');
    await vi.waitFor(() => expect(m.quitAndInstall).toHaveBeenCalledOnce());
    expect(m.order).toEqual([
      'dialog-open:update:tool',
      'dialog-close:update',
      'record',
      'quitAndInstall',
    ]);
  });
});
