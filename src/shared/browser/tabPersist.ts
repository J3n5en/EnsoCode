import { assertAllowedUrl } from './urlPolicy';

export interface PersistedBrowserTab {
  url: string;
  title: string;
  at?: number;
}

export function parsePersistedBrowserTabs(raw: unknown): Record<string, PersistedBrowserTab> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, PersistedBrowserTab> = {};
  for (const [sessionId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!sessionId || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const url = (value as { url?: unknown }).url;
    const title = (value as { title?: unknown }).title;
    if (typeof url !== 'string') continue;
    try {
      assertAllowedUrl(url);
    } catch {
      continue;
    }
    const at = (value as { at?: unknown }).at;
    out[sessionId] = {
      url,
      title: typeof title === 'string' ? title : '',
      ...(typeof at === 'number' && Number.isFinite(at) ? { at } : {}),
    };
  }
  return out;
}

export function serializePersistedBrowserTabs(tabs: Record<string, PersistedBrowserTab>): string {
  return JSON.stringify(tabs);
}
