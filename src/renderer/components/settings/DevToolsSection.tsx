import { Button } from '@/components/ui/button';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { isRemoteClient } from '@/lib/remoteClient';

/** 打开本机主窗口的 DevTools；远程客户端看的是宿主，不提供入口 */
export function DevToolsSection() {
  const { t } = useI18n();
  if (isRemoteClient()) return null;

  const open = async () => {
    try {
      const result = await window.electronAPI.window.openDevTools();
      if (result.ok) return;
      addToast({
        type: 'error',
        title: t('Could not open developer tools'),
        description:
          result.error === 'main-window-unavailable'
            ? t('The main window is closed. Open it and try again.')
            : result.error,
      });
    } catch (error) {
      addToast({
        type: 'error',
        title: t('Could not open developer tools'),
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <section className="space-y-3">
      <h4 className="border-b pb-2 text-base font-semibold">{t('Troubleshooting')}</h4>
      <div
        className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5"
        data-settings-row="general.devTools"
      >
        <div className="min-w-0">
          <p className="text-sm">{t('Developer tools')}</p>
          <p className="text-xs text-muted-foreground">
            {t('Open the console of the main window to see errors and logs.')}
          </p>
        </div>
        <Button variant="outline" size="sm" className="shrink-0" onClick={() => void open()}>
          {t('Open')}
        </Button>
      </div>
    </section>
  );
}
