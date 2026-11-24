import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { isRemoteClient } from '@/lib/remoteClient';
import { SettingsButton, SettingsRow } from './kit';

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
    <SettingsRow
      rowId="logs.devTools"
      label={t('Developer tools')}
      description={t('Open the console of the main window to see errors and logs.')}
    >
      <SettingsButton onClick={() => void open()}>{t('Open')}</SettingsButton>
    </SettingsRow>
  );
}
