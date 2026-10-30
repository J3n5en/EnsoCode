import { ComputerError } from '@shared/computer/errors';

/** 原生焦点原语；全部同步，便于在轮询里即时还回前台。 */
export interface FocusDeps {
  /** 系统真前台进程；不可读时 undefined */
  frontPid(): number | undefined;
  /** 让目标进程相信自己处于激活态、该窗口为 key（不改变系统真前台） */
  activate(pid: number, windowId: number): void;
  deactivate(pid: number, windowId: number): void;
  /** 把系统真前台还给 pid；失败返回 false */
  setFront(pid: number): boolean;
  /** 距上次物理键鼠的秒数；null 表示不可检测 */
  hidIdleSeconds(): number | null;
  sleep(ms: number): Promise<void>;
}

export interface FocusSessionOptions {
  /** 激活包投递后给目标处理的时间 */
  settleMs?: number;
  /** 单个会话内容忍的焦点窃取次数 */
  maxSteals?: number;
  /** 物理输入距今小于该秒数视为用户正在操作 */
  userActiveSeconds?: number;
  /** 动作期间轮询真前台的间隔；0 关闭 */
  pollMs?: number;
}

const DEFAULTS = {
  settleMs: 40,
  maxSteals: 3,
  userActiveSeconds: 1,
  pollMs: 30,
} satisfies Required<FocusSessionOptions>;

function userActiveError(): ComputerError {
  return new ComputerError(
    'user-active',
    'The user is using the target app right now; background input was not sent. Wait until they switch away, or ask them.'
  );
}

/**
 * 每个目标进程一份合成焦点状态：
 * believed-active（目标相信自己激活、key 窗口）与 really-active（系统真前台）分开跟踪。
 * 动作期间若目标把自己抢成真前台，而用户没有动键鼠，就把前台还给用户原来的 app。
 */
export class FocusSession {
  private believed = false;
  private window: number | undefined;
  private userFront: number | undefined;
  private steals = 0;
  private closed = false;
  private readonly options: Required<FocusSessionOptions>;

  constructor(
    readonly pid: number,
    private readonly deps: FocusDeps,
    options: FocusSessionOptions = {}
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  state(): { believedActive: boolean; window: number | undefined; reallyActive: boolean } {
    return {
      believedActive: this.believed,
      window: this.window,
      reallyActive: this.deps.frontPid() === this.pid,
    };
  }

  private userActive(): boolean {
    const idle = this.deps.hidIdleSeconds();
    return typeof idle === 'number' && idle < this.options.userActiveSeconds;
  }

  async enforce(windowId: number): Promise<void> {
    if (this.closed) throw new Error('focus session closed');
    const front = this.deps.frontPid();
    if (front === this.pid) {
      // 目标就是真前台：无需合成激活；用户正在用它时不能往里打字
      if (this.userActive()) throw userActiveError();
      this.window = windowId;
      return;
    }
    if (front !== undefined) this.userFront = front;
    if (this.believed && this.window === windowId) return;
    if (this.believed && this.window !== undefined) {
      this.deps.deactivate(this.pid, this.window);
      this.believed = false;
    }
    this.deps.activate(this.pid, windowId);
    this.believed = true;
    this.window = windowId;
    await this.deps.sleep(this.options.settleMs);
  }

  /** 目标成了真前台时的处置；返回需要抛给调用方的错误 */
  private detectSteal(): ComputerError | undefined {
    if (this.deps.frontPid() !== this.pid) return undefined;
    const userFront = this.userFront;
    if (userFront === undefined || userFront === this.pid) return undefined;
    // 系统已把真激活给了目标，原来的合成激活态不再成立
    this.believed = false;
    if (this.userActive()) {
      this.userFront = undefined;
      return userActiveError();
    }
    this.steals += 1;
    this.deps.setFront(userFront);
    if (this.steals > this.options.maxSteals) {
      return new ComputerError(
        'focus-steal',
        'The target app keeps taking the foreground from the user; background input stopped. Use delivery:"foreground" or ask the user.'
      );
    }
    return undefined;
  }

  async guard<T>(windowId: number, fn: () => Promise<T>): Promise<T> {
    await this.enforce(windowId);
    let pending: ComputerError | undefined;
    const timer =
      this.options.pollMs > 0
        ? setInterval(() => {
            pending ??= this.detectSteal();
          }, this.options.pollMs)
        : undefined;
    let result: T;
    try {
      result = await fn();
    } catch (error) {
      if (timer) clearInterval(timer);
      // 动作本身失败时只做还回，不改写它的错误
      this.detectSteal();
      throw error;
    }
    if (timer) clearInterval(timer);
    const error = pending ?? this.detectSteal();
    if (error) throw error;
    return result;
  }

  teardown(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.believed && this.window !== undefined) {
      this.believed = false;
      this.deps.deactivate(this.pid, this.window);
    }
  }
}

/** 后端级登记：同 pid 复用会话，跨 run 保持（菜单、下拉不会因 run 边界失焦关闭），空闲后收尾 */
export class FocusRegistry {
  private readonly sessions = new Map<number, FocusSession>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly idleMs: number;

  constructor(
    private readonly deps: FocusDeps,
    private readonly options: FocusSessionOptions & { idleMs?: number } = {}
  ) {
    this.idleMs = options.idleMs ?? 8_000;
  }

  has(pid: number): boolean {
    return this.sessions.has(pid);
  }

  session(pid: number): FocusSession {
    let session = this.sessions.get(pid);
    if (!session) {
      session = new FocusSession(pid, this.deps, this.options);
      this.sessions.set(pid, session);
    }
    this.touch(pid);
    return session;
  }

  touch(pid: number): void {
    const previous = this.timers.get(pid);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => this.release(pid), this.idleMs);
    timer.unref?.();
    this.timers.set(pid, timer);
  }

  release(pid: number): void {
    const timer = this.timers.get(pid);
    if (timer) clearTimeout(timer);
    this.timers.delete(pid);
    const session = this.sessions.get(pid);
    this.sessions.delete(pid);
    try {
      session?.teardown();
    } catch {
      // 进程已退出：没有可恢复的激活态
    }
  }

  releaseAll(): void {
    for (const pid of [...this.sessions.keys()]) this.release(pid);
  }
}

/** 焦点会话给出的、需要原样告诉模型的错误（用户正在用目标 / 目标反复抢前台） */
export function isUserFacingFocusError(error: unknown): boolean {
  return (
    error instanceof ComputerError && (error.code === 'user-active' || error.code === 'focus-steal')
  );
}
