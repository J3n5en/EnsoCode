import { DEFAULT_BASE_URLS } from '@shared/providerCatalog';
import type {
  ListModelsResult,
  ModelApiKind,
  ProviderApiConfig,
  TestProviderResult,
} from '@shared/types';
import { createSecretSet } from './secretRedactor';

const ANTHROPIC_VERSION = '2023-06-01';
const TIMEOUT_MS = 15000;

export function resolveBase(config: ProviderApiConfig): string {
  const base = config.baseUrl.trim().replace(/\/+$/, '');
  return base || DEFAULT_BASE_URLS[config.api];
}

/** anthropic：base 已含 /v1 则不重复拼接 */
export function withVersionSegment(base: string, segment: string): string {
  return base.endsWith(`/${segment}`) ? base : `${base}/${segment}`;
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
    const models = extractModelIds(config.api, data);
    return { ok: true, models };
  } catch (error) {
    const secrets = createSecretSet([config.apiKey]);
    return { ok: false, models: [], error: secrets.redactError(toMessage(error)) };
  }
}

export function extractModelIds(api: ModelApiKind, data: Record<string, unknown>): string[] {
  // 条目可能是 null 或非对象，先过滤再取字段，避免响应结构异常时抛错
  const objects = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value)
      ? value.filter(
          (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object'
        )
      : [];

  if (api === 'ollama') {
    return objects(data.models)
      .map((item) => item.model ?? item.name)
      .filter((id): id is string => typeof id === 'string');
  }
  if (api === 'google-generative-ai') {
    return objects(data.models)
      .map((item) =>
        typeof item.name === 'string' ? item.name.replace(/^models\//, '') : undefined
      )
      .filter((id): id is string => typeof id === 'string');
  }
  return objects(data.data)
    .map((item) => item.id)
    .filter((id): id is string => typeof id === 'string');
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
        body = { model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] };
        break;
      case 'google-generative-ai':
        url = `${withVersionSegment(base, 'v1beta')}/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
        body = {
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
          generationConfig: { maxOutputTokens: 1 },
        };
        break;
      case 'ollama':
        url = `${base}/api/chat`;
        body = { model, messages: [{ role: 'user', content: 'hi' }], stream: false };
        break;
      case 'openai-responses':
        url = `${base}/responses`;
        headers = { ...headers, Authorization: `Bearer ${key}` };
        body = { model, input: 'hi', max_output_tokens: 16 };
        break;
      default:
        url = `${base}/chat/completions`;
        headers = { ...headers, Authorization: `Bearer ${key}` };
        body = { model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] };
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
