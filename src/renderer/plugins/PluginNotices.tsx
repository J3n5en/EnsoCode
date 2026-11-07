import { pluginFocusSettingsLink } from '@shared/extensionPlugins/pluginProtocol';
import { useEffect } from 'react';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { describePluginNotice } from './pluginNotice';

export function PluginNotices() {
  const { t } = useI18n();
  useEffect(() => {
    return window.electronAPI.extensionPlugins.onNotice((notice) => {
      const view = describePluginNotice(notice);
      if (!view) return;
      addToast({
        type: view.type,
        title: t(view.titleKey, view.params),
        ...(view.actionKey
          ? {
              actions: [
                {
                  label: t(view.actionKey),
                  onClick: () => {
                    void window.electronAPI.window.openSettings(
                      pluginFocusSettingsLink(view.pluginId)
                    );
                  },
                },
              ],
            }
          : {}),
      });
    });
  }, [t]);
  return null;
}
