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
  /** worker 标的疑似闲置 */
  suspectedIdle?: true;
  /** agent 或用户留下运行 */
  kept?: true;
  /** 子代理起的任务：所属子会话 id（只在 tasksInTree 里给出） */
  ownerSessionId?: string;
}

const toObserved = (task: BackgroundTaskInfo): ObservedTask => ({
  taskId: task.taskId,
  command: task.command,
  status: task.status,
  startedAt: task.startedAt,
  ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }),
  ...(task.deadlineAt === undefined ? {} : { deadlineAt: task.deadlineAt }),
  ...(task.alive === undefined ? {} : { alive: task.alive }),
  ...(task.idle ? { suspectedIdle: true as const } : {}),
  ...(task.keep ? { kept: true as const } : {}),
});

export class BackgroundTaskTracker {
  private readonly bySession = new Map<string, Map<string, ObservedTask>>();
  private hasReported = false;
  private readonly reportedListeners = new Set<() => void>();

  /**
   * worker 启动时已把认回的任务（含没打开的会话）全部报上来。在此之前空表只是「还不知道」，
   * 不能当成没有任务（应用刚启动、worker 还没起来时就是这样）。
   */
  reported(): boolean {
    return this.hasReported;
  }

  /** worker 的 ready 握手：认回任务的事件都排在它前面，到这里任务表才算全量 */
  markReported(): void {
    this.hasReported = true;
    for (const listener of this.reportedListeners) {
      try {
        listener();
      } catch (error) {
        console.warn('[bg-tasks] reported listener failed:', error);
      }
    }
  }

  onReported(listener: () => void): () => void {
    this.reportedListeners.add(listener);
    return () => this.reportedListeners.delete(listener);
  }

  /** 会话最近一次已知的后台任务，按开始时间倒序 */
  tasks(sessionId: string): ObservedTask[] {
    const tasks = this.bySession.get(sessionId);
    if (!tasks) return [];
    return [...tasks.values()].sort(byNewest);
  }

  /** 会话自己的加上它子代理（`${sessionId}::…`）起的后台任务，子代理的带 ownerSessionId */
  tasksInTree(sessionId: string): ObservedTask[] {
    const all: ObservedTask[] = [];
    for (const [owner, tasks] of this.bySession) {
      if (owner === sessionId) all.push(...tasks.values());
      else if (owner.startsWith(`${sessionId}::`))
        for (const task of tasks.values()) all.push({ ...task, ownerSessionId: owner });
    }
    return all.sort(byNewest);
  }

  /** 任一会话还有没结束的后台命令（回合结束了也可能还在跑） */
  hasRunning(): boolean {
    for (const tasks of this.bySession.values())
      for (const task of tasks.values()) if (task.status === 'running') return true;
    return false;
  }

  observe(event: RendererAgentEvent): void {
    if (event.type === 'snapshot') {
      for (const snapshot of event.sessions)
        this.replace(snapshot.identity.sessionId, snapshot.backgroundTasks ?? []);
      return;
    }
    if (event.type === 'unopened-background-tasks') {
      this.replace(event.sessionId, event.tasks);
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

function byNewest(left: ObservedTask, right: ObservedTask): number {
  return right.startedAt - left.startedAt || left.taskId.localeCompare(right.taskId);
}

/** worker 后台任务在 Main 的投影（ipc/agent 喂事件，秘书与退出前的安全点判断读它） */
export const backgroundTaskStates = new BackgroundTaskTracker();
