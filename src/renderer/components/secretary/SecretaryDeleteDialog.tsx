import type { SecretaryDeletePreview } from '@shared/types/secretary';
import { Loader2 } from 'lucide-react';
import * as React from 'react';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';

function PreviewList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-0.5">
      <p className="text-xs font-medium">{title}</p>
      <ul className="max-h-24 overflow-y-auto text-xs text-muted-foreground">
        {items.map((item) => (
          <li key={item} className="truncate">
            · {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 删除秘书：第一步列出它在管的会话、待办、定时、联系方式绑定与记忆；
 * 第二步再确认一次才真正删除。Main 只接受带二次确认标记的删除。
 */
export function SecretaryDeleteDialog({
  open,
  secretaryId,
  onOpenChange,
  onDeleted,
}: {
  open: boolean;
  secretaryId: string;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const { t } = useI18n();
  const [preview, setPreview] = React.useState<SecretaryDeletePreview | null>(null);
  const [step, setStep] = React.useState<'preview' | 'confirm'>('preview');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setStep('preview');
    setBusy(false);
    setError(null);
    setPreview(null);
    void window.electronAPI.secretary.deletePreview(secretaryId).then((result) => {
      if (result.ok) setPreview(result.preview);
      else setError(result.error);
    });
  }, [open, secretaryId]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    const result = await window.electronAPI.secretary
      .deleteSecretary(secretaryId, true)
      .catch((error: unknown) => ({ ok: false as const, error: String(error) }));
    if (!result.ok) {
      setError(result.error);
      setBusy(false);
      return;
    }
    // 成功后保持「删除中…」直到弹窗卸下或再次打开，关闭动画期间不闪回可点的按钮
    onOpenChange(false);
    onDeleted?.();
  };

  const empty =
    preview !== null &&
    preview.sessions.length +
      preview.todos.length +
      preview.schedules.length +
      (preview.triggers?.length ?? 0) +
      preview.contacts.length +
      preview.memories ===
      0;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => (busy && !next ? undefined : onOpenChange(next))}
    >
      <AlertDialogPopup className="sm:max-w-md" data-enso="secretary-delete-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-base">
            {step === 'preview'
              ? `${t('Delete secretary')} · ${preview?.name ?? t('Secretary')}`
              : t('Delete this secretary?')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              'This cannot be undone. The sessions it manages stay, but nobody manages them afterwards; its contact bindings are released and its private memory is deleted.'
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {step === 'preview' && preview && (
          <div className="space-y-2 px-1" data-enso="secretary-delete-preview">
            {empty ? (
              <p className="text-xs text-muted-foreground">
                {t('Nothing is managed by this secretary.')}
              </p>
            ) : null}
            <PreviewList
              title={t('Sessions it manages ({{n}})', { n: preview.sessions.length })}
              items={preview.sessions.map((session) =>
                [session.projectName, session.title].filter(Boolean).join(' · ')
              )}
            />
            <PreviewList
              title={t('Open todos ({{n}})', { n: preview.todos.length })}
              items={preview.todos.map((todo) => todo.text)}
            />
            <PreviewList
              title={t('Schedules ({{n}})', { n: preview.schedules.length })}
              items={preview.schedules.map((schedule) => schedule.name)}
            />
            <PreviewList
              title={t('Local triggers ({{n}})', { n: preview.triggers?.length ?? 0 })}
              items={(preview.triggers ?? []).map((trigger) => trigger.name)}
            />
            <PreviewList
              title={t('Contact bindings ({{n}})', { n: preview.contacts.length })}
              items={preview.contacts}
            />
            {preview.memories > 0 && (
              <p className="text-xs font-medium">
                {t('Private memories: {{n}}', { n: preview.memories })}
              </p>
            )}
          </div>
        )}
        {error ? <p className="px-1 text-xs text-destructive">{error}</p> : null}
        <AlertDialogFooter variant="bare">
          <AlertDialogClose render={<Button variant="outline" size="sm" disabled={busy} />}>
            {t('Cancel')}
          </AlertDialogClose>
          {step === 'preview' ? (
            <Button
              variant="destructive"
              size="sm"
              data-enso="secretary-delete-next"
              disabled={!preview}
              onClick={() => setStep('confirm')}
            >
              {t('Next: confirm again')}
            </Button>
          ) : (
            <Button
              variant="destructive"
              size="sm"
              data-enso="secretary-delete-confirm"
              disabled={busy}
              onClick={() => void confirm()}
            >
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              {busy ? t('Deleting…') : t('Delete permanently')}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
