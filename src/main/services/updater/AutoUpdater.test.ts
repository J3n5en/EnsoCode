import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  userData: '',
  sent: [] as Array<{ restartPending?: boolean }>,
  observation: {} as Record<string, unknown>,
  handlers: new Map<string, (...args: unknown[]) => void>(),
  order: [] as string[],
  quitAndInstall: vi.fn(),
  prepare: vi.fn(),
  cancel: vi.fn(),
  needsCheckpoint: true,
  nativeHandlers: new Map<string, () => void>(),
  watchdog: { begin: vi.fn(), step: vi.fn(), cancel: vi.fn() },
  leaveServerMode: vi.fn(),
  showMessageBox: vi.fn(async () => ({ response: 0 })),
}));
vi.mock('node:fs', async (importActual) => {
  const fs = await importActual<typeof import('node:fs')>();
  m.userData = fs.mkdtempSync(`${(await import('node:os')).tmpdir()}/enso-updater-`);
  return fs;
});
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));
vi.mock('electron', () => ({
  app: { getPath: () => m.userData, on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [{}], getFocusedWindow: () => null },
  autoUpdater: {
    on: (event: string, handler: () => void) => m.nativeHandlers.set(event, handler),
  },
  dialog: { showMessageBox: m.showMessageBox },
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
  needsQuitCheckpoint: () => m.needsCheckpoint,
}));
vi.mock('../../ipc/settings', () => ({
  flushSettings: vi.fn(),
  readLocale: () => 'zh',
  writeTrayReenterAfterUpdate: vi.fn(),
}));
vi.mock('../../windows/createAppWindow', () => ({
  sendToWindow: (_win: unknown, _channel: string, status: { restartPending?: boolean }) =>
    m.sent.push(status),
}));
vi.mock('../exitInterruptHost', () => ({ markExitForUpdate: vi.fn() }));
vi.mock('../appQuitWatchdog', () => ({ quitWatchdog: m.watchdog }));
vi.mock('./idleRestartSnapshot', () => ({ currentIdleRestartObservation: () => m.observation }));
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
  leaveServerMode: m.leaveServerMode,
}));

import { existsSync } from 'node:fs';
import path from 'node:path';
import { autoUpdaterService } from './AutoUpdater';

autoUpdaterService.init({ on: vi.fn(), once: vi.fn() } as never, false, 'off');
m.handlers.get('update-downloaded')?.({ version: '9.9.9' });

beforeEach(() => {
  m.order.length = 0;
  m.quitAndInstall.mockReset().mockImplementation(() => m.order.push('quitAndInstall'));
  m.sent.length = 0;
  m.observation = {};
  m.cancel.mockReset().mockImplementation(() => m.order.push('cancel'));
});

describe('安装更新走优雅重启的安全点', () => {
  it('先等 worker 到安全点（断点与恢复清单落盘），再 quitAndInstall', async () => {
    let release!: (value: string) => void;
    m.prepare.mockReset().mockImplementation((options: { reason: string }) => {
      m.order.push(`prepare:${options.reason}`);
      return new Promise((resolve) => (release = resolve));
    });
    autoUpdaterService.requestRestart();
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
    expect(m.order).toEqual(['prepare:update', 'dialog-close:update', 'quitAndInstall']);
    // 已在退出流程里：再点重启不叠加
    autoUpdaterService.requestRestart();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(m.prepare).toHaveBeenCalledOnce();
  });
});

describe('安装更新的等待弹层', () => {
  it('有命令在跑：开「等完安装更新」弹层；命令结束先关弹层再安装；强制退出（等待按超时结束）同样接着安装', async () => {
    vi.resetModules();
    const { autoUpdaterService: service } = await import('./AutoUpdater');
    service.init({ on: vi.fn(), once: vi.fn() } as never, false, 'off');
    m.handlers.get('update-downloaded')?.({ version: '9.9.9' });
    let release!: (value: string) => void;
    m.prepare.mockReset().mockImplementation(
      (options: { onWaitingForTools: (reason: string) => void }) =>
        new Promise((resolve) => {
          release = resolve;
          options.onWaitingForTools('tool');
        })
    );
    service.requestRestart();
    await vi.waitFor(() => expect(m.order).toEqual(['dialog-open:update:tool']));
    expect(m.quitAndInstall).not.toHaveBeenCalled();
    // 弹层上点「强制退出」→ forceAgentWorkerQuit 让等待以超时结束
    release('timeout');
    await vi.waitFor(() => expect(m.quitAndInstall).toHaveBeenCalledOnce());
    expect(m.order).toEqual(['dialog-open:update:tool', 'dialog-close:update', 'quitAndInstall']);
  });
});

describe('重启更新不等整个回合', () => {
  it('有回合在跑、排队、待答与审批时也直接进安全点，不挂起等回合，不写 interrupted-by-update.json', async () => {
    vi.resetModules();
    const { autoUpdaterService: service } = await import('./AutoUpdater');
    service.init({ on: vi.fn(), once: vi.fn() } as never, false, 'off');
    m.handlers.get('update-downloaded')?.({ version: '9.9.9' });
    m.sent.length = 0;
    m.observation = {
      agentBusy: true,
      queuedCount: 2,
      pendingAskCount: 1,
      pendingApprovalCount: 1,
      windowFocused: true,
    };
    m.prepare.mockReset().mockResolvedValue('checkpointed');
    service.requestRestart();
    await vi.waitFor(() => expect(m.quitAndInstall).toHaveBeenCalledOnce());
    expect(m.prepare).toHaveBeenCalledOnce();
    expect(m.sent.some((status) => 'restartPending' in status)).toBe(false);
    expect(existsSync(path.join(m.userData, 'interrupted-by-update.json'))).toBe(false);
  });
});

describe('下载完成后的自动重启模式', () => {
  const calm = {
    agentBusy: false,
    queuedCount: 0,
    pendingAskCount: 0,
    pendingApprovalCount: 0,
    windowFocused: false,
    userActive: false,
    unsentDraft: false,
  };

  async function downloadedWith(mode: 'off' | 'idle' | 'immediate') {
    vi.resetModules();
    const { autoUpdaterService: service } = await import('./AutoUpdater');
    m.prepare.mockReset().mockResolvedValue('checkpointed');
    service.init({ on: vi.fn(), once: vi.fn() } as never, true, mode);
    m.handlers.get('update-downloaded')?.({ version: '9.9.9' });
    return service;
  }

  it('不等空闲：有 agent 在跑、排队、窗口在前台也装；前台最近有输入先等，输入停了再装', async () => {
    vi.useFakeTimers();
    try {
      m.observation = {
        ...calm,
        agentBusy: true,
        queuedCount: 1,
        windowFocused: true,
        userActive: true,
      };
      await downloadedWith('immediate');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(m.prepare).not.toHaveBeenCalled();
      m.observation = { ...m.observation, userActive: false };
      await vi.advanceTimersByTimeAsync(5_000);
      expect(m.prepare).toHaveBeenCalledOnce();
      expect(m.quitAndInstall).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('不等空闲：输入框有会丢的草稿时先等', async () => {
    vi.useFakeTimers();
    try {
      m.observation = { ...calm, unsentDraft: true };
      await downloadedWith('immediate');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(m.prepare).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('空闲时：有 agent 在跑不装', async () => {
    vi.useFakeTimers();
    try {
      m.observation = { ...calm, agentBusy: true };
      await downloadedWith('idle');
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(m.prepare).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('关：一直空闲也不装', async () => {
    vi.useFakeTimers();
    try {
      m.observation = calm;
      await downloadedWith('off');
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(m.prepare).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('安装更新途中失败', () => {
  it('看门狗跟住整个安装；Squirrel 报错（窗口可能已被关掉）时撤掉退出、恢复主窗口并说明原因', async () => {
    vi.resetModules();
    const { autoUpdaterService: service } = await import('./AutoUpdater');
    service.init({ on: vi.fn(), once: vi.fn() } as never, false, 'off');
    m.handlers.get('update-downloaded')?.({ version: '9.9.9' });
    m.prepare.mockReset().mockResolvedValue('checkpointed');
    m.watchdog.begin.mockClear();
    m.watchdog.step.mockClear();
    m.watchdog.cancel.mockClear();
    service.requestRestart();
    await vi.waitFor(() => expect(m.quitAndInstall).toHaveBeenCalledOnce());
    expect(m.watchdog.begin).toHaveBeenCalledWith('update', expect.any(String));
    expect(m.watchdog.step).toHaveBeenCalledWith('等 Squirrel 接手安装');
    m.nativeHandlers.get('before-quit-for-update')?.();
    expect(m.watchdog.step).toHaveBeenLastCalledWith(expect.any(String), { finishing: true });

    m.handlers.get('error')?.(new Error('ShipIt failed'));
    expect(m.order).toContain('cancel');
    expect(m.watchdog.cancel).toHaveBeenCalledOnce();
    expect(service.isQuittingForUpdate()).toBe(false);
    await vi.waitFor(() => expect(m.leaveServerMode).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(m.showMessageBox).toHaveBeenCalledWith(
        expect.objectContaining({ message: '重启失败：ShipIt failed' })
      )
    );
  });

  it('平时的检查 / 下载错误不动窗口', async () => {
    vi.resetModules();
    const { autoUpdaterService: service } = await import('./AutoUpdater');
    service.init({ on: vi.fn(), once: vi.fn() } as never, false, 'off');
    m.leaveServerMode.mockClear();
    m.watchdog.cancel.mockClear();
    m.handlers.get('error')?.(new Error('net::ERR_INTERNET_DISCONNECTED'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(m.leaveServerMode).not.toHaveBeenCalled();
    expect(m.watchdog.cancel).not.toHaveBeenCalled();
  });
});
