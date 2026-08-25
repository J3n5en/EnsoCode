import { spawn } from 'node:child_process';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { BackgroundTaskInfo } from '@shared/types/agent';

/** 输出缓冲上限（超出截头保尾） */
const MAX_BUFFER = 200_000;
/** 下发的尾部快照上限 */
const TAIL_LIMIT = 8_000;
/** 输出事件节流 */
const EMIT_INTERVAL_MS = 500;

interface Task {
  info: BackgroundTaskInfo;
  sessionId: string;
  child: ReturnType<typeof spawn>;
  output: string;
  dirty: boolean;
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
}

/**
 * 后台任务管理：命令 detach 于 agent 轮运行，输出累积并以尾部快照节流下发。
 * 会话 abort 不终止任务（dev server 场景）；stopSession/stopAll 收尾。
 */
export class BackgroundTaskManager {
  private tasks = new Map<string, Task>();
  private counter = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly events: TaskEvents) {}

  start(sessionId: string, command: string, cwd: string): string {
    const taskId = `task-${++this.counter}`;
    const child = spawn(command, { shell: true, cwd, env: process.env });
    const task: Task = {
      sessionId,
      child,
      output: '',
      dirty: false,
      info: { taskId, command, status: 'running', tail: '', startedAt: Date.now() },
    };
    this.tasks.set(taskId, task);
    const append = (chunk: Buffer) => {
      task.output = (task.output + chunk.toString()).slice(-MAX_BUFFER);
      task.dirty = true;
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (error) => {
      task.output += `\n[spawn error] ${error.message}`;
      this.finish(task, 'failed');
    });
    child.on('exit', (code) => {
      if (task.info.status !== 'running') return;
      this.finish(task, code === 0 ? 'done' : 'failed', code ?? undefined);
    });
    this.events.onStarted(sessionId, { ...task.info });
    this.ensureTimer();
    return taskId;
  }

  private finish(task: Task, status: 'done' | 'failed', exitCode?: number): void {
    task.info.status = status;
    task.info.exitCode = exitCode;
    task.info.tail = task.output.slice(-TAIL_LIMIT);
    this.events.onOutput(task.sessionId, task.info.taskId, task.info.tail, status);
    this.events.onEnded(task.sessionId, task.info.taskId, status, exitCode);
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

  /** task_output 工具：全量输出（截尾于缓冲上限） */
  read(taskId: string): { status: string; output: string; exitCode?: number } | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    return { status: task.info.status, output: task.output, exitCode: task.info.exitCode };
  }

  stop(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.info.status !== 'running') return false;
    task.child.kill('SIGTERM');
    return true;
  }

  snapshot(sessionId: string): BackgroundTaskInfo[] {
    return [...this.tasks.values()]
      .filter((task) => task.sessionId === sessionId)
      .map((task) => ({ ...task.info, tail: task.output.slice(-TAIL_LIMIT) }));
  }

  stopAll(): void {
    for (const task of this.tasks.values()) {
      if (task.info.status === 'running') task.child.kill('SIGTERM');
    }
  }
}

/** bash 加 background 能力：background=true 时 detach 运行立即返回 taskId */
export function withBackground(
  definition: ToolDefinition,
  manager: BackgroundTaskManager,
  sessionId: string,
  cwd: string
): ToolDefinition {
  const baseParams = definition.parameters as unknown as {
    properties?: Record<string, unknown>;
    [key: string]: unknown;
  };
  const parameters = {
    ...baseParams,
    properties: {
      ...baseParams.properties,
      background: {
        type: 'boolean',
        description:
          'Run in the background and return immediately with a task id. ' +
          'Use for long-running commands (dev servers, watchers, builds you want to poll). ' +
          'Check progress with task_output, stop with task_stop.',
      },
    },
  } as ToolDefinition['parameters'];
  return {
    ...definition,
    parameters,
    promptSnippet:
      'bash: run shell commands; pass background=true for long-running commands ' +
      '(dev servers, watchers) to get a task id immediately instead of blocking',
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const record = params as { command?: string; background?: boolean };
      if (record.background && typeof record.command === 'string') {
        const taskId = manager.start(sessionId, record.command, cwd);
        return {
          content: [
            {
              type: 'text',
              text: `Started background task ${taskId}. Use task_output("${taskId}") to check progress, task_stop("${taskId}") to stop.`,
            },
          ],
          details: undefined,
        };
      }
      return definition.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

/** task_output / task_stop 工具（免审） */
export function createTaskTools(manager: BackgroundTaskManager): ToolDefinition[] {
  const idParam = {
    type: 'object',
    properties: { taskId: { type: 'string', description: 'Background task id' } },
    required: ['taskId'],
  } as unknown as ToolDefinition['parameters'];
  return [
    {
      name: 'task_output',
      label: 'Task output',
      description: 'Read the accumulated output and status of a background task.',
      promptSnippet: 'task_output: check output/status of a background task by id',
      parameters: idParam,
      async execute(_id, params) {
        const taskId = (params as { taskId?: string }).taskId ?? '';
        const result = manager.read(taskId);
        if (!result) throw new Error(`unknown task: ${taskId}`);
        const suffix = result.exitCode !== undefined ? ` (exit ${result.exitCode})` : '';
        return {
          content: [
            {
              type: 'text',
              text: `[${result.status}${suffix}]\n${result.output.slice(-30_000) || '(no output yet)'}`,
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
      parameters: idParam,
      async execute(_id, params) {
        const taskId = (params as { taskId?: string }).taskId ?? '';
        const stopped = manager.stop(taskId);
        return {
          content: [
            { type: 'text', text: stopped ? `Stopped ${taskId}` : `${taskId} is not running` },
          ],
          details: undefined,
        };
      },
    },
  ];
}
