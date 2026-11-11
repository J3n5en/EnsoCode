import { type CatalogModelEntry, findCatalogModelById } from './modelCatalog';

export const MODELS_DEV_URL = 'https://models.dev/api.json';
export const MODELS_DEV_TTL_MS = 4 * 60 * 60 * 1000;
export const MODELS_DEV_SCHEMA_VERSION = 1;
export const MODELS_DEV_CACHE_NAME = 'models-dev-cache.json';

export interface ModelsDevCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelsDevModel extends CatalogModelEntry {
  provider: string;
  name?: string;
  cost?: ModelsDevCost;
}

export interface ModelsDevCache {
  schemaVersion: typeof MODELS_DEV_SCHEMA_VERSION;
  source: string;
  fetchedAt: number;
  etag?: string;
  models: ModelsDevModel[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isTextChat(model: Record<string, unknown>): boolean {
  if (model.tool_call !== true) return false;
  const output = asRecord(model.modalities)?.output;
  if (output === undefined) return true;
  return Array.isArray(output) && output.includes('text');
}

function parseCost(value: unknown): ModelsDevCost | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const input = nonNegative(record.input);
  const output = nonNegative(record.output);
  const cacheRead = nonNegative(record.cache_read);
  const cacheWrite = nonNegative(record.cache_write);
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined
  ) {
    return undefined;
  }
  const cost = {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
  };
  return cost.input || cost.output || cost.cacheRead || cost.cacheWrite ? cost : undefined;
}

function parseLiveModel(provider: string, key: string, value: unknown): ModelsDevModel | undefined {
  const model = asRecord(value);
  if (!model || !isTextChat(model)) return undefined;
  const id = typeof model.id === 'string' && model.id.trim() ? model.id.trim() : key.trim();
  if (!id) return undefined;
  const limit = asRecord(model.limit);
  const contextWindow = positiveInt(limit?.context) ?? positiveInt(limit?.input);
  const maxTokens = positiveInt(limit?.output);
  const name = typeof model.name === 'string' && model.name.trim() ? model.name.trim() : undefined;
  const cost = parseCost(model.cost);
  return {
    id,
    provider,
    ...(name ? { name } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
    ...(typeof model.reasoning === 'boolean' ? { reasoning: model.reasoning } : {}),
    ...(cost ? { cost } : {}),
  };
}

/** models.dev 的 /api.json。没有可对话模型时视为无效，调用方继续用旧缓存。 */
export function parseModelsDevPayload(
  raw: unknown,
  fetchedAt: number,
  source = MODELS_DEV_URL
): ModelsDevCache | undefined {
  const root = asRecord(raw);
  if (!root || !Number.isFinite(fetchedAt)) return undefined;
  const models: ModelsDevModel[] = [];
  for (const [provider, value] of Object.entries(root)) {
    const modelsRecord = asRecord(asRecord(value)?.models);
    if (!provider || !modelsRecord) continue;
    for (const [key, model] of Object.entries(modelsRecord)) {
      const parsed = parseLiveModel(provider, key, model);
      if (parsed) models.push(parsed);
    }
  }
  if (models.length === 0) return undefined;
  return { schemaVersion: MODELS_DEV_SCHEMA_VERSION, source, fetchedAt, models };
}

function parseCachedModel(value: unknown): ModelsDevModel | undefined {
  const model = asRecord(value);
  if (
    !model ||
    typeof model.id !== 'string' ||
    !model.id ||
    typeof model.provider !== 'string' ||
    !model.provider
  ) {
    return undefined;
  }
  const contextWindow = positiveInt(model.contextWindow);
  const maxTokens = positiveInt(model.maxTokens);
  const name = typeof model.name === 'string' && model.name ? model.name : undefined;
  const cost = parseCachedCost(model.cost);
  return {
    id: model.id,
    provider: model.provider,
    ...(name ? { name } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
    ...(typeof model.reasoning === 'boolean' ? { reasoning: model.reasoning } : {}),
    ...(cost ? { cost } : {}),
  };
}

function parseCachedCost(value: unknown): ModelsDevCost | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const input = nonNegative(record.input);
  const output = nonNegative(record.output);
  const cacheRead = nonNegative(record.cacheRead);
  const cacheWrite = nonNegative(record.cacheWrite);
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined
  ) {
    return undefined;
  }
  const cost = {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
  };
  return cost.input || cost.output || cost.cacheRead || cost.cacheWrite ? cost : undefined;
}

export function parseModelsDevCache(raw: unknown): ModelsDevCache | undefined {
  const record = asRecord(raw);
  if (!record || record.schemaVersion !== MODELS_DEV_SCHEMA_VERSION) return undefined;
  if (typeof record.source !== 'string' || !record.source) return undefined;
  if (typeof record.fetchedAt !== 'number' || !Number.isFinite(record.fetchedAt)) return undefined;
  if (!Array.isArray(record.models)) return undefined;
  const models = record.models
    .map(parseCachedModel)
    .filter((model): model is ModelsDevModel => model !== undefined);
  if (models.length === 0) return undefined;
  const etag = typeof record.etag === 'string' && record.etag ? record.etag : undefined;
  return {
    schemaVersion: MODELS_DEV_SCHEMA_VERSION,
    source: record.source,
    fetchedAt: record.fetchedAt,
    ...(etag ? { etag } : {}),
    models,
  };
}

export function modelsDevIsFresh(
  cache: { fetchedAt: number } | undefined,
  now: number,
  ttlMs = MODELS_DEV_TTL_MS
): boolean {
  return cache !== undefined && now - cache.fetchedAt < ttlMs;
}

/** models.dev 的窗口盖过静态目录；pi 已有的 reasoning / thinkingLevelMap 保持不动。 */
export function mergeCatalogEntry<T extends CatalogModelEntry>(
  pi: T | undefined,
  dev: ModelsDevModel | undefined
): T | CatalogModelEntry | undefined {
  if (!dev) return pi;
  if (!pi) {
    return {
      id: dev.id,
      ...(dev.provider ? { provider: dev.provider } : {}),
      ...(dev.contextWindow ? { contextWindow: dev.contextWindow } : {}),
      ...(dev.maxTokens ? { maxTokens: dev.maxTokens } : {}),
      ...(typeof dev.reasoning === 'boolean' ? { reasoning: dev.reasoning } : {}),
    };
  }
  return {
    ...pi,
    ...(dev.contextWindow ? { contextWindow: dev.contextWindow } : {}),
    ...(dev.maxTokens ? { maxTokens: dev.maxTokens } : {}),
    ...(typeof pi.reasoning === 'boolean' || typeof dev.reasoning !== 'boolean'
      ? {}
      : { reasoning: dev.reasoning }),
  };
}

export function findModelsDevModel(
  models: readonly ModelsDevModel[],
  modelId: string,
  providerId?: string
): ModelsDevModel | undefined {
  const scoped = providerId ? models.filter((model) => model.provider === providerId) : models;
  return findCatalogModelById(scoped, modelId);
}

/**
 * 把同一 provider 的 models.dev 模型补进订阅清单。
 * 没有同厂模板时不造可调用模型：空目录仍是空目录。
 */
export function withModelsDevOauthModels<T extends CatalogModelEntry>(
  providerId: string,
  catalog: readonly T[],
  devModels: readonly ModelsDevModel[]
): T[] {
  const mine = devModels.filter((model) => model.provider === providerId);
  const byId = new Map(mine.map((model) => [model.id, model]));
  const merged = catalog.map((model) => {
    const dev = byId.get(model.id);
    if (!dev) return model;
    return {
      ...model,
      ...(dev.contextWindow ? { contextWindow: dev.contextWindow } : {}),
      ...(dev.maxTokens ? { maxTokens: dev.maxTokens } : {}),
    };
  });
  const template = merged[0];
  if (!template) return merged;
  const seen = new Set(merged.map((model) => model.id));
  const extra: T[] = [];
  for (const dev of mine) {
    if (seen.has(dev.id)) continue;
    seen.add(dev.id);
    extra.push({
      ...template,
      id: dev.id,
      ...('name' in template ? { name: dev.name ?? dev.id } : {}),
      contextWindow: dev.contextWindow,
      maxTokens: dev.maxTokens,
      reasoning: typeof dev.reasoning === 'boolean' ? dev.reasoning : template.reasoning,
    });
  }
  return extra.length === 0 ? merged : [...merged, ...extra];
}

/** 订阅 spawn：pi 目录没有、但 models.dev 发布过的 id，按同厂模板克隆。 */
export function cloneModelsDevOauthModel<T extends CatalogModelEntry>(
  providerId: string,
  modelId: string,
  catalog: readonly T[],
  devModels: readonly ModelsDevModel[]
): T | undefined {
  const template = catalog[0];
  const dev = findModelsDevModel(devModels, modelId, providerId);
  if (!template || !dev || dev.provider !== providerId) return undefined;
  return {
    ...template,
    id: modelId,
    ...('name' in template ? { name: dev.name ?? modelId } : {}),
    contextWindow: dev.contextWindow ?? template.contextWindow,
    maxTokens: dev.maxTokens ?? template.maxTokens,
    reasoning: typeof dev.reasoning === 'boolean' ? dev.reasoning : template.reasoning,
  };
}
