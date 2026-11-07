import { useEffect } from 'react';
import { addToast } from '@/components/ui/toast';
import { useSessionsStore } from '@/stores/sessions';
import { displayedConversationId } from '@/stores/sessions/chatChrome';
import { newInterceptBreakers } from './breakers';
import { mergePluginCommands, setPluginCommands } from './commands';
import { handleDraftRequest, prefillDraft } from './draftBridge';
import { createRendererDeps, loadPluginRenderer } from './loader';
import { setPluginIcons } from './PluginIcon';
import { syncPluginRenderers } from './rendererReload';
import { handleSessionRequest, type SessionRequest } from './sessionBridge';
import { setPluginTriggers } from './triggers';
import { setPluginViews } from './viewBridge';

const sessionDeps = {
  conversation: (id: string) => useSessionsStore.getState().conversations[id] ?? null,
  focus: (rootId: string, target: string) => {
    const sessions = useSessionsStore.getState();
    sessions.selectConversation(rootId);
    if (target !== rootId) sessions.selectTab(rootId, target);
  },
  create: (projectId: string, presetId?: string) =>
    useSessionsStore.getState().newConversation(projectId, presetId ? { presetId } : undefined),
  prefill: prefillDraft,
  ensure: async (id: string) => {
    const sessions = useSessionsStore.getState();
    const before = sessions.conversations[id];
    if (before?.started || before?.spawning) return null;
    await sessions.resumeConversation(id, { fresh: true });
    const after = useSessionsStore.getState().conversations[id];
    if (after?.started || after?.spawning) return null;
    return after?.error ?? '无法启动会话：请检查默认模型与登录状态';
  },
};

/** 挂一次：启用插件的渲染模块在宿主页面加载，登记挂点；停用或变更时收回 */
export function PluginUiHost() {
  useEffect(() => {
    // 与主输入框 focusKey 一致：子 Agent tab 打开时指向该 tab 的会话
    const deps = createRendererDeps(() => displayedConversationId(useSessionsStore.getState()));
    let generation = 0;
    const loaded = new Map<string, { key: string; dispose(): void }>();
    const breakers = new Set<string>();
    const reload = () => {
      const mine = ++generation;
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
        setPluginIcons(Object.fromEntries(list.flatMap((p) => (p.icon ? [[p.id, p.icon]] : []))));
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
        await syncPluginRenderers(
          loaded,
          list,
          (plugin) =>
            loadPluginRenderer(plugin.id, plugin.renderer, deps, {
              draft: plugin.permissions.includes('composer.draft'),
            }),
          () => mine === generation
        );
      });
    };
    reload();
    const unsubscribe = window.electronAPI.extensionPlugins.onChanged(reload);
    const unsubscribeDraft = window.electronAPI.extensionPlugins.onDraftRequest((request) => {
      if (
        request.op === 'focusSession' ||
        request.op === 'createSession' ||
        request.op === 'ensureSession'
      ) {
        void handleSessionRequest(request as SessionRequest, sessionDeps)
          .catch((error: unknown) => ({
            ok: false as const,
            code: 'SESSION_FAILED',
            error: error instanceof Error ? error.message : String(error),
          }))
          .then((result) =>
            window.electronAPI.extensionPlugins.respondDraft({
              requestId: request.requestId,
              ...result,
            })
          );
        return;
      }
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
      for (const handle of loaded.values()) handle.dispose();
      loaded.clear();
    };
  }, []);
  return null;
}
