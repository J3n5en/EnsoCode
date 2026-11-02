import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { getPowerShellConfig, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { SHELL_LIMITS, type ShellLimits } from '@shared/shellLimits';
import type { BackgroundTaskInfo } from '@shared/types/agent';
import {
  bindForegroundCommand,
  type DetachableProcess,
  type DetachReason,
  ForegroundCommand,
  ForegroundDetachedError,
  ForegroundYieldError,
} from './foregroundCommand';
import { killProcessTree } from './killTree';
import { hardenedEnv } from './shell/hardenedEnv';
import { type CommandClass, classifyCommand } from './shell/policy';
import {
  completionReceiptText,
  deadlineKillText,
  failureLine,
  yieldFailedText,
  yieldReceiptText,
} from './shell/receipts';
import { classifyFailure, type FailureVerdict } from './shell/taxonomy';

/** 内存缓冲上限（超出截头保尾；磁盘 log 全量写到 limits.logMaxBytes 为止） */
const MAX_BUFFER = 200_000;
/** 下发渲染层的尾部快照上限 */
const TAIL_LIMIT = 8_000;
/** 完成通知内联的输出尾部上限：多数命令一次送达，模型无需再调 task_output */
const COMPLETION_OUTPUT_LIMIT = 4_000;
/** 内存缓冲截头后仍保留的输出开头（完成通知头 20% 用） */
const HEAD_KEEP = Math.floor(COMPLETION_OUTPUT_LIMIT * 0.2);
/** 失败分类只看输出尾部 */
const FAILURE_TAIL = 4_000;
/** 输出事件节流 */
const EMIT_INTERVAL_MS = 500;

interface Task {
  info: BackgroundTaskInfo;
  sessionId: string;
  kill(signal: NodeJS.Signals): void;
  output: string;
  /** 内存缓冲截头丢掉的字符数（磁盘 log 仍全量） */
  droppedChars: number;
  /** 输出开头（内存缓冲截头后仍保留） */
  head: string;
  dirty: boolean;
  logPath: string;
  logStream: WriteStream | null;
  /** 已写入磁盘日志的字节数 */
  logBytes: number;
  /** 日志超限后未写入的字节数 */
  droppedBytes: number;
  /** 模型已经由工具返回值知情（阻塞等到结束 / kill 已回执），不再通知 */
  consumed: boolean;
  killedByUser: boolean;
  /** 模型 task_stop 停的：结果不算失败 */
  stoppedByModel: boolean;
  /** 前台命令移交后台的时刻；直接后台启动的任务没有 */
  yieldedAt?: number;
  signal?: NodeJS.Signals | null;
  /** 结束时的结构化失败分类（含是否可重试） */
  failure?: FailureVerdict;
  /** 移交后台时模型显式 timeout 折算的剩余截止（秒）；用于到点杀进程并说明是超时 */
  deadlineSec?: number;
  /** 到点被截止时间杀掉：既不是模型主动停，也不是命令本身失败 */
  killedByDeadline?: boolean;
  deadlineTimer?: NodeJS.Timeout;
  waiters: Array<() => void>;
  details?: unknown;
  finalize?: () => Promise<unknown>;
  settling: boolean;
}

export interface PreparedBackgroundCommand {
  command: string;
  details?: unknown;
  finalize?: () => Promise<unknown>;
}

export interface BackgroundCommandHooks {
  prepare(
    toolCallId: string,
    command: string,
    signal?: AbortSignal
  ): Promise<PreparedBackgroundCommand>;
}

export const BACKGROUND_COMMAND_HOOKS = Symbol('enso.background-command-hooks');

type BackgroundAwareToolDefinition = ToolDefinition & {
  [BACKGROUND_COMMAND_HOOKS]?: BackgroundCommandHooks;
};

export function attachBackgroundCommandHooks(
  definition: ToolDefinition,
  hooks: BackgroundCommandHooks
): ToolDefinition {
  return Object.assign(definition, { [BACKGROUND_COMMAND_HOOKS]: hooks });
}

function abortedError(): Error {
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}

export interface TaskEvents {
  onStarted(sessionId: string, task: BackgroundTaskInfo): void;
  onOutput(
    sessionId: string,
    taskId: string,
    tail: string,
    status: BackgroundTaskInfo['status']
  ): void;
  onEnded(
    sessionId: string,
    taskId: string,
    status: BackgroundTaskInfo['status'],
    exitCode?: number
  ): void;
  /** 存活任务集合或状态变化时的全量快照（REPLACE 语义）：漏了 edge 事件或静默清理也能收敛 */
  onLevel?(sessionId: string, tasks: BackgroundTaskInfo[]): void;
  /** 未被模型知情的任务结束时触发：supervisor 决定注入唤醒或挂 pending 搭车 */
  onCompletionNotify(sessionId: string, text: string): void;
}

/** 毫秒转秒（保留一位小数），用于工具描述与回执里的时长 */
const yieldSec = (ms: number): number => Math.round(ms / 100) / 10;

/** 可被插话 / 用户「转后台」解除的在跑工具调用：前台命令移交后台，阻塞等待提前返回 */
interface DetachableCall {
  detach(reason: DetachReason): string | null;
}

export interface BlockingWait {
  signal: AbortSignal;
  /** 被解除的原因；未解除为 undefined */
  reason(): DetachReason | undefined;
  untrack(): void;
}

/** 阻塞等待被解除后给模型的说明：被等的对象继续跑，结束会自动通知 */
export function detachedWaitNote(reason: DetachReason, subject: string): string {
  return reason === 'steer'
    ? `Stopped waiting because the user sent a new message. The ${subject} keeps running and you will be notified automatically when it finishes — read and answer the user's message first.`
    : `The user chose to stop waiting. The ${subject} keeps running and you will be notified automatically when it finishes; do not wait for it again unless the user asks.`;
}

/**
 * 后台任务管理（grok-build 对齐）：detached 进程组、内存环形+磁盘全量双写、
 * 结束自动通知（幂等抑制）、阻塞等待、配额与护栏。
 */
export class BackgroundTaskManager {
  private tasks = new Map<string, Task>();
  /** sessionId → toolCallId → 在跑的前台命令（可移交后台）或阻塞等待（可提前结束） */
  private foreground = new Map<string, Map<string, DetachableCall>>();
  private counter = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly events: TaskEvents,
    private readonly logDir: string,
    private currentLimits: ShellLimits = SHELL_LIMITS
  ) {}

  /** 当前生效的命令时限；全局 settings.shell 变更时由 setLimits 整体替换，执行路径每次现读 */
  get limits(): ShellLimits {
    return this.currentLimits;
  }

  setLimits(limits: ShellLimits): void {
    this.currentLimits = limits;
  }

  start(
    sessionId: string,
    command: string,
    cwd: string,
    spawnOpts?: {
      file?: string;
      argsPrefix?: string[];
      displayCommand?: string;
      details?: unknown;
      finalize?: () => Promise<unknown>;
      /** 子进程环境；缺省继承 process.env（远程 ssh 包装命令需要原样的本地环境） */
      env?: NodeJS.ProcessEnv;
    }
  ): string {
    const taskId = this.reserveId();
    // detached：POSIX 下是独立进程组；kill 时整棵树一起清（Windows 走 taskkill /T）
    const child = spawnBackground(command, cwd, spawnOpts);
    const task = this.register(sessionId, taskId, spawnOpts?.displayCommand ?? command, {
      details: spawnOpts?.details,
      finalize: spawnOpts?.finalize,
      kill: (signal) => killProcessTree(child, signal),
    });
    child.stdout?.on('data', (chunk: Buffer) => this.append(task, chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.append(task, chunk));
    child.on('error', (error) => {
      task.output += `\n[spawn error] ${error.message}`;
    });
    // close 在 stdio 全部排空后触发；统计必须看到完整执行并晚于输出收集。
    child.on('close', (code, signal) => this.exited(task, code, signal));
    this.announce(task);
    return taskId;
  }

  /** 接管前台命令的在跑进程：不重启，已有输出作为任务初始输出 */
  adopt(
    sessionId: string,
    proc: DetachableProcess,
    opts: { command: string; startedAt: number; deadlineSec?: number }
  ): string {
    const taskId = this.reserveId();
    const task = this.register(sessionId, taskId, opts.command, {
      startedAt: opts.startedAt,
      kill: () => proc.kill(),
    });
    task.yieldedAt = Date.now();
    this.append(task, Buffer.from(proc.output()));
    proc.pipe((chunk) => this.append(task, chunk));
    proc.done.then(
      (code) => this.exited(task, code, null),
      (error: unknown) => {
        task.output += `\n[${error instanceof Error ? error.message : String(error)}]`;
        this.exited(task, null, null);
      }
    );
    this.announce(task);
    if (opts.deadlineSec !== undefined) this.armDeadline(task, opts.deadlineSec);
    return taskId;
  }

  /**
   * 模型显式 timeout 折算的后台截止：到点 SIGTERM（宽限后 SIGKILL）。
   * 与 `stop()` 的区别是不抑制通知——命令是被截止时间杀掉的，模型需要知道这不是命令自身的失败。
   */
  private armDeadline(task: Task, remainingSec: number): void {
    task.deadlineSec = remainingSec;
    task.deadlineTimer = setTimeout(
      () => {
        task.deadlineTimer = undefined;
        if (task.info.status !== 'running') return;
        task.killedByDeadline = true;
        task.kill('SIGTERM');
        setTimeout(() => {
          if (task.info.status === 'running') task.kill('SIGKILL');
        }, this.limits.killGraceMs).unref?.();
      },
      Math.max(0, remainingSec * 1000)
    );
    task.deadlineTimer.unref?.();
  }

  /** 前台收尾（如 rtk 统计）推迟到后台任务结束；任务已结束则立即执行 */
  attachFinalize(taskId: string, details: unknown, finalize?: () => Promise<unknown>): void {
    const task = this.tasks.get(taskId);
    if (task && task.info.status === 'running' && !task.settling) {
      task.details = details;
      task.finalize = finalize;
      return;
    }
    void finalize?.().catch(() => {});
  }

  trackForeground(sessionId: string, toolCallId: string, command: DetachableCall): () => void {
    const byCall = this.foreground.get(sessionId) ?? new Map<string, DetachableCall>();
    this.foreground.set(sessionId, byCall);
    byCall.set(toolCallId, command);
    return () => {
      if (byCall.get(toolCallId) === command) byCall.delete(toolCallId);
      if (byCall.size === 0 && this.foreground.get(sessionId) === byCall) {
        this.foreground.delete(sessionId);
      }
    };
  }

  /** 登记一次阻塞等待：插话或用户「不等了」时 abort 其 signal，被等的任务 / 子代理不受影响 */
  trackBlockingWait(sessionId: string, toolCallId: string): BlockingWait {
    const controller = new AbortController();
    let detachedBy: DetachReason | undefined;
    const untrack = this.trackForeground(sessionId, toolCallId, {
      detach: (reason) => {
        if (!controller.signal.aborted) {
          detachedBy = reason;
          controller.abort();
        }
        return null;
      },
    });
    return { signal: controller.signal, reason: () => detachedBy, untrack };
  }

  /** 把指定前台命令移交后台；命令不在跑或配额满时返回 null */
  backgroundForeground(sessionId: string, toolCallId: string, reason: DetachReason): string | null {
    return this.foreground.get(sessionId)?.get(toolCallId)?.detach(reason) ?? null;
  }

  backgroundAllForeground(sessionId: string, reason: DetachReason): string[] {
    const commands = [...(this.foreground.get(sessionId)?.values() ?? [])];
    return commands.flatMap((command) => command.detach(reason) ?? []);
  }

  private reserveId(): string {
    // 配额：先清理已完成，再满则拒绝并教模型下一步
    const max = this.limits.maxTasks;
    if (this.tasks.size >= max) this.pruneFinished();
    if (this.tasks.size >= max) {
      throw new Error(
        `Too many background tasks (limit ${max}). Stop one with task_stop first. ` +
          `Known task ids: [${[...this.tasks.keys()].join(', ')}]`
      );
    }
    return `task-${++this.counter}-${Date.now().toString(36)}`;
  }

  private register(
    sessionId: string,
    taskId: string,
    command: string,
    opts: {
      kill: Task['kill'];
      details?: unknown;
      finalize?: () => Promise<unknown>;
      startedAt?: number;
    }
  ): Task {
    const logPath = path.join(this.logDir, `${taskId}.log`);
    let logStream: WriteStream | null = null;
    try {
      mkdirSync(this.logDir, { recursive: true });
      logStream = createWriteStream(logPath);
    } catch {
      // 磁盘日志失败不阻塞任务，仅失去全量回看
    }
    const task: Task = {
      sessionId,
      kill: opts.kill,
      output: '',
      droppedChars: 0,
      head: '',
      dirty: false,
      logPath,
      logStream,
      logBytes: 0,
      droppedBytes: 0,
      consumed: false,
      killedByUser: false,
      stoppedByModel: false,
      waiters: [],
      details: opts.details,
      finalize: opts.finalize,
      settling: false,
      info: {
        taskId,
        command,
        status: 'running',
        tail: '',
        startedAt: opts.startedAt ?? Date.now(),
      },
    };
    this.tasks.set(taskId, task);
    return task;
  }

  private append(task: Task, chunk: Buffer): void {
    if (chunk.length === 0) return;
    const text = chunk.toString();
    if (task.head.length < HEAD_KEEP) task.head = (task.head + text).slice(0, HEAD_KEEP);
    const next = task.output + text;
    task.droppedChars += Math.max(0, next.length - MAX_BUFFER);
    task.output = next.slice(-MAX_BUFFER);
    task.dirty = true;
    this.writeLog(task, chunk);
  }

  /** 日志超过上限停写并标记截断；进程照常跑，内存缓冲照常滚动 */
  private writeLog(task: Task, chunk: Buffer): void {
    if (!task.logStream) return;
    const room = this.limits.logMaxBytes - task.logBytes;
    if (room >= chunk.length) {
      task.logStream.write(chunk);
      task.logBytes += chunk.length;
      return;
    }
    const fits = Math.max(0, room);
    if (task.droppedBytes === 0) {
      if (fits > 0) task.logStream.write(chunk.subarray(0, fits));
      task.logBytes += fits;
      task.logStream.write(
        `\n[log truncated: reached ${this.limits.logMaxBytes} bytes; further output is not recorded]\n`
      );
    }
    task.droppedBytes += chunk.length - (task.droppedBytes === 0 ? fits : 0);
  }

  private exited(task: Task, code: number | null, signal: NodeJS.Signals | null): void {
    if (task.info.status !== 'running' || task.settling) return;
    task.signal = signal;
    if (signal) task.output += `\n[terminated by ${signal}]`;
    void this.settle(task, code === 0 ? 'done' : 'failed', code ?? undefined);
  }

  private announce(task: Task): void {
    this.events.onStarted(task.sessionId, { ...task.info });
    this.emitLevel(task.sessionId);
    this.ensureTimer();
  }

  private pruneFinished(): void {
    const touched = new Set<string>();
    for (const [taskId, task] of this.tasks) {
      if (task.info.status !== 'running') {
        task.logStream?.end();
        this.tasks.delete(taskId);
        touched.add(task.sessionId);
      }
    }
    for (const sessionId of touched) this.emitLevel(sessionId);
  }

  private emitLevel(sessionId: string): void {
    this.events.onLevel?.(sessionId, this.snapshot(sessionId));
  }

  private finish(task: Task, status: 'done' | 'failed', exitCode?: number): void {
    task.info.status = status;
    task.info.exitCode = exitCode;
    task.info.tail = task.output.slice(-TAIL_LIMIT);
    if (task.deadlineTimer) {
      clearTimeout(task.deadlineTimer);
      task.deadlineTimer = undefined;
    }
    task.logStream?.end();
    task.failure = task.stoppedByModel
      ? { kind: 'none', retryable: true, hint: '' }
      : classifyFailure({
          exitCode: exitCode ?? null,
          signal: task.signal,
          tail: task.output.slice(-FAILURE_TAIL),
          killedByDeadline: task.killedByDeadline,
          deadlineSec: task.deadlineSec,
          stoppedByUser: task.killedByUser,
          droppedBytes: task.droppedBytes,
        });
    // 有阻塞等待者 = 结束态将经工具返回值送达模型（blockWaited 语义），无需再通知
    const hadWaiters = task.waiters.length > 0;
    if (hadWaiters) task.consumed = true;
    for (const wake of task.waiters.splice(0)) wake();
    this.events.onOutput(task.sessionId, task.info.taskId, task.info.tail, status);
    this.events.onEnded(task.sessionId, task.info.taskId, status, exitCode);
    this.emitLevel(task.sessionId);
    // 幂等抑制：模型已知情（阻塞等到 / 自己停的且收到回执）就不再打扰
    if (!task.consumed) {
      this.events.onCompletionNotify(task.sessionId, this.completionText(task));
    }
  }

  private async settle(task: Task, status: 'done' | 'failed', exitCode?: number): Promise<void> {
    task.settling = true;
    try {
      if (task.finalize) task.details = (await task.finalize()) ?? task.details;
    } catch {
      // 统计失败不能改变原命令的状态或输出。
    }
    this.finish(task, status, exitCode);
  }

  private completionText(task: Task): string {
    const { taskId, command, exitCode, status, startedAt } = task.info;
    return completionReceiptText({
      taskId,
      command,
      status,
      exitCode,
      ranMs: Date.now() - startedAt,
      ...(task.yieldedAt === undefined ? {} : { yieldedAfterMs: task.yieldedAt - startedAt }),
      killedByUser: task.killedByUser,
      killedByDeadline: task.killedByDeadline === true,
      deadlineSec: task.deadlineSec,
      failure: task.failure ?? { kind: 'none', retryable: true, hint: '' },
      output: stripVTControlCharacters(task.output),
      head: stripVTControlCharacters(task.head),
      droppedChars: task.droppedChars,
      logPath: task.logPath,
      limit: COMPLETION_OUTPUT_LIMIT,
    });
  }

  private ensureTimer(): void {
    this.timer ??= setInterval(() => {
      let anyRunning = false;
      for (const task of this.tasks.values()) {
        if (task.info.status === 'running') anyRunning = true;
        if (!task.dirty) continue;
        task.dirty = false;
        task.info.tail = task.output.slice(-TAIL_LIMIT);
        this.events.onOutput(task.sessionId, task.info.taskId, task.info.tail, task.info.status);
      }
      if (!anyRunning && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }, EMIT_INTERVAL_MS);
  }

  /** task_output：快照或阻塞等待（等到结束视为模型已知情） */
  async read(
    taskId: string,
    timeoutMs = 0,
    signal?: AbortSignal
  ): Promise<{
    status: string;
    output: string;
    exitCode?: number;
    logPath: string;
    details?: unknown;
    failure?: FailureVerdict;
  } | null> {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    if (timeoutMs > 0 && task.info.status === 'running' && !signal?.aborted) {
      const wait = Math.min(timeoutMs, this.limits.taskWaitMaxMs);
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        // 提前结束等待：撤下等待者，任务结束时照常通知
        const onAbort = () => {
          task.waiters = task.waiters.filter((waiter) => waiter !== wake);
          wake();
        };
        const timer = setTimeout(onAbort, wait);
        task.waiters.push(wake);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (task.info.status !== 'running') task.consumed = true;
    return {
      status: task.info.status,
      output: task.output,
      exitCode: task.info.exitCode,
      logPath: task.logPath,
      details: task.details,
      failure: task.failure,
    };
  }

  /** 任务的磁盘日志路径（回执用）；未知任务为 undefined */
  logPathOf(taskId: string): string | undefined {
    return this.tasks.get(taskId)?.logPath;
  }

  /**
   * 终止：SIGTERM 整个进程树，宽限后 SIGKILL；再不收口（如孙进程脱离但仍占着 stdio，
   * close 永不到）就按失败强制结束，免得僵尸任务占配额、锁工作区。
   */
  stop(taskId: string, byUser = false): boolean {
    const task = this.tasks.get(taskId);
    if (task?.info.status !== 'running') return false;
    if (byUser) task.killedByUser = true;
    else {
      task.consumed = true; // 模型自己停的：kill 回执即知情，不再通知
      task.stoppedByModel = true;
    }
    const stillRunning = () => task.info.status === 'running' && !task.settling;
    task.kill('SIGTERM');
    setTimeout(() => {
      if (!stillRunning()) return;
      task.kill('SIGKILL');
      setTimeout(() => {
        if (!stillRunning()) return;
        task.output += '\n[process did not exit after SIGKILL; marked as stopped]';
        void this.settle(task, 'failed');
      }, this.limits.killGraceMs).unref?.();
    }, this.limits.killGraceMs).unref?.();
    return true;
  }

  knownIds(): string[] {
    return [...this.tasks.keys()];
  }

  hasRunningInWorkspace(rootIds: readonly string[]): boolean {
    return [...this.tasks.values()].some(
      (task) =>
        task.info.status === 'running' &&
        rootIds.some((id) => task.sessionId === id || task.sessionId.startsWith(`${id}::`))
    );
  }

  snapshot(sessionId: string): BackgroundTaskInfo[] {
    return [...this.tasks.values()]
      .filter((task) => task.sessionId === sessionId)
      .map((task) => ({ ...task.info, tail: task.output.slice(-TAIL_LIMIT) }));
  }

  stopAll(): void {
    for (const task of this.tasks.values()) {
      if (task.info.status === 'running') this.stop(task.info.taskId, true);
    }
  }
}

/** 引号内的文本不参与 shell 后台化判断（避免误伤 echo "a & b"） */
const QUOTED_SEGMENT = /'[^']*'|"(?:[^"\\]|\\.)*"/g;
/** heredoc 正文同样不参与（写脚本时正文里常有 &） */
const HEREDOC_BODY = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1[ \t]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g;
/** 裸 & ：排除 && 、&> 、>& */
const SHELL_AMP = /(^|[^&>])&(?![&>])/;

/**
 * 用 shell 语法把命令丢到后台的写法；命中即拒绝，引导改用 background 参数。
 * 这类写法逃出任务跟踪，命令既不进后台任务列表，也不会在结束时唤醒模型。
 */
export function shellBackgroundEscape(command: string): string | null {
  const bare = command.replace(HEREDOC_BODY, ' ').replace(QUOTED_SEGMENT, ' ');
  if (/(?:^|[;&|])\s*(?:nohup|setsid)\b/.test(bare)) return 'nohup/setsid';
  if (/(?:^|[;|])\s*disown\b/.test(bare)) return 'disown';
  if (SHELL_AMP.test(bare)) return 'a shell "&"';
  return null;
}

const READLIKE_SHELL = [
  /^\s*(?:cat|head|tail|nl|less|more)\b/,
  /^\s*sed\s+(?!-i\b)/,
  /^\s*(?:rg|grep|ack|ag)\b/,
  /^\s*(?:fd|find)\b/,
];

/**
 * shell 读文件/搜内容的提示：这类命令绕过 read/grep 的行范围与输出预算，
 * 在长会话里尤其容易退化成一把梭。只对只读用法提示，写文件（sed -i）不提示。
 */
export function shellReadHint(command: string): string {
  if (!READLIKE_SHELL.some((pattern) => pattern.test(command))) return '';
  return (
    'Shell read-only shortcut: prefer read (offset/limit) for files, grep for content, ' +
    'find for paths — the dedicated tools handle line ranges and stream far less output.'
  );
}

/** 把提示附在工具结果前面：规则写进结果里才不会在长会话中被冲淡 */
function withReadHint<T>(result: T, command: string): T {
  const hint = shellReadHint(command);
  if (!hint) return result;
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  if (!Array.isArray(content)) return result;
  const first = content.find((part) => part?.type === 'text');
  if (first && typeof first.text === 'string') first.text = `${hint}\n\n${first.text}`;
  else content.unshift({ type: 'text', text: hint });
  return result;
}

function spawnBackground(
  command: string,
  cwd: string,
  spawnOpts?: { file?: string; argsPrefix?: string[]; env?: NodeJS.ProcessEnv }
) {
  const env = spawnOpts?.env ?? process.env;
  if (spawnOpts?.file) {
    return spawn(spawnOpts.file, [...(spawnOpts.argsPrefix ?? []), command], {
      cwd,
      env,
      detached: true,
    });
  }
  return spawn(command, { shell: true, cwd, env, detached: true });
}

export type BackgroundLaunch = {
  command: string;
  cwd: string;
  file?: string;
  argsPrefix?: string[];
};

export function resolveBackgroundLaunch(
  toolName: string,
  command: string,
  cwd: string,
  transform?: (command: string, cwd: string) => { command: string; cwd: string },
  resolvePowerShell?: () => { shell: string; args: string[] }
): BackgroundLaunch {
  if (transform) return transform(command, cwd);
  if (toolName === 'powershell') {
    const ps = (resolvePowerShell ?? getPowerShellConfig)();
    return { command, cwd, file: ps.shell, argsPrefix: [...ps.args] };
  }
  return { command, cwd };
}

const asRecord = (params: unknown): Record<string, unknown> =>
  params && typeof params === 'object' && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};

/** 模型显式给的 timeout（秒）：只表示「到点杀」，不影响前台等多久 */
function explicitTimeoutSec(record: Record<string, unknown>): number | undefined {
  return typeof record.timeout === 'number' && Number.isFinite(record.timeout) && record.timeout > 0
    ? record.timeout
    : undefined;
}

function detachedResult(
  error: ForegroundDetachedError,
  context: { commandClass: CommandClass; startedAt: number; logPath: string; waitCapSec: number }
) {
  const { taskId } = error;
  const text = yieldReceiptText({
    taskId,
    reason: error.reason,
    commandClass: context.commandClass,
    afterMs: Date.now() - context.startedAt,
    output: error.output.slice(-TAIL_LIMIT),
    logPath: context.logPath,
    waitCapSec: context.waitCapSec,
  });
  const details =
    error.details && typeof error.details === 'object' && !Array.isArray(error.details)
      ? error.details
      : {};
  return {
    content: [{ type: 'text' as const, text }],
    details: { ...details, backgroundTaskId: taskId },
  };
}

/** pi 对非零退出返回 isError 结果；退出码优先取 structuredContent，缺失时从状态行解析 */
function exitCodeOf(result: { structuredContent?: unknown }, text: string): number | undefined {
  const structured = asRecord(result.structuredContent).exit_code;
  if (typeof structured === 'number' && Number.isInteger(structured)) return structured;
  const match = /Command exited with code (\d+)\s*$/.exec(text);
  return match ? Number(match[1]) : undefined;
}

/** 非零退出的结果末尾追加失败分类与下一步，details 带结构化分类 */
function withFailureNote<T>(result: T): T {
  const record = result as {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
    details?: unknown;
    structuredContent?: unknown;
  };
  if (record.isError !== true || !Array.isArray(record.content)) return result;
  const textPart = [...record.content]
    .reverse()
    .find((part) => part?.type === 'text' && typeof part.text === 'string');
  const text = textPart?.text ?? '';
  const exitCode = exitCodeOf(record, text);
  if (exitCode === undefined) return result;
  const verdict = classifyFailure({ exitCode, tail: text.slice(-FAILURE_TAIL) });
  if (verdict.kind === 'none') return result;
  if (textPart) textPart.text = `${text}\n\n${failureLine(verdict)}`;
  return {
    ...result,
    details: {
      ...asRecord(record.details),
      shellFailure: { kind: verdict.kind, retryable: verdict.retryable, exitCode },
    },
  };
}

/**
 * 渲染层倒计时 / 卡死检测用的前台截止（毫秒）= min(让位时刻, 显式 timeout)。
 * 模型给 timeout=600 时前台仍在让位时刻返回，不能把 600s 当成截止。background 与非命令工具没有。
 */
export function foregroundCommandTimeoutMs(
  toolName: string,
  args: unknown,
  limits: ShellLimits = SHELL_LIMITS
): number | undefined {
  if (toolName !== 'bash' && toolName !== 'powershell') return undefined;
  const record = asRecord(args);
  if (record.background === true) return undefined;
  const command = typeof record.command === 'string' ? record.command : '';
  const yieldMs = classifyCommand(command, limits).yieldMs;
  const timeoutSec = explicitTimeoutSec(record);
  return timeoutSec === undefined ? yieldMs : Math.min(yieldMs, timeoutSec * 1000);
}

/** bash 加 background 能力：background=true 时 detach 运行立即返回 taskId */
export function withBackground(
  definition: ToolDefinition,
  manager: BackgroundTaskManager,
  sessionId: string,
  cwd: string,
  /** 远程会话：把远端命令变换成本地可 spawn 的 ssh 命令(manager 本体始终本地 spawn) */
  transform?: (command: string, cwd: string) => { command: string; cwd: string },
  /** 前台命令按哪个会话登记「转后台」：子代理的命令记在子会话，父会话插话不牵连它 */
  foregroundSessionId = sessionId
): ToolDefinition {
  // 描述文案按建工具时的时限生成（新会话随设置更新）；执行路径每次现读 manager.limits
  const limits = manager.limits;
  const baseParams = definition.parameters as unknown as {
    properties?: Record<string, unknown>;
    [key: string]: unknown;
  };
  const parameters = {
    ...baseParams,
    properties: {
      ...baseParams.properties,
      timeout: {
        type: 'number',
        description:
          'Seconds after which the command is killed. It does not make this call wait longer: a ' +
          'foreground command still running at its yield point continues as a background job and is ' +
          'still killed at this limit. Omit for no limit. Not applied when background=true.',
      },
      background: {
        type: 'boolean',
        description:
          'Run in the background and return immediately with a job id. Required for anything that ' +
          'does not exit on its own (dev servers, watch modes, tail -f) — run in the foreground they ' +
          `are moved to the background after ~${yieldSec(limits.yieldServerMs)}s anyway. ` +
          'You will be notified automatically when it finishes — do not poll or sleep-wait; end your turn instead.',
      },
    },
  } as ToolDefinition['parameters'];
  const name = definition.name;
  return {
    ...definition,
    parameters,
    description:
      `${definition.description} Each call runs in a fresh shell: cd, export and activated ` +
      'virtualenvs do not persist between calls, so chain them in one command. A foreground call ' +
      `still running at its yield point (~${yieldSec(limits.yieldDefaultMs)}s; ` +
      `~${yieldSec(limits.yieldBuildMs)}s for builds, tests and installs; ` +
      `~${yieldSec(limits.yieldServerMs)}s for servers and watchers) keeps running as a background ` +
      'job and returns a receipt with the job id and log path — that is not a failure. timeout only ' +
      'kills the command when reached. There is no interactive input: password prompts, ' +
      'confirmations and editors fail immediately, so use non-interactive flags. ' +
      'Read files with read (offset/limit) instead of cat/head/tail/sed/nl; ' +
      'search with grep and locate with find instead of running rg/grep/find in a shell command.',
    promptSnippet:
      `${name}: run shell commands as tracked jobs. Anything that can outlive the call must use ` +
      `background=true. Foreground calls yield back with a receipt at ~${yieldSec(limits.yieldServerMs)}–` +
      `${yieldSec(limits.yieldBuildMs)}s depending on the command, instead of blocking the turn.`,
    promptGuidelines: [
      ...(definition.promptGuidelines ?? []),
      `Never background a command with &, nohup, setsid or disown — set background: true on ${name}, which tracks the job and wakes you when it ends.`,
      `A ${name} yield receipt means the command is still running as a background job, not that it failed: do not rerun it and do not poll it (task_output loops, sleep) — continue other work or end your turn; its completion wakes you automatically.`,
    ],
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const record = params as { command?: string; background?: boolean };
      if (record.background && typeof record.command === 'string') {
        const hooks = (definition as BackgroundAwareToolDefinition)[BACKGROUND_COMMAND_HOOKS];
        const prepared = hooks
          ? await hooks.prepare(toolCallId, record.command, signal)
          : { command: record.command };
        let taskId: string;
        try {
          if (signal?.aborted) throw abortedError();
          const launch = resolveBackgroundLaunch(definition.name, prepared.command, cwd, transform);
          taskId = manager.start(sessionId, launch.command, launch.cwd, {
            file: launch.file,
            argsPrefix: launch.argsPrefix,
            displayCommand: hooks ? record.command : undefined,
            details: prepared.details,
            finalize: prepared.finalize,
            // 本地后台命令与前台同样跑在非交互硬化 env 里；远程 ssh 包装命令保持原环境
            ...(transform
              ? {}
              : {
                  env: hardenedEnv(process.env, {
                    shell: definition.name === 'powershell' ? 'powershell' : 'bash',
                  }),
                }),
          });
        } catch (error) {
          try {
            await prepared.finalize?.();
          } catch {
            // cleanup/finalize 失败不能覆盖原始取消或启动错误。
          }
          throw error;
        }
        return {
          content: [
            {
              type: 'text',
              text:
                `Started background task ${taskId}. You will be notified when it finishes. ` +
                `If no independent work remains, end your turn — the completion wakes you in a new turn; ` +
                `do not poll or sleep-wait. task_output("${taskId}") shows a snapshot, task_stop("${taskId}") stops it.`,
            },
          ],
          details: prepared.details,
        };
      }
      const shellEscape =
        typeof record.command === 'string' ? shellBackgroundEscape(record.command) : null;
      if (shellEscape) {
        throw new Error(
          `Do not background a foreground command with ${shellEscape} — ` +
            'set background: true on this tool instead, which tracks the process and notifies you on completion.'
        );
      }
      const command = record.command;
      if (typeof command !== 'string') {
        return definition.execute(toolCallId, params, signal, onUpdate, ctx);
      }
      // 每次调用独立 signal：并行工具共享轮次 signal，不能以它区分调用
      const callSignal = signal ? AbortSignal.any([signal]) : new AbortController().signal;
      const startedAt = Date.now();
      // 分类基于模型给的原命令：rtk 改写发生在下层 definition.execute 里
      const policy = classifyCommand(command, manager.limits);
      const deadlineSec = explicitTimeoutSec(asRecord(params));
      const foreground = new ForegroundCommand(
        {
          adopt: (proc) =>
            manager.adopt(sessionId, proc, {
              command,
              startedAt,
              ...(deadlineSec === undefined
                ? {}
                : { deadlineSec: Math.max(0, deadlineSec - (Date.now() - startedAt) / 1000) }),
            }),
          attachFinalize: (taskId, details, finalize) =>
            manager.attachFinalize(taskId, details, finalize),
        },
        policy.yieldMs
      );
      bindForegroundCommand(callSignal, foreground);
      const untrack = manager.trackForeground(foregroundSessionId, toolCallId, foreground);
      try {
        // timeout 原样下传：只作截止（到点杀），让位由 ForegroundCommand 按分类计时
        const result = await definition.execute(toolCallId, params, callSignal, onUpdate, ctx);
        return withReadHint(withFailureNote(result), command);
      } catch (error) {
        if (error instanceof ForegroundDetachedError) {
          return detachedResult(error, {
            commandClass: policy.class,
            startedAt,
            logPath: manager.logPathOf(error.taskId) ?? '',
            waitCapSec: yieldSec(manager.limits.taskWaitMaxMs),
          });
        }
        if (error instanceof ForegroundYieldError) {
          return {
            content: [
              {
                type: 'text' as const,
                text: yieldFailedText(error.output, error.reason, error.yieldMs),
              },
            ],
            details: undefined,
            isError: true,
          };
        }
        if (foreground.deadlineHit && error instanceof Error) {
          return {
            content: [
              { type: 'text' as const, text: deadlineKillText(error.message, deadlineSec) },
            ],
            details: { shellFailure: { kind: 'deadline' as const, retryable: true } },
            isError: true,
          };
        }
        throw error;
      } finally {
        untrack();
      }
    },
  };
}

/** task_output / task_stop 工具（免审） */
export function createTaskTools(
  manager: BackgroundTaskManager,
  sessionId?: string
): ToolDefinition[] {
  const waitCapMs = manager.limits.taskWaitMaxMs;
  return [
    {
      name: 'task_output',
      label: 'Task output',
      description:
        'Read the output/status of a background task. Omit timeout_ms (or pass 0) for an instant snapshot; ' +
        `pass a positive timeout_ms to block until the task finishes (capped at ${yieldSec(waitCapMs)} seconds per call). ` +
        'Prefer one snapshot or one bounded wait — you are notified automatically on completion, do not poll.',
      promptSnippet: 'task_output: snapshot or bounded-wait a background task by id (no polling)',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Background task id' },
          timeout_ms: {
            type: 'number',
            description: `Block up to this many ms waiting for completion (max ${waitCapMs})`,
          },
        },
        required: ['taskId'],
      } as unknown as ToolDefinition['parameters'],
      async execute(toolCallId, params, signal) {
        const { taskId = '', timeout_ms: timeoutMs } = params as {
          taskId?: string;
          timeout_ms?: number;
        };
        const requested = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 0;
        const blocking =
          requested > 0 && sessionId ? manager.trackBlockingWait(sessionId, toolCallId) : null;
        const waitSignal = blocking
          ? signal
            ? AbortSignal.any([signal, blocking.signal])
            : blocking.signal
          : signal;
        let result: Awaited<ReturnType<BackgroundTaskManager['read']>>;
        try {
          result = await manager.read(taskId, requested, waitSignal);
        } finally {
          blocking?.untrack();
        }
        if (!result) {
          throw new Error(
            `unknown task: ${taskId}. Known task ids: [${manager.knownIds().join(', ')}]`
          );
        }
        const suffix = result.exitCode !== undefined ? ` (exit ${result.exitCode})` : '';
        const detachedBy = blocking?.reason();
        const hint =
          result.status !== 'running' || requested === 0
            ? ''
            : detachedBy
              ? `\n[${detachedWaitNote(detachedBy, 'task')}]`
              : '\n[Still running after the bounded wait. You do not need to call this again — you will be notified automatically when it completes.]';
        const failure =
          result.status !== 'running' && result.failure && result.failure.kind !== 'none'
            ? `\n${failureLine(result.failure)}`
            : '';
        return {
          content: [
            {
              type: 'text',
              text:
                `[${result.status}${suffix}] Full log: ${result.logPath}\n` +
                `${result.output.slice(-30_000) || '(no output yet)'}${hint}${failure}`,
            },
          ],
          details: result.details,
        };
      },
    },
    {
      name: 'task_stop',
      label: 'Task stop',
      description: 'Stop a running background task.',
      promptSnippet: 'task_stop: stop a running background task by id',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string', description: 'Background task id' } },
        required: ['taskId'],
      } as unknown as ToolDefinition['parameters'],
      async execute(_id, params) {
        const taskId = (params as { taskId?: string }).taskId ?? '';
        const stopped = manager.stop(taskId);
        return {
          content: [
            {
              type: 'text',
              text: stopped
                ? `Stopped ${taskId}`
                : `${taskId} is not running. Known task ids: [${manager.knownIds().join(', ')}]`,
            },
          ],
          details: undefined,
        };
      },
    },
  ];
}

/** 完成提醒搭车：任意工具结果顶部前置未投递的后台任务完成通知 */
export function withTaskReminders(
  definition: ToolDefinition,
  takePending: () => string[]
): ToolDefinition {
  return {
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = await definition.execute(toolCallId, params, signal, onUpdate, ctx);
      const pending = takePending();
      if (pending.length === 0) return result;
      const reminder = `<background-task-update>\n${pending.join('\n\n')}\n</background-task-update>\n\n`;
      const content = [...(result.content ?? [])];
      const firstText = content.find((part) => part.type === 'text');
      if (firstText && firstText.type === 'text') {
        firstText.text = reminder + firstText.text;
      } else {
        content.unshift({ type: 'text', text: reminder.trimEnd() });
      }
      return { ...result, content };
    },
  };
}
