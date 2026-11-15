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
import { Checkbox } from '@/components/ui/checkbox';
import { useI18n } from '@/i18n';

/** 重来确认：清空档案后回到欢迎页；会话与私有记忆默认保留 */
export function SecretaryResetDialog({
  open,
  onOpenChange,
  onReset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReset?: () => void;
}) {
  const { t } = useI18n();
  const [clearMemory, setClearMemory] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setClearMemory(false);
    setError(null);
  }, [open]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.secretary.resetProfile(clearMemory);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onOpenChange(false);
      onReset?.();
    } catch {
      setError(t('Could not reset the secretary. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup className="sm:max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-base">
            {t('Reset the secretary and start over')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('Sessions and dispatch history are kept either way.')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label className="flex items-center gap-2 px-1 py-1 text-sm">
          <Checkbox
            checked={clearMemory}
            onCheckedChange={(checked) => setClearMemory(checked === true)}
          />
          {t('Also delete the secretary private memory')}
        </label>
        {error ? <p className="px-1 text-xs text-destructive">{error}</p> : null}
        <AlertDialogFooter variant="bare">
          <AlertDialogClose render={<Button variant="outline" size="sm" />}>
            {t('Cancel')}
          </AlertDialogClose>
          <Button variant="destructive" size="sm" disabled={busy} onClick={() => void confirm()}>
            {t('Reset')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
