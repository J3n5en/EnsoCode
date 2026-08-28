import { supportedProjectThinkingLevels } from './modelThinking';
import { THINKING_LEVELS, type ThinkingLevel } from './types/agent';
import type {
  ModelCapabilityOverrides,
  ModelReasoningOverride,
  ModelThinkingLevelOverride,
} from './types/llm';
import { MODEL_REASONING_OVERRIDES, MODEL_THINKING_LEVEL_OVERRIDES } from './types/llm';
import type { ModelMeta } from './types/modelMeta';

/** runtime.getModels() 条目里 resolve / ModelMeta 实际会读的字段 */
export interface CatalogModelEntry {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null | undefined>;
}

/** 自定义模型能力分层：行覆盖 > 精确 catalog id > 乐观默认 */
export const CUSTOM_MODEL_RESOLVE_SOURCES = ['override', 'catalog', 'default'] as const;
export type CustomModelResolveSource = (typeof CUSTOM_MODEL_RESOLVE_SOURCES)[number];

export interface CustomModelFieldSources {
  reasoning: CustomModelResolveSource;
  thinkingLevel: CustomModelResolveSource;
  contextWindow: CustomModelResolveSource;
  maxTokens: CustomModelResolveSource;
}

export interface ResolvedCustomModelCapabilities {
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null | undefined>;
  /** 缺省 = 数据层未知；spawn 再套 128K，这里不填假数字 */
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevels: ThinkingLevel[];
  source: CustomModelFieldSources;
}

const OPTIMISTIC_THINKING_LEVEL_MAP = { max: 'max' } as const;

/** 精确 model id 查找。OAuth meta 与自定义 spawn 共用；禁止前缀 / 品牌猜测。 */
export function findCatalogModelById<T extends { id: string }>(
  catalog: readonly T[],
  modelId: string
): T | undefined {
  return catalog.find((entry) => entry.id === modelId);
}

/** 非正 / 非有限视为缺失。未知不得用 128K 凑数。 */
export function positiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function positiveContextWindow(
  model: { contextWindow?: number } | undefined
): number | undefined {
  return positiveFiniteNumber(model?.contextWindow);
}

export function isModelReasoningOverride(value: unknown): value is ModelReasoningOverride {
  return (
    typeof value === 'string' && (MODEL_REASONING_OVERRIDES as readonly string[]).includes(value)
  );
}

export function isModelThinkingLevelOverride(value: unknown): value is ModelThinkingLevelOverride {
  return (
    typeof value === 'string' &&
    (MODEL_THINKING_LEVEL_OVERRIDES as readonly string[]).includes(value)
  );
}

/** 只抽出已设置且合法的覆盖；空 / 非法 = 跟随，不往下一层传假值。 */
export function pickModelCapabilityOverrides(
  entry: ModelCapabilityOverrides | undefined
): ModelCapabilityOverrides {
  if (!entry) return {};
  const overrides: ModelCapabilityOverrides = {};
  if (isModelReasoningOverride(entry.reasoning)) overrides.reasoning = entry.reasoning;
  if (isModelThinkingLevelOverride(entry.thinkingLevel)) {
    overrides.thinkingLevel = entry.thinkingLevel;
  }
  const contextWindow = positiveFiniteNumber(entry.contextWindow);
  if (contextWindow !== undefined) overrides.contextWindow = contextWindow;
  const maxTokens = positiveFiniteNumber(entry.maxTokens);
  if (maxTokens !== undefined) overrides.maxTokens = maxTokens;
  return overrides;
}

/**
 * 行覆盖把「最高支持档」写成 thinkingLevelMap：
 * max 显式声明；更低档用 null 剔除更高项目档（max 未声明本身就不支持）。
 */
export function thinkingLevelMapForCap(
  level: ThinkingLevel
): Record<string, string | null> | undefined {
  if (level === 'max') return { max: 'max' };
  if (level === 'high') return undefined;
  const map: Record<string, string | null> = {};
  const start = THINKING_LEVELS.indexOf(level) + 1;
  for (let i = start; i < THINKING_LEVELS.length; i++) {
    const higher = THINKING_LEVELS[i];
    if (higher && higher !== 'max') map[higher] = null;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

export function resolveCustomModelCapabilities(
  catalog: CatalogModelEntry | undefined,
  overrides?: ModelCapabilityOverrides
): ResolvedCustomModelCapabilities {
  const picked = pickModelCapabilityOverrides(overrides);
  const catalogHit = catalog !== undefined;

  const reasoning = resolveReasoning(catalog, picked);
  const thinking = resolveThinkingLevelMap(catalog, picked, catalogHit, reasoning.value);
  const contextWindow = resolvePositive(
    picked.contextWindow,
    catalogHit ? positiveFiniteNumber(catalog?.contextWindow) : undefined,
    catalogHit
  );
  const maxTokens = resolvePositive(
    picked.maxTokens,
    catalogHit ? positiveFiniteNumber(catalog?.maxTokens) : undefined,
    catalogHit
  );

  const thinkingLevelMap = reasoning.value ? thinking.value : undefined;
  return {
    reasoning: reasoning.value,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    ...(contextWindow.value !== undefined ? { contextWindow: contextWindow.value } : {}),
    ...(maxTokens.value !== undefined ? { maxTokens: maxTokens.value } : {}),
    thinkingLevels: supportedProjectThinkingLevels({
      reasoning: reasoning.value,
      thinkingLevelMap,
    }),
    source: {
      reasoning: reasoning.source,
      thinkingLevel: thinking.source,
      contextWindow: contextWindow.source,
      maxTokens: maxTokens.source,
    },
  };
}

function resolveReasoning(
  catalog: CatalogModelEntry | undefined,
  picked: ModelCapabilityOverrides
): { value: boolean; source: CustomModelResolveSource } {
  if (picked.reasoning === 'on') return { value: true, source: 'override' };
  if (picked.reasoning === 'off') return { value: false, source: 'override' };
  if (catalog && typeof catalog.reasoning === 'boolean') {
    return { value: catalog.reasoning, source: 'catalog' };
  }
  return { value: true, source: 'default' };
}

function resolveThinkingLevelMap(
  catalog: CatalogModelEntry | undefined,
  picked: ModelCapabilityOverrides,
  catalogHit: boolean,
  reasoningEnabled: boolean
): {
  value: Record<string, string | null | undefined> | undefined;
  source: CustomModelResolveSource;
} {
  if (picked.thinkingLevel) {
    return {
      value: thinkingLevelMapForCap(picked.thinkingLevel),
      source: 'override',
    };
  }
  if (catalogHit) {
    return {
      value: catalog?.thinkingLevelMap,
      source: 'catalog',
    };
  }
  return {
    value: reasoningEnabled ? { ...OPTIMISTIC_THINKING_LEVEL_MAP } : undefined,
    source: 'default',
  };
}

/** 把 queryModelMeta 的结果还原成 catalog 快照，供 UI 叠行覆盖并读 source。 */
export function catalogFromModelMeta(meta: ModelMeta | undefined): CatalogModelEntry | undefined {
  if (!meta || meta.source === 'unknown') return undefined;
  return {
    id: meta.modelId,
    reasoning: meta.reasoning,
    contextWindow: meta.contextWindow,
    maxTokens: meta.maxTokens,
    thinkingLevelMap: thinkingLevelMapFromProjectLevels(meta.reasoning, meta.thinkingLevels),
  };
}

/** 设置行 UI：ModelEntry 覆盖 + 已查到的 ModelMeta → 分层结果（含 source） */
export function resolveCustomModelView(
  entry: ModelCapabilityOverrides | undefined,
  meta: ModelMeta | undefined
): ResolvedCustomModelCapabilities {
  return resolveCustomModelCapabilities(catalogFromModelMeta(meta), entry);
}

function thinkingLevelMapFromProjectLevels(
  reasoning: boolean | undefined,
  levels: ThinkingLevel[] | undefined
): Record<string, string | null> | undefined {
  if (reasoning !== true || !levels) return undefined;
  const map: Record<string, string | null> = {};
  if (levels.includes('max')) map.max = 'max';
  for (const level of ['low', 'medium', 'high'] as const) {
    if (!levels.includes(level)) map[level] = null;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

function resolvePositive(
  override: number | undefined,
  catalogValue: number | undefined,
  catalogHit: boolean
): { value: number | undefined; source: CustomModelResolveSource } {
  if (override !== undefined) return { value: override, source: 'override' };
  if (catalogHit) return { value: catalogValue, source: 'catalog' };
  return { value: undefined, source: 'default' };
}
