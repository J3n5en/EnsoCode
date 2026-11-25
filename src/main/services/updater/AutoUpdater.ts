import path from 'node:path';
import { is } from '@electron-toolkit/utils';
import { IPC_CHANNELS } from '@shared/types/ipc';
import type { ManualInstall, RestartToUpdateResult, UpdateStatus } from '@shared/types/updater';
import { applyUpdateChannel, type UpdateChannel } from '@shared/updater/channel';
import { AUTO_RESTART_IDLE_MS, type AutoRestartMode } from '@shared/updater/idleRestart';
import { normalizeReleaseNotes } from '@shared/updater/releaseNotes';
import { app, BrowserWindow, dialog, autoUpdater as nativeAutoUpdater } from 'electron';
import electronUpdater from 'electron-updater';
import { waitWithExitDialog } from '../../ipc/appRestart';
import { needsQuitCheckpoint } from '../../ipc/sessionIndex';
import { flushSettings, readLocale, writeTrayReenterAfterUpdate } from '../../ipc/settings';
import { sendToWindow } from '../../windows/createAppWindow';
import { cancelAgentQuitCheckpoint, prepareAgentWorkerForQuit } from '../agentHost';
import { quitWatchdog } from '../appQuitWatchdog';
import { markExitForUpdate } from '../exitInterruptHost';
import { IdleRestartGate } from './idleRestartGate';
import { currentIdleRestartObservation } from './idleRestartSnapshot';
import {
  canAutoInstall,
  inspectAppSignature,
  isCodeSignatureError,
  manualInstallFor,
} from './localBuildInstall';
import { ensureFallbackUpdateConfig } from './updateFeed';

const { autoUpdater } = electronUpdater;

// 周期检查:4 小时
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
// focus 检查最小间隔:30 分钟
const MIN_FOCUS_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const BUSY_POLL_MS = 5_000;
// 渲染层落盘只等在途的设置写入（毫秒级）；短于通用的 5s，超时由这里记日志
const UPDATE_FLUSH_TIMEOUT_MS = 3_000;

/**
 * 自动更新单例(移植自 EnsoAI,剥离 proxy 耦合)。
 * 事件 → 广播全部窗口;
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
  private autoRestartMode: AutoRestartMode = 'off';
  private idleGate = new IdleRestartGate();
  private idleTimer: NodeJS.Timeout | null = null;
  private installingIdleRestart = false;
  private downloadedInfo: UpdateStatus['info'];
  private autoUpdateEnabled = true;
  /** 无 app-update.yml 的本地构建（electron-builder --dir） */
  private localBuild = false;
  /** 本地构建签名装不上正式包：只检查，不下载 */
  private manualInstallOnly = false;
  private localBuildReady: Promise<void> | null = null;
  private availableInfo: electronUpdater.UpdateInfo | undefined;

  init(
    window: BrowserWindow,
    autoUpdateEnabled = true,
    autoRestartMode: AutoRestartMode = 'off',
    channel: UpdateChannel = 'stable'
  ): void {
    this.mainWindow = window;
    this.autoRestartMode = autoRestartMode;
    applyUpdateChannel(autoUpdater, channel);

    if (is.dev) {
      autoUpdater.logger = console;
    }
    this.setupLocalBuild();

    autoUpdater.on('checking-for-update', () => this.sendStatus({ status: 'checking' }));
    autoUpdater.on('update-available', (info) => {
      this.availableInfo = info;
      this.sendStatus({
        status: 'available',
        info: projectInfo(info),
        ...(this.manualInstallOnly ? { manualInstall: manualInstallFor(info, process.arch) } : {}),
      });
    });
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
    autoUpdater.on('error', (error) => {
      const installing = this.quittingForUpdate;
      const manualInstall =
        this.localBuild && isCodeSignatureError(error.message)
          ? this.fallBackToManualInstall()
          : undefined;
      this.sendStatus({
        status: 'error',
        error: error.message,
        ...(manualInstall ? { manualInstall } : {}),
      });
      if (installing) this.recoverFailedInstall(error.message);
    });
    // Squirrel 接手后先关全部窗口、再发 before-quit：安全点已过，收尾期限收紧
    nativeAutoUpdater.on('before-quit-for-update', () =>
      quitWatchdog.step('安装更新：关闭所有窗口', { finishing: true })
    );

    autoUpdater.autoDownload = autoUpdateEnabled;

    // focus 触发检查(30 分钟去抖)
    this.onFocusHandler = () => {
      if (
        this.autoUpdateEnabled &&
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

  /** --dir 构建缺 app-update.yml：改用内置 feed；macOS 上再看签名能否通过 Squirrel.Mac 校验 */
  private setupLocalBuild(): void {
    if (!process.resourcesPath) return;
    let configPath: string | null;
    try {
      configPath = ensureFallbackUpdateConfig(
        process.resourcesPath,
        path.join(app.getPath('userData'), 'updater')
      );
    } catch (error) {
      console.error('Failed to write fallback update config:', error);
      return;
    }
    if (!configPath) return;
    this.localBuild = true;
    autoUpdater.updateConfigPath = configPath;
    if (process.platform !== 'darwin') return;
    this.localBuildReady = inspectAppSignature(
      path.resolve(process.resourcesPath, '..', '..')
    ).then((kind) => {
      if (canAutoInstall(kind)) return;
      console.warn(`[updater] local build signature=${kind}: updates require manual install`);
      this.manualInstallOnly = true;
      this.applyAutoDownload();
    });
  }

  /** Squirrel.Mac 拒装本地构建：撤掉已下载/待重启状态，之后只给手动下载入口 */
  private fallBackToManualInstall(): ManualInstall {
    this.manualInstallOnly = true;
    this.applyAutoDownload();
    this.updateDownloaded = false;
    this.downloadedInfo = undefined;
    this.idleGate.reset();
    this.clearIdleTimer();
    if (this.quittingForUpdate) {
      this.quittingForUpdate = false;
      cancelAgentQuitCheckpoint();
    }
    if (this.autoUpdateEnabled && !this.checkIntervalId) {
      this.checkIntervalId = setInterval(() => void this.checkForUpdates(), CHECK_INTERVAL_MS);
    }
    return manualInstallFor(this.availableInfo, process.arch);
  }

  /** 安装更新途中出错（窗口可能已被 quitAndInstall 关掉）：撤掉退出流程，恢复主窗口并说明原因 */
  private recoverFailedInstall(message: string): void {
    if (this.quittingForUpdate) {
      this.quittingForUpdate = false;
      cancelAgentQuitCheckpoint();
    }
    quitWatchdog.cancel();
    this.idleGate.markFailed();
    this.clearIdleTimer();
    writeTrayReenterAfterUpdate(false);
    void import('../appServerMode')
      .then(({ leaveServerMode }) => {
        leaveServerMode();
        const text = readLocale() === 'zh' ? `重启失败：${message}` : `Restart failed: ${message}`;
        const win = BrowserWindow.getFocusedWindow();
        return win && !win.isDestroyed()
          ? dialog.showMessageBox(win, { type: 'error', message: text })
          : dialog.showMessageBox({ type: 'error', message: text });
      })
      .catch((error: unknown) => console.error('[updater] 恢复窗口失败:', error));
  }

  private applyAutoDownload(): void {
    const auto = this.autoUpdateEnabled && !this.manualInstallOnly;
    autoUpdater.autoDownload = auto;
    autoUpdater.autoInstallOnAppQuit = auto;
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
      if (this.localBuildReady) await this.localBuildReady;
      await autoUpdater.checkForUpdates();
    } catch (error) {
      console.error('Failed to check for updates:', error);
    }
  }

  async downloadUpdate(): Promise<void> {
    if (this.manualInstallOnly) return;
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

  /** 用户点重启更新：不等回合结束，直接走优雅重启的安全点 */
  requestRestart(): Promise<RestartToUpdateResult> {
    if (!this.updateDownloaded) return Promise.resolve({ ok: false, reason: 'not-downloaded' });
    return this.install(() => true);
  }

  private async quitAndInstall(): Promise<void> {
    if (!this.updateDownloaded) return;
    this.quittingForUpdate = true;
    quitWatchdog.begin('update', '等 agent 安全点');
    // 退出记录要写明是安装更新：会话里的系统提示据此说清原因
    markExitForUpdate();
    // 与应用退出同一套：先等 agent worker 到安全点、断点与恢复清单落盘，再交给 electron-updater。
    // 没有正在跑的会话立即返回；有命令在跑主窗口弹等待层（等完先关再装），强制退出或等太久（超时）照常安装
    await waitWithExitDialog('update', (onWaitingForTools) =>
      prepareAgentWorkerForQuit({
        reason: 'update',
        hasRunningSessions: needsQuitCheckpoint,
        onWaitingForTools,
        // 装完会重新打开：能脱离的转后台命令交给新实例认回
        keepBackgroundTasks: true,
      })
    );
    try {
      quitWatchdog.step('等 Squirrel 接手安装');
      autoUpdater.quitAndInstall();
    } catch (error) {
      // 没退成：worker 已停在安全点，撤掉清单并按断点换代接着跑
      this.quittingForUpdate = false;
      cancelAgentQuitCheckpoint();
      quitWatchdog.cancel();
      throw error;
    }
  }

  setAutoUpdateEnabled(enabled: boolean): void {
    this.autoUpdateEnabled = enabled;
    this.applyAutoDownload();
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

  /** 切渠道只影响之后的检查；切回稳定版不降级，等下一个正式版 */
  setChannel(channel: UpdateChannel): void {
    applyUpdateChannel(autoUpdater, channel);
    if (this.autoUpdateEnabled) void this.checkForUpdates();
  }

  setAutoRestartMode(mode: AutoRestartMode): void {
    this.autoRestartMode = mode;
    if (mode === 'off') this.idleGate.reset();
    this.notifyIdleStateChanged();
  }

  notifyIdleStateChanged(): void {
    if (this.installingIdleRestart || this.quittingForUpdate || !this.updateDownloaded) {
      this.clearIdleTimer();
      return;
    }
    if (this.idleGate.isFailed() || this.autoRestartMode === 'off' || !autoUpdater.autoDownload) {
      this.clearIdleTimer();
      return;
    }
    const now = Date.now();
    const mode = this.autoRestartMode;
    if (this.idleGate.evaluate(currentIdleRestartObservation(), mode, now)) {
      this.clearIdleTimer();
      // 不等空闲也走同一个优雅重启安全点：在跑的会话按恢复清单续跑
      void this.install(() =>
        this.idleGate.evaluate(currentIdleRestartObservation(), mode, Date.now())
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
  private async install(recheck: () => boolean): Promise<RestartToUpdateResult> {
    if (this.installingIdleRestart || this.quittingForUpdate) return { ok: false, reason: 'busy' };
    this.installingIdleRestart = true;
    try {
      const { flushRendererPersist, isServerMode } = await import('../appServerMode');
      await flushWithin(flushRendererPersist(), UPDATE_FLUSH_TIMEOUT_MS);
      flushSettings();
      if (!recheck()) return { ok: true };
      if (isServerMode()) writeTrayReenterAfterUpdate(true);
      await this.quitAndInstall();
      return { ok: true };
    } catch (error) {
      console.error('Restart to update failed:', error);
      this.idleGate.markFailed();
      writeTrayReenterAfterUpdate(false);
      this.clearIdleTimer();
      return {
        ok: false,
        reason: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.installingIdleRestart = false;
      if (!this.quittingForUpdate && !this.idleGate.isFailed()) this.notifyIdleStateChanged();
    }
  }
}

/** 渲染层落盘尽力而为：主进程设置随后由 flushSettings 落盘，超时只丢在途的那次写入，记日志后照常安装 */
async function flushWithin(flush: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    flush.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), ms);
    }),
  ]).finally(() => clearTimeout(timer));
  if (timedOut) console.warn(`[updater] 渲染层落盘 ${ms}ms 未回应，跳过等待继续安装`);
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
