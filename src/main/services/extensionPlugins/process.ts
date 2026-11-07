import type {
  MainToPluginHost,
  PluginAgentSource,
  PluginCallMethod,
  PluginHostApi,
  PluginRegistrations,
} from '@shared/extensionPlugins/protocol';
import { PLUGIN_HOST_APIS } from '@shared/extensionPlugins/protocol';
import type { WorkerForkOptions, WorkerProcess } from '../../platform/types';

export type PluginError = Error & { code: string };
export const pluginError = (code: string, message: string): PluginError =>
  Object.assign(new Error(message), { code });

export interface PluginProcessDeps {
  fork(modulePath: string, args: string[], options: WorkerForkOptions): WorkerProcess;
  hostPath: string;
  env: NodeJS.ProcessEnv;
  init: { pluginId: string; pluginRoot: string; main: string; dataDir: string };
  handleHostCall(
    api: PluginHostApi,
    args: unknown,
    invocationId: string | undefined
  ): Promise<unknown>;
  onExit(info: { unexpected: boolean }): void;
  onLog?(level: PluginLogLevel, message: string): void;
  idleMs?: number;
  readyTimeoutMs?: number;
  /** 常驻进程不因空闲退出 */
  resident?: boolean;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  invocationId: string;
}

const DEFAULT_IDLE_MS = 5 * 60_000;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const SHUTDOWN_GRACE_MS = 3_000;
const STOP_FORCE_MS = 5_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export type PluginLogLevel = 'info' | 'warn' | 'error';
const LOG_LEVELS: readonly unknown[] = ['info', 'warn', 'error'];

/** 一个插件一个进程：按需拉起、闲置退出；超时先 cancel 再失败，晚到结果丢弃 */
export class PluginProcess {
  private child: WorkerProcess | null = null;
  private readyPromise: Promise<PluginRegistrations> | null = null;
  private stopping = false;
  /** 服务主动 stop 后置上；空闲退出和加载失败都不置，调用可以重新拉起 */
  private closed = false;
  private readonly pending = new Map<string, Pending>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stopWait: Promise<void> = Promise.resolve();
  private finishStop: (() => void) | null = null;
  private nextId = 1;

  constructor(private readonly deps: PluginProcessDeps) {}

  get running(): boolean {
    return this.child !== null;
  }

  get inflight(): number {
    return this.pending.size;
  }

  ready(): Promise<PluginRegistrations> {
    if (this.closed) return Promise.reject(pluginError('PLUGIN_EXITED', '插件进程已退出'));
    this.readyPromise ??= this.spawn();
    return this.readyPromise;
  }

  async call(
    method: PluginCallMethod,
    payload: unknown,
    options: {
      invocationId: string;
      sessionId: string | null;
      projectRoot: string | null;
      agent?: PluginAgentSource;
      timeoutMs: number;
    }
  ): Promise<unknown> {
    await this.ensureCallable();
    if (!this.child || this.stopping) throw pluginError('PLUGIN_EXITED', '插件进程已退出');
    this.clearIdle();
    const id = `m${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.post({ t: 'cancel', invocationId: options.invocationId });
        reject(pluginError('TIMEOUT', `插件调用超时（${options.timeoutMs}ms）`));
        this.armIdle();
      }, options.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, invocationId: options.invocationId });
      this.post({
        t: 'call',
        id,
        method,
        payload,
        invocationId: options.invocationId,
        sessionId: options.sessionId,
        projectRoot: options.projectRoot,
        ...(options.agent ? { agent: options.agent } : {}),
      });
    });
  }

  /** 主动 stop 后直接失败。只有空闲退出才等旧进程结束再拉起 */
  private async ensureCallable(): Promise<void> {
    if (this.closed) throw pluginError('PLUGIN_EXITED', '插件进程已退出');
    for (;;) {
      if (this.stopping) await this.stopWait;
      if (this.closed) throw pluginError('PLUGIN_EXITED', '插件进程已退出');
      await this.ready();
      if (this.closed) throw pluginError('PLUGIN_EXITED', '插件进程已退出');
      if (!this.stopping && this.child) return;
    }
  }

  /** 主动取消一次调用：通知插件并立即以 ABORTED 失败 */
  cancel(invocationId: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.invocationId !== invocationId) continue;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(pluginError('ABORTED', '调用已取消'));
    }
    this.post({ t: 'cancel', invocationId });
    this.armIdle();
  }

  /** 服务主动停进程：退出后不再拉起 */
  stop(): void {
    this.closed = true;
    this.beginStop();
  }

  /** 先发 shutdown，最多等 3 秒再 kill；再过 5 秒仍无 exit 则 SIGKILL 并结束等待 */
  private beginStop(): void {
    this.clearIdle();
    const child = this.child;
    if (!child || this.stopping) return;
    this.stopping = true;
    this.stopWait = new Promise((resolve) => {
      this.finishStop = resolve;
    });
    this.post({ t: 'shutdown' });
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout>;
    let forceTimer: ReturnType<typeof setTimeout>;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(forceTimer);
      if (this.child === child) {
        this.child = null;
        this.readyPromise = null;
        this.clearIdle();
        for (const [id, entry] of this.pending) {
          this.pending.delete(id);
          clearTimeout(entry.timer);
          entry.reject(pluginError('PLUGIN_EXITED', '插件进程已退出'));
        }
        this.deps.onExit({ unexpected: false });
      }
      this.finishStop?.();
      this.finishStop = null;
    };
    killTimer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 进程已经退出
      }
    }, SHUTDOWN_GRACE_MS);
    forceTimer = setTimeout(() => {
      if (typeof child.pid === 'number') {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          // 进程已经退出
        }
      }
      if (!settled) child.emit('exit');
      finish();
    }, SHUTDOWN_GRACE_MS + STOP_FORCE_MS);
    child.once('exit', finish);
  }

  /** 停进程并等到它退出；没有进程时立即完成 */
  whenStopped(): Promise<void> {
    if (!this.child) return Promise.resolve();
    if (!this.stopping) this.stop();
    return this.stopWait;
  }

  private post(message: MainToPluginHost): void {
    try {
      this.child?.postMessage(message);
    } catch {
      // 进程正在退出；exit 处理会统一回落挂起调用
    }
  }

  private spawn(): Promise<PluginRegistrations> {
    this.stopping = false;
    const child = this.deps.fork(this.deps.hostPath, [], {
      serviceName: `enso-plugin-${this.deps.init.pluginId}`,
      env: this.deps.env,
    });
    this.child = child;
    return new Promise<PluginRegistrations>((resolve, reject) => {
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        reject(pluginError('PLUGIN_INIT_FAILED', message));
        this.beginStop();
      };
      const readyTimer = setTimeout(
        () => fail('插件加载超时'),
        this.deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
      );
      child.once('spawn', () => this.post({ t: 'init', ...this.deps.init }));
      child.on('message', (raw: unknown) => {
        if (!isRecord(raw)) return;
        if (raw.t === 'ready' && !settled) {
          settled = true;
          clearTimeout(readyTimer);
          resolve(raw.registered as PluginRegistrations);
          this.armIdle();
          return;
        }
        if (raw.t === 'init-error') {
          fail(typeof raw.message === 'string' ? raw.message : '插件加载失败');
          return;
        }
        this.onMessage(raw);
      });
      child.on('exit', () => {
        if (this.child !== child) return;
        const unexpected = !this.stopping;
        this.child = null;
        this.readyPromise = null;
        this.clearIdle();
        for (const [id, entry] of this.pending) {
          this.pending.delete(id);
          clearTimeout(entry.timer);
          entry.reject(pluginError('PLUGIN_EXITED', '插件进程已退出'));
        }
        fail('插件进程在加载期间退出');
        this.deps.onExit({ unexpected });
      });
    });
  }

  private onMessage(message: Record<string, unknown>): void {
    if (message.t === 'log') {
      if (typeof message.message !== 'string') return;
      const level = LOG_LEVELS.includes(message.level) ? (message.level as PluginLogLevel) : 'info';
      this.deps.onLog?.(level, message.message);
      return;
    }
    if (message.t === 'res' && typeof message.id === 'string') {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok === true) entry.resolve(message.value);
      else {
        const error = isRecord(message.error) ? message.error : {};
        entry.reject(
          pluginError(
            typeof error.code === 'string' ? error.code : 'PLUGIN_ERROR',
            typeof error.message === 'string' ? error.message : '插件调用失败'
          )
        );
      }
      this.armIdle();
      return;
    }
    if (message.t === 'call' && typeof message.id === 'string') {
      const id = message.id;
      const api = message.api;
      const invocationId =
        typeof message.invocationId === 'string' ? message.invocationId : undefined;
      if (!(PLUGIN_HOST_APIS as readonly unknown[]).includes(api)) {
        this.post({
          t: 'res',
          id,
          ok: false,
          error: { code: 'UNKNOWN_API', message: `未知宿主接口 ${String(api)}` },
        });
        return;
      }
      this.deps.handleHostCall(api as PluginHostApi, message.args, invocationId).then(
        (value) => this.post({ t: 'res', id, ok: true, value }),
        (error: unknown) =>
          this.post({
            t: 'res',
            id,
            ok: false,
            error: {
              code:
                typeof (error as PluginError)?.code === 'string'
                  ? (error as PluginError).code
                  : 'HOST_ERROR',
              message: error instanceof Error ? error.message : String(error),
            },
          })
      );
    }
  }

  private armIdle(): void {
    this.clearIdle();
    if (this.deps.resident || this.pending.size > 0 || !this.child) return;
    this.idleTimer = setTimeout(() => this.beginStop(), this.deps.idleMs ?? DEFAULT_IDLE_MS);
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
