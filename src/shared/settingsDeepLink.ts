import { parsePluginInstallUrl } from './extensionPlugins/installUrl';
import { isPluginId } from './extensionPlugins/manifest';

export const SETTINGS_CATEGORIES = [
  'general',
  'shortcuts',
  'appearance',
  'providers',
  'skills',
  'plugins',
  'mcp',
  'instructions',
  'presets',
  'agents',
  'workflows',
  'tools',
  'memory',
  'privacy',
  'phone',
  'ssh',
  'usage',
  'resources',
  'experimental',
  'bots',
  'botTemplates',
  'secretary',
] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

export interface SettingsDeepLink {
  category: SettingsCategory;
  rowId: string;
  /** 仅插件安装深链：已校验的 http(s) 插件地址 */
  pluginInstallUrl?: string;
  /** 打开插件设置并展开该插件详情 */
  pluginId?: string;
  /** 打开插件市场并预填搜索词（按标签筛，如 contact） */
  marketQuery?: string;
}

const MARKET_QUERY = /^[a-z0-9-]{1,32}$/u;

const CATEGORY_SET = new Set<string>(SETTINGS_CATEGORIES);

export function parseSettingsDeepLink(raw: unknown): SettingsDeepLink | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const category = (raw as { category?: unknown }).category;
  const rowId = (raw as { rowId?: unknown }).rowId;
  if (typeof category !== 'string' || !CATEGORY_SET.has(category)) return null;
  if (typeof rowId !== 'string' || !rowId) return null;
  const pluginInstallUrl = (raw as { pluginInstallUrl?: unknown }).pluginInstallUrl;
  if (pluginInstallUrl === undefined)
    return attachMarketQuery(
      attachPluginId({ category: category as SettingsCategory, rowId }, raw),
      raw
    );
  if (typeof pluginInstallUrl !== 'string') return null;
  const parsed = parsePluginInstallUrl(pluginInstallUrl);
  if (!parsed.ok) return null;
  const link: SettingsDeepLink = {
    category: category as SettingsCategory,
    rowId,
    pluginInstallUrl: parsed.url.href,
  };
  return attachPluginId(link, raw);
}

function attachMarketQuery(link: SettingsDeepLink | null, raw: object): SettingsDeepLink | null {
  const marketQuery = (raw as { marketQuery?: unknown }).marketQuery;
  if (!link || marketQuery === undefined) return link;
  if (link.category !== 'plugins' || typeof marketQuery !== 'string') return null;
  return MARKET_QUERY.test(marketQuery) ? { ...link, marketQuery } : null;
}

function attachPluginId(link: SettingsDeepLink, raw: object): SettingsDeepLink | null {
  const pluginId = (raw as { pluginId?: unknown }).pluginId;
  if (pluginId === undefined) return link;
  if (link.category !== 'plugins' || !isPluginId(pluginId)) return null;
  return { ...link, pluginId };
}
