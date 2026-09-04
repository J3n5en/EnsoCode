import { vendorOf } from './providerGroups';
import type { ModelEntry, ModelProvider } from './types/llm';

export type ProviderIdentityInput = Pick<
  ModelProvider,
  'baseUrl' | 'apiKey' | 'oauthAccountKey' | 'catalogId'
>;

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/**
 * 入库去重键。
 *
 * - 订阅：账号 key（同一厂商多账号不能互吞）
 * - API-key：端点 + 钥匙 + 厂商桶。从 xAI 向导改到已有 OpenAI 中转 URL
 *   时必须是另一条（独立供应商）；选 Custom 且 hostname 也是 Custom 才合并进已有行。
 */
export function providerDedupeKey(provider: ProviderIdentityInput): string {
  if (provider.oauthAccountKey) return `oauth::${provider.oauthAccountKey}`;
  return `${normalizeBaseUrl(provider.baseUrl)}::${provider.apiKey.trim()}::${vendorOf(provider)}`;
}

/** 已有模型（含用户覆盖）优先；只把新 id 追加到末尾。 */
export function unionProviderModels(
  current: readonly ModelEntry[],
  incoming: readonly ModelEntry[]
): ModelEntry[] {
  const known = new Set(current.map((model) => model.id));
  const extra = incoming.filter((model) => !known.has(model.id));
  return [...current, ...extra];
}

/**
 * 把新录入的 provider 合进已有列表。
 * 指纹撞车时合并模型而不是整条丢弃，这样「同一 URL、不同模型」能生效。
 */
export function applyIncomingProviders(
  existing: readonly ModelProvider[],
  incoming: readonly ModelProvider[]
): { providers: ModelProvider[]; added: number } {
  const providers = existing.map((provider) => ({
    ...provider,
    models: [...provider.models],
  }));
  const indexByKey = new Map(
    providers.map((provider, index) => [providerDedupeKey(provider), index])
  );
  let added = 0;

  for (const provider of incoming) {
    const key = providerDedupeKey(provider);
    const index = indexByKey.get(key);
    if (index === undefined) {
      indexByKey.set(key, providers.length);
      providers.push(provider);
      added += 1;
      continue;
    }
    const current = providers[index];
    const models = unionProviderModels(current.models, provider.models);
    if (models.length === current.models.length) continue;
    providers[index] = { ...current, models };
    added += 1;
  }

  return { providers, added };
}
