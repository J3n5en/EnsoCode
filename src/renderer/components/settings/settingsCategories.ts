import { type SettingsSearchEntry, searchSettingsEntries } from '@shared/searchAnything';
import type { SettingsCategory } from './constants';

export const SETTINGS_CATEGORY_LABELS: Record<SettingsCategory, string> = {
  general: 'General',
  shortcuts: 'Shortcuts',
  appearance: 'Appearance',
  conversation: 'Conversation display',
  terminal: 'Terminal',
  runtime: 'Runtime & sessions',
  providers: 'Model Providers',
  skills: 'Skills',
  plugins: 'Enso plugins',
  mcp: 'MCP Servers',
  instructions: 'Instruction Files',
  presets: 'Presets',
  agents: 'Agent types',
  workflows: 'Workflows',
  tools: 'Built-in tools',
  memory: 'Memory',
  privacy: 'Privacy',
  phone: 'Devices',
  ssh: 'SSH',
  usage: 'Usage',
  resources: 'Resources',
  logs: 'Logs',
  experimental: 'Experimental',
  bots: 'Bot mode',
  botTemplates: 'Bot templates',
  secretary: 'Secretary',
  contacts: 'Contacts & owner',
};

export function categoryGroup(
  category: string
): { id: SettingsGroupId; label: string } | undefined {
  return SETTINGS_GROUPS.find((group) =>
    (group.categories as readonly string[]).includes(category)
  );
}

/** 组名 › 分类名 › 标题。includeTitle 为 false 时停在分类名，给侧栏副行用。 */
export function settingsEntryPath(
  entry: { category: string; title: string },
  translate: (text: string) => string,
  includeTitle = true
): string {
  const group = categoryGroup(entry.category);
  const categoryLabel =
    SETTINGS_CATEGORY_LABELS[entry.category as SettingsCategory] ?? entry.category;
  const parts = [group ? translate(group.label) : '', translate(categoryLabel)];
  if (includeTitle) parts.push(translate(entry.title));
  return parts.filter((part) => part.length > 0).join(' › ');
}

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
const SECRETARY_PAGES: readonly SettingsCategory[] = ['secretary', 'contacts'];

export type SettingsGroupId =
  | 'app'
  | 'agent'
  | 'extensions'
  | 'secretary'
  | 'connections'
  | 'system';

export const SETTINGS_GROUPS: readonly {
  id: SettingsGroupId;
  label: string;
  categories: readonly SettingsCategory[];
}[] = [
  {
    id: 'app',
    label: 'Application',
    categories: ['general', 'appearance', 'conversation', 'terminal', 'shortcuts', 'privacy'],
  },
  {
    id: 'agent',
    label: 'Models & agents',
    categories: ['providers', 'presets', 'agents', 'instructions', 'memory', 'runtime'],
  },
  {
    id: 'extensions',
    label: 'Tools & extensions',
    categories: ['tools', 'workflows', 'skills', 'mcp', 'plugins'],
  },
  {
    id: 'secretary',
    label: 'Secretary & contacts',
    categories: ['secretary', 'contacts'],
  },
  {
    id: 'connections',
    label: 'Connections',
    categories: ['phone', 'ssh'],
  },
  {
    id: 'system',
    label: 'System',
    categories: ['usage', 'resources', 'logs', 'experimental', 'bots', 'botTemplates'],
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
  botModeEnabled = false,
  secretaryEnabled = false
): boolean {
  // 秘书页跟随「实验」里的开关，开关所在的实验页始终可见
  if (SECRETARY_PAGES.includes(category)) return secretaryEnabled;
  // Bot 模式页跟随「实验」里的开关；开关所在的实验页始终可见
  if (BOT_PAGES.includes(category)) return botModeEnabled;
  // 秘书不受 memory 工具开关约束、始终会写自己的记忆，开着秘书就得能在这里管理它们
  if (category === 'memory' && secretaryEnabled) return true;
  const tool = TOOL_GATED[category];
  return !tool || !disabledBuiltinTools.includes(tool);
}

export function visibleCategories<T extends { id: SettingsCategory }>(
  categories: readonly T[],
  disabledBuiltinTools: readonly string[],
  botModeEnabled = false,
  secretaryEnabled = false
): T[] {
  return categories.filter((c) =>
    isCategoryVisible(c.id, disabledBuiltinTools, botModeEnabled, secretaryEnabled)
  );
}

/**
 * 当前分页被隐藏时该落到哪里。回到「内置工具」而不是「通用」：
 * 用户刚把它关掉（或 deeplink 指向了一个未启用的功能），
 * 落在能重新打开它的地方才合理。
 */
export function resolveActiveCategory(
  active: SettingsCategory,
  disabledBuiltinTools: readonly string[],
  botModeEnabled = false,
  secretaryEnabled = false
): SettingsCategory {
  if (isCategoryVisible(active, disabledBuiltinTools, botModeEnabled, secretaryEnabled))
    return active;
  return BOT_PAGES.includes(active) || SECRETARY_PAGES.includes(active) ? 'experimental' : 'tools';
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
