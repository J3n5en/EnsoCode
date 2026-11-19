import type { RestartOverlayState } from '@shared/types/ipc';
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
 * 重启弹层，Main 推送状态：点「重启」立刻是「正在重启」；有命令在跑改成等命令（可强制退出，
 * 不等命令立刻退出并重开，Main 照常尽量落断点与恢复清单），等到了切回「正在重启」。
 * 新实例有会话要续跑时显示「正在恢复会话」，恢复完成或到上限由 Main 关掉。只在本机主窗口显示。
 */
export function RestartWaitDialog() {
  const { t } = useI18n();
  const [state, setState] = useState<RestartOverlayState | null>(null);
  // 关弹层的淡出期间文案保持关前那一态，不闪成别的
  const [shown, setShown] = useState<RestartOverlayState>({ phase: 'restarting' });
  const [forcing, setForcing] = useState(false);
  useEffect(() => {
    if (window.electronAPI.remote) return;
    let pushed = false;
    const apply = (next: RestartOverlayState | null) => {
      setState(next);
      if (next) setShown(next);
    };
    const off = window.electronAPI.app.onRestartWaiting((next) => {
      pushed = true;
      apply(next);
      setForcing(false);
    });
    // 启动时 Main 的推送可能早于订阅：挂载时补取一次，已收到推送就以推送为准
    void window.electronAPI.app.getRestartWaiting().then((initial) => {
      if (!pushed) apply(initial);
    });
    return off;
  }, []);
  const forceQuit = () => {
    setForcing(true);
    window.electronAPI.app.forceRestart();
  };
  const waiting = shown.phase === 'waiting';
  return (
    <AlertDialog open={state !== null}>
      <AlertDialogPopup className="sm:max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-base">
            <Spinner className="size-4 text-muted-foreground" />
            {waiting
              ? t('Waiting for the current command to finish')
              : shown.phase === 'resuming'
                ? t('Restoring sessions…')
                : t('Restarting EnsoCode…')}
          </AlertDialogTitle>
          {waiting && (
            <AlertDialogDescription>
              {t('EnsoCode will restart once the current command finishes.')}
              {shown.reason === 'background-not-detachable' && (
                <>
                  {' '}
                  {t(
                    'A command moved to the background cannot keep running without EnsoCode (for example a remote or Windows command), so the restart waits for it.'
                  )}
                </>
              )}
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {waiting && (
          <AlertDialogFooter variant="bare">
            <Button variant="destructive" size="sm" disabled={forcing} onClick={forceQuit}>
              {t('Force quit')}
            </Button>
          </AlertDialogFooter>
        )}
      </AlertDialogPopup>
    </AlertDialog>
  );
}
