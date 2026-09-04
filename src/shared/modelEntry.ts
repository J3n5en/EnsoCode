import { pickModelCapabilityOverrides, resolveCustomModelView } from './modelCatalog';
import type { FetchedModel, ModelCapabilityOverrides, ModelEntry, ModelMeta } from './types';

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

/** 保存时把「添加模型 ID」输入框里还没点 + 的内容一并提交，避免只填了 ID 就点保存被当成空清单。 */
export function commitPendingModel(models: readonly ModelEntry[], pending: string): ModelEntry[] {
  const id = pending.trim();
  if (!id || models.some((model) => model.id === id)) return [...models];
  return [...models, { id, enabled: true }];
}

/**
 * 拉取结果并入已有模型列表（Fetch Models 按钮的唯一合并逻辑）：
 * - 新模型追加到末尾，默认启用，携带拉到的 contextWindow/maxTokens；
 * - 已有模型只回填缺失字段，绝不覆盖已有值（已有值 = 用户覆盖，优先级更高）。
 */
export function mergeFetchedModels(
  current: readonly ModelEntry[],
  fetched: readonly FetchedModel[]
): ModelEntry[] {
  const byId = new Map(fetched.map((model) => [model.id, model]));
  const known = new Set(current.map((model) => model.id));
  const updated = current.map((model) => {
    const hit = byId.get(model.id);
    if (!hit) return model;
    const next: ModelEntry = { ...model };
    if (next.contextWindow === undefined && hit.contextWindow !== undefined)
      next.contextWindow = hit.contextWindow;
    if (next.maxTokens === undefined && hit.maxTokens !== undefined) next.maxTokens = hit.maxTokens;
    return next;
  });
  const fresh = fetched
    .filter((model) => !known.has(model.id))
    .map(
      (model): ModelEntry => ({
        id: model.id,
        enabled: true,
        ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
        ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
      })
    );
  return [...updated, ...fresh];
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
  const { id, label, enabled } = next;
  return {
    id,
    ...(label !== undefined ? { label } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...cleaned,
  };
}
