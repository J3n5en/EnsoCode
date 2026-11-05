export interface MarketFilterItem {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export function marketCategories(plugins: { tags: string[] }[]): string[] {
  const tags = new Set<string>();
  for (const plugin of plugins) {
    for (const tag of plugin.tags) {
      const value = tag.trim();
      if (value) tags.add(value);
    }
  }
  return [...tags].sort((a, b) => a.localeCompare(b));
}

export function filterMarketPlugins<T extends MarketFilterItem>(
  plugins: T[],
  options: { query: string; category: string | null }
): T[] {
  const q = options.query.trim().toLowerCase();
  const category = options.category?.trim() || null;
  return plugins.filter((plugin) => {
    if (category && !plugin.tags.some((tag) => tag.trim() === category)) return false;
    if (!q) return true;
    return [plugin.id, plugin.name, plugin.description, ...plugin.tags].some((value) =>
      value.toLowerCase().includes(q)
    );
  });
}
