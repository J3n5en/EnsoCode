import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/i18n';
import { inlinePluginViewHtml } from './inlineAssets';
import {
  createViewBridge,
  decodeUtf8Base64,
  usePluginViews,
  viewEventPush,
  viewStoragePatch,
  viewThemePush,
} from './viewBridge';

const SHELL = 'plugin-view.html';

function documentTheme(): 'light' | 'dark' {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

/**
 * 插件侧栏页面。外层 iframe 不加 sandbox：没有 allow-same-origin 的沙箱导航
 * 不经过 Service Worker，PWA 完整模式会向中继要壳页面并得到空文档。
 * 壳页面内部再用 sandbox="allow-scripts" 的 srcdoc iframe 跑插件页面（不同源、无 preload），
 * 页面只能经 MessagePort 调本插件的 renderer.call。
 */
export function PluginView({
  pluginId,
  viewId,
  sessionId,
}: {
  pluginId: string;
  viewId: string;
  sessionId: string | null;
}) {
  const { t } = useI18n();
  const view = usePluginViews().find((v) => v.pluginId === pluginId && v.id === viewId);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState<string | null>(null);
  const entry = view?.entry;
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !entry) return;
    setError(null);
    let disposed = false;
    let channel: MessageChannel | null = null;
    const pushTheme = () => {
      try {
        channel?.port1.postMessage(viewThemePush(documentTheme()));
      } catch {
        /* 端口已关闭 */
      }
    };
    const themeObserver = new MutationObserver(pushTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    const unsubscribeViewEvent = window.electronAPI.extensionPlugins.onViewEvent((event) => {
      if (event.pluginId !== pluginId || typeof event.name !== 'string') return;
      try {
        channel?.port1.postMessage(viewEventPush(event.name, event.data));
      } catch {
        /* 端口已关闭 */
      }
    });
    const handle = createViewBridge(async (method, args) => {
      const res = await window.electronAPI.extensionPlugins.call({
        pluginId,
        method: 'renderer.call',
        payload: { method, args },
        sessionId: sessionRef.current,
      });
      if (!res.ok) throw new Error(res.error);
      return res.value;
    });
    // iframe 被移出文档（拖到别的分组等）后会重新加载壳页面；壳页面每次加载发 ready，按 ready 重新握手。
    // 不能按 load 事件握手：壳页面 document.write 插件 HTML 后也会触发 load。
    const onReady = async (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.data?.type !== 'enso-view-ready') return;
      channel?.port1.close();
      const current = new MessageChannel();
      channel = current;
      current.port1.onmessage = (event) => {
        const patch = viewStoragePatch(event.data);
        if (patch) {
          void window.electronAPI.extensionPlugins.viewStateSet(pluginId, patch);
          return;
        }
        void handle(event.data).then((reply) => {
          if (reply && !disposed && channel === current) current.port1.postMessage(reply);
        });
      };
      const [res, state] = await Promise.all([
        window.electronAPI.extensionPlugins.asset(pluginId, entry),
        window.electronAPI.extensionPlugins.viewStateGet(pluginId),
      ]);
      if (disposed || channel !== current) return;
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const html = await inlinePluginViewHtml(decodeUtf8Base64(res.base64), entry, async (rel) => {
        const asset = await window.electronAPI.extensionPlugins.asset(pluginId, rel);
        return asset.ok ? { mime: asset.mime, base64: asset.base64 } : null;
      });
      if (disposed || channel !== current) return;
      frame.contentWindow?.postMessage(
        {
          type: 'enso-view-init',
          html,
          theme: documentTheme(),
          storage: state.ok ? state.state : {},
        },
        '*',
        [current.port2]
      );
    };
    window.addEventListener('message', onReady);
    frame.src = new URL(SHELL, document.baseURI).href;
    return () => {
      disposed = true;
      themeObserver.disconnect();
      unsubscribeViewEvent();
      window.removeEventListener('message', onReady);
      channel?.port1.close();
      frame.removeAttribute('src');
    };
  }, [pluginId, entry]);

  if (!view)
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        {t('Plugin is not enabled')}
      </div>
    );
  return (
    <div className="flex h-full min-h-0 flex-col">
      {error && <div className="shrink-0 px-3 py-2 text-xs text-destructive">{error}</div>}
      <iframe
        ref={frameRef}
        title={view.title}
        className="min-h-0 w-full flex-1 border-0 bg-background"
      />
    </div>
  );
}
