import { useEffect, useState } from 'react';
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/i18n';

/**
 * 菜单「重启」在等命令结束：Main 推送开关，命令自然结束时 Main 先关弹层再退出重开。
 * 「强制退出」不等命令，立刻退出并重开（Main 照常尽量落断点与恢复清单）。
 */
export function RestartWaitDialog() {
  const { t } = useI18n();
  const [waiting, setWaiting] = useState(false);
  const [undetachable, setUndetachable] = useState(false);
  const [forcing, setForcing] = useState(false);
  useEffect(
    () =>
      window.electronAPI.app.onRestartWaiting((next, reason) => {
        setWaiting(next);
        setUndetachable(reason === 'background-not-detachable');
        setForcing(false);
      }),
    []
  );
  const forceQuit = () => {
    setForcing(true);
    window.electronAPI.app.forceRestart();
  };
  return (
    <AlertDialog open={waiting}>
      <AlertDialogPopup className="sm:max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-base">
            <Spinner className="size-4 text-muted-foreground" />
            {t('Waiting for the current command to finish')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('EnsoCode will restart once the current command finishes.')}
            {undetachable && (
              <>
                {' '}
                {t(
                  'A command moved to the background cannot keep running without EnsoCode (for example a remote or Windows command), so the restart waits for it.'
                )}
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter variant="bare">
          <Button variant="destructive" size="sm" disabled={forcing} onClick={forceQuit}>
            {t('Force quit')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
