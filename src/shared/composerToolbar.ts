/**
 * composer 工具行按钮的 pin/排序状态。
 * pinned 控制哪些按钮显示在工具行里，order 是全部按钮的排列顺序（popover 按它渲染，
 * 工具行内的 pinned 按钮也按 order 排序），两者都只含已知 id。
 */

export const COMPOSER_TOOLBAR_ITEM_IDS = [
  'preset',
  'worktree',
  'plan-mode',
  'approval-mode',
  'model',
  'learn',
] as const;

export type ComposerToolbarItemId = (typeof COMPOSER_TOOLBAR_ITEM_IDS)[number];

export interface ComposerToolbarSettings {
  order: ComposerToolbarItemId[];
  pinned: ComposerToolbarItemId[];
}

/** 默认顺序：预设、分支、Plan、权限、模型、复盘 */
export const COMPOSER_TOOLBAR_DEFAULT_ORDER: readonly ComposerToolbarItemId[] =
  COMPOSER_TOOLBAR_ITEM_IDS;

/** 默认 pin 在外面：预设、分支、权限、模型（用户明确要求） */
export const COMPOSER_TOOLBAR_DEFAULT_PINNED: readonly ComposerToolbarItemId[] = [
  'preset',
  'worktree',
  'approval-mode',
  'model',
];

function isItemId(value: unknown): value is ComposerToolbarItemId {
  return (COMPOSER_TOOLBAR_ITEM_IDS as readonly unknown[]).includes(value);
}

function normalizeIdList(value: unknown): ComposerToolbarItemId[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<ComposerToolbarItemId>();
  for (const entry of value) {
    if (isItemId(entry) && !seen.has(entry)) seen.add(entry);
  }
  return [...seen];
}

/** 宽容归一化（本地 store / 热更新路径）：未知 id 丢弃，order 补齐漏掉的 id */
export function normalizeComposerToolbar(value: unknown): ComposerToolbarSettings {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  if (!record) {
    return {
      order: [...COMPOSER_TOOLBAR_DEFAULT_ORDER],
      pinned: [...COMPOSER_TOOLBAR_DEFAULT_PINNED],
    };
  }
  const order = normalizeIdList(record.order);
  for (const id of COMPOSER_TOOLBAR_ITEM_IDS) {
    if (!order.includes(id)) order.push(id);
  }
  return { order, pinned: normalizeIdList(record.pinned) };
}

export function pinComposerToolbarItem(
  settings: ComposerToolbarSettings,
  id: ComposerToolbarItemId
): ComposerToolbarSettings {
  if (settings.pinned.includes(id)) return settings;
  return { order: settings.order, pinned: [...settings.pinned, id] };
}

export function unpinComposerToolbarItem(
  settings: ComposerToolbarSettings,
  id: ComposerToolbarItemId
): ComposerToolbarSettings {
  if (!settings.pinned.includes(id)) return settings;
  return { order: settings.order, pinned: settings.pinned.filter((entry) => entry !== id) };
}

/** 把 id 移到 order 的目标下标（拖拽排序落点），未知 id 或越界下标原样返回 */
export function reorderComposerToolbar(
  settings: ComposerToolbarSettings,
  id: ComposerToolbarItemId,
  targetIndex: number
): ComposerToolbarSettings {
  const from = settings.order.indexOf(id);
  if (from === -1 || targetIndex < 0 || targetIndex >= settings.order.length) return settings;
  const order = [...settings.order];
  order.splice(from, 1);
  order.splice(targetIndex, 0, id);
  return { order, pinned: settings.pinned };
}

/** 严格校验（configSync 导入）：形状、键集合、id 合法性、无重复，缺一不可 */
export function isStoredComposerToolbar(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes('order') || !keys.includes('pinned')) return false;
  for (const key of ['order', 'pinned'] as const) {
    const list = record[key];
    if (!Array.isArray(list)) return false;
    if (list.some((entry) => !isItemId(entry))) return false;
    if (new Set(list).size !== list.length) return false;
  }
  return true;
}
