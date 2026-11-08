import { useSyncExternalStore } from 'react';

export type ViewReply =
  | { id: string | number; ok: true; value: unknown }
  | {
      id: string | number;
      ok: false;
      error: string;
    };

/** 侧栏页面经 MessagePort 发来的 { id, method, args }，转成插件 renderer.call；坏消息返回 null */
export function createViewBridge(
  call: (method: string, args: unknown) => Promise<unknown>
): (data: unknown) => Promise<ViewReply | null> {
  return async (data) => {
    if (typeof data !== 'object' || data === null) return null;
    const { id, method, args } = data as Record<string, unknown>;
    if (typeof id !== 'string' && typeof id !== 'number') return null;
    if (typeof method !== 'string' || method.length === 0 || method.length > 128) return null;
    try {
      return { id, ok: true, value: await call(method, args ?? null) };
    } catch (error) {
      return { id, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
}

export function decodeUtf8Base64(base64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)));
}

/** 侧栏壳经 MessagePort 提交的 localStorage / enso.storage 补丁；不是插件调用 */
export function viewStoragePatch(data: unknown): Record<string, string | null> | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  if (record.type !== 'enso-storage' || typeof record.patch !== 'object' || record.patch === null)
    return null;
  if (Array.isArray(record.patch)) return null;
  const patch: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(record.patch as Record<string, unknown>)) {
    if (key.length === 0 || key.length > 256) return null;
    if (value === null) patch[key] = null;
    else if (typeof value === 'string') patch[key] = value;
    else return null;
  }
  return patch;
}

export function viewThemePush(theme: 'light' | 'dark'): {
  type: 'enso-theme';
  theme: 'light' | 'dark';
} {
  return { type: 'enso-theme', theme };
}

/** 插件主进程推给自己侧栏页面的事件 */
export function viewEventPush(
  name: string,
  data: unknown
): { type: 'enso-view-event'; name: string; data: unknown } {
  return { type: 'enso-view-event', name, data };
}

/** 宿主经端口推来的主题；不是主题消息时返回 null */
export function viewThemeNotice(data: unknown): 'light' | 'dark' | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  if (record.type !== 'enso-theme') return null;
  return record.theme === 'dark' || record.theme === 'light' ? record.theme : null;
}

export interface PluginViewRef {
  pluginId: string;
  pluginName: string;
  id: string;
  title: string;
  entry: string;
}

let views: PluginViewRef[] = [];
const listeners = new Set<() => void>();

/** 已启用插件声明的侧栏页面，由 PluginUiHost 随插件列表刷新 */
export function setPluginViews(next: PluginViewRef[]): void {
  views = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => views;

export function usePluginViews(): PluginViewRef[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
