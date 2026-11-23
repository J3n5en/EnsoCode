import { queuedStartOf, queuePositions } from '@shared/secretary/queuedSession';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import { useI18n } from '@/i18n';
import { cancelQueuedSession, startQueuedSession } from '@/lib/queuedSessionApi';
import { useSessionsStore } from '@/stores/sessions';

function fileName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return path.slice(cut + 1) || path;
}

export function QueuedSessionButtons({
  conversationId,
  failed,
  starting = false,
}: {
  conversationId: string;
  failed: boolean;
  starting?: boolean;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const disabled = busy || starting;
  const start = () => {
    if (disabled) return;
    setBusy(true);
    setError(null);
    void startQueuedSession(conversationId)
      .then((result) => {
        if (!result.ok) setError(result.error);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => setBusy(false));
  };
  const cancel = () => {
    if (disabled) return;
    setBusy(true);
    setError(null);
    void cancelQueuedSession(conversationId)
      .then((result) => {
        if (!result.ok) setError(result.error);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => setBusy(false));
  };
  return (
    <>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          data-enso="queued-session-start"
          disabled={disabled}
          onClick={start}
          className="rounded-md bg-primary px-2.5 py-1 text-[12px] text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {t(failed ? 'Retry' : 'Start now')}
        </button>
        <button
          type="button"
          data-enso="queued-session-cancel"
          disabled={disabled}
          onClick={() => setConfirmCancel(true)}
          className="rounded-md px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          {t('Cancel queue')}
        </button>
      </div>
      {error && (
        <p data-enso="queued-session-error" className="text-[12px] text-destructive">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title={t('Cancel queue')}
        description={t('Cancel this queued session? It has not run and will be deleted.')}
        confirmLabel={t('Cancel queue')}
        onConfirm={cancel}
      />
    </>
  );
}

/** 打开尚未启动的排队会话：首条消息、位次，以及立即开始 / 取消。 */
export function QueuedSessionCard({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  // 选择器只取行上的原对象：queuedStartOf 每次返回新对象，放进选择器会无限重渲染
  const row = useSessionsStore((state) => state.conversations[conversationId]);
  const queued = queuedStartOf(row);
  const position = useSessionsStore((state) =>
    queuePositions(state.conversations).get(conversationId)
  );
  const sendError = useSessionsStore((state) => state.conversations[conversationId]?.error);
  if (!queued) return null;
  const failed = queued.failed?.error;
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto px-4 py-8">
      <div
        data-enso="queued-session-card"
        data-conversation-id={conversationId}
        className="flex w-full max-w-lg flex-col gap-3 rounded-xl border bg-card px-4 py-3.5 text-left shadow-xs"
      >
        <p className="text-[13px] font-medium text-orange-600">
          {failed ? t('Queued') : t('Queued · #{{n}}', { n: position ?? 1 })}
        </p>
        {failed && <p className="text-[12.5px] text-destructive">{failed}</p>}
        {queued.goal && (
          <p className="text-[12.5px] text-muted-foreground">
            <span className="text-subtle-foreground">{t('Goal')}</span> {queued.goal}
          </p>
        )}
        <p className="whitespace-pre-wrap break-words text-[14px]">{queued.text}</p>
        {queued.attachments && queued.attachments.length > 0 && (
          <ul className="text-[12px] text-muted-foreground">
            {queued.attachments.map((path) => (
              <li key={path}>{fileName(path)}</li>
            ))}
          </ul>
        )}
        {queued.startingAt !== undefined && (
          <p className="text-[12px] text-muted-foreground">{t('Starting…')}</p>
        )}
        {sendError && !failed && <p className="text-[12px] text-destructive">{sendError}</p>}
        <QueuedSessionButtons
          conversationId={conversationId}
          failed={Boolean(failed)}
          starting={queued.startingAt !== undefined}
        />
      </div>
    </div>
  );
}
