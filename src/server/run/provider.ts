import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { modelUsability } from '@shared/defaultModel';
import { DEFAULT_BASE_URLS } from '@shared/providerCatalog';
import { MODEL_API_KINDS, type ModelApiKind, type ModelProvider } from '@shared/types/llm';

export interface RunProviderRequest {
  providerId?: string;
  modelId?: string;
  apiKey?: string;
  baseUrl?: string;
  api?: ModelApiKind;
}

export interface ResolvedRunProvider {
  providerId: string;
  modelId: string;
  providers: unknown[];
  changed: boolean;
}

function isApi(value: string): value is ModelApiKind {
  return (MODEL_API_KINDS as readonly string[]).includes(value);
}

function inferApi(baseUrl: string | undefined, explicit: ModelApiKind | undefined): ModelApiKind {
  if (explicit) return explicit;
  if (baseUrl?.toLowerCase().includes('anthropic')) return 'anthropic-messages';
  return 'openai-completions';
}

export function coerceProvider(value: unknown): ModelProvider | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Partial<ModelProvider>;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.api !== 'string' || !isApi(raw.api)) return null;
  if (typeof raw.apiKey !== 'string' || typeof raw.baseUrl !== 'string') return null;
  if (!Array.isArray(raw.models)) return null;
  const name = typeof raw.name === 'string' && raw.name ? raw.name : raw.id;
  const enabled = raw.enabled === undefined ? true : raw.enabled === true;
  const models = raw.models.filter(
    (model): model is ModelProvider['models'][number] =>
      Boolean(model) &&
      typeof model === 'object' &&
      typeof (model as { id?: unknown }).id === 'string' &&
      (model as { id: string }).id.length > 0
  );
  return {
    id: raw.id,
    name,
    api: raw.api,
    apiKey: raw.apiKey,
    baseUrl: raw.baseUrl,
    enabled,
    models,
    ...(typeof raw.importedFrom === 'string' ? { importedFrom: raw.importedFrom } : {}),
    ...(typeof raw.catalogId === 'string' ? { catalogId: raw.catalogId } : {}),
    ...(raw.headers ? { headers: raw.headers } : {}),
    ...(raw.oauthAccountKey ? { oauthAccountKey: raw.oauthAccountKey } : {}),
    ...(raw.oauthAccountPool ? { oauthAccountPool: raw.oauthAccountPool } : {}),
  };
}

function enabledModelId(provider: ModelProvider, preferred?: string): string | null {
  if (preferred) {
    const match = provider.models.find(
      (model) => model.id === preferred && model.enabled !== false
    );
    return match ? match.id : null;
  }
  return provider.models.find((model) => model.enabled !== false)?.id ?? null;
}

function withModel(provider: ModelProvider, modelId: string): ModelProvider {
  if (provider.models.some((model) => model.id === modelId)) return provider;
  return { ...provider, models: [...provider.models, { id: modelId }] };
}

/**
 * 标志 / 环境变量覆盖或新建供应商；否则从已有 settings 里挑一个可用模型。
 * 返回的 providers 保留无法识别的原始条目。
 */
export function resolveRunProvider(
  request: RunProviderRequest,
  providersRaw: unknown
): { ok: true; value: ResolvedRunProvider } | { ok: false; error: string } {
  const rawList = Array.isArray(providersRaw) ? [...providersRaw] : [];
  const known = rawList.map((item) => coerceProvider(item));
  const endpoint = Boolean(request.apiKey || request.baseUrl || request.api);
  if (endpoint) {
    if (!request.modelId) return { ok: false, error: '新建供应商时需要 --model 或 ENSO_MODEL' };
    if (!request.apiKey) return { ok: false, error: '新建供应商时需要 --api-key 或 ENSO_API_KEY' };
    const id = request.providerId || 'enso-run';
    const api = inferApi(request.baseUrl, request.api);
    const baseUrl = request.baseUrl || DEFAULT_BASE_URLS[api];
    const index = known.findIndex((provider) => provider?.id === id);
    const previous = index >= 0 ? known[index] : null;
    const base: ModelProvider = previous ?? {
      id,
      name: id,
      api,
      apiKey: request.apiKey,
      baseUrl,
      enabled: true,
      models: [],
    };
    const next = withModel(
      {
        ...base,
        name: base.name || id,
        api,
        apiKey: request.apiKey,
        baseUrl,
        enabled: true,
      },
      request.modelId
    );
    const providers = [...rawList];
    if (index >= 0) providers[index] = next;
    else providers.push(next);
    return {
      ok: true,
      value: {
        providerId: id,
        modelId: request.modelId,
        providers,
        changed: JSON.stringify(providers) !== JSON.stringify(rawList),
      },
    };
  }

  const usable = known.filter((provider): provider is ModelProvider => provider !== null);
  const provider =
    (request.providerId ? usable.find((item) => item.id === request.providerId) : undefined) ??
    (!request.providerId ? usable.find((item) => item.enabled && enabledModelId(item)) : undefined);
  if (!provider) {
    return {
      ok: false,
      error: request.providerId
        ? `设置里没有供应商 ${request.providerId}`
        : '没有可用供应商。用 --api-key、--base-url 和 --model 指定，或先写入 settings.json',
    };
  }
  if (!provider.enabled) return { ok: false, error: `供应商 ${provider.id} 已停用` };
  let modelId = enabledModelId(provider, request.modelId);
  let next = provider;
  if (!modelId && request.modelId) {
    next = withModel(provider, request.modelId);
    modelId = request.modelId;
  }
  if (!modelId) return { ok: false, error: `供应商 ${provider.id} 没有可用模型` };
  const reason = modelUsability({ providerId: provider.id, modelId }, [next], {
    oauthCredentials: { status: 'ready', authenticatedAccountKeys: new Set() },
  });
  if (reason !== 'usable') return { ok: false, error: `模型不可用: ${reason}` };
  const index = known.findIndex((item) => item?.id === provider.id);
  const providers = [...rawList];
  if (index >= 0) providers[index] = next;
  return {
    ok: true,
    value: {
      providerId: provider.id,
      modelId,
      providers,
      changed: JSON.stringify(providers) !== JSON.stringify(rawList),
    },
  };
}

export function settingsProviders(settings: unknown): unknown {
  if (!settings || typeof settings !== 'object') return undefined;
  const store = (settings as { 'enso-settings'?: unknown })['enso-settings'];
  if (!store || typeof store !== 'object') return undefined;
  const state = (store as { state?: unknown }).state;
  if (!state || typeof state !== 'object') return undefined;
  return (state as { providers?: unknown }).providers;
}

/** 把供应商写进 settings.json，并限制为仅所有者可读。其它字段原样保留。 */
export function writeProviderSettings(file: string, providers: unknown[]): void {
  let current: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      current = parsed as Record<string, unknown>;
    }
  } catch {
    current = {};
  }
  const store =
    current['enso-settings'] && typeof current['enso-settings'] === 'object'
      ? (current['enso-settings'] as Record<string, unknown>)
      : {};
  const state =
    store.state && typeof store.state === 'object' ? (store.state as Record<string, unknown>) : {};
  const next = {
    ...current,
    'enso-settings': { ...store, state: { ...state, providers } },
  };
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
  chmodSync(file, 0o600);
}
