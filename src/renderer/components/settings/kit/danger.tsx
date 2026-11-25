import * as React from 'react';
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { SettingsRow } from './layout';

/**
 * 危险操作行，放在页面最后的 `<SettingsSection tone="danger">` 里。
 * 可恢复或可重建的用描边红按钮，不可恢复的用实心红按钮；一律先弹确认。
 */
export function SettingsDangerAction({
  label,
  description,
  rowId,
  actionLabel,
  confirmTitle,
  confirmDescription,
  confirmLabel,
  irreversible = false,
  onConfirm,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  rowId?: string;
  actionLabel: string;
  /** 写出对象名，例如「删除服务商 “OpenAI”？」 */
  confirmTitle: React.ReactNode;
  confirmDescription?: React.ReactNode;
  confirmLabel?: string;
  irreversible?: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await onConfirm();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsRow label={label} description={description} rowId={rowId}>
      <Button
        size="sm"
        variant={irreversible ? 'destructive' : 'destructive-outline'}
        className={cn(!irreversible && 'border-destructive-text/45 text-destructive-text')}
        onClick={() => setOpen(true)}
      >
        {actionLabel}
      </Button>
      <AlertDialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmTitle}</AlertDialogTitle>
            {confirmDescription && (
              <AlertDialogDescription>{confirmDescription}</AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button variant="destructive" size="sm" disabled={busy} onClick={() => void run()}>
              {confirmLabel ?? actionLabel}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsRow>
  );
}
