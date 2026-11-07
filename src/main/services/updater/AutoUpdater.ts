import { is } from '@electron-toolkit/utils';
import { IPC_CHANNELS } from '@shared/types';
import type { UpdateStatus } from '@shared/types/updater';
import { AUTO_RESTART_IDLE_MS, isTurnRestartBlocked } from '@shared/updater/idleRestart';
import { normalizeReleaseNotes } from '@shared/updater/releaseNotes';
import { app, BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';
import { agentSessionIndex } from '../../ipc/capabilities';
import { flushSettings, writeTrayReenterAfterUpdate } from '../../ipc/settings';
import { sendToWindow } from '../../windows/createAppWindow';
import { IdleRestartGate } from './idleRestartGate';
import { currentIdleRestartObservation } from './idleRestartSnapshot';
import { recordInterruptedSessions } from './interruptedSessions';

const { autoUpdater } = electronUpdater;

// 周期检查:4 小时
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
// focus 检查最小间隔:30 分钟
const MIN_FOCUS_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const BUSY_POLL_MS = 5_000;

/**
 * 自动更新单例(移植自 EnsoAI,剥离 proxy 耦合)。
 * 事件 → 广播全部窗口(设置为独立窗口,主窗口与设置窗口都要收到);
 * 周期 + focus 去抖检查;下载完成后停后续检查并提示重启。
 */
class AutoUpdaterService {
  private mainWindow: BrowserWindow | null = null;
  private updateDownloaded = false;
  private checkIntervalId: NodeJS.Timeout | null = null;
  private initialCheckTimer: NodeJS.Timeout | null = null;
  private lastCheckTime = 0;
  private onFocusHandler: (() => void) | null = null;
  private quittingForUpdate = false;
  private autoRestartWhenIdle = false;
  private idleGate = new IdleRestartGate();
  private idleTimer: NodeJS.Timeout | null = null;
  private installingIdleRestart = false;
  private restartPending = false;
  private downloadedInfo: UpdateStatus['info'];

  init(window: BrowserWindow, autoUpdateEnabled = true, autoRestartWhenIdle = false): void {
    this.mainWindow = window;
    this.autoRestartWhenIdle = autoRestartWhenIdle;

    if (is.dev) {
      autoUpdater.logger = console;
    }

    autoUpdater.on('checking-for-update', () => this.sendStatus({ status: 'checking' }));
    autoUpdater.on('update-available', (info) =>
      this.sendStatus({ status: 'available', info: projectInfo(info) })
    );
    autoUpdater.on('update-not-available', (info) =>
      this.sendStatus({ status: 'not-available', info: projectInfo(info) })
    );
    autoUpdater.on('download-progress', (progress) => {
      this.sendStatus({
        status: 'downloading',
        progress: {
          percent: progress.percent,
          bytesPerSecond: progress.bytesPerSecond,
          total: progress.total,
          transferred: progress.transferred,
        },
      });
    });
    autoUpdater.on('update-downloaded', (info) => {
      this.updateDownloaded = true;
      this.idleGate.reset();
      // 停掉后续检查,防止竞态把下载完成的状态覆盖掉
      if (this.checkIntervalId) {
        clearInterval(this.checkIntervalId);
        this.checkIntervalId = null;
      }
      this.downloadedInfo = projectInfo(info);
      this.sendStatus({ status: 'downloaded', info: this.downloadedInfo });
      this.notifyIdleStateChanged();
    });
    autoUpdater.on('error', (error) => this.sendStatus({ status: 'error', error: error.message }));

    autoUpdater.autoDownload = autoUpdateEnabled;

    // focus 触发检查(30 分钟去抖)
    this.onFocusHandler = () => {
      if (
        autoUpdater.autoDownload &&
        Date.now() - this.lastCheckTime >= MIN_FOCUS_CHECK_INTERVAL_MS
      ) {
        void this.checkForUpdates();
      }
    };
    window.on('focus', this.onFocusHandler);
    window.once('closed', () => {
      if (this.mainWindow === window) {
        this.mainWindow = null;
        this.onFocusHandler = null;
      }
    });

    this.setAutoUpdateEnabled(autoUpdateEnabled);
    app.on('browser-window-focus', () => this.notifyIdleStateChanged());
    app.on('browser-window-blur', () => this.notifyIdleStateChanged());
  }

  private sendStatus(status: UpdateStatus): void {
    // 下载完成后不再发别的状态,避免更新提示被后续检查冲掉
    if (this.updateDownloaded && status.status !== 'downloaded') return;
    for (const win of BrowserWindow.getAllWindows()) {
      sendToWindow(win, IPC_CHANNELS.UPDATER_STATUS, status);
    }
  }

  async checkForUpdates(): Promise<void> {
    if (this.updateDownloaded) return;
    try {
      this.lastCheckTime = Date.now();
      await autoUpdater.checkForUpdates();
    } catch (error) {
      console.error('Failed to check for updates:', error);
    }
  }

  async downloadUpdate(): Promise<void> {
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      console.error('Failed to download update:', error);
      throw error;
    }
  }

  isQuittingForUpdate(): boolean {
    return this.quittingForUpdate;
  }

  /** 用户点重启：有回合在跑时等它们结束再装，now 跳过等待 */
  requestRestart(now = false): void {
    if (!this.updateDownloaded || this.quittingForUpdate) return;
    if (now || !this.turnsBlockRestart()) {
      this.setRestartPending(false);
      void this.install(() => true);
      return;
    }
    this.setRestartPending(true);
    this.notifyIdleStateChanged();
  }

  cancelRestart(): void {
    if (!this.restartPending) return;
    this.setRestartPending(false);
    this.notifyIdleStateChanged();
  }

  private turnsBlockRestart(): boolean {
    return isTurnRestartBlocked(currentIdleRestartObservation(true, true));
  }

  private setRestartPending(pending: boolean): void {
    if (this.restartPending === pending) return;
    this.restartPending = pending;
    this.sendStatus({
      status: 'downloaded',
      info: this.downloadedInfo,
      ...(pending ? { restartPending: true } : {}),
    });
  }

  private quitAndInstall(): void {
    if (!this.updateDownloaded) return;
    this.quittingForUpdate = true;
    try {
      recordInterruptedSessions(app.getPath('userData'), agentSessionIndex.runningRootSessionIds());
    } catch (error) {
      console.error('Failed to record sessions interrupted by update:', error);
    }
    autoUpdater.quitAndInstall();
  }

  setAutoUpdateEnabled(enabled: boolean): void {
    autoUpdater.autoDownload = enabled;
    autoUpdater.autoInstallOnAppQuit = enabled;
    if (enabled) {
      if (!this.checkIntervalId) {
        this.checkIntervalId = setInterval(() => void this.checkForUpdates(), CHECK_INTERVAL_MS);
      }
      if (this.initialCheckTimer) clearTimeout(this.initialCheckTimer);
      this.initialCheckTimer = setTimeout(() => {
        this.initialCheckTimer = null;
        void this.checkForUpdates();
      }, 3000);
    } else {
      if (this.checkIntervalId) {
        clearInterval(this.checkIntervalId);
        this.checkIntervalId = null;
      }
      if (this.initialCheckTimer) {
        clearTimeout(this.initialCheckTimer);
        this.initialCheckTimer = null;
      }
    }
    this.notifyIdleStateChanged();
  }

  setAutoRestartWhenIdle(enabled: boolean): void {
    this.autoRestartWhenIdle = enabled;
    if (!enabled) this.idleGate.reset();
    this.notifyIdleStateChanged();
  }

  notifyIdleStateChanged(): void {
    if (this.installingIdleRestart || this.quittingForUpdate || !this.updateDownloaded) {
      this.clearIdleTimer();
      return;
    }
    if (this.restartPending) {
      if (this.turnsBlockRestart()) {
        this.scheduleIdleCheck(BUSY_POLL_MS);
        return;
      }
      this.clearIdleTimer();
      void this.install(() => !this.turnsBlockRestart());
      return;
    }
    if (this.idleGate.isFailed() || !this.autoRestartWhenIdle || !autoUpdater.autoDownload) {
      this.clearIdleTimer();
      return;
    }
    const now = Date.now();
    const observation = currentIdleRestartObservation(true, true);
    if (this.idleGate.evaluate(observation, now)) {
      this.clearIdleTimer();
      void this.install(() =>
        this.idleGate.evaluate(currentIdleRestartObservation(true, true), Date.now())
      );
      return;
    }
    const remaining = this.idleGate.delayUntilReadyMs(now);
    this.scheduleIdleCheck(remaining === null ? BUSY_POLL_MS : Math.max(remaining, 250));
  }

  private scheduleIdleCheck(delayMs: number): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(
      () => {
        this.idleTimer = null;
        this.notifyIdleStateChanged();
      },
      Math.min(delayMs, AUTO_RESTART_IDLE_MS)
    );
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** 落盘渲染层状态与设置后安装；recheck 在落盘后复核仍可重启 */
  private async install(recheck: () => boolean): Promise<void> {
    if (this.installingIdleRestart || this.quittingForUpdate) return;
    this.installingIdleRestart = true;
    try {
      const { flushRendererPersist, isServerMode } = await import('../appServerMode');
      await flushRendererPersist();
      flushSettings();
      if (!recheck()) return;
      if (isServerMode()) writeTrayReenterAfterUpdate(true);
      this.quitAndInstall();
    } catch (error) {
      console.error('Restart to update failed:', error);
      this.idleGate.markFailed();
      this.setRestartPending(false);
      writeTrayReenterAfterUpdate(false);
      this.clearIdleTimer();
    } finally {
      this.installingIdleRestart = false;
      if (!this.quittingForUpdate && !this.idleGate.isFailed()) this.notifyIdleStateChanged();
    }
  }
}

/** electron-updater 的 UpdateInfo 收窄成可序列化的白名单形状 */
function projectInfo(info: electronUpdater.UpdateInfo): UpdateStatus['info'] {
  const notes = normalizeReleaseNotes(info.releaseNotes);
  return {
    version: info.version,
    ...(notes ? { releaseNotes: notes } : {}),
    ...(info.releaseName ? { releaseName: info.releaseName } : {}),
  };
}

export const autoUpdaterService = new AutoUpdaterService();
