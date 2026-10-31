import type { ExtensionPluginSummary } from '@shared/extensionPlugins/types';
import { useEffect, useState } from 'react';

export type PluginPresetOption = ExtensionPluginSummary['presets'][number] & { pluginName: string };

/** 已启用插件声明的预设。停用或卸载后从列表消失。 */
export function useEnabledPluginPresets(): PluginPresetOption[] {
  const [presets, setPresets] = useState<PluginPresetOption[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => {
      void window.electronAPI.extensionPlugins.list().then((list) => {
        if (!alive) return;
        setPresets(
          list
            .filter((plugin) => plugin.state === 'enabled')
            .flatMap((plugin) =>
              plugin.presets.map((preset) => ({ ...preset, pluginName: plugin.name }))
            )
        );
      });
    };
    load();
    const unsubscribe = window.electronAPI.extensionPlugins.onChanged(load);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);
  return presets;
}
