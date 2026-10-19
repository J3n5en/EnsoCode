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
 * 用成功拉取的完整清单同步模型：移除上游缺席的条目（包括手动添加的模型），
 * 空清单会清空本地列表。同 ID 去重；仍存在的模型保留原顺序与用户设置，
 * 只回填缺失元数据；新模型追加到末尾并默认启用。调用方不能传入失败结果。
 *
 * Synchronize against a successfully fetched complete list, removing absent entries
 * (including manually added models) and clearing the local list when it is empty.
 * Deduplicate fetched IDs, preserve retained order and user settings, backfill only
 * missing metadata, and append enabled new models. Callers must exclude failed results.
 */
export function mergeFetchedModels(
  current: readonly ModelEntry[],
  fetched: readonly FetchedModel[]
): ModelEntry[] {
  const byId = new Map(fetched.map((model) => [model.id, model]));
  const known = new Set(current.map((model) => model.id));
  const updated = current.flatMap((model) => {
    const hit = byId.get(model.id);
    if (!hit) return [];
    const next: ModelEntry = { ...model };
    if (next.contextWindow === undefined && hit.contextWindow !== undefined)
      next.contextWindow = hit.contextWindow;
    if (next.maxTokens === undefined && hit.maxTokens !== undefined) next.maxTokens = hit.maxTokens;
    return [next];
  });
  const fresh = [...byId.values()]
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
