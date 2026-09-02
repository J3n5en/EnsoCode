import { is } from '@electron-toolkit/utils';
import { IPC_CHANNELS } from '@shared/types';
import type { UpdateStatus } from '@shared/types/updater';
import { BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';
import { sendToWindow } from '../../windows/createAppWindow';

const { autoUpdater } = electronUpdater;

// 周期检查:4 小时
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
// focus 检查最小间隔:30 分钟
const MIN_FOCUS_CHECK_INTERVAL_MS = 30 * 60 * 1000;

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

  init(window: BrowserWindow, autoUpdateEnabled = true): void {
    this.mainWindow = window;

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
      // 停掉后续检查,防止竞态把下载完成的状态覆盖掉
      if (this.checkIntervalId) {
        clearInterval(this.checkIntervalId);
        this.checkIntervalId = null;
      }
      this.sendStatus({ status: 'downloaded', info: projectInfo(info) });
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

  quitAndInstall(): void {
    if (this.updateDownloaded) autoUpdater.quitAndInstall();
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
  }
}

/** electron-updater 的 UpdateInfo 收窄成可序列化的白名单形状 */
function projectInfo(info: electronUpdater.UpdateInfo): UpdateStatus['info'] {
  const notes = typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined;
  return {
    version: info.version,
    ...(notes ? { releaseNotes: notes } : {}),
    ...(info.releaseName ? { releaseName: info.releaseName } : {}),
  };
}

export const autoUpdaterService = new AutoUpdaterService();
