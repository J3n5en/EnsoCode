import { queuedStartOf } from '@shared/secretary/queuedSession';
import type { DispatchRecord, SecretaryArchiveVia } from '@shared/types/secretary';
import type { ObservedTask } from '../backgroundTaskTracker';
import type { SecretarySessionStatus } from './readers';

/**
 * 秘书派出的会话报了 goal-complete、已经空闲、没有待处理项：可以自动归档（后台任务另由 liveTasks 判）。
 * 接管来的、用户已归档的、手动标记完成的都不算；同一次结果只归档一次，用户取消归档后不再收走。
 */
export function autoArchivable(
  record: DispatchRecord,
  row: Record<string, unknown> | undefined,
  status: SecretarySessionStatus,
  /** 还挂着自定提醒：会话会被它叫醒，先不收走 */
  reminderPending = false
): boolean {
  if (!row || row.archived === true) return false;
  // 排队会话还没开始，谈不上收口
  if (queuedStartOf(row)) return false;
  if (row.secretaryOrigin === undefined || record.takeover) return false;
  const result = record.lastResult;
  if (result?.kind !== 'goal-complete' || result.manual) return false;
  if (record.autoArchiveResultAt === result.at) return false;
  if (status.state !== 'idle' || status.pendingAsks + status.pendingApprovals > 0) return false;
  if (record.backgroundRunning || record.reopenedAt !== undefined) return false;
  if (reminderPending) return false;
  return true;
}

/** 还没结束的后台任务：常驻、保留、疑似闲置、看门狗报进程不在但还没收尾的都算 */
export function liveTasks(tasks: readonly ObservedTask[]): ObservedTask[] {
  return tasks.filter((task) => task.status === 'running');
}

/** 会话现在的归档是不是 Main 自动做的：归档时刻对得上才算，用户手动归档的永远对不上 */
export function autoArchived(
  record: DispatchRecord,
  row: Record<string, unknown> | undefined
): boolean {
  return (
    row?.archived === true &&
    record.autoArchivedAt !== undefined &&
    row.archivedAt === record.autoArchivedAt
  );
}

/**
 * 当前这次归档是谁做的。secretaryArchived.at 必须是数字且等于会话行 archivedAt；
 * 时刻缺失时 undefined === undefined 不算。对不上再认旧版自动归档，否则是用户的。
 */
export function archivedBySecretary(
  record: DispatchRecord,
  row: Record<string, unknown> | undefined
): SecretaryArchiveVia | 'auto' | null {
  if (row?.archived !== true) return null;
  const mark = record.secretaryArchived;
  if (mark && typeof mark.at === 'number' && row.archivedAt === mark.at) return mark.via;
  return autoArchived(record, row) ? 'auto' : null;
}
