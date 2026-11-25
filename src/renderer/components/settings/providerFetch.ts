import { mergeFetchedModels } from '@shared/modelEntry';
import type { ModelEntry, ModelProvider } from '@shared/types';
import { create } from 'zustand';
import { invalidateModelMeta } from '@/stores/modelMeta';

export type ProviderFetchOutcome =
  | { status: 'ok'; count: number; models?: ModelEntry[] }
  | { status: 'failed'; message: string };

export async function fetchProviderModels(provider: ModelProvider): Promise<ProviderFetchOutcome> {
  try {
    if (provider.oauthAccountKey) {
      // 订阅清单的权威源是 Main 统一目录。空 modelIds 只触发重拉，不回写 settings。
      const result = await window.electronAPI.providers.modelMeta({
        oauthAccountKey: provider.oauthAccountKey,
        modelIds: [],
      });
      if (!result.ok) return { status: 'failed', message: result.error ?? 'Failed' };
      return {
        status: 'ok',
        count: result.models.filter((meta) => meta.source !== 'unknown').length,
      };
    }

    const result = await window.electronAPI.providers.listModels({
      api: provider.api,
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      ...(provider.headers ? { headers: provider.headers } : {}),
      ...(provider.proxy ? { proxy: provider.proxy } : {}),
    });
    if (!result.ok) return { status: 'failed', message: result.error ?? 'Failed' };
    return {
      status: 'ok',
      count: result.models.length,
      models: mergeFetchedModels(provider.models, result.models),
    };
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 并发拉取每个条目的模型清单；结果按 provider.id 归位，单个条目失败不影响其他条目。 */
export async function fetchAllProviderModels(
  providers: readonly ModelProvider[]
): Promise<Record<string, ProviderFetchOutcome>> {
  const pairs = await Promise.all(
    providers.map(async (provider) => [provider.id, await fetchProviderModels(provider)] as const)
  );
  return Object.fromEntries(pairs);
}

/**
 * 把拉到的清单写回 settings。只有带 models 的成功结果才回写：
 * 订阅条目的清单由 Main 统一目录派生，重拉本身就已生效，不写 settings。
 */
export function applyFetchedModels(
  outcomes: Record<string, ProviderFetchOutcome>,
  updateProvider: (id: string, patch: { models: ModelEntry[] }) => void
): void {
  for (const [id, outcome] of Object.entries(outcomes)) {
    if (outcome.status === 'ok' && outcome.models) updateProvider(id, { models: outcome.models });
  }
}

export interface FetchOutcomeSummary {
  okCount: number;
  failedCount: number;
  modelCount: number;
  firstError: string | null;
}

export function summarizeFetchOutcomes(
  outcomes: Record<string, ProviderFetchOutcome>
): FetchOutcomeSummary {
  const summary: FetchOutcomeSummary = {
    okCount: 0,
    failedCount: 0,
    modelCount: 0,
    firstError: null,
  };
  for (const outcome of Object.values(outcomes)) {
    if (outcome.status === 'ok') {
      summary.okCount += 1;
      summary.modelCount += outcome.count;
    } else {
      summary.failedCount += 1;
      summary.firstError ??= outcome.message;
    }
  }
  return summary;
}

interface ProviderFetchEntry {
  refreshing: boolean;
  error: string | null;
}

const useProviderFetchStore = create<{ entries: Record<string, ProviderFetchEntry> }>(() => ({
  entries: {},
}));

export function providerFetchStates(): Record<string, ProviderFetchEntry> {
  return useProviderFetchStore.getState().entries;
}

export function resetProviderFetchStates(): void {
  useProviderFetchStore.setState({ entries: {} });
}

function writeProviderFetchEntry(id: string, entry: ProviderFetchEntry): void {
  useProviderFetchStore.setState((state) => ({
    entries: { ...state.entries, [id]: entry },
  }));
}

export async function refreshProvider(
  provider: ModelProvider,
  updateProvider: (id: string, patch: { models: ModelEntry[] }) => void
): Promise<void> {
  if (useProviderFetchStore.getState().entries[provider.id]?.refreshing) return;
  writeProviderFetchEntry(provider.id, { refreshing: true, error: null });
  let error: string | null = null;
  try {
    const outcome = await fetchProviderModels(provider);
    if (outcome.status === 'failed') {
      error = outcome.message;
    } else {
      applyFetchedModels({ [provider.id]: outcome }, updateProvider);
      invalidateModelMeta();
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    writeProviderFetchEntry(provider.id, { refreshing: false, error });
  }
}

export async function refreshProviders(
  providers: readonly ModelProvider[],
  updateProvider: (id: string, patch: { models: ModelEntry[] }) => void
): Promise<void> {
  await Promise.all(providers.map((provider) => refreshProvider(provider, updateProvider)));
}

/** 多个 id 聚合成一行：任一在刷新即转动，错误取第一个非空。没有记录视为从未刷过。 */
export function useProviderFetchState(providerIds: readonly string[]): {
  refreshing: boolean;
  error: string | null;
} {
  const entries = useProviderFetchStore((state) => state.entries);
  let refreshing = false;
  let error: string | null = null;
  for (const id of providerIds) {
    const entry = entries[id];
    if (!entry) continue;
    if (entry.refreshing) refreshing = true;
    if (error === null && entry.error) error = entry.error;
  }
  return { refreshing, error };
}
