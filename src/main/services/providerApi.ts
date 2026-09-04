import { positiveFiniteNumber } from '@shared/modelCatalog';
import { DEFAULT_BASE_URLS, withVersionSegment } from '@shared/providerCatalog';
import type {
  FetchedModel,
  ListModelsResult,
  ModelApiKind,
  ProviderApiConfig,
  TestProviderResult,
} from '@shared/types';
import { createSecretSet } from './secretRedactor';

const ANTHROPIC_VERSION = '2023-06-01';
const TIMEOUT_MS = 15000;
/** 连通性探测上限。1 会让 thinking 模型在思维链阶段直接超限（上游 502）。 */
const TEST_MAX_OUTPUT_TOKENS = 4096;

export function resolveBase(config: ProviderApiConfig): string {
  const base = config.baseUrl.trim().replace(/\/+$/, '');
  return base || DEFAULT_BASE_URLS[config.api];
}

async function request(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function httpError(response: Response): string {
  return `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
}

export function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'AbortError' ? 'Request timed out' : error.message;
  }
  return String(error);
}

export async function listModels(config: ProviderApiConfig): Promise<ListModelsResult> {
  const base = resolveBase(config);
  const key = config.apiKey.trim();
  try {
    let url: string;
    let headers: Record<string, string> = {};
    switch (config.api) {
      case 'anthropic-messages':
        url = `${withVersionSegment(base, 'v1')}/models`;
        headers = { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION };
        break;
      case 'google-generative-ai':
        url = `${withVersionSegment(base, 'v1beta')}/models?key=${encodeURIComponent(key)}`;
        break;
      case 'ollama':
        url = `${base}/api/tags`;
        break;
      default:
        url = `${base}/models`;
        headers = { Authorization: `Bearer ${key}` };
    }

    const response = await request(url, { headers });
    if (!response.ok) return { ok: false, models: [], error: httpError(response) };

    const data = (await response.json()) as Record<string, unknown>;
    const models = extractModelEntries(config.api, data);
    return { ok: true, models };
  } catch (error) {
    const secrets = createSecretSet([config.apiKey]);
    return { ok: false, models: [], error: secrets.redactError(toMessage(error)) };
  }
}

/**
 * 各家 "OpenAI 兼容" 站与 Google 官方对上下文窗口 / 最大输出的字段名各不相同，
 * 按 "更具体的字段名优先" 依次探测（清单参考 DeepChat new-api 分支 + OpenRouter/Groq/Gemini）。
 * 官方 OpenAI / Anthropic 不返回这些字段，探不到就缺省，下游走 catalog/default 兜底。
 */
const CONTEXT_WINDOW_FIELDS = [
  'context_length',
  'contextLength',
  'input_token_limit',
  'max_input_tokens',
  'context_window',
  'context_size',
  'inputTokenLimit',
] as const;

const MAX_TOKENS_FIELDS = [
  'max_completion_tokens',
  'max_output_tokens',
  'output_token_limit',
  'max_tokens',
  'outputTokenLimit',
] as const;

function firstPositiveField(
  item: Record<string, unknown>,
  fields: readonly string[]
): number | undefined {
  for (const field of fields) {
    const value = positiveFiniteNumber(item[field]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** 非正 / 非有限 / 非数字一律视为缺失，不留假数字 */
function attachTokenLimits(id: string, item: Record<string, unknown>): FetchedModel {
  const contextWindow = firstPositiveField(item, CONTEXT_WINDOW_FIELDS);
  let maxTokens = firstPositiveField(item, MAX_TOKENS_FIELDS);
  if (maxTokens === undefined && item.top_provider && typeof item.top_provider === 'object') {
    // OpenRouter 形状：最大输出藏在 top_provider 里
    maxTokens = firstPositiveField(item.top_provider as Record<string, unknown>, [
      'max_completion_tokens',
    ]);
  }
  return {
    id,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

export function extractModelEntries(
  api: ModelApiKind,
  data: Record<string, unknown>
): FetchedModel[] {
  // 条目可能是 null 或非对象，先过滤再取字段，避免响应结构异常时抛错
  const objects = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value)
      ? value.filter(
          (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object'
        )
      : [];

  if (api === 'ollama') {
    // /api/tags 不携带上下文信息（需要逐个调 /api/show，不在本列表接口里做）
    return objects(data.models)
      .map((item) => item.model ?? item.name)
      .filter((id): id is string => typeof id === 'string')
      .map((id) => ({ id }));
  }
  if (api === 'google-generative-ai') {
    return objects(data.models)
      .filter(
        (item): item is Record<string, unknown> & { name: string } => typeof item.name === 'string'
      )
      .map((item) => attachTokenLimits(item.name.replace(/^models\//, ''), item));
  }
  return objects(data.data)
    .filter((item): item is Record<string, unknown> & { id: string } => typeof item.id === 'string')
    .map((item) => attachTokenLimits(item.id, item));
}

export async function testProvider(
  config: ProviderApiConfig,
  modelId?: string
): Promise<TestProviderResult> {
  const started = Date.now();
  const model = modelId?.trim();

  // 无模型可用时，退化为拉取模型列表做连通性检查
  if (!model) {
    const result = await listModels(config);
    return {
      ok: result.ok,
      latencyMs: Date.now() - started,
      message: result.ok ? 'Connected' : (result.error ?? 'Failed'),
    };
  }

  const base = resolveBase(config);
  const key = config.apiKey.trim();
  try {
    let url: string;
    let headers: Record<string, string> = { 'Content-Type': 'application/json' };
    let body: unknown;

    switch (config.api) {
      case 'anthropic-messages':
        url = `${withVersionSegment(base, 'v1')}/messages`;
        headers = { ...headers, 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION };
        body = {
          model,
          max_tokens: TEST_MAX_OUTPUT_TOKENS,
          messages: [{ role: 'user', content: 'hi' }],
        };
        break;
      case 'google-generative-ai':
        url = `${withVersionSegment(base, 'v1beta')}/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
        body = {
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
          generationConfig: { maxOutputTokens: TEST_MAX_OUTPUT_TOKENS },
        };
        break;
      case 'ollama':
        url = `${base}/api/chat`;
        body = { model, messages: [{ role: 'user', content: 'hi' }], stream: false };
        break;
      case 'openai-responses':
        url = `${base}/responses`;
        headers = { ...headers, Authorization: `Bearer ${key}` };
        body = { model, input: 'hi', max_output_tokens: TEST_MAX_OUTPUT_TOKENS };
        break;
      default:
        url = `${base}/chat/completions`;
        headers = { ...headers, Authorization: `Bearer ${key}` };
        body = {
          model,
          max_tokens: TEST_MAX_OUTPUT_TOKENS,
          messages: [{ role: 'user', content: 'hi' }],
        };
    }

    const response = await request(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const latencyMs = Date.now() - started;
    if (!response.ok) return { ok: false, latencyMs, message: httpError(response) };
    return { ok: true, latencyMs, message: model };
  } catch (error) {
    const secrets = createSecretSet([config.apiKey]);
    return {
      ok: false,
      latencyMs: Date.now() - started,
      message: secrets.redactError(toMessage(error)),
    };
  }
}
