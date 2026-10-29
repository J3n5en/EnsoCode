import { type ApprovalReviewReason, parseApprovalReviewRecord } from '@shared/approvalReviewRecord';
import { useI18n } from '@/i18n';

export const APPROVAL_REVIEW_REASON_LABELS: Record<ApprovalReviewReason, string> = {
  read_only: 'Read-only',
  regenerable: 'Regenerable output',
  reversible_workspace_change: 'Reversible workspace change',
  data_loss: 'Possible data loss',
  system_state: 'Changes system state',
  exfiltration: 'Sends data externally',
  unclear_target: 'Unclear target or intent',
};

/** 工具卡片 footer：托管代审的判定（模型、三档概率、理由），历史恢复同样可见 */
export function ApprovalReviewBar({ value }: { value: unknown }) {
  const record = parseApprovalReviewRecord(value);
  const { t } = useI18n();
  if (!record) return null;
  const odds = `allow ${record.allow.toFixed(2)} · ask ${record.ask.toFixed(2)} · block ${record.block.toFixed(2)}`;
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1.5 border-border/60 border-t px-3 py-1 text-[10px] text-muted-foreground"
      data-approval-review={record.verdict}
    >
      <span className="font-semibold tracking-wide text-foreground/75">
        {record.verdict === 'allow' ? t('Auto-managed · allowed') : t('Auto-managed · denied')}
      </span>
      <span aria-hidden="true">·</span>
      <span className="font-mono">{record.model}</span>
      <span aria-hidden="true">·</span>
      <span className="font-mono">{odds}</span>
      {record.reason && (
        <>
          <span aria-hidden="true">·</span>
          <span>
            {t('Reason')}: {t(APPROVAL_REVIEW_REASON_LABELS[record.reason])}
          </span>
        </>
      )}
    </div>
  );
}
