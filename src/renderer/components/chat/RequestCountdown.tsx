import { useEffect, useState } from 'react';
import { useI18n } from '@/i18n';

/** 距截止的剩余毫秒，每秒刷新；clockOffset = 本机时钟 − host 时钟（手机伴侣） */
export function useRemainingMs(expiresAt: number | undefined, clockOffset = 0): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  return expiresAt === undefined ? undefined : expiresAt + clockOffset - now;
}

/** 卡片角上的剩余时间；到点显示超时文案（Main 随后按超时收尾并移除卡片） */
export function RequestCountdown({
  remainingMs,
  expiredLabel,
}: {
  remainingMs: number | undefined;
  expiredLabel: string;
}) {
  const { t } = useI18n();
  if (remainingMs === undefined) return null;
  if (remainingMs <= 0)
    return <span className="shrink-0 text-[10px] text-warning">{t(expiredLabel)}</span>;
  const seconds = Math.ceil(remainingMs / 1000);
  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return (
    <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
      {t('{{time}} left', { time })}
    </span>
  );
}
