import type {
  ServerRestartMethod,
  ServerUpdateMode,
  UpdaterState,
  UpdateStatus,
} from '@shared/types/updater';
import type { UpdateChannel } from '@shared/updater/channel';
import type { AutoRestartMode } from '@shared/updater/idleRestart';
import { detectRestartMethod } from './reexec';
import { compareVersions, DEFAULT_NPM_REGISTRY, npmDistTagUrl, parseNpmLatest } from './version';

/** 应用更新时等正在跑的 turn 收完的上限；超时后安全中断（断点续跑机制兜底） */
const WAIT_FOR_TASKS_MS = 5 * 60 * 1000;
const WAIT_POLL_MS = 1_000;

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
  now?: () => number;
  /** 测试覆盖：进程 pid（reexec 探测 PID1 用） */
  pid?: number;
  /** 还在跑回合的工作区数（应用前等待用） */
  busyCount?: () => number;
  /** 无守护时拉起替代进程 */
  spawnReexec?: () => void;
  /** 健康检查标记：安装前写入、安装失败清除 */
  writePending?: (update: { from: string; to: string }) => void;
  clearPending?: () => void;
  /** 测试缩短等待上限/轮询 */
  waitForTasksMs?: number;
  waitPollMs?: number;
}

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INITIAL_CHECK_MS = 30_000;

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
  private applying = false;
  private channel: UpdateChannel = 'stable';
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: ServerUpdaterDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  mode(): ServerUpdateMode {
    return this.deps.npm ? 'npm' : 'manual';
  }

  restartMethod(): ServerRestartMethod {
    return detectRestartMethod(this.deps.env, this.deps.pid ?? process.pid);
  }

  canRestart(): boolean {
    return this.restartMethod() !== 'manual';
  }

  state(): UpdaterState {
    return {
      host: 'server',
      status: this.status,
      mode: this.mode(),
      canRestart: this.canRestart(),
      restartMethod: this.restartMethod(),
      channel: this.channel,
    };
  }

  start(autoUpdate: boolean, autoRestartMode: AutoRestartMode): void {
    this.setAutoRestartMode(autoRestartMode);
    this.setAutoUpdateEnabled(autoUpdate);
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
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

  private async fetchTag(tag: string): Promise<string | null> {
    const registry = this.deps.env.ENSO_NPM_REGISTRY?.trim() || DEFAULT_NPM_REGISTRY;
    const response = await this.deps.fetch(npmDistTagUrl(registry, this.deps.packageName, tag), {
      headers: { Accept: 'application/json', 'User-Agent': `enso-server/${this.deps.version}` },
    });
    if (!response.ok) throw new Error(`update check failed: HTTP ${response.status}`);
    return parseNpmLatest(await response.json());
  }

  /**
   * stable 只看 latest；beta 取 beta 与 latest 中较新的（与桌面「取两者较新」口径一致）。
   * beta dist-tag 还没发过（404/网络错误）时回退 latest，不算检查失败。
   */
  private async fetchLatest(): Promise<string | null> {
    const stable = await this.fetchTag('latest');
    if (this.channel !== 'beta') return stable;
    let beta: string | null = null;
    try {
      beta = await this.fetchTag('beta');
    } catch {
      beta = null;
    }
    if (beta && (!stable || compareVersions(beta, stable) > 0)) return beta;
    return stable;
  }

  /**
   * 切渠道只影响之后的检查；切回 stable 不降级（正式版更旧就报已是最新，等下一个正式版）。
   * 已下载的版本若不属于新渠道作废重查，避免 beta 下载被 stable 渠道装进去。
   */
  setChannel(channel: UpdateChannel): void {
    if (channel === this.channel) return;
    this.channel = channel;
    if (this.downloadedVersion) {
      const invalid = channel === 'stable' ? this.downloadedVersion.includes('-') : false;
      if (invalid || !this.downloadedVersion) this.clearDownloaded();
    }
    void this.checkForUpdates();
  }

  private clearDownloaded(): void {
    this.downloadedVersion = null;
    this.latest = null;
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
      // 等正在跑的 turn 收完；超时后按推荐方案安全中断（退出收尾会写断点，重启后续跑）
      const busyCount = this.deps.busyCount?.() ?? 0;
      if (busyCount > 0) await this.waitForTasks();
      this.setApplying('installing');
      this.deps.writePending?.({ from: this.deps.version, to: version });
      await this.deps.npm.install(this.spec(version));
      this.setApplying('restarting');
      // 应用成功后不再有「已下载待装」状态；重启倒计时结束状态由新进程自己报
      this.downloadedVersion = null;
      this.restartProcess();
    } catch (error) {
      this.applying = false;
      this.deps.clearPending?.();
      this.fail(error);
    }
  }

  /** 广播 applying 阶段；waiting-tasks 之外不带 busyCount/deadline */
  private setApplying(
    stage: 'waiting-tasks' | 'installing' | 'restarting',
    busyCount = 0,
    deadlineMs = 0
  ): void {
    this.setStatus(
      {
        status: 'applying',
        info: this.downloadedVersion ? { version: this.downloadedVersion } : undefined,
        applying: {
          stage,
          ...(stage === 'waiting-tasks' ? { busyCount, deadlineMs } : {}),
        },
      },
      true
    );
  }

  private async waitForTasks(): Promise<void> {
    const now = this.now();
    const limit = this.deps.waitForTasksMs ?? WAIT_FOR_TASKS_MS;
    const poll = this.deps.waitPollMs ?? WAIT_POLL_MS;
    const deadlineMs = now + limit;
    for (;;) {
      const busy = this.deps.busyCount?.() ?? 0;
      if (busy === 0) return;
      if (this.now() >= deadlineMs) return;
      this.setApplying('waiting-tasks', busy, deadlineMs);
      await new Promise((resolve) => setTimeout(resolve, poll));
    }
  }

  /** 退出并由守护/替代进程拉起：supervisor 直接退，reexec 先放小脚本再退 */
  private restartProcess(): void {
    if (this.restartMethod() === 'reexec') this.deps.spawnReexec?.();
    this.deps.quit();
  }

  /**
   * 手动重启。默认优雅：等正在跑的回合收完（同应用更新的等待上限），再退出拉起；
   * force=true 立即退出（收尾仍会安全中断写断点，任务重启后续跑）。
   */
  restart(force = false): void {
    if (!this.canRestart()) throw new Error('enso-server is not running under a supervisor');
    if (force) {
      this.restartProcess();
      return;
    }
    void this.gracefulRestart();
  }

  private async gracefulRestart(): Promise<void> {
    await this.exclusive(async () => {
      const busyCount = this.deps.busyCount?.() ?? 0;
      if (busyCount > 0) {
        this.applying = true;
        try {
          await this.waitForTasks();
        } finally {
          this.applying = false;
        }
      }
      this.restartProcess();
    });
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

  // 服务端没有自动重启档位：应用本身等待任务收完，设置保留通道只为不报错
  setAutoRestartMode(_mode: AutoRestartMode): void {}

  private notifyIdleStateChanged(): void {
    if (!this.downloadedVersion || !this.autoUpdate || this.applying || !this.canRestart()) {
      return;
    }
    // 服务端应用的等待逻辑（等任务收完/超时安全中断）都在 quitAndInstall 内，
    // 下载完成立即优雅应用，不再需要桌面那套空闲判定与「只提示不重启」档位。
    void this.quitAndInstall();
  }
}
