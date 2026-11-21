import type { BackgroundTaskInfo } from '@shared/types/agent';

export interface TaskSource {
  title?: string;
  projectId?: string;
  /** worker 这一代已 spawn 过的会话才有 */
  generation?: string;
  lastActiveAt?: number;
  createdAt?: number;
  backgroundTasks?: readonly BackgroundTaskInfo[];
}

export interface TaskGroup {
  conversationId: string;
  title: string;
  projectId?: string;
  unopened: boolean;
  tasks: BackgroundTaskInfo[];
}

export const isIdleTask = (task: BackgroundTaskInfo): boolean =>
  task.status === 'running' && task.idle !== undefined;

/** 按会话分组的在跑任务，最近活跃的会话在前 */
export function collectTaskGroups(
  conversations: Record<string, TaskSource | undefined>
): TaskGroup[] {
  const groups: (TaskGroup & { at: number })[] = [];
  for (const [conversationId, conversation] of Object.entries(conversations)) {
    const tasks = (conversation?.backgroundTasks ?? []).filter((task) => task.status === 'running');
    if (!conversation || tasks.length === 0) continue;
    groups.push({
      conversationId,
      title: conversation.title ?? '',
      ...(conversation.projectId ? { projectId: conversation.projectId } : {}),
      unopened: !conversation.generation,
      tasks: [...tasks].sort((a, b) => a.startedAt - b.startedAt),
      at: conversation.lastActiveAt ?? conversation.createdAt ?? 0,
    });
  }
  return groups.sort((a, b) => b.at - a.at).map(({ at: _at, ...group }) => group);
}

/** 侧栏与总览的计数：running 不含疑似闲置 */
export function countTasks(tasks: readonly BackgroundTaskInfo[] | undefined): {
  running: number;
  idle: number;
} {
  let running = 0;
  let idle = 0;
  for (const task of tasks ?? []) {
    if (task.status !== 'running') continue;
    if (isIdleTask(task)) idle += 1;
    else running += 1;
  }
  return { running, idle };
}

export const selectionKey = (conversationId: string, taskId: string): string =>
  `${conversationId}\u0000${taskId}`;

export interface StopTarget {
  conversationId: string;
  taskId: string;
  command: string;
  sessionTitle: string;
  unopened: boolean;
}

/** 批量停止要确认的清单：只认还在跑的、已勾选的任务（含未打开会话） */
export function stopTargets(
  groups: readonly TaskGroup[],
  selected: ReadonlySet<string>
): StopTarget[] {
  return groups.flatMap((group) =>
    group.tasks
      .filter((task) => selected.has(selectionKey(group.conversationId, task.taskId)))
      .map((task) => ({
        conversationId: group.conversationId,
        taskId: task.taskId,
        command: task.command,
        sessionTitle: group.title,
        unopened: group.unopened,
      }))
  );
}
