import { isDeepStrictEqual } from 'node:util';
import { mergeFetchedModels } from '@shared/modelEntry';
import { isClassifierOnlyProvider } from '@shared/providerCatalog';
import { unionProviderModels } from '@shared/providerIdentity';
import {
  hasApiKeyProviderCredentials,
  normalizeProviderModelRefreshIntervalHours,
} from '@shared/providers/modelRefreshInterval';
import { parseProviderHeaders } from '@shared/providers/providerHeaders';
import {
  type ListModelsResult,
  MODEL_API_KINDS,
  type ModelApiKind,
  type ModelEntry,
  type ProviderApiConfig,
} from '@shared/types';

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
  const config: ProviderApiConfig = {
    api,
    apiKey: provider.apiKey,
    baseUrl,
    headers: parseProviderHeaders(provider.headers, { warn: false }),
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
    let result: ListModelsResult;
    try {
      result = await deps.fetchModels(config, signal);
    } catch {
      if (!signal.aborted) console.warn('[provider-model-refresh] model list failed');
      return;
    }
    if (signal.aborted) return;
    if (!result.ok) {
      console.warn('[provider-model-refresh] model list failed');
      return;
    }
    if (!result.models.length) return;

    // 请求期间其他条目也可能写入。核对当前配置、合并并提交使用同一份最新设置。
    //
    // Other entries can write during the request. Check the current config, merge, and commit using the same latest settings snapshot.
    const latest = deps.readSettingsState();
    if (!Array.isArray(latest.providers)) return;
    const index = latest.providers.findIndex((entry: unknown) => asRecord(entry)?.id === id);
    const target = refreshTarget(latest.providers[index]);
    if (!target || !isDeepStrictEqual(target.config, config)) return;
    const models = unionProviderModels(target.models, mergeFetchedModels([], result.models));
    if (models.length === target.models.length) return;
    const next = [...latest.providers];
    next[index] = { ...target.provider, models };
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
