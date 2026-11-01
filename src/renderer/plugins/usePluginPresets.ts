import type { ExtensionPluginSummary } from '@shared/extensionPlugins/types';
import { useEffect, useState } from 'react';

export type PluginPresetOption = ExtensionPluginSummary['presets'][number] & { pluginName: string };

/** 选中带模型的插件预设时，输入框要切到的模型；没有则保持当前模型 */
export function pluginPresetModel(
  presetId: string,
  presets: readonly { id: string; model?: { providerId: string; modelId: string } }[]
): { providerId: string; modelId: string } | null {
  const model = presets.find((preset) => preset.id === presetId)?.model;
  if (!model?.providerId || !model.modelId) return null;
  return { providerId: model.providerId, modelId: model.modelId };
}

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
