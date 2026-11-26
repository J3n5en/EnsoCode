/**
 * composer 工具行的 pin/排序状态。
 * pinned 是显示在工具行里的按钮 id。order 是按钮与弹性空白的排列
 * （popover 按它渲染，工具行里的 pinned 按钮和 spacer 也按它排）。
 */

export const COMPOSER_TOOLBAR_ITEM_IDS = [
  'preset',
  'worktree',
  'plan-mode',
  'approval-mode',
  'model',
  'learn',
  'add-image',
] as const;

export type ComposerToolbarItemId = (typeof COMPOSER_TOOLBAR_ITEM_IDS)[number];

/** `spacer`，或 `spacer-` 加数字。编辑器插入的是 `spacer` 与 `spacer-2`…`spacer-5`。 */
export type ComposerToolbarSpacerKey = 'spacer' | `spacer-${number}`;

export type ComposerToolbarEntry = ComposerToolbarItemId | ComposerToolbarSpacerKey;

export const COMPOSER_TOOLBAR_MAX_SPACERS = 5;

const SPACER_KEY = /^spacer(-\d+)?$/;
const SPACER_INSERT_KEYS = ['spacer', 'spacer-2', 'spacer-3', 'spacer-4', 'spacer-5'] as const;

export interface ComposerToolbarSettings {
  order: ComposerToolbarEntry[];
  pinned: ComposerToolbarItemId[];
}

/** 默认顺序：预设、分支、Plan、权限、模型、复盘、添加图片 */
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

export function isSpacerKey(value: unknown): value is ComposerToolbarSpacerKey {
  return typeof value === 'string' && SPACER_KEY.test(value);
}

function normalizePinned(value: unknown): ComposerToolbarItemId[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<ComposerToolbarItemId>();
  for (const entry of value) {
    if (isItemId(entry) && !seen.has(entry)) seen.add(entry);
  }
  return [...seen];
}

function normalizeOrder(value: unknown): ComposerToolbarEntry[] {
  const seenItems = new Set<ComposerToolbarItemId>();
  const seenSpacers = new Set<string>();
  const order: ComposerToolbarEntry[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (isItemId(entry)) {
        if (seenItems.has(entry)) continue;
        seenItems.add(entry);
        order.push(entry);
        continue;
      }
      if (!isSpacerKey(entry) || seenSpacers.has(entry)) continue;
      if (seenSpacers.size >= COMPOSER_TOOLBAR_MAX_SPACERS) continue;
      seenSpacers.add(entry);
      order.push(entry);
    }
  }
  for (const id of COMPOSER_TOOLBAR_ITEM_IDS) {
    if (!seenItems.has(id)) order.push(id);
  }
  return order;
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
  return { order: normalizeOrder(record.order), pinned: normalizePinned(record.pinned) };
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

/** 把条目移到 order 的目标下标（拖拽排序落点），未知条目或越界下标原样返回 */
export function reorderComposerToolbar(
  settings: ComposerToolbarSettings,
  id: ComposerToolbarEntry,
  targetIndex: number
): ComposerToolbarSettings {
  const from = settings.order.indexOf(id);
  if (from === -1 || targetIndex < 0 || targetIndex >= settings.order.length) return settings;
  const order = [...settings.order];
  order.splice(from, 1);
  order.splice(targetIndex, 0, id);
  return { order, pinned: settings.pinned };
}

/** 在 order 的 index 处插入一个新 spacer。已达 5 个时返回原对象。 */
export function insertComposerToolbarSpacer(
  settings: ComposerToolbarSettings,
  index: number
): ComposerToolbarSettings {
  const used = settings.order.filter(isSpacerKey);
  if (used.length >= COMPOSER_TOOLBAR_MAX_SPACERS) return settings;
  const key = SPACER_INSERT_KEYS.find((candidate) => !used.includes(candidate));
  if (!key) return settings;
  const order = [...settings.order];
  const at = Math.min(Math.max(index, 0), order.length);
  order.splice(at, 0, key);
  return { order, pinned: settings.pinned };
}

/** 从 order 移除 spacer。不存在时返回原对象。 */
export function removeComposerToolbarSpacer(
  settings: ComposerToolbarSettings,
  key: ComposerToolbarSpacerKey
): ComposerToolbarSettings {
  if (!settings.order.includes(key)) return settings;
  return { order: settings.order.filter((entry) => entry !== key), pinned: settings.pinned };
}

function isStoredOrder(list: unknown): boolean {
  if (!Array.isArray(list)) return false;
  const seen = new Set<string>();
  let spacers = 0;
  for (const entry of list) {
    if (typeof entry !== 'string' || seen.has(entry)) return false;
    if (isItemId(entry)) {
      seen.add(entry);
      continue;
    }
    if (!isSpacerKey(entry)) return false;
    seen.add(entry);
    spacers += 1;
    if (spacers > COMPOSER_TOOLBAR_MAX_SPACERS) return false;
  }
  return true;
}

function isStoredPinned(list: unknown): boolean {
  if (!Array.isArray(list)) return false;
  if (list.some((entry) => !isItemId(entry))) return false;
  return new Set(list).size === list.length;
}

/** 严格校验（configSync 导入）：形状、键集合、id 合法性、无重复，缺一不可 */
export function isStoredComposerToolbar(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes('order') || !keys.includes('pinned')) return false;
  return isStoredOrder(record.order) && isStoredPinned(record.pinned);
}
