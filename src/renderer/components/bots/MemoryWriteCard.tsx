import type { PendingMemoryWriteDto } from '@shared/memory/dto';
import type { BotProfile } from '@shared/types/bot';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { usePendingMemoryWritesStore } from '@/stores/memoryReview';
import { BotAvatar } from './BotAvatar';

/** 收件箱：成员写项目 / 全局记忆的待审批卡片；批准后才真正写入 */
export function MemoryWriteCard({
  write,
  bot,
  chatName,
}: {
  write: PendingMemoryWriteDto;
  bot: BotProfile | undefined;
  chatName: string;
}) {
  const { t } = useI18n();
  const review = usePendingMemoryWritesStore((s) => s.review);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = (decision: 'approve' | 'reject') => {
    setBusy(true);
    setError(null);
    void review(write.id, decision)
      .then((result) => {
        if (!result.ok) setError(result.error ?? t('Failed'));
      })
      .finally(() => setBusy(false));
  };
  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <BotAvatar bot={bot} size="sm" />
        <span className="text-foreground">{bot?.name ?? t('Deleted member')}</span>
        {chatName && <span>· {chatName}</span>}
        <span className="rounded bg-warning/20 px-1.5 text-[11px] text-warning">
          {t('Memory write')}
        </span>
        <span>→ {write.spaceLabel}</span>
        {write.redacted && <span>· {t('Secrets redacted')}</span>}
      </div>
      {write.title && <div className="mt-2 font-medium text-sm">{write.title}</div>}
      <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-muted/60 px-2 py-1.5 text-xs">
        {write.content}
      </pre>
      {error && <div className="mt-1 text-destructive text-xs">{error}</div>}
      <div className="mt-2.5 flex flex-wrap items-center justify-end gap-1.5">
        <Button size="xs" variant="outline" disabled={busy} onClick={() => decide('reject')}>
          {t('Reject')}
        </Button>
        <Button size="xs" disabled={busy} onClick={() => decide('approve')}>
          {t('Approve')}
        </Button>
      </div>
    </div>
  );
}
