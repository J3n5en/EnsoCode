import type { Delegation } from '../../../shared/types/bot';

/**
 * 私聊回退越过发起委派的回合：该会话在回退点（被裁掉的 user 消息时间）之后发起的委派，
 * 进行中的取消；连同已结束但未投递的结果一起作废（记为已投递，不再注入回退后的会话）。
 * 已投递的结果随被裁掉的分支一起离开上下文，不动。
 */
export function rewoundDelegations(
  records: readonly Delegation[],
  conversationId: string,
  since: number
): { cancel: string[]; discard: string[] } {
  const affected = records.filter(
    (record) =>
      record.parentConversationId === conversationId &&
      record.createdAt >= since &&
      record.deliveredAt === undefined
  );
  return {
    cancel: affected
      .filter((record) => record.state === 'queued' || record.state === 'running')
      .map((record) => record.id),
    discard: affected.map((record) => record.id),
  };
}

/**
 * 记忆水位（已整理到的 entry）落在被裁掉的部分时退到回退点前一条，回退到首条则清空；
 * 否则不变（undefined）。branch 为回退前当前分支的 entry id 序列。
 */
export function rewoundWatermark(
  branch: readonly string[],
  targetEntryId: string,
  watermark: string | undefined
): { next: string | null } | undefined {
  const target = branch.indexOf(targetEntryId);
  if (!watermark || target < 0) return undefined;
  const at = branch.indexOf(watermark);
  if (at < target) return undefined;
  return { next: target > 0 ? branch[target - 1] : null };
}
