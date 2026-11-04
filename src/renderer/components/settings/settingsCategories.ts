import { type SettingsSearchEntry, searchSettingsEntries } from '@shared/searchAnything';
import type { SettingsCategory } from './constants';

/**
 * 记忆、工作流分页跟随内置工具开关显隐：功能没开就不该占一个入口。
 *
 * 关掉后仍能重新打开——「内置工具」页会遍历 BUILTIN_TOOLS，开关都在那里，
 * 所以隐藏入口不会造成没法再启用的死锁。
 */

/** 依赖某个内置工具才显示的分页 */
const TOOL_GATED: Partial<Record<SettingsCategory, string>> = {
  memory: 'memory',
  workflows: 'workflow',
};
const BOT_PAGES: readonly SettingsCategory[] = ['bots', 'botTemplates'];

export type SettingsGroupId = 'app' | 'agent' | 'extensions' | 'connections' | 'system';

export const SETTINGS_GROUPS: readonly {
  id: SettingsGroupId;
  label: string;
  categories: readonly SettingsCategory[];
}[] = [
  {
    id: 'app',
    label: 'Application',
    categories: ['general', 'appearance', 'shortcuts', 'voice', 'privacy'],
  },
  {
    id: 'agent',
    label: 'Models & agents',
    categories: ['providers', 'presets', 'agents', 'instructions', 'memory'],
  },
  {
    id: 'extensions',
    label: 'Tools & extensions',
    categories: ['tools', 'workflows', 'skills', 'mcp', 'plugins', 'claudePlugins'],
  },
  {
    id: 'connections',
    label: 'Connections',
    categories: ['phone', 'ssh'],
  },
  {
    id: 'system',
    label: 'System',
    categories: ['usage', 'resources', 'experimental', 'bots', 'botTemplates'],
  },
];

export function groupCategories<T extends { id: SettingsCategory }>(
  items: readonly T[]
): { id: SettingsGroupId; label: string; items: T[] }[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return SETTINGS_GROUPS.flatMap((group) => {
    const grouped = group.categories.flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
    return grouped.length > 0 ? [{ id: group.id, label: group.label, items: grouped }] : [];
  });
}

export function isCategoryVisible(
  category: SettingsCategory,
  disabledBuiltinTools: readonly string[],
  botModeEnabled = false
): boolean {
  // Bot 模式页跟随「实验」里的开关；开关所在的实验页始终可见
  if (BOT_PAGES.includes(category)) return botModeEnabled;
  const tool = TOOL_GATED[category];
  return !tool || !disabledBuiltinTools.includes(tool);
}

export function visibleCategories<T extends { id: SettingsCategory }>(
  categories: readonly T[],
  disabledBuiltinTools: readonly string[],
  botModeEnabled = false
): T[] {
  return categories.filter((c) => isCategoryVisible(c.id, disabledBuiltinTools, botModeEnabled));
}

/**
 * 当前分页被隐藏时该落到哪里。回到「内置工具」而不是「通用」：
 * 用户刚把它关掉（或 deeplink 指向了一个未启用的功能），
 * 落在能重新打开它的地方才合理。
 */
export function resolveActiveCategory(
  active: SettingsCategory,
  disabledBuiltinTools: readonly string[],
  botModeEnabled = false
): SettingsCategory {
  if (isCategoryVisible(active, disabledBuiltinTools, botModeEnabled)) return active;
  return BOT_PAGES.includes(active) ? 'experimental' : 'tools';
}

export function searchCategories<T extends { id: SettingsCategory; label: string }>(
  items: readonly T[],
  entries: readonly SettingsSearchEntry[],
  query: string,
  translate?: (value: string) => string
): Array<T & { hits: SettingsSearchEntry[] }> {
  const trimmed = query.trim();
  if (!trimmed) return items.map((item) => ({ ...item, hits: [] }));

  const matched = searchSettingsEntries(
    [
      ...entries,
      ...items.map((item) => ({
        id: `${item.id}.root`,
        category: item.id,
        title: item.label,
      })),
    ],
    trimmed,
    { translate, limit: Number.POSITIVE_INFINITY }
  );

  const matchedCategories = new Set<string>();
  const hitsByCategory = new Map<string, SettingsSearchEntry[]>();
  for (const entry of matched) {
    matchedCategories.add(entry.category);
    if (entry.id.endsWith('.root')) continue;
    const hits = hitsByCategory.get(entry.category);
    if (hits) hits.push(entry);
    else hitsByCategory.set(entry.category, [entry]);
  }

  return items.flatMap((item) =>
    matchedCategories.has(item.id) ? [{ ...item, hits: hitsByCategory.get(item.id) ?? [] }] : []
  );
}
