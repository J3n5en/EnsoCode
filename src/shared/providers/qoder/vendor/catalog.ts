import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { buildAuthHeaders } from "./cosy.js";
import { getQoderBaseUrl, getQoderModelListURL, getQoderRegionConfig, type QoderMode } from "./region.js";

export const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/**
 * Maximum output tokens sent per request. Aliyun Model Studio (the upstream
 * behind Qoder's CN catalog) documents Max Output Length = 131072 for every
 * model we expose (qwen3.8-max/flash, qwen3.7-max/plus/flash), in both normal
 * and thinking modes (thinking chain alone goes up to 262144). The Qoder
 * /model/list catalog does not return a per-model output cap, so this single
 * constant is the source of truth for both static models and request sending.
 * qodercli ships a conservative 32e3 default and caps its UI at 65536; we use
 * the documented upstream ceiling so reasoning chains and long generations
 * are not truncated.
 */
export const MAX_OUTPUT_TOKENS = 131072;

/**
 * Fallback context window when the catalog omits `context_config`.
 *
 * Qoder's `/model/list` often ships `max_input_tokens` as a stale 180K floor
 * even for models that accept 1M-token prompts (verified against global `lite`
 * through 1,000K tokens). When `context_config` is present we use its largest
 * `token_count` instead, so models that truly advertise 200K/256K stay there.
 */
export const DEFAULT_CONTEXT_WINDOW = 1000000;

/** Shape of a single entry returned by the Qoder /model/list endpoint. */
export interface QoderModelEntry {
  key?: string;
  enable?: boolean;
  display_name?: string;
  max_input_tokens?: number;
  context_config?: Record<string, { token_count?: number; is_default?: boolean }>;
  is_vl?: boolean;
  is_reasoning?: boolean;
  thinking_config?: {
    disabled?: unknown;
    enabled?: { efforts?: Record<string, { is_default?: boolean }>; is_default?: boolean };
  };
  source?: string;
  [key: string]: unknown;
}

/**
 * omp fork's `ThinkingConfig` shape. The fork reads `model.thinking` (not the
 * `thinkingLevelMap` that earendil pi-ai exposes), and when it is absent omp
 * fills a generic default ladder (`minimal`..`high`) instead of the model's
 * real efforts - so `DeepSeek-V4-Pro` would show `low`/`medium` it does not
 * support. Defining this inline because the plugin compiles against
 * @earendil-works/pi-ai, which has no such field.
 */
export interface QoderThinkingConfig {
  mode: "effort";
  efforts: readonly ThinkingLevel[];
  defaultLevel?: ThinkingLevel;
  requiresEffort?: boolean;
}

export interface QoderModelDef {
  id: string;
  upstreamKey?: string;
  name: string;
  api: "qoder-api";
  provider: "qoder" | "qoder-cn";
  baseUrl: string;
  reasoning: boolean;
  supportsEffort: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  thinking?: QoderThinkingConfig;
  input: ("text" | "image")[];
  cost: typeof ZERO_COST;
  contextWindow: number;
  maxTokens: number;
  description?: string;
}

function getHomeDir(): string {
  if (!process.env.PI_CODING_AGENT_DIR) throw new Error("PI_CODING_AGENT_DIR is required for Qoder");
  return process.env.PI_CODING_AGENT_DIR;
}

function getQoderCachePath(mode: QoderMode, userID: string): string {
  const scope = createHash('sha256').update(userID).digest('hex');
  return join(getHomeDir(), `${getQoderRegionConfig(mode).modelCacheFile}.${scope}`);
}

interface ParsedModelCache {
  updatedAt?: number;
  models?: QoderModelDef[];
  configs?: Record<string, QoderModelEntry>;
}

function readParsedModelCache(mode: QoderMode, userID: string): ParsedModelCache | null {
  const cachePath = getQoderCachePath(mode, userID);
  try {
    const data = JSON.parse(readFileSync(cachePath, "utf8")) as ParsedModelCache;
    return data;
  } catch {
    return null;
  }
}

function writeParsedModelCache(mode: QoderMode, userID: string, data: ParsedModelCache): void {
  const cachePath = getQoderCachePath(mode, userID);
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Derive the only public model id from Qoder's display name.
 * The upstream key remains available solely inside the matching config entry.
 */
export function toQoderModelId(displayName?: string): string {
  return (displayName || "QoderModel").replace(/\s+/g, "");
}

export const staticModels: QoderModelDef[] = [
  {
    id: "Auto",
    upstreamKey: "auto",
    name: "Auto",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: getQoderBaseUrl("global"),
    reasoning: true,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "Ultimate",
    upstreamKey: "ultimate",
    name: "Ultimate",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: getQoderBaseUrl("global"),
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "Performance",
    upstreamKey: "performance",
    name: "Performance",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: getQoderBaseUrl("global"),
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "Efficient",
    upstreamKey: "efficient",
    name: "Efficient",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: getQoderBaseUrl("global"),
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "Lite",
    upstreamKey: "lite",
    name: "Lite",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: getQoderBaseUrl("global"),
    reasoning: false,
    supportsEffort: false,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "Qwen3.7Plus",
    upstreamKey: "qmodel",
    name: "Qwen3.7 Plus",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: getQoderBaseUrl("global"),
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "Cantus",
    upstreamKey: "cmodel",
    name: "Cantus",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: getQoderBaseUrl("global"),
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "Qwen3.8-Max",
    upstreamKey: "qmodel_preview",
    name: "Qwen3.8-Max",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: getQoderBaseUrl("global"),
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "Qwen3.7-Max",
    upstreamKey: "qmodel_latest",
    name: "Qwen3.7-Max",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: getQoderBaseUrl("global"),
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "DeepSeek-V4-Pro",
    upstreamKey: "dmodel",
    name: "DeepSeek-V4-Pro",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: getQoderBaseUrl("global"),
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "DeepSeek-V4-Flash",
    upstreamKey: "dfmodel",
    name: "DeepSeek-V4-Flash",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: getQoderBaseUrl("global"),
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "GLM-5.2",
    upstreamKey: "gm51model",
    name: "GLM-5.2",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: getQoderBaseUrl("global"),
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "Kimi-K2.7-Code",
    upstreamKey: "kmodel",
    name: "Kimi-K2.7-Code",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: getQoderBaseUrl("global"),
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    // Catalog advertises 256K; not included in the 1M live test in issue #13.
    contextWindow: 256000,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "Kimi-K3",
    upstreamKey: "kmodel_latest",
    name: "Kimi-K3",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: getQoderBaseUrl("global"),
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "MiniMax-M3",
    upstreamKey: "mmodel",
    name: "MiniMax-M3",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: getQoderBaseUrl("global"),
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
];

export const staticCnModels: QoderModelDef[] = [
  {
    id: "Auto",
    upstreamKey: "auto",
    name: "Auto",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: true,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    // CN Auto has not been live-tested at 1M; keep the conservative 200K
    // fallback until the CN catalog advertises a larger option.
    contextWindow: 200000,
    maxTokens: MAX_OUTPUT_TOKENS,
    description: "Qoder CN smart routing; fallback context window of 200K.",
  },
  {
    id: "Qwen3.7-Max",
    upstreamKey: "qmodel_latest",
    name: "Qwen3.7-Max",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: true,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
    description: "Qoder CN qmodel_latest; context options 200K/400K/1M.",
  },
  {
    id: "Qwen3.7-Plus",
    upstreamKey: "qmodel",
    name: "Qwen3.7-Plus",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: true,
    supportsEffort: false,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
    description: "Qoder CN qmodel; context options 200K/400K/1M.",
  },
  {
    id: "Qwen3.6-Flash",
    upstreamKey: "q36fmodel",
    name: "Qwen3.6-Flash",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: true,
    supportsEffort: false,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
    description: "Qoder CN q36fmodel; context options 200K/400K/1M.",
  },
  {
    id: "DeepSeek-V4-Pro",
    upstreamKey: "dmodel",
    name: "DeepSeek-V4-Pro",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: true,
    supportsEffort: false,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
    description: "Qoder CN dmodel; context options 200K/400K/1M.",
  },
  {
    id: "DeepSeek-V4-Flash",
    upstreamKey: "dfmodel",
    name: "DeepSeek-V4-Flash",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: false,
    supportsEffort: false,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
    description: "Qoder CN dfmodel; context options 200K/400K/1M.",
  },
  {
    id: "GLM-5.2",
    upstreamKey: "gm51model",
    name: "GLM-5.2",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: true,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    // Live CN catalog currently displays 200K; do not copy global gm51model's 1M.
    contextWindow: 200000,
    maxTokens: MAX_OUTPUT_TOKENS,
    description: "Qoder CN gm51model; live catalog currently displays GLM-5.2 with 200K context.",
  },
  {
    id: "Kimi-K2.7-Code",
    upstreamKey: "kmodel",
    name: "Kimi-K2.7-Code",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: true,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    // Catalog advertises 256K; same as global kmodel.
    contextWindow: 256000,
    maxTokens: MAX_OUTPUT_TOKENS,
    description: "Qoder CN kmodel; context option 256K.",
  },
  {
    id: "MiniMax-M2.7",
    upstreamKey: "mmodel",
    name: "MiniMax-M2.7",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: false,
    supportsEffort: false,
    input: ["text"],
    cost: ZERO_COST,
    // Live CN catalog reports 200K; not confirmed at 1M.
    contextWindow: 200000,
    maxTokens: MAX_OUTPUT_TOKENS,
    description: "Qoder CN mmodel; live catalog reports 200K context.",
  },
];

/** pi thinking levels in display order (matches the pi-ai SDK this build targets). */
const PI_THINKING_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Map Qoder's `thinking_config` to pi's `thinkingLevelMap` so the TUI exposes
 * the levels the upstream model actually supports.
 *
 * Qoder has two shapes:
 *   - effort-based: `thinking_config.enabled.efforts = { low, medium, xhigh, ... }`
 *     Each effort key is already a pi level name, so supported levels map to
 *     themselves and the rest are pinned to null (hidden in the picker).
 *     `xhigh`/`max` are only shown when the map carries them, otherwise the
 *     picker tops out at `high`.
 *   - toggle-based: `thinking_config.enabled` without `efforts` (only on/off).
 *     Every pi level is exposed and maps to "enabled" so a user picking any
 *     level turns thinking on; the exact effort sent upstream is decided at
 *     request time.
 * Returns undefined for models that do not support thinking, so pi falls back
 * to `reasoning: false`-style behavior (only `off`).
 */
function buildThinkingLevelMap(entry: QoderModelEntry): ThinkingLevelMap | undefined {
  const tc = entry.thinking_config;
  if (!tc) return undefined;
  const efforts = tc.enabled?.efforts;
  if (efforts && typeof efforts === "object") {
    const supported = new Set(Object.keys(efforts));
    // `off` (disable thinking) is selectable when the catalog advertises a
    // `disabled` option; otherwise pin it to null to hide it.
    const map: ThinkingLevelMap = { off: tc.disabled ? "disabled" : null };
    for (const level of PI_THINKING_LEVELS) {
      map[level] = supported.has(level) ? level : null;
    }
    return map;
  }
  // toggle-only (enabled/disabled, no efforts) — expose every level as "on".
  // `off` is selectable when the catalog advertises `disabled`.
  if (tc.enabled) {
    const map: ThinkingLevelMap = { off: tc.disabled ? "disabled" : null };
    for (const level of PI_THINKING_LEVELS) {
      map[level] = "enabled";
    }
    return map;
  }
  return undefined;
}

/**
 * Map Qoder's `thinking_config` to omp's `thinking` metadata so omp's effort
 * picker lists the actual supported levels (it reads `thinking.efforts`, not
 * `thinkingLevelMap`). Only effort-based models have a meaningful ladder;
 * toggle-only models (no `efforts`) return undefined so omp falls back to its
 * generic behavior.
 */
export function buildThinkingConfig(entry: QoderModelEntry): QoderThinkingConfig | undefined {
  const tc = entry.thinking_config;
  const efforts = tc?.enabled?.efforts;
  if (!efforts || typeof efforts !== "object") return undefined;

  const supported = new Set(Object.keys(efforts));
  const ordered = PI_THINKING_LEVELS.filter((level) => supported.has(level));
  if (ordered.length === 0) return undefined;

  const defaultLevel = PI_THINKING_LEVELS.find((level) => efforts[level]?.is_default);

  return {
    mode: "effort",
    efforts: ordered,
    ...(defaultLevel ? { defaultLevel } : {}),
    // Qoder's catalog marks a `disabled` branch when thinking can be turned
    // off. Without it reasoning is mandatory upstream, so omp clamps "off" to
    // the lowest supported effort instead of disabling.
    requiresEffort: !tc?.disabled,
  };
}

export function getCachedModels(mode: QoderMode, userID = ''): QoderModelDef[] {
  const data = userID ? readParsedModelCache(mode, userID) : null;
  if (data && Array.isArray(data.models)) {
    const models = data.models.map((model: QoderModelDef) => {
      const config = data.configs?.[model.id] as QoderModelEntry | undefined;
      const display = config?.display_name;
      const staticModel = (mode === "cn" ? staticCnModels : staticModels).find((seed) => seed.upstreamKey === model.id);
      if (display) return { ...model, id: toQoderModelId(display), name: display };
      if (staticModel) return { ...model, id: staticModel.id, name: staticModel.name };
      return model.name ? { ...model, id: toQoderModelId(model.name) } : model;
    });
    // Older releases injected `auto` without a corresponding service config.
    // Keep an explicitly enabled service model, but drop the legacy fallback.
    // Configs are keyed by display id (`Auto`) since 9d88e99; older caches
    // still key them by upstream raw key (`auto`), so check both spellings.
    if (data.configs && typeof data.configs === "object" && !data.configs.auto && !data.configs.Auto) {
      return models.filter((model: QoderModelDef) => model.id.toLowerCase() !== "auto");
    }
    return models;
  }
  return mode === "cn" ? staticCnModels : staticModels;
}

export function getCachedModelConfig(modelId: string, mode: QoderMode, userID = ''): QoderModelEntry | null {
  const data = userID ? readParsedModelCache(mode, userID) : null;
  if (data) {
    const direct = data.configs?.[modelId] as QoderModelEntry | undefined;
    if (direct && toQoderModelId(direct.display_name) === modelId) {
      return withMaxContextAsDefault(direct);
    }

    // Read old cache shapes without preserving their raw-key aliases.
    const legacyEntry = Object.values(data.configs || {}).find(
      (entry) =>
        entry && typeof entry === "object" && toQoderModelId((entry as QoderModelEntry).display_name) === modelId,
    ) as QoderModelEntry | undefined;
    if (legacyEntry) {
      return withMaxContextAsDefault(legacyEntry);
    }
  }

  const staticModel = (mode === "cn" ? staticCnModels : staticModels).find((model) => model.id === modelId);
  if (staticModel) {
    return {
      key: staticModel.upstreamKey || modelId,
      is_reasoning: staticModel.reasoning,
      source: "system",
    };
  }

  return null;
}

/** Resolve contextWindow from a catalog entry. Exported for tests. */
export function contextWindowFromCatalog(entry: QoderModelEntry): number {
  const contextConfig = entry.context_config;
  if (contextConfig && typeof contextConfig === "object") {
    let advertised = 0;
    for (const configVal of Object.values(contextConfig)) {
      if (configVal && typeof configVal === "object" && typeof configVal.token_count === "number") {
        if (configVal.token_count > advertised) advertised = configVal.token_count;
      }
    }
    if (advertised > 0) return advertised;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/** Prefer the largest context option when Qoder exposes selectable contexts. */
function withMaxContextAsDefault(entry: QoderModelEntry): QoderModelEntry {
  const contextConfig = entry.context_config;
  if (!contextConfig || typeof contextConfig !== "object") return entry;

  const maxTokenCount = Math.max(
    ...Object.values(contextConfig).map((config) => (typeof config?.token_count === "number" ? config.token_count : 0)),
  );
  if (maxTokenCount <= 0) return entry;

  return {
    ...entry,
    context_config: Object.fromEntries(
      Object.entries(contextConfig).map(([name, config]) => [
        name,
        { ...config, is_default: config.token_count === maxTokenCount },
      ]),
    ),
  };
}

export function isCacheStale(mode: QoderMode, userID = ''): boolean {
  const data = userID ? readParsedModelCache(mode, userID) : null;
  if (!data || typeof data.updatedAt !== "number") return true;
  // Stale if older than 1 hour
  return Date.now() - data.updatedAt > 3600_000;
}

export async function updateQoderModelsCache(
  authToken: string,
  userID: string,
  name: string,
  email: string,
  mode: QoderMode,
  signal?: AbortSignal,
  machineID?: string,
): Promise<void> {
  const modelListURL = getQoderModelListURL(mode);
  try {
    const headers = buildAuthHeaders(null, modelListURL, {
      userID,
      authToken,
      name,
      email,
      machineID,
    });

    const response = await fetch(modelListURL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...headers,
      },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return;
    }

    const resData = (await response.json()) as { chat?: QoderModelEntry[] };
    const chatModels = Array.isArray(resData?.chat) ? resData.chat : [];
    if (chatModels.length === 0) return;

    const newModels: QoderModelDef[] = [];
    const configs: Record<string, QoderModelEntry> = {};

    for (const entry of chatModels) {
      if (!entry || typeof entry !== 'object') continue;
      const key = entry.key;
      if (typeof key !== 'string' || !key.trim() || entry.enable !== true || typeof entry.display_name !== 'string' || !entry.display_name.trim()) continue;

      const display = entry.display_name;
      // Prefer the largest selectable context option the catalog advertises
      // (e.g. 1M when 200K/400K/1M are offered). If none is advertised, use
      // DEFAULT_CONTEXT_WINDOW rather than the stale 180K `max_input_tokens`
      // floor. Do not seed from DEFAULT_CONTEXT_WINDOW before scanning
      // context_config: that would inflate models that only advertise 200K.
      const ctxLen = contextWindowFromCatalog(entry);
      const isVL = !!entry.is_vl;
      const isReasoning = !!entry.is_reasoning || !!entry.thinking_config;
      const supportsEffort = !!entry.thinking_config?.enabled?.efforts;
      const thinkingLevelMap = buildThinkingLevelMap(entry);
      const thinking = buildThinkingConfig(entry);
      // Both regions expose display_name (whitespace-stripped) as the sole
      // pi-visible id. The config stores the upstream key under that id for
      // request-time use.
      const modelInfo = { id: toQoderModelId(display), name: display };

      configs[modelInfo.id] = entry;

      newModels.push({
        id: modelInfo.id,
        name: modelInfo.name,
        api: "qoder-api",
        provider: getQoderRegionConfig(mode).providerID,
        baseUrl: getQoderBaseUrl(mode),
        reasoning: isReasoning,
        supportsEffort,
        thinkingLevelMap,
        thinking,
        input: isVL ? ["text", "image"] : ["text"],
        cost: ZERO_COST,
        contextWindow: ctxLen,
        maxTokens: MAX_OUTPUT_TOKENS,
      });
    }

    if (newModels.length === 0) return;

    const cacheData = {
      updatedAt: Date.now(),
      models: newModels,
      configs,
    };

    if (signal?.aborted) return;
    writeParsedModelCache(mode, userID, cacheData);
  } catch {}
}
