import type { ModelEntry, ModelProvider } from '../types/llm';

/** 设置页「远程」后端的哨兵模型名：`remote:openai-compatible` 表示还没挑具体模型 */
export const REMOTE_EMBEDDING_SENTINEL_MODEL = 'openai-compatible';

/**
 * ModelEntry 没有 chat / embedding 能力字段（目录物化时还会主动丢掉 embedding 模型），
 * 只能按模型名判断。Main 校验与设置页候选共用这一口径，两边不会出现「能选但必然失败」。
 */
const EMBEDDING_MODEL_PATTERN =
  /embed|bge|m3e|voyage|jina|nomic|mxbai|stella|conan|acge|retriev|text-(?:similarity|search)|(?:^|[^a-z0-9])(?:e5|gte|bce)(?:[^a-z0-9]|$)/i;

export function isLikelyEmbeddingModelId(id: string): boolean {
  return EMBEDDING_MODEL_PATTERN.test(id);
}

export type RemoteEmbeddingIssue =
  | 'no-provider'
  | 'provider-missing'
  | 'no-base-url'
  | 'no-api-key'
  | 'no-model'
  | 'not-embedding-model'
  | 'no-embedding-models';

type ProviderLike = Partial<Pick<ModelProvider, 'baseUrl' | 'apiKey' | 'oauthAccountKey'>> & {
  models?: readonly Pick<ModelEntry, 'id'>[];
};

export function embeddingModelsOf<T extends Pick<ModelEntry, 'id'>>(provider: {
  models?: readonly T[];
}): T[] {
  return Array.isArray(provider.models)
    ? provider.models.filter((m) => typeof m?.id === 'string' && isLikelyEmbeddingModelId(m.id))
    : [];
}

/** 设置页候选：只留填了 API Key + Base URL 的服务商，且只列其中的向量模型 */
export function remoteEmbeddingCandidates<P extends ModelProvider>(providers: readonly P[]): P[] {
  return providers.flatMap((provider) => {
    if (!provider.apiKey || typeof provider.baseUrl !== 'string' || !provider.baseUrl.trim()) {
      return [];
    }
    const models = embeddingModelsOf(provider);
    return models.length > 0 ? [{ ...provider, models }] : [];
  });
}

/** provider 为 undefined 表示 providerId 在设置里找不到（已删除） */
export function remoteEmbeddingIssue(input: {
  providerId: string | null;
  provider: ProviderLike | undefined;
  modelId: string | null;
}): RemoteEmbeddingIssue | null {
  const { providerId, provider, modelId } = input;
  if (!providerId) return 'no-provider';
  if (!provider) return 'provider-missing';
  // 订阅条目 baseUrl 也为空，先判 API Key 才能给出真正的原因
  if (!provider.apiKey) return 'no-api-key';
  if (typeof provider.baseUrl !== 'string' || !provider.baseUrl.trim()) return 'no-base-url';
  if (!modelId || modelId === REMOTE_EMBEDDING_SENTINEL_MODEL) return 'no-model';
  if (isLikelyEmbeddingModelId(modelId)) return null;
  return embeddingModelsOf(provider).length > 0 ? 'not-embedding-model' : 'no-embedding-models';
}

const ISSUE_KEYS: Record<RemoteEmbeddingIssue, string> = {
  'no-provider':
    'No remote embedding provider is selected. Choose a provider with an API key, or switch to a local embedding model.',
  'provider-missing':
    'The selected embedding provider no longer exists. Choose another provider, or switch to a local embedding model.',
  'no-base-url': 'Provider "{{provider}}" has no Base URL. Fill it in, or choose another provider.',
  'no-api-key':
    'Provider "{{provider}}" has no API key. Subscription sign-in cannot be used for embeddings; choose a provider with an API key, or switch to a local embedding model.',
  'no-model': 'No remote embedding model is selected. Choose a model that supports /embeddings.',
  'not-embedding-model':
    '"{{model}}" is a chat model and cannot be used for embeddings. Choose a model that supports /embeddings, or switch to a local embedding model.',
  'no-embedding-models':
    'Provider "{{provider}}" has no embedding model ("{{model}}" is a chat model). Add one that supports /embeddings (e.g. text-embedding-3-small), or switch to a local embedding model.',
};

export const NO_REMOTE_EMBEDDING_CANDIDATES =
  'No model can be used for embeddings: it needs a provider with an API key and an embedding model (e.g. text-embedding-3-small). Subscription sign-in cannot be used for embeddings.';

export function remoteEmbeddingIssueMessage(
  issue: RemoteEmbeddingIssue,
  params: { provider?: string; model?: string },
  t: (key: string, params?: Record<string, string>) => string
): string {
  return t(ISSUE_KEYS[issue], { provider: params.provider ?? '', model: params.model ?? '' });
}
