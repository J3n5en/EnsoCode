/** 托管代审理由的固定分类：只用于展示与交回模型，不参与判定 */
export const APPROVAL_REVIEW_REASONS = [
  'read_only',
  'regenerable',
  'reversible_workspace_change',
  'data_loss',
  'system_state',
  'exfiltration',
  'unclear_target',
] as const;
export type ApprovalReviewReason = (typeof APPROVAL_REVIEW_REASONS)[number];

/** 托管判定失败、退回人工的原因 */
export type ApprovalReviewFallback = 'timeout' | 'error' | 'invalid';
export const APPROVAL_REVIEW_FALLBACKS: readonly ApprovalReviewFallback[] = [
  'timeout',
  'error',
  'invalid',
];

/** 托管判定记录：写进工具结果 details，投影到工具卡片与会话历史 */
export interface ApprovalReviewRecord {
  verdict: 'allow' | 'deny';
  model: string;
  allow: number;
  ask: number;
  block: number;
  reason?: ApprovalReviewReason;
}

const MODEL_MAX = 200;

export function isApprovalReviewReason(value: unknown): value is ApprovalReviewReason {
  return (APPROVAL_REVIEW_REASONS as readonly unknown[]).includes(value);
}

export function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function parseApprovalReviewRecord(value: unknown): ApprovalReviewRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { verdict, model, allow, ask, block, reason } = value as Record<string, unknown>;
  if (
    (verdict !== 'allow' && verdict !== 'deny') ||
    typeof model !== 'string' ||
    !model ||
    model.length > MODEL_MAX ||
    !isProbability(allow) ||
    !isProbability(ask) ||
    !isProbability(block) ||
    (reason !== undefined && !isApprovalReviewReason(reason))
  )
    return undefined;
  return { verdict, model, allow, ask, block, ...(reason ? { reason } : {}) };
}
