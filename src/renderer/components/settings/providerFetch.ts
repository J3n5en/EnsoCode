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
