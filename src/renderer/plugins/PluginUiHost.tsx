import { useEffect } from 'react';
import { addToast } from '@/components/ui/toast';
import { useSessionsStore } from '@/stores/sessions';
import { displayedConversationId } from '@/stores/sessions/chatChrome';
import { newInterceptBreakers } from './breakers';
import { mergePluginCommands, setPluginCommands } from './commands';
import { handleDraftRequest } from './draftBridge';
import { createRendererDeps, loadPluginRenderer } from './loader';
import { setPluginTriggers } from './triggers';
import { setPluginViews } from './viewBridge';

/** 挂一次：启用插件的渲染模块在宿主页面加载，登记挂点；停用或变更时收回 */
export function PluginUiHost() {
  useEffect(() => {
    // 与主输入框 focusKey 一致：子 Agent tab 打开时指向该 tab 的会话
    const deps = createRendererDeps(() => displayedConversationId(useSessionsStore.getState()));
    let generation = 0;
    let handles: { dispose(): void }[] = [];
    const breakers = new Set<string>();
    const reload = () => {
      const mine = ++generation;
      for (const handle of handles) handle.dispose();
      handles = [];
      void window.electronAPI.extensionPlugins.list().then(async (list) => {
        if (mine !== generation) return;
        for (const { pluginName, event } of newInterceptBreakers(list, breakers)) {
          addToast({
            type: 'warning',
            title: `插件 ${pluginName} 的检查连续失败，已临时放行`,
            description: `${event} 事件 30 秒内不再经过该插件；详情见设置里的插件日志`,
          });
        }
        const enabled = list.filter((plugin) => plugin.state === 'enabled');
        setPluginCommands(
          enabled.flatMap((plugin) =>
            mergePluginCommands(plugin.commands, plugin.dynamicCommands).map((command) => ({
              pluginId: plugin.id,
              pluginName: plugin.name,
              ...command,
            }))
          )
        );
        setPluginViews(
          enabled.flatMap((plugin) =>
            plugin.views.map((view) => ({
              pluginId: plugin.id,
              pluginName: plugin.name,
              ...view,
            }))
          )
        );
        setPluginTriggers(
          enabled.flatMap((plugin) =>
            plugin.triggers
              .filter((trigger) => trigger.symbol === '#')
              .map((trigger) => ({ pluginId: plugin.id, name: trigger.name }))
          )
        );
        for (const plugin of list) {
          if (plugin.state !== 'enabled' || !plugin.renderer) continue;
          try {
            const handle = await loadPluginRenderer(plugin.id, plugin.renderer, deps, {
              draft: plugin.permissions.includes('composer.draft'),
            });
            if (mine !== generation) {
              handle.dispose();
              return;
            }
            handles.push(handle);
          } catch (error) {
            console.warn(`[plugin] ${plugin.id} 渲染模块加载失败`, error);
          }
        }
      });
    };
    reload();
    const unsubscribe = window.electronAPI.extensionPlugins.onChanged(reload);
    const unsubscribeDraft = window.electronAPI.extensionPlugins.onDraftRequest((request) => {
      void window.electronAPI.extensionPlugins.respondDraft({
        requestId: request.requestId,
        ...handleDraftRequest(request),
      });
    });
    return () => {
      generation += 1;
      unsubscribe();
      unsubscribeDraft();
      setPluginCommands([]);
      setPluginTriggers([]);
      setPluginViews([]);
      for (const handle of handles) handle.dispose();
    };
  }, []);
  return null;
}
