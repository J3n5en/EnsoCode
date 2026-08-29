import { pickModelCapabilityOverrides, resolveCustomModelView } from './modelCatalog';
import type { ModelCapabilityOverrides, ModelEntry, ModelMeta } from './types';

/** 模型级覆盖字段。缺失 = 跟随；合法值由 `pickModelCapabilityOverrides` 过滤。 */
export const MODEL_OVERRIDE_KEYS = [
  'reasoning',
  'thinkingLevel',
  'contextWindow',
  'maxTokens',
] as const;

export type ModelOverrideKey = (typeof MODEL_OVERRIDE_KEYS)[number];

/** 行徽章：已覆盖 / catalog / 默认。分层只走 `resolveCustomModelView`。 */
export type ModelRowBadge = 'override' | 'catalog' | 'default';

export function hasModelOverrides(model: ModelCapabilityOverrides): boolean {
  return Object.keys(pickModelCapabilityOverrides(model)).length > 0;
}

/**
 * 行徽章来源。覆盖优先；否则用 `resolveCustomModelView` 的 source
 * （catalog-fallback / catalog → catalog，unknown / 未查 → default）。
 * 不要另写一份 catalog vs 默认判定。
 */
export function modelRowBadge(
  model: ModelCapabilityOverrides,
  catalogMeta?: ModelMeta
): ModelRowBadge {
  const view = resolveCustomModelView(model, catalogMeta);
  const sources = Object.values(view.source);
  if (sources.includes('override')) return 'override';
  if (sources.includes('catalog')) return 'catalog';
  return 'default';
}

/** 把覆盖写成「缺失=跟随」：显式 undefined 删键，且不落盘 `'follow'` / 非法值。 */
export function applyModelOverrides(
  model: ModelEntry,
  patch: Partial<ModelCapabilityOverrides>
): ModelEntry {
  const next: ModelEntry = { ...model };
  for (const key of MODEL_OVERRIDE_KEYS) {
    if (!Object.hasOwn(patch, key)) continue;
    const value = patch[key];
    if (value === undefined) delete next[key];
    else (next as ModelCapabilityOverrides)[key] = value as never;
  }
  const cleaned = pickModelCapabilityOverrides(next);
  const { id, label, enabled, subagent } = next;
  return {
    id,
    ...(label !== undefined ? { label } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(subagent !== undefined ? { subagent } : {}),
    ...cleaned,
  };
}
