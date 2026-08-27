import type { ModelEntry, ModelMeta } from './types';

/** 模型级覆盖字段。缺失 = 跟随，由后续 resolveBaseModel 按 catalog / 乐观默认解析。 */
export const MODEL_OVERRIDE_KEYS = [
  'reasoning',
  'thinkingLevel',
  'contextWindow',
  'maxTokens',
] as const;

export type ModelOverrideKey = (typeof MODEL_OVERRIDE_KEYS)[number];
export type ModelOverrideFields = Pick<ModelEntry, ModelOverrideKey>;

/** 行徽章：已覆盖 / catalog / 默认；lookup 未完成时回退 inherit（跟随）。 */
export type ModelRowBadge = 'override' | 'catalog' | 'default' | 'inherit';

export function hasModelOverrides(model: ModelOverrideFields): boolean {
  return MODEL_OVERRIDE_KEYS.some((key) => model[key] !== undefined);
}

/**
 * `queryModelMeta` 的 source 已能区分 catalog 命中与未知。
 * 查不到 / 还没查 → undefined，调用方不要把「未知」捏成 catalog。
 */
export function catalogMatchedFromMeta(
  meta: Pick<ModelMeta, 'source'> | undefined
): boolean | undefined {
  if (!meta) return undefined;
  return meta.source === 'catalog' || meta.source === 'catalog-fallback';
}

/**
 * 行徽章来源。`catalogMatched`：
 * - true：`queryModelMeta` 命中 catalog / catalog-fallback
 * - false：已查且无 catalog 行
 * - undefined：lookup 未接线或未完成 —— 显示跟随，不要猜 catalog vs 默认
 */
export function modelRowBadge(model: ModelOverrideFields, catalogMatched?: boolean): ModelRowBadge {
  if (hasModelOverrides(model)) return 'override';
  if (catalogMatched === true) return 'catalog';
  if (catalogMatched === false) return 'default';
  return 'inherit';
}

/** 把覆盖写成「缺失=跟随」：显式 undefined 会从对象上删掉键，避免 JSON 落盘 null。 */
export function applyModelOverrides(
  model: ModelEntry,
  patch: Partial<ModelOverrideFields>
): ModelEntry {
  const next: ModelEntry = { ...model };
  for (const key of MODEL_OVERRIDE_KEYS) {
    if (!Object.hasOwn(patch, key)) continue;
    const value = patch[key];
    if (value === undefined) delete next[key];
    else (next as ModelOverrideFields)[key] = value as never;
  }
  return next;
}
