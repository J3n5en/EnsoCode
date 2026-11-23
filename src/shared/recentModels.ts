import type { ModelRef } from './types/agent';

export const MAX_RECENT_MODELS = 10;

export function sameModelRef(a: ModelRef, b: ModelRef): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId;
}

/** 最近用的排最前，去重，超出上限丢最旧；只保留 id，不带入其他字段。 */
export function pushRecentModel(list: readonly ModelRef[], ref: ModelRef): ModelRef[] {
  const entry = { providerId: ref.providerId, modelId: ref.modelId };
  return [entry, ...list.filter((item) => !sameModelRef(item, entry))].slice(0, MAX_RECENT_MODELS);
}

export function removeRecentModel(list: readonly ModelRef[], ref: ModelRef): ModelRef[] {
  return list.filter((item) => !sameModelRef(item, ref));
}

/** settings.json 可被外部改写：丢弃非法条目后按同一规则去重截断。 */
export function parseRecentModels(value: unknown): ModelRef[] {
  if (!Array.isArray(value)) return [];
  const out: ModelRef[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const { providerId, modelId } = item as Record<string, unknown>;
    if (typeof providerId !== 'string' || !providerId) continue;
    if (typeof modelId !== 'string' || !modelId) continue;
    const entry = { providerId, modelId };
    if (out.some((existing) => sameModelRef(existing, entry))) continue;
    out.push(entry);
    if (out.length === MAX_RECENT_MODELS) break;
  }
  return out;
}

/** 外部写入只收原样合法的列表：恰好 providerId/modelId 两个字段、去重、不超上限；不看键序。 */
export function isRecentModelList(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const parsed = parseRecentModels(value);
  return (
    parsed.length === value.length &&
    parsed.every((ref, i) => Object.keys(value[i]).length === 2 && sameModelRef(ref, value[i]))
  );
}
