/**
 * Main 侧的后台任务汇总：只旁路消费 worker 已有的 task-* / background-tasks-level / snapshot
 * 事件，不另起一套记录，也不改 worker 协议。秘书的 session_tasks 从这里取。
 *
 * 权威源仍是 worker 的 BackgroundTaskManager；这里只是它在 Main 的最近一次投影，
 * 因此进程存活只能报 worker 看门狗最近一次探测的结果（alive 缺省 = 还没探测）。
 */
import type { BackgroundTaskInfo, RendererAgentEvent } from '@shared/types/agent';

export interface ObservedTask {
  taskId: string;
  command: string;
  status: BackgroundTaskInfo['status'];
  startedAt: number;
  exitCode?: number;
  deadlineAt?: number;
  alive?: boolean;
}

const toObserved = (task: BackgroundTaskInfo): ObservedTask => ({
  taskId: task.taskId,
  command: task.command,
  status: task.status,
  startedAt: task.startedAt,
  ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }),
  ...(task.deadlineAt === undefined ? {} : { deadlineAt: task.deadlineAt }),
  ...(task.alive === undefined ? {} : { alive: task.alive }),
});

export class BackgroundTaskTracker {
  private readonly bySession = new Map<string, Map<string, ObservedTask>>();

  /** 会话最近一次已知的后台任务，按开始时间倒序 */
  tasks(sessionId: string): ObservedTask[] {
    const tasks = this.bySession.get(sessionId);
    if (!tasks) return [];
    return [...tasks.values()].sort(
      (left, right) => right.startedAt - left.startedAt || left.taskId.localeCompare(right.taskId)
    );
  }

  observe(event: RendererAgentEvent): void {
    if (event.type === 'snapshot') {
      for (const snapshot of event.sessions)
        this.replace(snapshot.identity.sessionId, snapshot.backgroundTasks ?? []);
      return;
    }
    if (!('identity' in event) || !event.identity) return;
    const sessionId = event.identity.sessionId;
    switch (event.type) {
      case 'task-started':
        this.put(sessionId, toObserved(event.task));
        break;
      case 'task-output': {
        // 输出只用来翻状态，正文不入库：秘书要的是"还活着吗"，不是日志
        const current = this.bySession.get(sessionId)?.get(event.taskId);
        if (current) this.put(sessionId, { ...current, status: event.status });
        break;
      }
      case 'task-ended': {
        const current = this.bySession.get(sessionId)?.get(event.taskId);
        if (!current) break;
        this.put(sessionId, {
          ...current,
          status: event.status,
          ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
        });
        break;
      }
      case 'background-tasks-level':
        this.replace(sessionId, event.tasks);
        break;
      default:
        break;
    }
  }

  private put(sessionId: string, task: ObservedTask): void {
    let tasks = this.bySession.get(sessionId);
    if (!tasks) {
      tasks = new Map();
      this.bySession.set(sessionId, tasks);
    }
    tasks.set(task.taskId, task);
  }

  private replace(sessionId: string, tasks: readonly BackgroundTaskInfo[]): void {
    const next = new Map<string, ObservedTask>();
    for (const task of tasks) next.set(task.taskId, toObserved(task));
    if (next.size === 0) this.bySession.delete(sessionId);
    else this.bySession.set(sessionId, next);
  }
}
