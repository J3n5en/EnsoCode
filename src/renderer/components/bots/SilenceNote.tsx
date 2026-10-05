import { useEffect, useState } from 'react';
import { useI18n } from '@/i18n';
import { useBotsStore } from '@/stores/bots';
import { quietSeconds, silenceOf } from '@/stores/bots/silence';

/** 每秒刷新的「已安静 X 秒」；只是提示，不中断成员 */
export function QuietFor({ since }: { since: number }) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <>{t('Quiet for {{n}}s', { n: quietSeconds(since, now) })}</>;
}

/** 会话处于静默时显示；否则不渲染 */
export function SilenceNote({
  conversationId,
  className,
}: {
  conversationId: string | undefined;
  className?: string;
}) {
  const since = useBotsStore((s) => silenceOf(s.silences, conversationId)?.since);
  if (since === undefined) return null;
  return (
    <span className={className ?? 'shrink-0 text-warning'}>
      <QuietFor since={since} />
    </span>
  );
}
