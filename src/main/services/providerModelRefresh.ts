import { isDeepStrictEqual } from 'node:util';
import { isClassifierOnlyProvider } from '@shared/providerCatalog';
import {
  hasApiKeyProviderCredentials,
  normalizeProviderModelRefreshIntervalHours,
} from '@shared/providers/modelRefreshInterval';
import { parseProviderHeaders } from '@shared/providers/providerHeaders';
import { parseProviderProxy } from '@shared/providers/providerProxy';
import type {
  FetchedModel,
  ListModelsResult,
  ModelApiKind,
  ModelEntry,
  ProviderApiConfig,
} from '@shared/types';
import { MODEL_API_KINDS } from '@shared/types/llm';

const HOUR_MS = 60 * 60 * 1000;

interface ProviderModelRefreshDeps {
  readSettingsState(): Record<string, unknown>;
  writeProviders(providers: unknown[]): void;
  fetchModels(config: ProviderApiConfig, signal: AbortSignal): Promise<ListModelsResult>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * 只追加从未见过的模型（不在 knownModelIds 与现有列表里），用户删掉的不会回来。
 * 后台加入的模型默认禁用：无人确认的变更不进模型选择器，由用户在列表里启用。
 *
 * Append only never-seen models so user deletions stay deleted. Background additions start disabled.
 */
function appendUnseenModels(
  models: readonly ModelEntry[],
  knownModelIds: unknown,
  fetched: readonly FetchedModel[]
): { models: ModelEntry[]; knownModelIds: string[] } {
  const known = new Set([...stringIds(knownModelIds), ...models.map((model) => model.id)]);
  const fresh: ModelEntry[] = [];
  for (const model of fetched) {
    if (known.has(model.id)) continue;
    known.add(model.id);
    fresh.push({
      id: model.id,
      enabled: false,
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
    });
  }
  return { models: [...models, ...fresh], knownModelIds: [...known] };
}

const REQUEST_FIELDS = ['api', 'baseUrl', 'apiKey', 'headers', 'proxy'] as const;

/**
 * 渲染端可能带着 Main 后台追加之前的旧快照写回。快照的 knownModelIds 就是它的基线：
 * Main 记过、快照没记过且快照里缺席的模型是后台新增，补回；快照记过却缺席的是用户删除，照删。
 * 同时保留 Main 记录的已见 id 与拉取状态。请求配置已改时不补回旧端点的模型。无需修正返回 undefined。
 *
 * A stale renderer snapshot's knownModelIds is its baseline: restore models Main recorded after it, honor deletions of models it had seen.
 */
export function keepRefreshedProviderModels(
  currentProviders: unknown,
  incomingProviders: unknown
): unknown[] | undefined {
  if (!Array.isArray(currentProviders) || !Array.isArray(incomingProviders)) return;
  const latestById = new Map<string, Record<string, unknown>>();
  for (const entry of currentProviders) {
    const row = asRecord(entry);
    if (typeof row?.id === 'string') latestById.set(row.id, row);
  }
  let corrected = false;
  const next = incomingProviders.map((entry: unknown) => {
    const row = asRecord(entry);
    const latest = typeof row?.id === 'string' ? latestById.get(row.id) : undefined;
    if (!row || !latest || !Array.isArray(latest.knownModelIds) || !Array.isArray(row.models)) {
      return entry;
    }
    const seenIds = stringIds(row.knownModelIds);
    const seen = new Set(seenIds);
    const latestKnown = stringIds(latest.knownModelIds);
    const recorded = new Set(latestKnown);
    const present = new Set(row.models.map((model: unknown) => asRecord(model)?.id));
    const sameRequest = REQUEST_FIELDS.every((field) =>
      isDeepStrictEqual(row[field], latest[field])
    );
    const missed =
      sameRequest && Array.isArray(latest.models)
        ? latest.models.filter((model: unknown) => {
            const id = asRecord(model)?.id;
            return typeof id === 'string' && recorded.has(id) && !seen.has(id) && !present.has(id);
          })
        : [];
    const merged: Record<string, unknown> = {
      ...row,
      models: [...row.models, ...missed],
      knownModelIds: [...seenIds, ...latestKnown.filter((id) => !seen.has(id))],
    };
    if (latest.modelRefreshStatus !== undefined) {
      merged.modelRefreshStatus = latest.modelRefreshStatus;
    }
    if (isDeepStrictEqual(merged, row)) return entry;
    corrected = true;
    return merged;
  });
  return corrected ? next : undefined;
}

function isModelApiKind(value: unknown): value is ModelApiKind {
  return MODEL_API_KINDS.some((api) => api === value);
}

function refreshTarget(value: unknown) {
  const provider = asRecord(value);
  if (!provider) return;
  const { id, api, baseUrl, catalogId, models } = provider;
  if (
    typeof id !== 'string' ||
    provider.enabled !== true ||
    provider.autoFetchModels !== true ||
    !hasApiKeyProviderCredentials(provider) ||
    !isModelApiKind(api) ||
    typeof baseUrl !== 'string' ||
    isClassifierOnlyProvider({
      api,
      baseUrl,
      catalogId: typeof catalogId === 'string' ? catalogId : undefined,
    }) ||
    !Array.isArray(models) ||
    !models.every((model: unknown) => typeof asRecord(model)?.id === 'string')
  ) {
    return;
  }
  // 坏代理不刷新：退回全局代理会把 key 发到用户没选的出口
  const proxy = parseProviderProxy(provider.proxy);
  if (proxy === null) return;
  const config: ProviderApiConfig = {
    api,
    apiKey: provider.apiKey,
    baseUrl,
    headers: parseProviderHeaders(provider.headers, { warn: false }),
    proxy,
  };
  return {
    id,
    provider,
    config,
    models: models as ModelEntry[],
    intervalMs:
      normalizeProviderModelRefreshIntervalHours(provider.modelRefreshIntervalHours) * HOUR_MS,
  };
}

interface Schedule {
  config: ProviderApiConfig;
  intervalMs: number;
  timer?: NodeJS.Timeout;
  running?: AbortController;
}

/**
 * 开启自动拉取的 API Key 条目按 provider id 独立计时。修改间隔会重置该条计时，关闭开关或修改请求配置会取消该条在途请求。
 *
 * Each opted-in API key entry is scheduled by provider id. An interval edit resets its timer. Turning it off or changing its request configuration cancels its active fetch.
 */
export function createProviderModelRefresh(deps: ProviderModelRefreshDeps) {
  const schedules = new Map<string, Schedule>();

  async function refresh(id: string, config: ProviderApiConfig, signal: AbortSignal) {
    let result: ListModelsResult | undefined;
    try {
      result = await deps.fetchModels(config, signal);
    } catch {
      result = undefined;
    }
    if (signal.aborted) return;
    // 错误可能带端点或凭据，日志与状态只记成败
    //
    // Errors may carry endpoints or credentials; log and store only success or failure.
    const ok = result?.ok === true;
    if (!ok) console.warn('[provider-model-refresh] model list failed');

    // 请求期间其他条目也可能写入。核对当前配置、合并并提交使用同一份最新设置。
    //
    // Other entries can write during the request. Check the current config, merge, and commit using the same latest settings snapshot.
    const latest = deps.readSettingsState();
    if (!Array.isArray(latest.providers)) return;
    const index = latest.providers.findIndex((entry: unknown) => asRecord(entry)?.id === id);
    const target = refreshTarget(latest.providers[index]);
    if (!target || !isDeepStrictEqual(target.config, config)) return;
    const next = [...latest.providers];
    next[index] = {
      ...target.provider,
      ...(ok && result
        ? appendUnseenModels(target.models, target.provider.knownModelIds, result.models)
        : {}),
      modelRefreshStatus: { ok, at: Date.now() },
    };
    deps.writeProviders(next);
  }

  function run(id: string, schedule: Schedule): void {
    if (schedule.running) return;
    const controller = new AbortController();
    schedule.running = controller;
    void refresh(id, schedule.config, controller.signal)
      .catch(() => console.warn('[provider-model-refresh] refresh failed'))
      .finally(() => {
        schedule.running = undefined;
      });
  }

  function resetTimer(id: string, schedule: Schedule, intervalMs: number): void {
    clearInterval(schedule.timer);
    schedule.intervalMs = intervalMs;
    schedule.timer = setInterval(() => run(id, schedule), intervalMs).unref();
  }

  function remove(id: string, schedule: Schedule): void {
    schedules.delete(id);
    clearInterval(schedule.timer);
    schedule.running?.abort();
  }

  function stop(): void {
    for (const [id, schedule] of schedules) remove(id, schedule);
  }

  return {
    sync(): void {
      const { providers } = deps.readSettingsState();
      if (!Array.isArray(providers)) {
        stop();
        return;
      }
      const eligible = new Set<string>();
      for (const entry of providers) {
        const target = refreshTarget(entry);
        if (!target || eligible.has(target.id)) continue;
        const { id, config, intervalMs } = target;
        eligible.add(id);
        const current = schedules.get(id);
        if (current && isDeepStrictEqual(current.config, config)) {
          if (current.intervalMs !== intervalMs) resetTimer(id, current, intervalMs);
          continue;
        }
        if (current) remove(id, current);
        const schedule = { config, intervalMs };
        schedules.set(id, schedule);
        resetTimer(id, schedule, intervalMs);
        run(id, schedule);
      }
      for (const [id, schedule] of schedules) {
        if (!eligible.has(id)) remove(id, schedule);
      }
    },
    stop,
  };
}
