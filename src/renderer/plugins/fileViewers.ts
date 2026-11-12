import { useSyncExternalStore } from 'react';

export interface PluginFileViewerRef {
  pluginId: string;
  pluginName: string;
  id: string;
  title: string;
  entry: string;
  extensions: string[];
  default: boolean;
}

/** 文件名的最长匹配后缀长度；文件名正好是后缀（如 `.csv`）不算 */
function matchLength(name: string, extensions: readonly string[]): number {
  let best = 0;
  for (const ext of extensions)
    if (name.length > ext.length && name.endsWith(ext) && ext.length > best) best = ext.length;
  return best;
}

/** 能打开该文件的插件查看器，后缀更长的排前面 */
export function pluginFileViewersFor(
  rel: string,
  viewers: readonly PluginFileViewerRef[]
): PluginFileViewerRef[] {
  const name = (rel.split('/').at(-1) ?? '').toLowerCase();
  return viewers
    .map((viewer) => ({ viewer, length: matchLength(name, viewer.extensions) }))
    .filter((item) => item.length > 0)
    .sort((a, b) => b.length - a.length)
    .map((item) => item.viewer);
}

export const fileViewerKey = (viewer: { pluginId: string; id: string }) =>
  `${viewer.pluginId}:${viewer.id}`;

let viewers: PluginFileViewerRef[] = [];
const listeners = new Set<() => void>();

/** 已启用插件声明的文件查看器，由 PluginUiHost 随插件列表刷新 */
export function setPluginFileViewers(next: PluginFileViewerRef[]): void {
  viewers = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => viewers;

export function usePluginFileViewers(): PluginFileViewerRef[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
