import { spawn as nodeSpawn } from 'node:child_process';

export const MACOS_SYSTEM_SLEEP_ASSERTION_RETRY_MS = 30_000;

type Logger = Pick<Console, 'warn'>;

type CaffeinateErrorListener = (error: Error) => void;
type CaffeinateExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;

type CaffeinateProcess = {
  kill: () => boolean;
  on(event: 'error', listener: CaffeinateErrorListener): void;
  on(event: 'exit', listener: CaffeinateExitListener): void;
  off(event: 'error', listener: CaffeinateErrorListener): void;
  off(event: 'exit', listener: CaffeinateExitListener): void;
};

type CaffeinateSpawn = (
  command: string,
  args: string[],
  options: { stdio: 'ignore'; windowsHide: true }
) => CaffeinateProcess;

export type MacosSystemSleepAssertionOptions = {
  logger?: Logger;
  platform?: NodeJS.Platform;
  spawn?: CaffeinateSpawn;
};

/**
 * 请求 macOS 不要因 idle / 系统策略进入睡眠（插电时含 PreventSystemSleep）。
 * 合盖仍可能被系统强制睡。preventDisplaySleep 时加 -d，托盘隐藏 Dock 后也挡住息屏。
 */
export class MacosSystemSleepAssertion {
  private readonly logger: Logger;
  private readonly platform: NodeJS.Platform;
  private readonly spawn: CaffeinateSpawn;
  private desired = false;
  private preventDisplaySleep = false;
  private child: CaffeinateProcess | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalStop = false;

  constructor(options: MacosSystemSleepAssertionOptions = {}) {
    this.logger = options.logger ?? console;
    this.platform = options.platform ?? process.platform;
    this.spawn = options.spawn ?? nodeSpawn;
  }

  start(_reason: string, options?: { preventDisplaySleep?: boolean }): void {
    const preventDisplaySleep = options?.preventDisplaySleep === true;
    const modeChanged = this.desired && this.preventDisplaySleep !== preventDisplaySleep;
    this.preventDisplaySleep = preventDisplaySleep;
    this.desired = true;
    if (modeChanged) this.killChild();
    this.spawnIfNeeded();
  }

  stop(_reason: string): void {
    this.desired = false;
    this.clearRetry();
    this.killChild();
  }

  dispose(): void {
    this.stop('dispose');
  }

  private spawnIfNeeded(): void {
    if (this.platform !== 'darwin' || !this.desired || this.child) {
      return;
    }

    let child: CaffeinateProcess;
    try {
      child = this.spawn('/usr/bin/caffeinate', this.caffeinateArgs(), {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (error) {
      this.logger.warn('[pair-awake] failed to start macOS system sleep assertion', { error });
      this.scheduleRetry();
      return;
    }

    this.child = child;
    this.intentionalStop = false;
    const onError: CaffeinateErrorListener = (error) => {
      this.handleChildGone(child, error);
    };
    const onExit: CaffeinateExitListener = (code, signal) => {
      this.handleChildGone(child, { code, signal });
    };
    child.on('error', onError);
    child.on('exit', onExit);
  }

  private handleChildGone(child: CaffeinateProcess, details: unknown): void {
    if (this.child !== child) {
      return;
    }
    this.child = null;
    if (this.intentionalStop) {
      this.intentionalStop = false;
      return;
    }
    this.logger.warn('[pair-awake] macOS system sleep assertion ended', { details });
    this.scheduleRetry();
  }

  private killChild(): void {
    if (!this.child) {
      return;
    }
    const child = this.child;
    this.intentionalStop = true;
    this.child = null;
    try {
      child.kill();
    } catch (error) {
      if (!isEsrchError(error)) {
        this.logger.warn('[pair-awake] failed to stop macOS system sleep assertion', { error });
      }
    }
  }

  // -w：app 以任何方式退出时 caffeinate 跟着退，否则孤儿 caffeinate 继承的异常端口会让 crashpad_handler 常驻。
  private caffeinateArgs(): string[] {
    return ['-w', String(process.pid), ...(this.preventDisplaySleep ? ['-d'] : []), '-i', '-s'];
  }

  private scheduleRetry(): void {
    if (!this.desired || this.retryTimer || this.platform !== 'darwin') {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.spawnIfNeeded();
    }, MACOS_SYSTEM_SLEEP_ASSERTION_RETRY_MS);
    if (typeof this.retryTimer.unref === 'function') {
      this.retryTimer.unref();
    }
  }

  private clearRetry(): void {
    if (!this.retryTimer) {
      return;
    }
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}

function isEsrchError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ESRCH'
  );
}
