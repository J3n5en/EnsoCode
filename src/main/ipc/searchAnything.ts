import type { BrowserSearchTab } from '@shared/searchAnything';
import { parseSettingsDeepLink, type SettingsDeepLink } from '@shared/settingsDeepLink';

export function parseBrowserSearchTabsResult(raw: unknown): BrowserSearchTab[] {
  if (!Array.isArray(raw)) return [];
  const out: BrowserSearchTab[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.tabId !== 'string' || !rec.tabId) continue;
    if (typeof rec.conversationId !== 'string' || !rec.conversationId) continue;
    if (typeof rec.url !== 'string') continue;
    const at = rec.at;
    out.push({
      tabId: rec.tabId,
      conversationId: rec.conversationId,
      url: rec.url,
      title: typeof rec.title === 'string' ? rec.title : '',
      at: typeof at === 'number' && Number.isFinite(at) ? at : 0,
      live: rec.live === true,
    });
  }
  return out;
}

export function parseOpenSettingsRequest(raw: unknown): SettingsDeepLink | null {
  if (raw === undefined || raw === null) return null;
  return parseSettingsDeepLink(raw);
}
