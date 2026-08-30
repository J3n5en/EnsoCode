import { RefreshCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useI18n } from '@/i18n';

export interface RetryInfo {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  error: string;
  at: number;
}

/**
 * 自动重试状态条（非终态）：瞬态错误后 pi 正在退避重试。
 * 显示 (n/m) 与倒计时；onCancel 可选（取消 = 立即落终态失败，由用户接管；
 * 手机第二屏无 abort-retry 通道，不传则不渲染按钮）。
 */
export function RetryBar({ retry, onCancel }: { retry: RetryInfo; onCancel?: () => void }) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);

  const remainingSeconds = Math.max(0, Math.ceil((retry.at + retry.delayMs - now) / 1000));

  return (
    <div className="mb-1 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs">
      <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-500 [animation-duration:2s]" />
      <span className="min-w-0 flex-1 truncate" title={retry.error}>
        {t('Auto-retrying ({{attempt}}/{{max}})', {
          attempt: retry.attempt,
          max: retry.maxAttempts,
        })}
        <span className="text-muted-foreground">
          {' · '}
          {remainingSeconds > 0
            ? t('retrying in {{seconds}}s', { seconds: remainingSeconds })
            : t('retrying…')}
          {' — '}
          {retry.error}
        </span>
      </span>
      {onCancel && (
        <button
          type="button"
          title={t('Cancel auto-retry')}
          onClick={onCancel}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
