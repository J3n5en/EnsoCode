import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, statSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';
import { getPowerShellConfig, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { SHELL_READ_HINT, SHELL_SLEEP_HINT, SHELL_TIMEOUT_HINT } from '@shared/shellHints';
import { SHELL_LIMITS, type ShellLimits } from '@shared/shellLimits';
import type { BackgroundTaskInfo, BackgroundTaskKeep } from '@shared/types/agent';
import {
  commandKey,
  commandSummary,
  type DetachedTaskRecord,
  type InterruptedTaskRecord,
} from './detachedTasksManifest';
import {
  bindForegroundCommand,
  type DetachableProcess,
  type DetachReason,
  ForegroundCommand,
  ForegroundDetachedError,
  ForegroundYieldError,
} from './foregroundCommand';
import { killProcessTree } from './killTree';
import { ensureSessionTempDir, sessionTempDir } from './sessionTempDir';
import {
  attachFileBacked,
  defaultRunProbe,
  type FileBackedRun,
  processAlive,
  type RunProbe,
  readExitCode,
  readFileTail,
  readRunOutput,
  removeRunFiles,
  runFiles,
  spawnFileBacked,
} from './shell/detachedRun';
import { hardenedEnv } from './shell/hardenedEnv';
import { type CommandClass, classifyCommand } from './shell/policy';
import {
  completionReceiptText,
  deadlineKillText,
  excerpt,
  failureLine,
  headChars,
  yieldFailedText,
  yieldReceiptText,
} from './shell/receipts';
import { classifyFailure, type FailureVerdict } from './shell/taxonomy';
import {
  ActivitySampler,
  IDLE_QUIET_MS,
  IDLE_SAMPLE_INTERVAL_MS,
  judgeIdle,
  keepSuppressesIdle,
} from './taskHygiene';

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
/** task_output 单次返回的新输出上限（头 20% 尾 80%） */
const TASK_OUTPUT_LIMIT = 30_000;
/** 输出事件节流 */
const EMIT_INTERVAL_MS = 500;
/** 认回任务时从上一代日志读回内存的尾部上限：够面板 tail 用，不把大日志整个读进来 */
const RECOVER_TAIL_BYTES = 64 * 1024;
/** 因重启中断的通知里附的输出尾部 */
const RESTART_NOTICE_TAIL = 1_500;

export function restartInterruptedNotice(record: InterruptedTaskRecord, tail: string): string {
  const ranMin = Math.max(0, Math.round((record.stoppedAt - record.startedAt) / 60_000));
  const lines = [
    `Background task ${record.taskId} was terminated because the app restarted (status: interrupted-by-restart). It had run about ${ranMin} min.`,
    `Command: ${record.command}`,
    `Its output up to the restart is in ${record.logPath}${tail ? '; the last lines were:' : ' (no output yet).'}`,
    ...(tail ? [tail] : []),
    record.resident
      ? 'It was a long-running service. It was not restarted automatically; start it again only if you still need it.'
      : 'Its result is lost. If you still need it, run the command again; continue with any goal you were working on.',
  ];
  return lines.join('\n');
}

interface Task {
  info: BackgroundTaskInfo;
  sessionId: string;
  kill(signal: NodeJS.Signals): void;
  output: string;
  /** 内存缓冲截头丢掉的字符数（磁盘 log 仍全量） */
  droppedChars: number;
  /** 内存缓冲截头丢掉的 UTF-8 字节数 */
  droppedMemBytes: number;
  /** 模型读游标（输出流绝对位置，字符 / 字节）：让位回执、task_output、完成通知共用，读过的不重放 */
  readChars: number;
  readBytes: number;
  /** 输出开头（内存缓冲截头后仍保留） */
  head: string;
  dirty: boolean;
  logPath: string;
  logStream: WriteStream | null;
  /** 已写入磁盘日志的字节数 */
  logBytes: number;
  /** 日志超限后未写入的字节数 */
  logDroppedBytes: number;
  /** 任务累计写出的输出字节数（认回的任务含上一代写进日志的） */
  outputBytes: number;
  /** 最近一次有输出（或登记）的时刻：闲置判定只看它，不读日志 */
  lastOutputAt: number;
  /** 跨 chunk 的多字节字符留到下个 chunk 再解码，避免产生替换字符 */
  decoder: StringDecoder;
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
  /** 直接子进程；没有 pid 的（前台移交）不做存活探针 */
  pid?: number;
  /** 输出直写文件、能脱离 worker 活过重启的进程；没有的（管道 / 远程 / Windows）重启只能等它结束 */
  run?: FileBackedRun;
  /** 已写进输出的读文件失败原因：同一原因只提示一次 */
  readError?: string;
  /** 原命令 + cwd 的指纹：认回的任务据此拦同一命令的重复启动 */
  commandKey?: string;
  cwd?: string;
  /** 上一代 worker 交出、本代认回的任务 */
  recovered?: boolean;
  /** 上一代收尾时被停掉的任务：完成通知换成这段说明 */
  restartNotice?: string;
  restartResident?: boolean;
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
    status: BackgroundTaskInfo['status'],
    outputBytes?: number
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
  /** quiet：只落盘随下一轮送达，不单独叫醒会话（因重启停掉的常驻服务） */
  onCompletionNotify(
    sessionId: string,
    text: string,
    options?: { durable?: boolean; quiet?: boolean }
  ): void;
}

/** 毫秒转秒（保留一位小数），用于工具描述与回执里的时长 */
const yieldSec = (ms: number): number => Math.round(ms / 100) / 10;

/** 任务归属的会话属于以 rootId 为根的会话树（会话自身或键以 `${rootId}::` 开头的子会话） */
const inSessionTree = (sessionId: string, rootId: string): boolean =>
  sessionId === rootId || sessionId.startsWith(`${rootId}::`);

/** 自上次读取以来的新输出 */
export interface UnreadOutput {
  /** 内存缓冲里的未读部分 */
  text: string;
  /** 未读部分被内存缓冲截掉时单独保留的开头；不可得为空 */
  head: string;
  /** 未读部分里已被内存缓冲截掉的字节数（磁盘日志仍有） */
  droppedBytes: number;
  /** 未读总字节数 */
  bytes: number;
  /** 此前已读过部分输出 */
  resumed: boolean;
}

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
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private sampling = false;

  constructor(
    private readonly events: TaskEvents,
    private readonly logDir: string,
    private currentLimits: ShellLimits = SHELL_LIMITS,
    private readonly sampler: ActivitySampler = new ActivitySampler()
  ) {}

  /** 任务日志与文件直写输出所在目录 */
  get outputDir(): string {
    return this.logDir;
  }

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
      /** 本地 POSIX 命令：输出直写文件，重启时可脱离 worker 活下来 */
      detachable?: boolean;
      commandKey?: string;
    }
  ): string {
    const taskId = this.reserveId(sessionId);
    const run =
      spawnOpts?.detachable && !spawnOpts.file && process.platform !== 'win32'
        ? spawnFileBacked({
            // 与 spawn(command, { shell: true }) 同一个 shell
            shell: '/bin/sh',
            args: ['-c'],
            command,
            cwd,
            env: spawnOpts.env,
            dir: this.logDir,
          })
        : undefined;
    if (run) {
      const task = this.register(sessionId, taskId, spawnOpts?.displayCommand ?? command, {
        details: spawnOpts?.details,
        finalize: spawnOpts?.finalize,
        kill: (signal) => run.kill(signal),
      });
      task.run = run;
      task.cwd = cwd;
      task.commandKey = spawnOpts?.commandKey;
      run.sink((chunk) => this.append(task, chunk));
      run.done.then(
        ({ code, signal }) => this.exited(task, code, signal),
        (error: unknown) => {
          task.output += `\n[spawn error] ${error instanceof Error ? error.message : String(error)}`;
          if (task.info.status === 'running' && !task.settling) void this.settle(task, 'failed');
        }
      );
      this.announce(task);
      return taskId;
    }
    // POSIX 下 detached 独立进程组；kill 时整棵树一起清（Windows 不 detached，走 taskkill /T）
    const child = spawnBackground(command, cwd, spawnOpts);
    const task = this.register(sessionId, taskId, spawnOpts?.displayCommand ?? command, {
      details: spawnOpts?.details,
      finalize: spawnOpts?.finalize,
      kill: (signal) => killProcessTree(child, signal),
    });
    task.pid = child.pid;
    child.stdout?.on('data', (chunk: Buffer) => this.append(task, chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.append(task, chunk));
    child.on('error', (error) => {
      task.output += `\n[spawn error] ${error.message}`;
      if (task.info.status === 'running' && !task.settling) void this.settle(task, 'failed');
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
    opts: { command: string; startedAt: number; deadlineSec?: number; cwd?: string }
  ): string {
    const taskId = this.reserveId(sessionId);
    const task = this.register(sessionId, taskId, opts.command, {
      startedAt: opts.startedAt,
      kill: () => proc.kill(),
    });
    task.yieldedAt = Date.now();
    task.run = proc.detachable?.();
    if (opts.cwd !== undefined) {
      task.cwd = opts.cwd;
      task.commandKey = commandKey(opts.command, opts.cwd);
    }
    this.append(task, Buffer.from(proc.output()));
    // 让位回执会带上这部分输出：视为已读。pipe() 之后 proc.output() 冻结（不再捕获），
    // ForegroundCommand.detach 在同一同步段里取到的 error.output 与这里是同一快照，不存在时差
    this.takeUnread(task);
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
    task.info.deadlineAt = Date.now() + Math.max(0, remainingSec) * 1000;
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

  private reserveId(sessionId: string): string {
    // 配额：先清理已完成，再满则拒绝并教模型下一步
    const max = this.limits.maxTasks;
    if (this.tasks.size >= max) this.pruneFinished();
    if (this.tasks.size >= max) {
      // 只列本会话树的：别的会话的任务模型既停不了，也不该看到
      throw new Error(
        `Too many background tasks (limit ${max}). Stop one with task_stop first. ` +
          `Known task ids: [${this.knownIds(sessionId).join(', ')}]`
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
      /** 认回的任务接着写同一份日志，并把日志尾部读回内存给面板 */
      appendLog?: boolean;
    }
  ): Task {
    const logPath = path.join(this.logDir, `${taskId}.log`);
    let logStream: WriteStream | null = null;
    let logBytes = 0;
    let seed = '';
    try {
      mkdirSync(this.logDir, { recursive: true });
      if (opts.appendLog) {
        try {
          logBytes = statSync(logPath).size;
        } catch {}
        seed = new StringDecoder('utf8').end(readFileTail(logPath, RECOVER_TAIL_BYTES));
      }
      logStream = createWriteStream(logPath, { flags: opts.appendLog ? 'a' : 'w' });
    } catch {
      // 磁盘日志失败不阻塞任务，仅失去全量回看
    }
    const task: Task = {
      sessionId,
      kill: opts.kill,
      output: seed,
      droppedChars: 0,
      droppedMemBytes: Math.max(0, logBytes - Buffer.byteLength(seed)),
      // 上一代的输出模型已按它自己的游标读过/通知过，不再当作新输出重放
      readChars: seed.length,
      readBytes: Math.max(logBytes, Buffer.byteLength(seed)),
      head: '',
      dirty: false,
      logPath,
      logStream,
      logBytes,
      logDroppedBytes: 0,
      outputBytes: logBytes,
      lastOutputAt: Date.now(),
      decoder: new StringDecoder('utf8'),
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
        tail: seed.slice(-TAIL_LIMIT),
        startedAt: opts.startedAt ?? Date.now(),
      },
    };
    this.tasks.set(taskId, task);
    return task;
  }

  private append(task: Task, chunk: Buffer): void {
    if (chunk.length === 0) return;
    task.outputBytes += chunk.length;
    task.lastOutputAt = Date.now();
    if (task.info.idle) {
      delete task.info.idle;
      this.emitLevel(task.sessionId);
    }
    this.writeLog(task, chunk);
    const text = task.decoder.write(chunk);
    if (!text) return;
    if (task.head.length < HEAD_KEEP) task.head = headChars(task.head + text, HEAD_KEEP);
    const next = task.output + text;
    let overflow = next.length - MAX_BUFFER;
    if (overflow > 0) {
      // 截头不劈开代理对：否则缓冲以孤立代理项开头，字节也会多算
      if (
        overflow < next.length &&
        next.charCodeAt(overflow) >= 0xdc00 &&
        next.charCodeAt(overflow) <= 0xdfff
      ) {
        overflow += 1;
      }
      task.droppedChars += overflow;
      task.droppedMemBytes += Buffer.byteLength(next.slice(0, overflow));
      task.output = next.slice(overflow);
    } else {
      task.output = next;
    }
    task.dirty = true;
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
    if (task.logDroppedBytes === 0) {
      if (fits > 0) task.logStream.write(chunk.subarray(0, fits));
      task.logBytes += fits;
      task.logStream.write(
        `\n[log truncated: reached ${this.limits.logMaxBytes} bytes; further output is not recorded]\n`
      );
    }
    task.logDroppedBytes += chunk.length - (task.logDroppedBytes === 0 ? fits : 0);
  }

  /** 取出自上次读取以来的新输出并推进游标 */
  private takeUnread(task: Task): UnreadOutput {
    const text = task.output.slice(Math.max(0, task.readChars - task.droppedChars));
    const totalBytes = task.droppedMemBytes + Buffer.byteLength(task.output);
    const bytes = totalBytes - task.readBytes;
    const droppedBytes = Math.max(0, bytes - Buffer.byteLength(text));
    const unread: UnreadOutput = {
      text,
      head: droppedBytes > 0 && task.readChars === 0 ? task.head : '',
      droppedBytes,
      bytes,
      resumed: task.readChars > 0,
    };
    task.readChars = task.droppedChars + task.output.length;
    task.readBytes = totalBytes;
    return unread;
  }

  private exited(task: Task, code: number | null, signal: NodeJS.Signals | null): void {
    if (task.info.status !== 'running' || task.settling) return;
    task.signal = signal;
    if (signal) task.output += `\n[terminated by ${signal}]`;
    void this.settle(task, code === 0 ? 'done' : 'failed', code ?? undefined);
  }

  private announce(task: Task): void {
    this.events.onStarted(task.sessionId, this.infoOf(task));
    this.emitLevel(task.sessionId);
    this.ensureTimer();
    if (process.platform !== 'win32') {
      this.idleTimer ??= setInterval(() => void this.sampleIdle(), IDLE_SAMPLE_INTERVAL_MS);
      this.idleTimer.unref?.();
    }
  }

  /**
   * 闲置采样：只看已安静接近阈值的任务（提前一个周期取 CPU 基线），一轮一次 ps + 一次 lsof。
   * 状态变了才发全量快照；保留未满 1 小时的不判，到点后仍闲置就撤掉保留、重新标闲置。
   */
  async sampleIdle(now = Date.now()): Promise<void> {
    if (this.sampling) return;
    const running = [...this.tasks.values()].filter(
      (task) => task.info.status === 'running' && !task.settling
    );
    if (running.length === 0) {
      if (this.idleTimer) clearInterval(this.idleTimer);
      this.idleTimer = null;
      return;
    }
    const candidates = running.flatMap((task) => {
      const pid = task.pid ?? task.run?.pid;
      return pid !== undefined &&
        !keepSuppressesIdle(task.info.keep, now + IDLE_SAMPLE_INTERVAL_MS) &&
        now - task.lastOutputAt >= IDLE_QUIET_MS - IDLE_SAMPLE_INTERVAL_MS
        ? [{ key: task.info.taskId, pid }]
        : [];
    });
    this.sampling = true;
    let samples: Awaited<ReturnType<ActivitySampler['sample']>>;
    try {
      samples = await this.sampler.sample(candidates, now);
    } catch {
      samples = new Map();
    } finally {
      this.sampling = false;
    }
    const touched = new Set<string>();
    for (const task of running) {
      if (task.info.status !== 'running') continue;
      const idle =
        !keepSuppressesIdle(task.info.keep, now) &&
        judgeIdle({ now, lastOutputAt: task.lastOutputAt, sample: samples.get(task.info.taskId) });
      if (idle) {
        const ports = samples.get(task.info.taskId)?.sockets?.listening ?? [];
        const changed =
          !task.info.idle ||
          task.info.idle.since !== task.lastOutputAt ||
          task.info.idle.ports.join() !== ports.join() ||
          task.info.keep !== undefined;
        task.info.idle = { since: task.lastOutputAt, ports };
        delete task.info.keep;
        if (changed) touched.add(task.sessionId);
      } else if (task.info.idle && samples.has(task.info.taskId)) {
        // 拿不到数据的一轮维持原判，不来回闪；拿到了且不再闲置才撤
        delete task.info.idle;
        touched.add(task.sessionId);
      }
    }
    for (const sessionId of touched) this.emitLevel(sessionId);
  }

  /** 留下运行（agent 表态或用户手动保留）：清掉闲置标记，1 小时后重新检查 */
  keep(taskId: string, keep: Omit<BackgroundTaskKeep, 'at'>, now = Date.now()): boolean {
    const task = this.tasks.get(taskId);
    if (task?.info.status !== 'running') return false;
    const reason = keep.reason?.trim().slice(0, 200);
    task.info.keep = { by: keep.by, ...(reason ? { reason } : {}), at: now };
    delete task.info.idle;
    this.emitLevel(task.sessionId);
    return true;
  }

  /** 取消保留：下一轮采样重新判定 */
  unkeep(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task?.info.keep) return false;
    delete task.info.keep;
    this.emitLevel(task.sessionId);
    return true;
  }

  /** 会话自己起的、还在跑、没表态（没保留、也没在停）的任务；子代理起的归子代理，不算在内 */
  undeclared(sessionId: string): BackgroundTaskInfo[] {
    return [...this.tasks.values()]
      .filter(
        (task) =>
          task.info.status === 'running' &&
          !task.info.keep &&
          !task.killedByUser &&
          !task.stoppedByModel &&
          task.sessionId === sessionId
      )
      .map((task) => this.infoOf(task));
  }

  taskInfo(taskId: string): BackgroundTaskInfo | undefined {
    const task = this.tasks.get(taskId);
    return task ? this.infoOf(task) : undefined;
  }

  private infoOf(task: Task): BackgroundTaskInfo {
    return { ...task.info, tail: task.output.slice(-TAIL_LIMIT), outputBytes: task.outputBytes };
  }

  /** 输出文件读不到时把原因写进输出：面板和 task_output 看到的是失败原因，不是「暂无输出」 */
  private noteReadError(task: Task): void {
    const error = task.run?.readError() ?? undefined;
    if (!error || error === task.readError) return;
    task.readError = error;
    task.output += `\n[cannot read command output: ${error}]\n`;
    task.dirty = true;
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
          droppedBytes: task.logDroppedBytes,
        });
    // 有阻塞等待者 = 结束态将经工具返回值送达模型（blockWaited 语义），无需再通知
    const hadWaiters = task.waiters.length > 0;
    if (hadWaiters) task.consumed = true;
    for (const wake of task.waiters.splice(0)) wake();
    this.events.onOutput(
      task.sessionId,
      task.info.taskId,
      task.info.tail,
      status,
      task.outputBytes
    );
    this.events.onEnded(task.sessionId, task.info.taskId, status, exitCode);
    this.emitLevel(task.sessionId);
    // 幂等抑制：模型已知情（阻塞等到 / 自己停的且收到回执）就不再打扰
    if (!task.consumed) {
      const text = task.restartNotice ?? this.completionText(task);
      // 认回的任务所属会话可能还没打开：通知要落盘等它打开，不能丢
      if (task.recovered)
        this.events.onCompletionNotify(task.sessionId, text, {
          durable: true,
          ...(task.restartResident ? { quiet: true } : {}),
        });
      else this.events.onCompletionNotify(task.sessionId, text);
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
    const unread = this.takeUnread(task);
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
      output: stripVTControlCharacters(unread.text),
      head: stripVTControlCharacters(unread.head),
      droppedBytes: unread.droppedBytes,
      resumed: unread.resumed,
      logPath: task.logPath,
      limit: COMPLETION_OUTPUT_LIMIT,
    });
  }

  private ensureTimer(): void {
    this.timer ??= setInterval(() => {
      this.watchTasks();
      let anyRunning = false;
      for (const task of this.tasks.values()) {
        if (task.info.status === 'running') anyRunning = true;
        this.noteReadError(task);
        if (!task.dirty) continue;
        task.dirty = false;
        task.info.tail = task.output.slice(-TAIL_LIMIT);
        this.events.onOutput(
          task.sessionId,
          task.info.taskId,
          task.info.tail,
          task.info.status,
          task.outputBytes
        );
      }
      if (!anyRunning && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }, EMIT_INTERVAL_MS);
  }

  /**
   * 直接子进程已经不在，或显式截止到了但定时器没把它杀掉：收口并走完成通知。
   * alive 可注入，测试不必真的杀进程才走这条路径。
   */
  watchTasks(now = Date.now(), alive: (pid: number) => boolean = processAlive): void {
    for (const task of this.tasks.values()) {
      if (task.info.status !== 'running' || task.settling) continue;
      if (task.pid !== undefined && !alive(task.pid)) {
        task.info.alive = false;
        task.output += '\n[process gone; watchdog settled the task]';
        task.kill('SIGKILL');
        this.exited(task, null, null);
        continue;
      }
      if (
        task.info.deadlineAt !== undefined &&
        now >= task.info.deadlineAt &&
        !task.killedByDeadline
      ) {
        task.killedByDeadline = true;
        task.kill('SIGTERM');
        setTimeout(() => {
          if (task.info.status === 'running') task.kill('SIGKILL');
        }, this.limits.killGraceMs).unref?.();
      }
    }
  }

  /**
   * 仅供模型面（task_output）：快照或阻塞等待（等到结束视为模型已知情）。
   * 调用即消费读游标——unread 是自上次交付以来的新输出；UI 等其它调用方用 snapshot()，否则会吞掉模型的新输出。
   */
  async read(
    taskId: string,
    timeoutMs = 0,
    signal?: AbortSignal
  ): Promise<{
    status: string;
    output: string;
    unread: UnreadOutput;
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
      unread: this.takeUnread(task),
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

  /** 给了 rootId 时只列该会话树的任务 */
  knownIds(rootId?: string): string[] {
    return [...this.tasks.values()]
      .filter((task) => rootId === undefined || inSessionTree(task.sessionId, rootId))
      .map((task) => task.info.taskId);
  }

  /** 任务是否属于以 rootId 为根的会话树：所有会话共用一个 manager，模型面只能碰自己的 */
  owns(taskId: string, rootId: string): boolean {
    const task = this.tasks.get(taskId);
    return task !== undefined && inSessionTree(task.sessionId, rootId);
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
      .map((task) => this.infoOf(task));
  }

  /** 名下还有任务（含已结束、尚未清理的）的会话 */
  sessionIds(): string[] {
    return [...new Set([...this.tasks.values()].map((task) => task.sessionId))];
  }

  /**
   * 前台命令转后台（adopt，有 yieldedAt）后还没结束的任务：优雅重启把它们当作在跑的工具。
   * exceptDetachable：重启会把能脱离的交给下一代，只剩脱离不了的需要等
   */
  runningYielded(sessionId: string, opts?: { exceptDetachable?: boolean }): string[] {
    return [...this.tasks.values()]
      .filter(
        (task) =>
          task.sessionId === sessionId &&
          task.yieldedAt !== undefined &&
          task.info.status === 'running' &&
          !(opts?.exceptDetachable && task.run)
      )
      .map((task) => task.info.taskId);
  }

  stopAll(): void {
    for (const task of this.tasks.values()) {
      if (task.info.status === 'running') this.stop(task.info.taskId, true);
    }
  }

  /**
   * worker 收尾前：还在跑、即将被停掉的任务（含空闲会话的）。记进台账后调 handOverNotices，
   * 本代不再发完成通知，由下一代在任务表留下「因重启中断」并通知一次。子代理的任务记到根会话（子会话不随换代恢复），
   * keepChild 认定重启后会续跑的子会话除外：记给它本身，续跑时交给它
   */
  interruptedOnShutdown(
    now = Date.now(),
    keepChild: (sessionId: string) => boolean = () => false
  ): InterruptedTaskRecord[] {
    const records: InterruptedTaskRecord[] = [];
    for (const task of this.tasks.values()) {
      if (task.info.status !== 'running' || task.settling) continue;
      records.push({
        taskId: task.info.taskId,
        sessionId: keepChild(task.sessionId)
          ? task.sessionId
          : (task.sessionId.split('::')[0] ?? task.sessionId),
        command: commandSummary(task.info.command),
        startedAt: task.info.startedAt,
        stoppedAt: now,
        logPath: task.logPath,
        resident:
          task.info.keep !== undefined || classifyCommand(task.info.command).class === 'server',
      });
    }
    return records;
  }

  handOverNotices(taskIds: readonly string[]): void {
    for (const taskId of taskIds) {
      const task = this.tasks.get(taskId);
      if (task) task.consumed = true;
    }
  }

  /** 新一代：上一代收尾时停掉的任务按原 taskId 留在任务表（failed + interrupted），通知所属会话一次 */
  recoverInterrupted(records: readonly InterruptedTaskRecord[]): void {
    for (const record of records) {
      if (this.tasks.has(record.taskId)) continue;
      const task = this.register(record.sessionId, record.taskId, record.command, {
        startedAt: record.startedAt,
        kill: () => {},
        appendLog: true,
      });
      task.recovered = true;
      task.info.interrupted = 'restart';
      task.restartResident = record.resident;
      task.restartNotice = restartInterruptedNotice(
        record,
        stripVTControlCharacters(task.output.slice(-RESTART_NOTICE_TAIL)).trim()
      );
      this.announce(task);
      this.finish(task, 'failed');
    }
  }

  /**
   * 重启前把能脱离的在跑任务交出去：读完已有输出、停止跟读，进程不动，从本代移除，返回恢复清单条目。
   * 脱离不了的（管道进程）留在原处，worker 收尾时照常停掉。
   */
  detachForRestart(): DetachedTaskRecord[] {
    const records: DetachedTaskRecord[] = [];
    for (const task of [...this.tasks.values()]) {
      const run = task.run;
      if (!run || task.info.status !== 'running' || task.settling) continue;
      const outputOffset = run.release();
      if (task.deadlineTimer) clearTimeout(task.deadlineTimer);
      task.logStream?.end();
      this.tasks.delete(task.info.taskId);
      records.push({
        taskId: task.info.taskId,
        sessionId: task.sessionId,
        command: commandSummary(task.info.command),
        commandKey: task.commandKey ?? null,
        cwd: task.cwd ?? run.cwd,
        pid: run.pid,
        runId: run.runId,
        startedAt: task.info.startedAt,
        runStartedAt: run.startedAt,
        yieldedAt: task.yieldedAt ?? null,
        deadlineAt: task.info.deadlineAt ?? null,
        outputFile: run.outputFile,
        outputOffset,
        exitCodeFile: run.exitFile,
        logPath: task.logPath,
      });
    }
    return records;
  }

  /**
   * 冷启动认回上一代交出的任务，同一个 taskId 重新登记：
   * - pid 在、认得出是原进程（命令行 / 环境变量带着 runId，或启动时间对得上）：running，按偏移接着读输出文件；
   * - pid 不在：读完剩余输出，按退出码文件标 done / failed，照常发完成通知；
   * - pid 在但对不上（被复用）：不认、不发任何信号，标 failed 并说明找不到原进程。
   * 返回处理过的 runId（孤儿清理跳过它们）。
   */
  recover(records: readonly DetachedTaskRecord[], probe: RunProbe = defaultRunProbe): Set<string> {
    const handled = new Set<string>();
    for (const record of records) {
      if (this.tasks.has(record.taskId)) continue;
      handled.add(record.runId);
      const files = runFiles(this.logDir, record.runId);
      const identity = { runId: record.runId, startedAt: record.runStartedAt ?? record.startedAt };
      const state = !probe.alive(record.pid)
        ? 'gone'
        : probe.matches(record.pid, identity)
          ? 'alive'
          : 'reused';
      const task = this.register(record.sessionId, record.taskId, record.command, {
        startedAt: record.startedAt,
        kill: () => {},
        appendLog: true,
      });
      task.recovered = true;
      task.cwd = record.cwd;
      if (record.commandKey) task.commandKey = record.commandKey;
      if (record.yieldedAt !== null) task.yieldedAt = record.yieldedAt;
      if (state === 'alive') {
        const run = attachFileBacked(
          this.logDir,
          {
            runId: record.runId,
            pid: record.pid,
            startedAt: identity.startedAt,
            cwd: record.cwd,
            outputFile: files.outputFile,
            exitFile: files.exitFile,
          },
          record.outputOffset,
          probe
        );
        task.run = run;
        task.kill = (signal) => run.kill(signal);
        run.sink((chunk) => this.append(task, chunk));
        void run.done.then(({ code }) => {
          if (code === null) task.output += '\n[process ended; exit code unavailable]';
          this.exited(task, code, null);
        });
        this.announce(task);
        if (record.deadlineAt !== null)
          this.armDeadline(task, (record.deadlineAt - Date.now()) / 1000);
        continue;
      }
      this.append(task, readRunOutput(files.outputFile, record.outputOffset));
      const code = state === 'gone' ? readExitCode(files.exitFile) : null;
      removeRunFiles(this.logDir, record.runId);
      task.output +=
        state === 'gone'
          ? code === null
            ? '\n[process ended while the app was restarting; exit code unavailable]'
            : ''
          : `\n[original process not found after restart: pid ${record.pid} now belongs to another process; the task was not reattached and nothing was killed]`;
      this.announce(task);
      this.exited(task, code, null);
    }
    return handled;
  }

  /** 认回的、同一会话树里还在跑的同一命令（同 cwd）；没有返回 undefined */
  recoveredDuplicate(sessionId: string, key: string): string | undefined {
    const root = sessionId.split('::')[0] ?? sessionId;
    for (const task of this.tasks.values()) {
      if (
        task.recovered &&
        task.info.status === 'running' &&
        !task.settling &&
        task.commandKey === key &&
        inSessionTree(task.sessionId, root)
      )
        return task.info.taskId;
    }
    return undefined;
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
  return SHELL_READ_HINT;
}

const SLEEP_UNIT_SEC: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600 };
const SLEEP_HINT_MIN_SEC = 20;

/**
 * 前台 sleep 等待的提示：固定延时后检查、或 sleep 轮询循环，每查一次都要多一轮模型。
 * 改成后台条件等待，结束时通知，一次就够。
 */
export function shellSleepHint(command: string): string {
  const bare = command.replace(HEREDOC_BODY, ' ').replace(QUOTED_SEGMENT, ' ');
  const sleeps = [...bare.matchAll(/(?:^|[;&|(\s])sleep\s+(\d+(?:\.\d+)?)([smh]?)\b/g)].map(
    (match) => Number(match[1]) * (SLEEP_UNIT_SEC[match[2]] ?? 1)
  );
  if (sleeps.length === 0) return '';
  const loop = /(?:^|[;&|\s])(?:while|until|for)\s/.test(bare);
  if (!loop && sleeps.reduce((sum, value) => sum + value, 0) < SLEEP_HINT_MIN_SEC) return '';
  return SHELL_SLEEP_HINT;
}

const TIMEOUT_HINT_MIN_SEC = SHELL_LIMITS.yieldDefaultMs / 1000;
/** 实际耗时达到默认让位的三分之二才算「跑得久」 */
export const TIMEOUT_HINT_SLOW_MS = (SHELL_LIMITS.yieldDefaultMs * 2) / 3;

/**
 * 前台显式 timeout 的提示：模型常把 timeout 当成「等这么久」，其实它只杀进程、不延长让位。
 * 达到默认让位时长才提示，短 timeout 是在提前杀，不误伤；
 * 且命令真的跑得久或已转后台才提示，快速结束的命令不带，免得每次都刷屏。
 */
export function shellTimeoutHint(
  timeoutSec: number | undefined,
  run: { elapsedMs: number; detached?: boolean }
): string {
  if (timeoutSec === undefined || timeoutSec < TIMEOUT_HINT_MIN_SEC) return '';
  if (!run.detached && run.elapsedMs < TIMEOUT_HINT_SLOW_MS) return '';
  return SHELL_TIMEOUT_HINT;
}

/** 把提示附在工具结果前面：规则写进结果里才不会在长会话中被冲淡 */
function withCommandHints<T>(result: T, command: string, timeoutHint: string): T {
  const hint = [shellReadHint(command), shellSleepHint(command), timeoutHint]
    .filter(Boolean)
    .join('\n');
  return prependHint(result, hint);
}

function prependHint<T>(result: T, hint: string): T {
  if (!hint) return result;
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  if (!Array.isArray(content)) return result;
  const first = content.find((part) => part?.type === 'text');
  if (first && typeof first.text === 'string') first.text = `${hint}\n\n${first.text}`;
  else content.unshift({ type: 'text', text: hint });
  return result;
}

/** Windows 下 detached 会让 powershell.exe 不执行命令直接退出 0；进程树由 taskkill /T 清理，不依赖进程组 */
export function backgroundSpawnMode(platform: string): {
  detached: boolean;
  windowsHide?: boolean;
} {
  return platform === 'win32' ? { detached: false, windowsHide: true } : { detached: true };
}

function spawnBackground(
  command: string,
  cwd: string,
  spawnOpts?: { file?: string; argsPrefix?: string[]; env?: NodeJS.ProcessEnv }
) {
  const env = spawnOpts?.env ?? process.env;
  // stdin 关闭与前台（pi bash）一致：读 stdin 立即 EOF，交互提示 fail-fast 而不是挂到让位点；远程包装即 ssh -n
  const stdio: ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe'];
  const mode = backgroundSpawnMode(process.platform);
  if (spawnOpts?.file) {
    return spawn(spawnOpts.file, [...(spawnOpts.argsPrefix ?? []), command], {
      cwd,
      env,
      ...mode,
      stdio,
    });
  }
  return spawn(command, { shell: true, cwd, env, ...mode, stdio });
}

export { processAlive };

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

/** PowerShell 临时文件只进会话专属目录；拿不到安全路径时也只给禁令，不再指向 Temp 根 */
function powerShellTempNote(tempDir: string | null): string {
  return tempDir
    ? `Put temporary scripts and files only in ${tempDir} (this session's own temp folder, created ` +
        'for you); never write to or clean up the shared $env:TEMP root, and when cleaning up delete ' +
        'only inside that folder. '
    : 'Avoid temporary files; never write to or clean up the shared $env:TEMP root. ';
}

/** 说明里点名的命令按工具所在的 shell 写：PowerShell 会话不能看到 bash 写法 */
function shellTerms(name: string, tempDir: string | null) {
  return name === 'powershell'
    ? {
        kind: 'PowerShell',
        syntax:
          'Commands run in PowerShell, not bash: there is no head, tail or /tmp — use ' +
          'Select-Object -First N / -Last N, and chain with ; (&& and || need PowerShell 7). ' +
          powerShellTempNote(tempDir),
        sessionState: 'Set-Location, $env: changes',
        follow: 'Get-Content -Wait',
        readCommands: 'Get-Content',
        searchCommands: 'Select-String or Get-ChildItem -Recurse',
        poll: 'Start-Sleep, Get-Process',
        pollJob: 'Start-Sleep, Get-Process',
        detach: 'Start-Job, Start-Process or a trailing &',
      }
    : {
        kind: 'shell',
        syntax: '',
        sessionState: 'cd, export',
        follow: 'tail -f',
        readCommands: 'cat/head/tail/sed/nl',
        searchCommands: 'rg/grep/find',
        poll: 'sleep, ps, pgrep',
        pollJob: 'sleep, ps, pgrep, top',
        detach: '&, nohup, setsid or disown',
      };
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
    output: error.output,
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
  const name = definition.name;
  // 只有本机 PowerShell 需要：远程会话的命令跑在远端，本机 Temp 路径对它无意义
  const tempDir = name === 'powershell' && !transform ? sessionTempDir(sessionId, { cwd }) : null;
  const terms = shellTerms(name, tempDir);
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
          'still killed at this limit. Do not set timeout to wait — use background: true. ' +
          'Omit for no kill limit. Not applied when background=true.',
      },
      background: {
        type: 'boolean',
        description:
          'Run in the background and return immediately with a job id. Use this whenever the command ' +
          `may outlast the foreground yield (~${yieldSec(limits.yieldDefaultMs)}s; ` +
          `~${yieldSec(limits.yieldBuildMs)}s for builds/tests; servers/watchers ~${yieldSec(limits.yieldServerMs)}s). ` +
          `Required for anything that does not exit on its own (dev servers, watch modes, ${terms.follow}). ` +
          'You will be notified automatically when it finishes — do not poll or sleep-wait; end your turn instead.',
      },
    },
  } as ToolDefinition['parameters'];
  return {
    ...definition,
    parameters,
    description:
      `${definition.description} ${terms.syntax}Each call runs in a fresh shell: ${terms.sessionState} and activated ` +
      'virtualenvs do not persist between calls, so chain them in one command. A foreground call ' +
      `still running at its yield point (~${yieldSec(limits.yieldDefaultMs)}s; ` +
      `~${yieldSec(limits.yieldBuildMs)}s for builds, tests and installs; ` +
      `~${yieldSec(limits.yieldServerMs)}s for servers and watchers) keeps running as a background ` +
      'job and returns a receipt with the job id and log path — that is not a failure. timeout only ' +
      'kills the command when reached. There is no interactive input: password prompts, ' +
      'confirmations and editors fail immediately, so use non-interactive flags. ' +
      `Read files with read (offset/limit) instead of ${terms.readCommands}; ` +
      `search with grep and locate with find instead of running ${terms.searchCommands} in a shell command. ` +
      `Do not poll a running job with ${terms.pollJob}, or task_output loops. ` +
      'If you already know the command will outlast the yield, set background: true instead of a large timeout.',
    promptSnippet:
      `${name}: run ${terms.kind} commands as tracked jobs. Anything that can outlive the call must use ` +
      `background=true. timeout only kills; it does not extend the wait. Foreground calls yield back ` +
      `with a receipt at ~${yieldSec(limits.yieldServerMs)}–${yieldSec(limits.yieldBuildMs)}s ` +
      `depending on the command, instead of blocking the turn.`,
    promptGuidelines: [
      ...(definition.promptGuidelines ?? []),
      `Never background a command with ${terms.detach} — set background: true on ${name}, which tracks the job and wakes you when it ends.`,
      `A ${name} yield receipt means the command is still running as a background job, not that it failed: do not rerun it and do not poll it (task_output loops, sleep) — continue other work or end your turn; its completion wakes you automatically.`,
      `timeout only kills — it does not extend the foreground wait. If a command may outlast the yield (~${yieldSec(limits.yieldDefaultMs)}s; ~${yieldSec(limits.yieldBuildMs)}s for builds), set background: true from the start and end your turn. Never poll with ${terms.poll}, or task_output loops.`,
      'To wait for CI, a deploy or another external result, set a reminder with remind_me (when available) and end your turn; do not keep a sleep or --watch command running just to wait.',
    ],
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const record = params as { command?: string; background?: boolean };
      if (tempDir) ensureSessionTempDir(tempDir);
      // 重启后认回的同一命令还在跑：不再起第二个（dev server 之类会撞端口）
      const duplicate =
        typeof record.command === 'string' && !transform
          ? manager.recoveredDuplicate(sessionId, commandKey(record.command, cwd))
          : undefined;
      if (duplicate) {
        return {
          content: [
            {
              type: 'text',
              text:
                `Not started: this command is already running as background task ${duplicate}. ` +
                'It kept running through the app restart and was reattached, so starting it again would ' +
                `collide with it (ports, files). task_output("${duplicate}") shows its output; ` +
                `task_stop("${duplicate}") stops it if a fresh run is really needed.`,
            },
          ],
          details: { backgroundTaskId: duplicate },
        };
      }
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
                  detachable: definition.name === 'bash',
                  commandKey: commandKey(record.command, cwd),
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
              cwd,
              ...(deadlineSec === undefined
                ? {}
                : { deadlineSec: Math.max(0, deadlineSec - (Date.now() - startedAt) / 1000) }),
            }),
          attachFinalize: (taskId, details, finalize) =>
            manager.attachFinalize(taskId, details, finalize),
        },
        policy.yieldMs,
        transform ? undefined : manager.outputDir
      );
      bindForegroundCommand(callSignal, foreground);
      const untrack = manager.trackForeground(foregroundSessionId, toolCallId, foreground);
      try {
        // timeout 原样下传：只作截止（到点杀），让位由 ForegroundCommand 按分类计时
        const result = await definition.execute(toolCallId, params, callSignal, onUpdate, ctx);
        const timeoutHint = shellTimeoutHint(deadlineSec, { elapsedMs: Date.now() - startedAt });
        return withCommandHints(withFailureNote(result), command, timeoutHint);
      } catch (error) {
        if (error instanceof ForegroundDetachedError) {
          return prependHint(
            detachedResult(error, {
              commandClass: policy.class,
              startedAt,
              logPath: manager.logPathOf(error.taskId) ?? '',
              waitCapSec: yieldSec(manager.limits.taskWaitMaxMs),
            }),
            shellTimeoutHint(deadlineSec, { elapsedMs: Date.now() - startedAt, detached: true })
          );
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
  // 所有会话共用一个 manager：只认本会话树的任务（子代理起的登记在子会话名下，父会话也能读、能停）。
  // 别的会话的任务一律按未知处理，免得推进它的读游标、吞掉它的完成通知，或把它静默停掉
  const owned = (taskId: string) => sessionId === undefined || manager.owns(taskId, sessionId);
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
        const mine = owned(taskId);
        const blocking =
          mine && requested > 0 && sessionId
            ? manager.trackBlockingWait(sessionId, toolCallId)
            : null;
        const waitSignal = blocking
          ? signal
            ? AbortSignal.any([signal, blocking.signal])
            : blocking.signal
          : signal;
        let result: Awaited<ReturnType<BackgroundTaskManager['read']>> = null;
        try {
          if (mine) result = await manager.read(taskId, requested, waitSignal);
        } finally {
          blocking?.untrack();
        }
        if (!result) {
          throw new Error(
            `unknown task: ${taskId}. Known task ids: [${manager.knownIds(sessionId).join(', ')}]`
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
        const { unread } = result;
        const shown = excerpt(unread.text, TASK_OUTPUT_LIMIT, {
          head: unread.droppedBytes > 0 ? unread.head : undefined,
          droppedBytes: unread.droppedBytes,
        });
        const since = unread.resumed ? ' since the last read' : '';
        const omitted = shown.omittedBytes > 0 ? `, ${shown.omittedBytes} omitted in between` : '';
        const header =
          unread.bytes > 0
            ? `${unread.bytes} new bytes${since}${omitted}`
            : unread.resumed
              ? 'no new output since the last read'
              : 'no output yet';
        return {
          content: [
            {
              type: 'text',
              text:
                `[${result.status}${suffix}] ${header}. Full log: ${result.logPath}` +
                `${shown.text ? `\n${shown.text}` : ''}${hint}${failure}`,
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
        const stopped = owned(taskId) && manager.stop(taskId);
        return {
          content: [
            {
              type: 'text',
              text: stopped
                ? `Stopped ${taskId}`
                : `${taskId} is not running. Known task ids: [${manager.knownIds(sessionId).join(', ')}]`,
            },
          ],
          details: undefined,
        };
      },
    },
    {
      name: 'task_settle',
      label: 'Task settle',
      description:
        'Declare what happens to background tasks that are still running when you wrap up, all in one call: ' +
        'stop the ones you no longer need, keep the rest with a one-line reason the user will see. ' +
        'Kept tasks are not flagged as idle for an hour.',
      promptSnippet:
        'task_settle: when wrapping up, stop or keep (with a reason) each still-running background task',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description: 'One entry per running background task',
            items: {
              type: 'object',
              properties: {
                taskId: { type: 'string', description: 'Background task id' },
                action: { type: 'string', enum: ['stop', 'keep'], description: 'stop or keep' },
                reason: {
                  type: 'string',
                  description:
                    'One short sentence: why it is no longer needed, or why it must keep running',
                },
              },
              required: ['taskId', 'action', 'reason'],
            },
          },
        },
        required: ['tasks'],
      } as unknown as ToolDefinition['parameters'],
      prepareArguments: (args: unknown) => normalizeSettleArgs(args),
      async execute(_id, params) {
        const entries = settleEntries((params as { tasks?: unknown }).tasks);
        if (entries.length === 0)
          throw new Error('tasks must list at least one { taskId, action, reason }');
        const settled = entries.map((entry) => {
          const command = owned(entry.taskId) ? manager.taskInfo(entry.taskId)?.command : undefined;
          const ok =
            owned(entry.taskId) &&
            (entry.action === 'stop'
              ? manager.stop(entry.taskId)
              : manager.keep(entry.taskId, { by: 'agent', reason: entry.reason }));
          return { ...entry, ...(command ? { command } : {}), ok };
        });
        const stillOpen = sessionId ? manager.undeclared(sessionId).map((task) => task.taskId) : [];
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                settled,
                ...(stillOpen.length > 0 ? { stillUndeclared: stillOpen } : {}),
              }),
            },
          ],
          details: undefined,
        };
      },
    } as ToolDefinition,
  ];
}

interface SettleEntry {
  taskId: string;
  action: 'stop' | 'keep';
  reason: string;
}

/** 模型常把数组写成 JSON 字符串、或只给单个对象：在 schema 校验前归一 */
function normalizeSettleArgs(args: unknown): unknown {
  if (!args || typeof args !== 'object') return args;
  let tasks = (args as { tasks?: unknown }).tasks;
  if (typeof tasks === 'string') {
    try {
      tasks = JSON.parse(tasks);
    } catch {}
  }
  if (tasks && typeof tasks === 'object' && !Array.isArray(tasks)) tasks = [tasks];
  return { ...args, tasks };
}

function settleEntries(value: unknown): SettleEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const { taskId, action, reason } = item as Record<string, unknown>;
    if (typeof taskId !== 'string' || !taskId || (action !== 'stop' && action !== 'keep'))
      return [];
    return [
      { taskId, action, reason: typeof reason === 'string' ? reason.trim().slice(0, 200) : '' },
    ];
  });
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
