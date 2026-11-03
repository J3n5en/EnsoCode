import { parsePluginInstallUrl } from './extensionPlugins/installUrl';

export const SETTINGS_CATEGORIES = [
  'general',
  'shortcuts',
  'voice',
  'appearance',
  'providers',
  'skills',
  'plugins',
  'claudePlugins',
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
] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

export interface SettingsDeepLink {
  category: SettingsCategory;
  rowId: string;
  /** 仅插件安装深链：已校验的 http(s) 插件地址 */
  pluginInstallUrl?: string;
}

const CATEGORY_SET = new Set<string>(SETTINGS_CATEGORIES);

export function parseSettingsDeepLink(raw: unknown): SettingsDeepLink | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const category = (raw as { category?: unknown }).category;
  const rowId = (raw as { rowId?: unknown }).rowId;
  if (typeof category !== 'string' || !CATEGORY_SET.has(category)) return null;
  if (typeof rowId !== 'string' || !rowId) return null;
  const pluginInstallUrl = (raw as { pluginInstallUrl?: unknown }).pluginInstallUrl;
  if (pluginInstallUrl === undefined) return { category: category as SettingsCategory, rowId };
  if (typeof pluginInstallUrl !== 'string') return null;
  const parsed = parsePluginInstallUrl(pluginInstallUrl);
  if (!parsed.ok) return null;
  return {
    category: category as SettingsCategory,
    rowId,
    pluginInstallUrl: parsed.url.href,
  };
}
