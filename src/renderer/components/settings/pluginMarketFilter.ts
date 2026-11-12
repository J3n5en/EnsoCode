import { MARKET_CATEGORIES, type MarketCategory } from '@shared/extensionPlugins/marketCategories';

export interface MarketFilterItem {
  id: string;
  name: string;
  description: string;
  tier: 'official' | 'community';
  tags: string[];
  category?: MarketCategory;
  installedVersion?: string;
  updateAvailable: boolean;
}

/** 市场左栏的分区：全部、已安装、可更新、各分类、没分类的「其他」 */
export type MarketSection = 'all' | 'installed' | 'updates' | MarketCategory | 'other';

function inSection(plugin: MarketFilterItem, section: MarketSection): boolean {
  if (section === 'all') return true;
  if (section === 'installed') return plugin.installedVersion !== undefined;
  if (section === 'updates') return plugin.updateAvailable;
  if (section === 'other') return plugin.category === undefined;
  return plugin.category === section;
}

/** 有插件的分区与数量；全部、已安装、可更新总在前面 */
export function marketSections(
  plugins: readonly MarketFilterItem[]
): { id: MarketSection; count: number }[] {
  const count = (section: MarketSection) => plugins.filter((p) => inSection(p, section)).length;
  const fixed: MarketSection[] = ['all', 'installed', 'updates'];
  const rest: MarketSection[] = [...MARKET_CATEGORIES, 'other'];
  return [
    ...fixed.map((id) => ({ id, count: count(id) })),
    ...rest.map((id) => ({ id, count: count(id) })).filter((item) => item.count > 0),
  ];
}

export function filterMarketPlugins<T extends MarketFilterItem>(
  plugins: readonly T[],
  options: { query: string; section: MarketSection }
): T[] {
  const q = options.query.trim().toLowerCase();
  return plugins
    .filter((plugin) => {
      if (!inSection(plugin, options.section)) return false;
      if (!q) return true;
      return [plugin.id, plugin.name, plugin.description, ...plugin.tags].some((value) =>
        value.toLowerCase().includes(q)
      );
    })
    .sort((a, b) =>
      a.tier !== b.tier ? (a.tier === 'official' ? -1 : 1) : a.name.localeCompare(b.name)
    );
}
