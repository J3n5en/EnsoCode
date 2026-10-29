import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import type { ApprovalReviewRecord } from '@shared/approvalReviewRecord';

const LIMIT = 200;
const records = new Map<string, ApprovalReviewRecord>();

/** 托管判定按工具调用 id 暂存，工具结果出来时并进 details */
export function rememberApprovalReview(toolCallId: string, record: ApprovalReviewRecord): void {
  records.delete(toolCallId);
  records.set(toolCallId, record);
  while (records.size > LIMIT) records.delete(records.keys().next().value as string);
}

export function takeApprovalReview(toolCallId: string): ApprovalReviewRecord | undefined {
  const record = records.get(toolCallId);
  records.delete(toolCallId);
  return record;
}

/** 放行或拒绝的工具结果都带上托管判定记录（模型、三档概率、理由），写进会话历史 */
export const approvalReviewResultExtension: InlineExtension = {
  name: 'approval-review-result',
  hidden: true,
  factory: (pi) => {
    pi.on('tool_result', (event) => {
      const record = takeApprovalReview(event.toolCallId);
      if (!record) return;
      const details =
        event.details && typeof event.details === 'object' && !Array.isArray(event.details)
          ? event.details
          : {};
      return { details: { ...details, approvalReview: record } };
    });
  },
};
