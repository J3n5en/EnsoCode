import type { BackgroundTaskInfo, SubagentInfo } from '@shared/types/agent';

/**
 * 后台任务 / subagent 的事件投影（与桌面 sessions/reducer 同语义）：
 * task-started 去重追加、task-output 覆盖 tail、task-ended 写终态、
 * subagent-update 按 id 覆盖式 upsert。纯函数，client 收 agent-event 时调用。
 */

export interface TaskState {
  tasks: BackgroundTaskInfo[];
  subagents: SubagentInfo[];
}

/** 返回 null 表示事件与任务投影无关（或字段缺失），调用方跳过更新 */
export function applyTaskEvent(state: TaskState, event: Record<string, unknown>): TaskState | null {
  switch (event.type) {
    case 'task-started': {
      const task = event.task as BackgroundTaskInfo | undefined;
      if (!task || typeof task.taskId !== 'string') return null;
      if (state.tasks.some((t) => t.taskId === task.taskId)) return state;
      return { ...state, tasks: [...state.tasks, task] };
    }
    case 'task-output': {
      const taskId = event.taskId as string | undefined;
      if (!taskId) return null;
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          t.taskId === taskId
            ? {
                ...t,
                tail: event.tail as string,
                status: event.status as BackgroundTaskInfo['status'],
              }
            : t
        ),
      };
    }
    case 'task-ended': {
      const taskId = event.taskId as string | undefined;
      if (!taskId) return null;
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          t.taskId === taskId
            ? {
                ...t,
                status: event.status as BackgroundTaskInfo['status'],
                exitCode: event.exitCode as number | undefined,
              }
            : t
        ),
      };
    }
    case 'subagent-update': {
      const agent = event.agent as SubagentInfo | null | undefined;
      if (!agent || typeof agent.id !== 'string') return null;
      const exists = state.subagents.some((a) => a.id === agent.id);
      return {
        ...state,
        subagents: exists
          ? state.subagents.map((a) => (a.id === agent.id ? agent : a))
          : [...state.subagents, agent],
      };
    }
    default:
      return null;
  }
}
