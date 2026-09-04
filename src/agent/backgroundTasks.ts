import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { BackgroundTaskInfo } from '@shared/types/agent';

/** 内存缓冲上限（超出截头保尾；磁盘 log 始终全量） */
const MAX_BUFFER = 200_000;
/** 下发渲染层的尾部快照上限 */
const TAIL_LIMIT = 8_000;
/** 输出事件节流 */
const EMIT_INTERVAL_MS = 500;
/** 并发配额（满额先清已完成，再满拒绝） */
const MAX_TASKS = 10;
/** task_output 阻塞等待上限（与工具描述插值同源） */
const MAX_WAIT_MS = 10 * 60 * 1000;
/** SIGTERM 后未退的宽限，超时 SIGKILL */
const KILL_GRACE_MS = 5_000;

interface Task {
  info: BackgroundTaskInfo;
  sessionId: string;
  child: ReturnType<typeof spawn>;
  output: string;
  dirty: boolean;
  logPath: string;
  logStream: WriteStream | null;
  /** 模型已经由工具返回值知情（阻塞等到结束 / kill 已回执），不再通知 */
  consumed: boolean;
  killedByUser: boolean;
  waiters: Array<() => void>;
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
  /** 未被模型知情的任务结束时触发：supervisor 决定注入唤醒或挂 pending 搭车 */
  onCompletionNotify(sessionId: string, text: string): void;
}

const fmtDuration = (ms: number): string => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
};

/**
 * 后台任务管理（grok-build 对齐）：detached 进程组、内存环形+磁盘全量双写、
 * 结束自动通知（幂等抑制）、阻塞等待、配额与护栏。
 */
export class BackgroundTaskManager {
  private tasks = new Map<string, Task>();
  private counter = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly events: TaskEvents,
    private readonly logDir: string
  ) {}

  start(sessionId: string, command: string, cwd: string): string {
    // 配额：先清理已完成，再满则拒绝并教模型下一步
    if (this.tasks.size >= MAX_TASKS) this.pruneFinished();
    if (this.tasks.size >= MAX_TASKS) {
      throw new Error(
        `Too many background tasks (limit ${MAX_TASKS}). Stop one with task_stop first. ` +
          `Known task ids: [${[...this.tasks.keys()].join(', ')}]`
      );
    }
    const taskId = `task-${++this.counter}-${Date.now().toString(36)}`;
    // detached：独立进程组，kill 时整棵树一起清
    const child = spawn(command, { shell: true, cwd, env: process.env, detached: true });
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
      child,
      output: '',
      dirty: false,
      logPath,
      logStream,
      consumed: false,
      killedByUser: false,
      waiters: [],
      info: { taskId, command, status: 'running', tail: '', startedAt: Date.now() },
    };
    this.tasks.set(taskId, task);
    const append = (chunk: Buffer) => {
      task.output = (task.output + chunk.toString()).slice(-MAX_BUFFER);
      task.dirty = true;
      task.logStream?.write(chunk);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (error) => {
      task.output += `\n[spawn error] ${error.message}`;
      this.finish(task, 'failed');
    });
    child.on('exit', (code, signal) => {
      if (task.info.status !== 'running') return;
      if (signal) task.output += `\n[terminated by ${signal}]`;
      this.finish(task, code === 0 ? 'done' : 'failed', code ?? undefined);
    });
    this.events.onStarted(sessionId, { ...task.info });
    this.ensureTimer();
    return taskId;
  }

  private pruneFinished(): void {
    for (const [taskId, task] of this.tasks) {
      if (task.info.status !== 'running') {
        task.logStream?.end();
        this.tasks.delete(taskId);
      }
    }
  }

  private finish(task: Task, status: 'done' | 'failed', exitCode?: number): void {
    task.info.status = status;
    task.info.exitCode = exitCode;
    task.info.tail = task.output.slice(-TAIL_LIMIT);
    task.logStream?.end();
    // 有阻塞等待者 = 结束态将经工具返回值送达模型（blockWaited 语义），无需再通知
    const hadWaiters = task.waiters.length > 0;
    if (hadWaiters) task.consumed = true;
    for (const wake of task.waiters.splice(0)) wake();
    this.events.onOutput(task.sessionId, task.info.taskId, task.info.tail, status);
    this.events.onEnded(task.sessionId, task.info.taskId, status, exitCode);
    // 幂等抑制：模型已知情（阻塞等到 / 自己停的且收到回执）就不再打扰
    if (!task.consumed) {
      this.events.onCompletionNotify(task.sessionId, this.completionText(task));
    }
  }

  private completionText(task: Task): string {
    const { taskId, command, exitCode, status, startedAt } = task.info;
    const outcome = exitCode !== undefined ? `exit ${exitCode}` : status;
    const lines = [
      `Background task ${taskId} finished (${outcome}, ran ${fmtDuration(Date.now() - startedAt)}).`,
      `Command: ${command}`,
    ];
    if (task.killedByUser) {
      lines.push('This task was stopped by the user — do not restart it.');
    }
    lines.push(
      `Use task_output("${taskId}") for the full output, or read ${task.logPath} for the complete log.`
    );
    return lines.join('\n');
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
    timeoutMs = 0
  ): Promise<{ status: string; output: string; exitCode?: number; logPath: string } | null> {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    if (timeoutMs > 0 && task.info.status === 'running') {
      const wait = Math.min(timeoutMs, MAX_WAIT_MS);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        task.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (task.info.status !== 'running') task.consumed = true;
    return {
      status: task.info.status,
      output: task.output,
      exitCode: task.info.exitCode,
      logPath: task.logPath,
    };
  }

  /** 终止：SIGTERM 整个进程组，宽限后 SIGKILL */
  stop(taskId: string, byUser = false): boolean {
    const task = this.tasks.get(taskId);
    if (task?.info.status !== 'running') return false;
    if (byUser) task.killedByUser = true;
    else task.consumed = true; // 模型自己停的：kill 回执即知情，不再通知
    const pid = task.child.pid;
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        if (pid) process.kill(-pid, signal);
        else task.child.kill(signal);
      } catch {
        task.child.kill(signal);
      }
    };
    signalGroup('SIGTERM');
    setTimeout(() => {
      if (task.info.status === 'running') signalGroup('SIGKILL');
    }, KILL_GRACE_MS).unref?.();
    return true;
  }

  knownIds(): string[] {
    return [...this.tasks.keys()];
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

/** 前台命令尾部 & 检测：引导改用 background 参数 */
const TRAILING_AMP = /(?:^|[^&])&\s*$/;

/** 前台 bash 默认超时（秒）。background=true 不限。 */
export const DEFAULT_FOREGROUND_BASH_TIMEOUT_SEC = 10 * 60;

export function withForegroundBashTimeout(params: unknown): Record<string, unknown> {
  const record =
    params && typeof params === 'object' && !Array.isArray(params)
      ? { ...(params as Record<string, unknown>) }
      : {};
  if (record.background === true) return record;
  if (typeof record.timeout === 'number' && Number.isFinite(record.timeout) && record.timeout > 0) {
    return record;
  }
  return { ...record, timeout: DEFAULT_FOREGROUND_BASH_TIMEOUT_SEC };
}

/** bash 加 background 能力：background=true 时 detach 运行立即返回 taskId */
export function withBackground(
  definition: ToolDefinition,
  manager: BackgroundTaskManager,
  sessionId: string,
  cwd: string,
  /** 远程会话：把远端命令变换成本地可 spawn 的 ssh 命令(manager 本体始终本地 spawn) */
  transform?: (command: string, cwd: string) => { command: string; cwd: string }
): ToolDefinition {
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
          `Timeout in seconds (default ${DEFAULT_FOREGROUND_BASH_TIMEOUT_SEC} for foreground; ` +
          'no timeout when background=true)',
      },
      background: {
        type: 'boolean',
        description:
          'Run in the background and return immediately with a task id. ' +
          'Use for long-running commands (dev servers, watchers, long builds). ' +
          'You will be notified automatically when it finishes — do not poll or sleep-wait.',
      },
    },
  } as ToolDefinition['parameters'];
  return {
    ...definition,
    parameters,
    promptSnippet:
      'bash: run shell commands; pass background=true for long-running commands ' +
      `(dev servers, watchers, long builds). Foreground default timeout ${DEFAULT_FOREGROUND_BASH_TIMEOUT_SEC}s.`,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const record = params as { command?: string; background?: boolean };
      if (record.background && typeof record.command === 'string') {
        const launch = transform
          ? transform(record.command, cwd)
          : { command: record.command, cwd };
        const taskId = manager.start(sessionId, launch.command, launch.cwd);
        return {
          content: [
            {
              type: 'text',
              text:
                `Started background task ${taskId}. You will be notified when it finishes; ` +
                `continue with other work. task_output("${taskId}") shows a snapshot, task_stop("${taskId}") stops it.`,
            },
          ],
          details: undefined,
        };
      }
      if (typeof record.command === 'string' && TRAILING_AMP.test(record.command.trim())) {
        throw new Error(
          'Do not use a trailing "&" to background a foreground command — ' +
            'set background: true on this tool instead, which tracks the process and notifies you on completion.'
        );
      }
      return definition.execute(
        toolCallId,
        withForegroundBashTimeout(params),
        signal,
        onUpdate,
        ctx
      );
    },
  };
}

/** task_output / task_stop 工具（免审） */
export function createTaskTools(manager: BackgroundTaskManager): ToolDefinition[] {
  return [
    {
      name: 'task_output',
      label: 'Task output',
      description:
        'Read the output/status of a background task. Omit timeout_ms (or pass 0) for an instant snapshot; ' +
        `pass a positive timeout_ms to block until the task finishes (capped at ${MAX_WAIT_MS / 60000} minutes per call). ` +
        'Prefer one snapshot or one bounded wait — you are notified automatically on completion, do not poll.',
      promptSnippet: 'task_output: snapshot or bounded-wait a background task by id (no polling)',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Background task id' },
          timeout_ms: {
            type: 'number',
            description: `Block up to this many ms waiting for completion (max ${MAX_WAIT_MS})`,
          },
        },
        required: ['taskId'],
      } as unknown as ToolDefinition['parameters'],
      async execute(_id, params) {
        const { taskId = '', timeout_ms: timeoutMs } = params as {
          taskId?: string;
          timeout_ms?: number;
        };
        const requested = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 0;
        const result = await manager.read(taskId, requested);
        if (!result) {
          throw new Error(
            `unknown task: ${taskId}. Known task ids: [${manager.knownIds().join(', ')}]`
          );
        }
        const suffix = result.exitCode !== undefined ? ` (exit ${result.exitCode})` : '';
        const hint =
          result.status === 'running' && requested > 0
            ? '\n[Still running after the bounded wait. You do not need to call this again — you will be notified automatically when it completes.]'
            : '';
        return {
          content: [
            {
              type: 'text',
              text:
                `[${result.status}${suffix}] Full log: ${result.logPath}\n` +
                `${result.output.slice(-30_000) || '(no output yet)'}${hint}`,
            },
          ],
          details: undefined,
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
