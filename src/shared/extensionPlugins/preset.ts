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
