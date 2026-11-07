import { DEFAULT_BASE_URLS, withVersionSegment } from './providerCatalog';
import type { ModelEntry, ModelProvider } from './types';

export type ImageGenerationProtocol = 'openai' | 'openai-compatible' | 'gemini';
export interface ImageGenerationConfig {
  providerId: string;
  modelId: string;
  protocol: ImageGenerationProtocol;
  baseUrl: string;
  apiKey: string;
}
export interface ImageGenerationState {
  config: ImageGenerationConfig | null;
  error?: string;
}
export type ImageGenItem = {
  index: number;
  status: 'success' | 'error' | 'cancelled';
  path: string | null;
  mimeType: string | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !value.includes('?') &&
      !value.includes('#')
    );
  } catch {
    return false;
  }
}
export function parseImageGenerationConfig(value: unknown): ImageGenerationConfig | null {
  const raw = record(value);
  if (!raw) return null;
  if (
    Object.keys(raw).some(
      (key) => !['providerId', 'modelId', 'protocol', 'baseUrl', 'apiKey'].includes(key)
    )
  )
    return null;
  const { providerId, modelId, protocol, baseUrl, apiKey } = raw;
  if (
    typeof providerId !== 'string' ||
    !providerId.trim() ||
    typeof modelId !== 'string' ||
    !modelId.trim() ||
    typeof apiKey !== 'string' ||
    !apiKey.trim() ||
    typeof baseUrl !== 'string' ||
    !validUrl(baseUrl) ||
    (protocol !== 'openai' && protocol !== 'openai-compatible' && protocol !== 'gemini')
  )
    return null;
  return { providerId, modelId, protocol, baseUrl, apiKey };
}
function providerConfig(provider: ModelProvider, modelId: string): ImageGenerationConfig | null {
  if (
    provider?.enabled !== true ||
    provider.oauthAccountKey ||
    provider.oauthAccountPool ||
    typeof provider.apiKey !== 'string' ||
    !provider.apiKey.trim() ||
    typeof provider.baseUrl !== 'string'
  )
    return null;
  let protocol: ImageGenerationProtocol;
  if (provider.api === 'google-generative-ai') protocol = 'gemini';
  else if (provider.api === 'openai-completions' || provider.api === 'openai-responses') {
    let host = '';
    try {
      host = new URL(provider.baseUrl).hostname.toLowerCase();
    } catch {
      // 地址缺失或非法时稍后统一校验。
    }
    protocol =
      provider.catalogId !== '__custom' &&
      (provider.catalogId === 'openai' || (!provider.catalogId && host === 'api.openai.com'))
        ? 'openai'
        : 'openai-compatible';
  } else return null;
  const fallback =
    protocol === 'gemini'
      ? DEFAULT_BASE_URLS['google-generative-ai']
      : protocol === 'openai'
        ? DEFAULT_BASE_URLS['openai-responses']
        : '';
  let baseUrl = provider.baseUrl.trim().replace(/\/+$/, '') || fallback;
  if (protocol === 'gemini' && baseUrl) baseUrl = withVersionSegment(baseUrl, 'v1beta');
  if (protocol === 'openai' && baseUrl) {
    try {
      if (new URL(baseUrl).pathname === '/') baseUrl = `${baseUrl}/v1`;
    } catch {
      // 地址由下方解析器校验。
    }
  }
  return parseImageGenerationConfig({
    providerId: provider.id,
    modelId,
    protocol,
    baseUrl,
    apiKey: provider.apiKey,
  });
}

/** settings 与导入数据可能来自旧版本；单个坏行不能阻止撤销 worker 中的旧配置。 */
function imageModels(provider: ModelProvider | undefined): ModelEntry[] {
  return Array.isArray(provider?.models)
    ? provider.models.filter(
        (model): model is ModelEntry =>
          Boolean(model) &&
          typeof model === 'object' &&
          typeof model.id === 'string' &&
          Boolean(model.id.trim()) &&
          model.enabled !== false &&
          model.imageGeneration === true
      )
    : [];
}
export function imageGenerationCandidateProviders(
  providers: readonly ModelProvider[]
): ModelProvider[] {
  return providers.flatMap((provider) => {
    const models = imageModels(provider).filter((model) => providerConfig(provider, model.id));
    return models.length ? [{ ...provider, models }] : [];
  });
}
export function resolveImageGenerationConfig(
  ref: unknown,
  providers: readonly ModelProvider[]
): ImageGenerationState {
  if (ref === null || ref === undefined) return { config: null };
  const raw = record(ref);
  if (!raw || typeof raw.providerId !== 'string' || typeof raw.modelId !== 'string')
    return { config: null, error: 'Invalid image generation model selection' };
  const provider = providers.find((p) => p?.id === raw.providerId);
  const model = imageModels(provider).find((m) => m.id === raw.modelId);
  const config = provider && model ? providerConfig(provider, model.id) : null;
  return config ? { config } : { config: null, error: 'Image generation model is unavailable' };
}
