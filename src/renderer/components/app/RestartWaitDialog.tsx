import type { AppExitReason } from '@shared/types/ipc';
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

const EXIT_NOTES: Record<AppExitReason, string> = {
  restart: 'EnsoCode will restart once the current command finishes.',
  update: 'EnsoCode will install the update once the current command finishes.',
  quit: 'EnsoCode will quit once the current command finishes.',
};

/**
 * 重启 / 安装更新 / 退出在等命令结束：Main 推送开关与等完要做什么，命令自然结束时 Main 先关弹层再往下走。
 * 「强制退出」不等命令，立刻照原路径退出（重开 / 安装 / 退出；Main 照常尽量落断点与恢复清单）。
 */
export function RestartWaitDialog() {
  const { t } = useI18n();
  const [waiting, setWaiting] = useState(false);
  const [undetachable, setUndetachable] = useState(false);
  const [exit, setExit] = useState<AppExitReason>('restart');
  const [forcing, setForcing] = useState(false);
  useEffect(
    () =>
      window.electronAPI.app.onRestartWaiting((next, reason, nextExit) => {
        setWaiting(next);
        setUndetachable(reason === 'background-not-detachable');
        if (next) setExit(nextExit ?? 'restart');
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
            {t(EXIT_NOTES[exit])}
            {undetachable && (
              <>
                {' '}
                {t(
                  'A command moved to the background cannot keep running without EnsoCode (for example a remote or Windows command), so EnsoCode waits for it.'
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
