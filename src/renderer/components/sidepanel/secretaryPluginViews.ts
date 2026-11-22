import type { PluginViewRef } from '../../plugins/viewBridge';

const PREFIX = 'plugin:';

/** 秘书会话只开放秘书设置里勾选的插件页面；勾选写在档案 pluginIds */
export function secretaryPluginViews(
  views: readonly PluginViewRef[],
  pluginIds: readonly string[] | undefined
): PluginViewRef[] {
  const allowed = new Set(pluginIds ?? []);
  return views.filter((view) => allowed.has(view.pluginId));
}

/**
 * 取消勾选后要收起的插件面板 id；pluginIds 为 null 表示档案还没到，不动布局。
 * 全局标签豁免：在这里关掉会被当成用户关闭、让所有会话一起关。
 */
export function secretaryPluginPanelsToClose(
  panelIds: readonly string[],
  pluginIds: readonly string[] | null,
  globalIds: ReadonlySet<string> = new Set()
): string[] {
  if (!pluginIds) return [];
  const allowed = new Set(pluginIds);
  return panelIds.filter((id) => {
    if (!id.startsWith(PREFIX) || globalIds.has(id)) return false;
    const pluginId = id.slice(PREFIX.length).split(':')[0] ?? '';
    return !allowed.has(pluginId);
  });
}
