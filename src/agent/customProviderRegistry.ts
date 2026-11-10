import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { findCatalogModelById, resolveCustomModelCapabilities } from '@shared/modelCatalog';
import { type ModelDirectorySnapshot, parseModelDirectorySnapshot } from '@shared/modelDirectory';
import { resolvePiProviderBaseUrl } from '@shared/providerCatalog';
import { escapePiConfigValue, parseProviderHeaders } from '@shared/providers/providerHeaders';
import type { WorkerCustomProvider } from '@shared/types/agent';
import {
  MODEL_API_KINDS,
  MODEL_REASONING_OVERRIDES,
  MODEL_THINKING_LEVEL_OVERRIDES,
  type ModelApiKind,
  type ModelEntry,
  type ModelReasoningOverride,
  type ModelThinkingLevelOverride,
} from '@shared/types/llm';
import { version } from '../../package.json';
import { resolveCustomModelCompat, selectCatalogEntryForCompat } from './customModelCompat';
import { withOpenAIResponsesRouting } from './openaiResponsesRouting';
import { withRequestBodyBudget } from './requestBodyBudget';
import { providerKeyFor } from './smartCompact';

/** 统一的客户端标识，格式对齐 pi-coding-agent 的 getPiUserAgent。 */
const ENSO_USER_AGENT = `enso-code/${version} (${process.platform}; node/${process.version}; ${process.arch})`;

type CustomModelDefinition = NonNullable<
  Parameters<ModelRuntime['registerProvider']>[1]['models']
>[number];
type CatalogModel = ReturnType<ModelRuntime['getModels']>[number];

/** 每个自定义 provider 键已注册过的模型定义（worker 进程内，只增不删）。 */
const registeredCustomModels = new Map<string, Map<string, CustomModelDefinition>>();

/** 测试隔离：生产路径没有「清空已注册模型」的语义。 */
export function resetCustomProviderRegistryForTests(): void {
  registeredCustomModels.clear();
}

export interface CustomProviderEndpoint {
  api: ModelApiKind;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
}

export interface ModelDirectoryPushState {
  snapshot: ModelDirectorySnapshot;
  providers: WorkerCustomProvider[];
}

export type ModelDirectoryPushPreview =
  | { status: 'ignored'; reason: string }
  | { status: 'unchanged' }
  | {
      status: 'apply';
      parsed: { snapshot: ModelDirectorySnapshot; providers: WorkerCustomProvider[] };
    };

function isModelApiKind(value: string): value is ModelApiKind {
  return (MODEL_API_KINDS as readonly string[]).includes(value);
}

function isReasoningOverride(value: unknown): value is ModelReasoningOverride {
  return (
    typeof value === 'string' && (MODEL_REASONING_OVERRIDES as readonly string[]).includes(value)
  );
}

function isThinkingLevelOverride(value: unknown): value is ModelThinkingLevelOverride {
  return (
    typeof value === 'string' &&
    (MODEL_THINKING_LEVEL_OVERRIDES as readonly string[]).includes(value)
  );
}

/** 模型行只要求 id；能力覆盖非法就丢掉该字段，不让一行脏数据废掉整个 provider。 */
export function parseWorkerModelEntry(value: unknown): ModelEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || raw.id.length === 0) return undefined;
  const entry: ModelEntry = { id: raw.id };
  if (typeof raw.label === 'string') entry.label = raw.label;
  if (typeof raw.enabled === 'boolean') entry.enabled = raw.enabled;
  if (isReasoningOverride(raw.reasoning)) entry.reasoning = raw.reasoning;
  if (isThinkingLevelOverride(raw.thinkingLevel)) entry.thinkingLevel = raw.thinkingLevel;
  if (typeof raw.contextWindow === 'number' && Number.isFinite(raw.contextWindow)) {
    entry.contextWindow = raw.contextWindow;
  }
  if (typeof raw.maxTokens === 'number' && Number.isFinite(raw.maxTokens)) {
    entry.maxTokens = raw.maxTokens;
  }
  return entry;
}

function parseWorkerCustomProvider(value: unknown): WorkerCustomProvider | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.settingsId !== 'string' || raw.settingsId.length === 0) return undefined;
  if (typeof raw.name !== 'string') return undefined;
  if (typeof raw.api !== 'string' || !isModelApiKind(raw.api)) return undefined;
  if (typeof raw.baseUrl !== 'string' || typeof raw.apiKey !== 'string') return undefined;
  if (!Array.isArray(raw.models)) return undefined;
  const models: ModelEntry[] = [];
  for (const item of raw.models) {
    const model = parseWorkerModelEntry(item);
    if (model) models.push(model);
  }
  const headers = parseProviderHeaders(raw.headers);
  return {
    settingsId: raw.settingsId,
    name: raw.name,
    api: raw.api,
    baseUrl: raw.baseUrl,
    apiKey: raw.apiKey,
    models,
    ...(headers ? { headers } : {}),
  };
}

/** 非数组整包拒绝；数组里坏条目丢掉，好的保留。 */
export function parseWorkerCustomProviders(value: unknown): WorkerCustomProvider[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const providers: WorkerCustomProvider[] = [];
  for (const item of value) {
    const provider = parseWorkerCustomProvider(item);
    if (provider) providers.push(provider);
  }
  return providers;
}

export function parseModelDirectoryPush(
  snapshot: unknown,
  customProviders: unknown
):
  | { ok: true; snapshot: ModelDirectorySnapshot; providers: WorkerCustomProvider[] }
  | { ok: false; reason: string } {
  const parsedSnapshot = parseModelDirectorySnapshot(snapshot);
  if (!parsedSnapshot) return { ok: false, reason: 'snapshot' };
  const providers = parseWorkerCustomProviders(customProviders);
  if (!providers) return { ok: false, reason: 'customProviders' };
  return { ok: true, snapshot: parsedSnapshot, providers };
}

function providerFingerprint(provider: WorkerCustomProvider) {
  return {
    settingsId: provider.settingsId,
    name: provider.name,
    api: provider.api,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    ...(provider.headers ? { headers: provider.headers } : {}),
    models: provider.models.map((model) => ({
      id: model.id,
      ...(model.label !== undefined ? { label: model.label } : {}),
      ...(model.enabled !== undefined ? { enabled: model.enabled } : {}),
      ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
      ...(model.thinkingLevel !== undefined ? { thinkingLevel: model.thinkingLevel } : {}),
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
    })),
  };
}

export function sameCustomProviders(
  left: readonly WorkerCustomProvider[],
  right: readonly WorkerCustomProvider[]
): boolean {
  return (
    JSON.stringify(left.map(providerFingerprint)) === JSON.stringify(right.map(providerFingerprint))
  );
}

/**
 * 已有 id 原样保留，incoming 只追加没有的。推送不能顶掉 spawn 已注册的定义。
 */
export function accumulateModelIds(
  existing: readonly string[],
  incoming: readonly string[]
): string[] {
  const seen = new Set(existing);
  const out = [...existing];
  for (const id of incoming) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function previewModelDirectoryPush(
  previous: ModelDirectoryPushState | undefined,
  snapshot: unknown,
  customProviders: unknown
): ModelDirectoryPushPreview {
  const parsed = parseModelDirectoryPush(snapshot, customProviders);
  if (!parsed.ok) return { status: 'ignored', reason: parsed.reason };
  // 防御晚到的旧推送：postMessage 理论上有序，但 Main 侧多次连发时读到的快照
  // 可能交错；revision 倒退的推送直接丢弃
  if (previous && parsed.snapshot.revision < previous.snapshot.revision) {
    return { status: 'ignored', reason: 'stale-revision' };
  }
  if (
    previous &&
    previous.snapshot.revision === parsed.snapshot.revision &&
    sameCustomProviders(previous.providers, parsed.providers)
  ) {
    return { status: 'unchanged' };
  }
  return {
    status: 'apply',
    parsed: { snapshot: parsed.snapshot, providers: parsed.providers },
  };
}

function definitionFor(
  catalogModels: readonly CatalogModel[],
  api: ModelApiKind,
  piBaseUrl: string,
  entry: ModelEntry
): CustomModelDefinition {
  const catalog = findCatalogModelById(catalogModels, entry.id);
  const resolved = resolveCustomModelCapabilities(catalog, entry);
  const contextWindow = resolved.contextWindow ?? 128_000;
  const maxTokens = resolved.maxTokens ?? 32_000;
  const compat = resolveCustomModelCompat(
    api,
    piBaseUrl,
    selectCatalogEntryForCompat(catalogModels, api, piBaseUrl, entry.id)
  );
  return {
    id: entry.id,
    name: entry.id,
    reasoning: resolved.reasoning,
    ...(resolved.thinkingLevelMap ? { thinkingLevelMap: resolved.thinkingLevelMap } : {}),
    input: ['text', 'image'],
    ...(catalog?.api === api && catalog.inputLimits ? { inputLimits: catalog.inputLimits } : {}),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    ...(compat ? { compat } : {}),
  };
}

/**
 * 把自定义模型写入进程内累积表并 registerProvider 全量重注册。
 * 默认覆盖同 id（spawn 路径，与原先 known.set 一致）；
 * accumulateOnly 只追加尚未注册的 id，已有定义保持原对象。
 *
 * 已知边界（目录推送路径）：能力覆盖的修改要等下次 spawn 的重解析才刷新到
 * 已注册 id；settings 里删除的模型在 worker 进程内不注销（下次重启清理）。
 * 两者对枚举/鉴权无害，故从简。
 */
export function registerCustomProviderModels(
  runtime: ModelRuntime,
  provider: CustomProviderEndpoint,
  models: readonly ModelEntry[],
  options?: { accumulateOnly?: boolean }
): void {
  const providerId = providerKeyFor(provider);
  const catalogModels = runtime.getModels();
  const known = registeredCustomModels.get(providerId) ?? new Map<string, CustomModelDefinition>();
  const piBaseUrl = resolvePiProviderBaseUrl(provider.api, provider.baseUrl);
  const accumulateOnly = options?.accumulateOnly === true;
  let wrote = false;
  for (const entry of models) {
    if (!entry.id) continue;
    if (accumulateOnly && known.has(entry.id)) continue;
    known.set(entry.id, definitionFor(catalogModels, provider.api, piBaseUrl, entry));
    wrote = true;
  }
  if (accumulateOnly && !wrote) return;
  registeredCustomModels.set(providerId, known);
  runtime.registerProvider(providerId, {
    baseUrl: piBaseUrl,
    api: provider.api,
    apiKey: provider.apiKey,
    headers: providerRequestHeaders(provider.headers),
    models: [...known.values()],
  });
  const registered = runtime.getProvider(providerId);
  if (!registered) throw new Error(`provider not found after register: ${providerId}`);
  runtime.registerNativeProvider(
    provider.api === 'openai-responses'
      ? withOpenAIResponsesRouting(withRequestBodyBudget(registered))
      : withRequestBodyBudget(registered)
  );
}

export function installPushedCustomProviders(
  runtime: ModelRuntime,
  providers: readonly WorkerCustomProvider[]
): void {
  for (const provider of providers) {
    if (!isModelApiKind(provider.api)) continue;
    const headers = parseProviderHeaders(provider.headers);
    registerCustomProviderModels(
      runtime,
      {
        api: provider.api,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        ...(headers ? { headers } : {}),
      },
      provider.models,
      { accumulateOnly: true }
    );
  }
}

/** 内置 User-Agent 垫底；用户任意大小写的 user-agent 替换它。值按 pi 配置模板转义成字面量。 */
function providerRequestHeaders(
  headers: Record<string, string> | undefined
): Record<string, string> {
  const user = headers ?? {};
  const overridesUserAgent = Object.keys(user).some((name) => name.toLowerCase() === 'user-agent');
  const merged: Record<string, string> = {};
  if (!overridesUserAgent) merged['User-Agent'] = ENSO_USER_AGENT;
  for (const [name, value] of Object.entries(user)) merged[name] = escapePiConfigValue(value);
  return merged;
}
