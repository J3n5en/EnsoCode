import { Puzzle } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { cn } from '@/lib/utils';

let icons: Record<string, string> = {};
const listeners = new Set<() => void>();
const urls = new Map<string, Promise<string | null>>();

/** 由 PluginUiHost 随插件列表刷新：pluginId → 清单 icon 相对路径 */
export function setPluginIcons(next: Record<string, string>): void {
  icons = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function loadIcon(pluginId: string, rel: string): Promise<string | null> {
  const key = `${pluginId}\0${rel}`;
  let url = urls.get(key);
  if (!url) {
    url = window.electronAPI.extensionPlugins
      .asset(pluginId, rel)
      .then((res) => (res.ok ? `data:${res.mime};base64,${res.base64}` : null))
      .catch(() => null);
    url.then((v) => v === null && urls.delete(key));
    urls.set(key, url);
  }
  return url;
}

/** 插件清单声明了 icon 用之，否则回落到拼图图标；没挂 PluginUiHost 的窗口（设置）直接传 icon */
export function PluginIcon({
  pluginId,
  icon,
  className,
}: {
  pluginId: string;
  icon?: string;
  className?: string;
}) {
  const registered = useSyncExternalStore(subscribe, () => icons[pluginId]);
  const rel = icon ?? registered;
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    setSrc(null);
    if (!rel) return;
    let live = true;
    void loadIcon(pluginId, rel).then((v) => live && setSrc(v));
    return () => {
      live = false;
    };
  }, [pluginId, rel]);
  if (!src) return <Puzzle className={className} />;
  return <img src={src} alt="" className={cn('object-contain', className)} />;
}
