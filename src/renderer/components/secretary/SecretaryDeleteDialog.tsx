import type { SecretaryDeletePreview } from '@shared/types/secretary';
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
    try {
      const result = await window.electronAPI.secretary.deleteSecretary(secretaryId, true);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onOpenChange(false);
      onDeleted?.();
    } finally {
      setBusy(false);
    }
  };

  const empty =
    preview !== null &&
    preview.sessions.length +
      preview.todos.length +
      preview.schedules.length +
      preview.contacts.length +
      preview.memories ===
      0;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
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
          <AlertDialogClose render={<Button variant="outline" size="sm" />}>
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
              {t('Delete permanently')}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
