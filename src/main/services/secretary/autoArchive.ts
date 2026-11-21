import type { DispatchRecord } from '@shared/types/secretary';
import type { ObservedTask } from '../backgroundTaskTracker';
import type { SecretarySessionStatus } from './readers';

/**
 * 秘书派出的会话报了 goal-complete、已经空闲、没有待处理项也没有在跑的后台任务：可以自动归档。
 * 接管来的、用户已归档的、手动标记完成的都不算；同一次结果只归档一次，用户取消归档后不再收走。
 */
export function autoArchivable(
  record: DispatchRecord,
  row: Record<string, unknown> | undefined,
  status: SecretarySessionStatus,
  tasks: readonly ObservedTask[]
): boolean {
  if (!row || row.archived === true) return false;
  if (row.secretaryOrigin === undefined || record.takeover) return false;
  const result = record.lastResult;
  if (result?.kind !== 'goal-complete' || result.manual) return false;
  if (record.autoArchiveResultAt === result.at) return false;
  if (status.state !== 'idle' || status.pendingAsks + status.pendingApprovals > 0) return false;
  if (record.backgroundRunning || record.reopenedAt !== undefined) return false;
  return !tasks.some((task) => task.status === 'running' && task.alive !== false);
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
