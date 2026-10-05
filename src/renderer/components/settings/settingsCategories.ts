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
