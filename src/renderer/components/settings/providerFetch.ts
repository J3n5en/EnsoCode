import { mergeFetchedModels } from '@shared/modelEntry';
import type { ModelEntry, ModelProvider } from '@shared/types';

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
