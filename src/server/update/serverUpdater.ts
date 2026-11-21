import type { ServerUpdateMode, UpdaterState, UpdateStatus } from '@shared/types/updater';
import { AUTO_RESTART_IDLE_MS, type AutoRestartMode } from '@shared/updater/idleRestart';
import {
  IdleRestartGate,
  type IdleRestartObservation,
} from '../../main/services/updater/idleRestartGate';
import { compareVersions, DEFAULT_NPM_REGISTRY, npmLatestUrl, parseNpmLatest } from './version';

/** 全局 npm 安装能力；装在 npx 缓存或不可写前缀时为 null */
export interface NpmInstaller {
  /** 预取到 npm 缓存，应用时离线优先安装 */
  prefetch(spec: string): Promise<void>;
  install(spec: string): Promise<void>;
}

export interface ServerUpdaterDeps {
  version: string;
  packageName: string;
  env: Record<string, string | undefined>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  npm: NpmInstaller | null;
  broadcast: (status: UpdateStatus) => void;
  quit: () => void;
  idle: () => IdleRestartObservation;
  now?: () => number;
}

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INITIAL_CHECK_MS = 30_000;
const BUSY_POLL_MS = 5_000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * 无界面服务端的自更新，对外与桌面 AutoUpdater 同一组 IPC 语义：
 * check → available → download（预取到 npm 缓存）→ downloaded → quitAndInstall（npm i -g 后退出，由守护进程拉起）。
 * 全局安装改写的是正在运行的文件，所以真正安装放在退出前一刻。
 */
export class ServerUpdater {
  private status: UpdateStatus | null = null;
  private latest: string | null = null;
  private downloadedVersion: string | null = null;
  private running: Promise<void> | null = null;
  private autoUpdate = false;
  private autoRestartMode: AutoRestartMode = 'off';
  private applying = false;
  private readonly idleGate = new IdleRestartGate();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: ServerUpdaterDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  mode(): ServerUpdateMode {
    return this.deps.npm ? 'npm' : 'manual';
  }

  canRestart(): boolean {
    return this.deps.env.ENSO_SUPERVISED === '1' || Boolean(this.deps.env.INVOCATION_ID);
  }

  state(): UpdaterState {
    return {
      host: 'server',
      status: this.status,
      mode: this.mode(),
      canRestart: this.canRestart(),
    };
  }

  start(autoUpdate: boolean, autoRestartMode: AutoRestartMode): void {
    this.autoRestartMode = autoRestartMode;
    this.setAutoUpdateEnabled(autoUpdate);
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.clearIdleTimer();
  }

  private later(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    timer.unref?.();
    this.timers.add(timer);
  }

  private setStatus(status: UpdateStatus, force = false): void {
    if (!force && this.downloadedVersion && status.status !== 'downloaded') return;
    this.status = status;
    this.deps.broadcast(status);
  }

  private fail(error: unknown): void {
    this.downloadedVersion = null;
    this.setStatus({ status: 'error', error: message(error) }, true);
  }

  private exclusive(task: () => Promise<void>): Promise<void> {
    if (this.running) return this.running;
    this.running = task().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async fetchLatest(): Promise<string | null> {
    const registry = this.deps.env.ENSO_NPM_REGISTRY?.trim() || DEFAULT_NPM_REGISTRY;
    const response = await this.deps.fetch(npmLatestUrl(registry, this.deps.packageName), {
      headers: { Accept: 'application/json', 'User-Agent': `enso-server/${this.deps.version}` },
    });
    if (!response.ok) throw new Error(`update check failed: HTTP ${response.status}`);
    return parseNpmLatest(await response.json());
  }

  checkForUpdates(): Promise<void> {
    if (this.downloadedVersion) return Promise.resolve();
    return this.exclusive(async () => {
      this.setStatus({ status: 'checking' });
      let version: string | null;
      try {
        version = await this.fetchLatest();
      } catch (error) {
        this.fail(error);
        return;
      }
      if (!version || compareVersions(version, this.deps.version) <= 0) {
        this.setStatus({
          status: 'not-available',
          info: { version: version ?? this.deps.version },
        });
        return;
      }
      this.latest = version;
      this.setStatus({ status: 'available', info: { version } });
      if (this.autoUpdate && this.mode() !== 'manual') await this.fetchUpdate();
    });
  }

  downloadUpdate(): Promise<void> {
    if (this.downloadedVersion) return Promise.resolve();
    return this.exclusive(() => this.fetchUpdate());
  }

  private spec(version: string): string {
    return `${this.deps.packageName}@${version}`;
  }

  private async fetchUpdate(): Promise<void> {
    const version = this.latest;
    try {
      if (!this.deps.npm) throw new Error('this install cannot update itself; run npm i -g');
      if (!version) throw new Error('check for updates first');
      this.setStatus({
        status: 'downloading',
        progress: { percent: 0, bytesPerSecond: 0, total: 0, transferred: 0 },
      });
      await this.deps.npm.prefetch(this.spec(version));
    } catch (error) {
      this.fail(error);
      return;
    }
    this.markDownloaded(version);
    this.idleGate.reset();
    this.notifyIdleStateChanged();
  }

  private markDownloaded(version: string): void {
    this.downloadedVersion = version;
    this.setStatus({ status: 'downloaded', info: { version } });
  }

  async quitAndInstall(): Promise<void> {
    const version = this.downloadedVersion;
    if (!version || this.applying) return;
    this.applying = true;
    try {
      if (!this.deps.npm) throw new Error('this install cannot update itself; run npm i -g');
      await this.deps.npm.install(this.spec(version));
      this.deps.quit();
    } catch (error) {
      this.applying = false;
      this.fail(error);
    }
  }

  restart(): void {
    if (!this.canRestart()) throw new Error('enso-server is not running under a supervisor');
    this.deps.quit();
  }

  setAutoUpdateEnabled(enabled: boolean): void {
    this.autoUpdate = enabled;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    if (enabled) {
      this.interval = setInterval(() => void this.checkForUpdates(), CHECK_INTERVAL_MS);
      this.interval.unref?.();
      this.later(INITIAL_CHECK_MS, () => void this.checkForUpdates());
    }
    this.notifyIdleStateChanged();
  }

  setAutoRestartMode(mode: AutoRestartMode): void {
    this.autoRestartMode = mode;
    if (mode === 'off') this.idleGate.reset();
    this.notifyIdleStateChanged();
  }

  private notifyIdleStateChanged(): void {
    this.clearIdleTimer();
    if (
      this.applying ||
      this.idleGate.isFailed() ||
      !this.downloadedVersion ||
      !this.autoUpdate ||
      this.autoRestartMode === 'off' ||
      !this.canRestart()
    ) {
      return;
    }
    const now = this.now();
    if (this.idleGate.evaluate(this.deps.idle(), this.autoRestartMode, now)) {
      void this.quitAndInstall();
      return;
    }
    const remaining = this.idleGate.delayUntilReadyMs(now);
    const delay = Math.min(
      remaining === null ? BUSY_POLL_MS : Math.max(remaining, 250),
      AUTO_RESTART_IDLE_MS
    );
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.notifyIdleStateChanged();
    }, delay);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
