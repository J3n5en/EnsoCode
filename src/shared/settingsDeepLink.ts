import { parsePluginInstallUrl } from './extensionPlugins/installUrl';
import { isPluginId } from './extensionPlugins/manifest';

export const SETTINGS_CATEGORIES = [
  'general',
  'shortcuts',
  'appearance',
  'conversation',
  'terminal',
  'runtime',
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
  'logs',
  'experimental',
  'bots',
  'botTemplates',
  'secretary',
  'contacts',
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

/** 主进程转给主窗口的「打开设置」：link 为空时回到上次的分区 */
export interface SettingsOpenRequest {
  link: SettingsDeepLink | null;
}

const MARKET_QUERY = /^[a-z0-9-]{1,32}$/u;

const CATEGORY_SET = new Set<string>(SETTINGS_CATEGORIES);

/** 拆页后挪了分区的行：行号不变，深链改落新分区并继续闪那一行 */
const ROW_RELOCATIONS: Readonly<Record<string, SettingsCategory>> = {
  'general.generationStallTimeout': 'runtime',
  'general.autoRetryLimit': 'runtime',
  'general.longCacheRetention': 'runtime',
  'general.smartCompactEnabled': 'runtime',
  'general.compactReserveTokens': 'runtime',
  'general.autoArchiveIdleDays': 'runtime',
  'general.autoArchiveMergedWorktrees': 'runtime',
  'general.autoDeleteArchivedDays': 'runtime',
  'general.activeRetentionMinutes': 'runtime',
  'general.worktreeRoot': 'runtime',
  'general.terminalShell': 'terminal',
  'general.windowsLocalShell': 'terminal',
  'appearance.fileOpening': 'general',
  'terminal.context-menu-opening': 'general',
  'terminal.font-size': 'appearance',
  'terminal.font': 'appearance',
  'appearance.chatTypography': 'conversation',
  'appearance.navRailSide': 'conversation',
  'appearance.openChangesOnFileEdit': 'conversation',
  'appearance.compactReadOnlyTools': 'conversation',
  'appearance.expandLiveEdits': 'conversation',
  'appearance.expandLiveReasoning': 'conversation',
  'appearance.autoCollapseTurns': 'conversation',
  'appearance.quoteSelectionButton': 'conversation',
  'appearance.collapseCompletedActivity': 'conversation',
  'appearance.collapseLiveActivity': 'conversation',
  'appearance.liveActivityFoldDelaySec': 'conversation',
  'appearance.pinUnfinishedTodos': 'conversation',
  'appearance.headerSessionTabs': 'conversation',
};

/** 行号前缀即分区；拆页后挪走的行以 ROW_RELOCATIONS 为准。 */
export function categoryForSettingsRow(rowId: string): string {
  const relocated = ROW_RELOCATIONS[rowId];
  if (relocated) return relocated;
  const dot = rowId.indexOf('.');
  return dot === -1 ? rowId : rowId.slice(0, dot);
}

export function relocateSettingsLink<T extends SettingsDeepLink>(link: T): T {
  const category = ROW_RELOCATIONS[link.rowId];
  return category ? { ...link, category } : link;
}

export function parseSettingsDeepLink(raw: unknown): SettingsDeepLink | null {
  const link = parseRawSettingsDeepLink(raw);
  return link && relocateSettingsLink(link);
}

function parseRawSettingsDeepLink(raw: unknown): SettingsDeepLink | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const category = (raw as { category?: unknown }).category;
  const rowId = (raw as { rowId?: unknown }).rowId ?? `${String(category)}.root`;
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
