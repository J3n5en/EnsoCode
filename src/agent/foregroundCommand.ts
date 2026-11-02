import type { BashOperations } from '@earendil-works/pi-coding-agent';

/** 转后台的原因：用户点「转后台」、插话、到让位时刻 */
export type DetachReason = 'user' | 'yield' | 'steer';

/** 移交给后台任务的在跑进程：输出改接到新的接收者，退出码经 done 送达 */
export interface DetachableProcess {
  output(): string;
  pipe(onData: (chunk: Buffer) => void): void;
  done: Promise<number | null>;
  kill(): void;
}

export interface ForegroundOwner {
  /** 接管进程并返回后台任务 id；拒绝（如配额满）时抛错，命令留在前台 */
  adopt(proc: DetachableProcess, reason: DetachReason): string;
  attachFinalize(taskId: string, details: unknown, finalize?: () => Promise<unknown>): void;
}

/** 前台命令已移交后台：沿工具包装链上抛，由 withBackground 转成正常工具结果 */
export class ForegroundDetachedError extends Error {
  details: unknown;

  constructor(
    readonly taskId: string,
    readonly reason: DetachReason,
    readonly output: string,
    private readonly owner: ForegroundOwner
  ) {
    super(`Command moved to background task ${taskId}`);
    this.name = 'ForegroundDetachedError';
  }

  /** 命令包装层（rtk）把收尾推迟到后台任务结束 */
  defer(details: unknown, finalize?: () => Promise<unknown>): void {
    this.details = details;
    this.owner.attachFinalize(this.taskId, details, finalize);
  }
}

/** 到让位时刻却移交不了后台（如配额满）：命令已停止，带已有输出与原因上抛 */
export class ForegroundYieldError extends Error {
  constructor(
    readonly output: string,
    readonly reason: string,
    readonly yieldMs: number
  ) {
    super(reason);
    this.name = 'ForegroundYieldError';
  }
}

/** 与后台任务缓冲同量级：移交时作为任务初始输出 */
const SEED_OUTPUT_LIMIT = 200_000;
/** setTimeout 上限；超出交还底层 exec 按 pi 规则报错 */
const MAX_TIMER_MS = 2_147_483_647;

interface Running {
  proc: DetachableProcess;
  release(error: Error): void;
}

/**
 * 一次前台命令调用：进程在跑时可随时移交后台，不杀不重启。
 *
 * 两个独立计时：让位（yieldMs，按命令分类）到点转后台、工具立即回执；
 * 截止（模型显式 timeout）到点杀进程。让位先到则截止交给后台任务继续计时。
 */
export class ForegroundCommand {
  private running: Running | undefined;
  private adoptError: unknown;
  /** 本次调用被截止时间（模型显式 timeout）杀掉 */
  deadlineHit = false;

  constructor(
    private readonly owner: ForegroundOwner,
    readonly yieldMs?: number
  ) {}

  detach(reason: DetachReason): string | null {
    const entry = this.running;
    if (!entry) return null;
    let taskId: string;
    try {
      taskId = this.owner.adopt(entry.proc, reason);
    } catch (error) {
      this.adoptError = error;
      return null;
    }
    entry.release(new ForegroundDetachedError(taskId, reason, entry.proc.output(), this.owner));
    return taskId;
  }

  run(
    inner: BashOperations,
    command: string,
    cwd: string,
    options: Parameters<BashOperations['exec']>[2],
    timeoutMs: number | undefined,
    yieldMs: number | undefined
  ): Promise<{ exitCode: number | null }> {
    const { onData, signal, env, timeout } = options;
    // 截止由这里计时：转后台后底层不能再按前台截止杀进程（后台任务另行计时）
    const controller = new AbortController();
    let sink = onData;
    let capture = true;
    let output = '';
    const done = inner
      .exec(command, cwd, {
        onData: (chunk) => {
          if (capture) output = (output + chunk.toString()).slice(-SEED_OUTPUT_LIMIT);
          sink(chunk);
        },
        signal: controller.signal,
        env,
      })
      .then((result) => result.exitCode);
    const proc: DetachableProcess = {
      output: () => output,
      pipe: (next) => {
        capture = false;
        sink = next;
      },
      done,
      kill: () => controller.abort(),
    };
    return new Promise((resolve, reject) => {
      let timedOut = false;
      let yieldFailed = false;
      const onAbort = () => controller.abort();
      const deadlineTimer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              this.deadlineHit = true;
              controller.abort();
            }, timeoutMs);
      const yieldTimer =
        yieldMs === undefined || (timeoutMs !== undefined && timeoutMs <= yieldMs)
          ? undefined
          : setTimeout(() => {
              if (this.detach('yield')) return;
              // 移交不了就停掉：到点必回，不能让调用无限挂着
              yieldFailed = true;
              controller.abort();
            }, yieldMs);
      const failure = (error: unknown): unknown =>
        timedOut
          ? new Error(`timeout:${timeout}`)
          : yieldFailed
            ? new ForegroundYieldError(
                output,
                this.adoptError instanceof Error
                  ? this.adoptError.message
                  : String(this.adoptError ?? 'could not move the command to the background'),
                yieldMs ?? 0
              )
            : error;
      const entry: Running = {
        proc,
        release: (error) => {
          settle();
          reject(error);
        },
      };
      const settle = () => {
        this.running = undefined;
        clearTimeout(deadlineTimer);
        clearTimeout(yieldTimer);
        signal?.removeEventListener('abort', onAbort);
      };
      this.running = entry;
      done.then(
        (exitCode) => {
          if (this.running !== entry) return;
          settle();
          if (timedOut || yieldFailed) reject(failure(null));
          else resolve({ exitCode });
        },
        (error: unknown) => {
          if (this.running !== entry) return;
          settle();
          reject(failure(error));
        }
      );
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) controller.abort();
    });
  }
}

const bound = new WeakMap<AbortSignal, ForegroundCommand>();

/** pi 把工具 execute 的 signal 原样交给 operations.exec，以此把调用关联到 exec */
export function bindForegroundCommand(signal: AbortSignal, command: ForegroundCommand): void {
  bound.set(signal, command);
}

/** 包装任意 bash/powershell operations（本地或远程），使登记过的前台调用可移交后台 */
export function withDetachableExec(inner: BashOperations): BashOperations {
  return {
    exec(command, cwd, options) {
      const foreground = options.signal ? bound.get(options.signal) : undefined;
      const timeoutMs = options.timeout === undefined ? undefined : options.timeout * 1000;
      const validTimeout = timeoutMs === undefined || (timeoutMs > 0 && timeoutMs <= MAX_TIMER_MS);
      if (!foreground || !validTimeout) return inner.exec(command, cwd, options);
      return foreground.run(inner, command, cwd, options, timeoutMs, foreground.yieldMs);
    },
  };
}
