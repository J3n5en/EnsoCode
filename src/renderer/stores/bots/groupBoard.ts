import type { BotRoutine, Delegation, GroupTask, GroupTaskStatus } from '@shared/types/bot';
import { isActiveDelegation } from './delegations';

/** 看板分栏：待办 / 进行中按编号，已完成 / 已取消新的在前 */
export function taskColumns(tasks: readonly GroupTask[]): Record<GroupTaskStatus, GroupTask[]> {
  const columns: Record<GroupTaskStatus, GroupTask[]> = {
    todo: [],
    doing: [],
    done: [],
    canceled: [],
  };
  for (const task of tasks) columns[task.status].push(task);
  columns.todo.sort((a, b) => a.seq - b.seq);
  columns.doing.sort((a, b) => a.seq - b.seq);
  columns.done.sort((a, b) => b.updatedAt - a.updatedAt);
  columns.canceled.sort((a, b) => b.updatedAt - a.updatedAt);
  return columns;
}

/** 本群的例行任务（跨成员） */
export function chatRoutines(routines: readonly BotRoutine[], chatId: string): BotRoutine[] {
  return routines
    .filter((routine) => routine.chatId === chatId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

const finished = (item: Delegation) => item.finishedAt ?? item.createdAt;

/** 本群委派汇总：进行中（先发起的在前）/ 已完成 / 失败·中断·取消（新的在前） */
export function chatDelegationGroups(
  delegations: readonly Delegation[],
  chatId: string
): { active: Delegation[]; completed: Delegation[]; failed: Delegation[] } {
  const mine = delegations.filter((item) => item.chatId === chatId);
  return {
    active: mine
      .filter((item) => isActiveDelegation(item.state))
      .sort((a, b) => a.createdAt - b.createdAt),
    completed: mine
      .filter((item) => item.state === 'completed')
      .sort((a, b) => finished(b) - finished(a)),
    failed: mine
      .filter((item) => item.state === 'failed' || item.state === 'canceled')
      .sort((a, b) => finished(b) - finished(a)),
  };
}
