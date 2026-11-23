import type { RestartToUpdateResult } from '@shared/types/updater';
import { addToast } from '@/components/ui/toast';
import type { TFunction } from '@/i18n';

/** 重启更新：没被受理（无已下载更新、已在重启、安装前出错）时提示，不再静默 */
export async function restartToUpdate(t: TFunction): Promise<void> {
  let result: RestartToUpdateResult | undefined;
  try {
    result = await window.electronAPI.updater.quitAndInstall();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = { ok: false, reason: 'error', error: message };
  }
  if (!result || result.ok) return;
  if (result.reason === 'busy') {
    addToast({ type: 'info', title: t('Restart to update is already in progress. Please wait.') });
    return;
  }
  addToast({
    type: 'error',
    title:
      result.reason === 'error'
        ? t(
            'Restart to update failed: {{error}}. Try Restart to update again in a moment; if it still fails, quit EnsoCode completely and reopen it.',
            { error: result.error }
          )
        : t('No downloaded update to install. Check for updates again.'),
  });
}
