import type { Preset } from '../types/assets';

// 插件预设的会话 id：plugin:<插件 id>:<预设 id>。插件 id 含点、不含冒号。

const PREFIX = 'plugin:';
const PLUGIN_ID = /^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/;
const LOCAL_ID = /^[a-z][a-z0-9-]{0,31}$/;

export function pluginPresetId(pluginId: string, localId: string): string {
  return `${PREFIX}${pluginId}:${localId}`;
}

export function parsePluginPresetId(id: string): { pluginId: string; localId: string } | undefined {
  if (!id.startsWith(PREFIX)) return undefined;
  const rest = id.slice(PREFIX.length);
  const split = rest.lastIndexOf(':');
  if (split <= 0) return undefined;
  const pluginId = rest.slice(0, split);
  const localId = rest.slice(split + 1);
  if (!PLUGIN_ID.test(pluginId) || !LOCAL_ID.test(localId)) return undefined;
  return { pluginId, localId };
}

export function isPluginPresetId(id: string): boolean {
  return parsePluginPresetId(id) !== undefined;
}

/** 会话预设拆成「自建预设」和「插件预设」两层：直接选插件预设时它必须可用；自建预设叠加的插件预设可缺省 */
export function presetOverlay(
  presetId: string | undefined,
  resolve: (id?: string) => Preset | undefined
): { preset?: Preset; pluginPresetIds?: string[]; required: boolean } {
  if (presetId && isPluginPresetId(presetId))
    return { pluginPresetIds: [presetId], required: true };
  const preset = resolve(presetId);
  const pluginPresetIds = presetOverlayIds(preset);
  return {
    ...(preset ? { preset } : {}),
    ...(pluginPresetIds.length > 0 ? { pluginPresetIds } : {}),
    required: false,
  };
}

/** 自建预设上叠加的插件预设 id 列表：pluginPresetIds 有序数组为准，旧单值字段并入数组首元素；非法 id 滤除 */
export function presetOverlayIds(preset: Preset | undefined): string[] {
  if (!preset) return [];
  const ids: string[] = [];
  if (typeof preset.pluginPresetId === 'string' && isPluginPresetId(preset.pluginPresetId)) {
    ids.push(preset.pluginPresetId);
  }
  for (const id of preset.pluginPresetIds ?? []) {
    if (typeof id === 'string' && isPluginPresetId(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}
