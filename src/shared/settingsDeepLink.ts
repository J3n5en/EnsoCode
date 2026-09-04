export const SETTINGS_CATEGORIES = [
  'general',
  'shortcuts',
  'appearance',
  'providers',
  'skills',
  'mcp',
  'instructions',
  'presets',
  'agents',
  'tools',
  'phone',
  'ssh',
  'usage',
] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

export interface SettingsDeepLink {
  category: SettingsCategory;
  rowId: string;
}

const CATEGORY_SET = new Set<string>(SETTINGS_CATEGORIES);

export function parseSettingsDeepLink(raw: unknown): SettingsDeepLink | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const category = (raw as { category?: unknown }).category;
  const rowId = (raw as { rowId?: unknown }).rowId;
  if (typeof category !== 'string' || !CATEGORY_SET.has(category)) return null;
  if (typeof rowId !== 'string' || !rowId) return null;
  return { category: category as SettingsCategory, rowId };
}
