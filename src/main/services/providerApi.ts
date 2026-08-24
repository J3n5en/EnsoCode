import type {
  ListModelsResult,
  ModelApiKind,
  ProviderApiConfig,
  TestProviderResult,
} from '@shared/types';

const DEFAULT_BASE_URLS: Record<ModelApiKind, string> = {
  'openai-completions': 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  'anthropic-messages': 'https://api.anthropic.com',
  'google-generative-ai': 'https://generativelanguage.googleapis.com',
  ollama: 'http://127.0.0.1:11434',
};

const ANTHROPIC_VERSION = '2023-06-01';
const TIMEOUT_MS = 15000;

function resolveBase(config: ProviderApiConfig): string {
  const base = config.baseUrl.trim().replace(/\/+$/, '');
  return base || DEFAULT_BASE_URLS[config.api];
}

/** anthropic：base 已含 /v1 则不重复拼接 */
function withVersionSegment(base: string, segment: string): string {
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

async function errorText(response: Response): Promise<string> {
  const body = (await response.text().catch(() => '')).slice(0, 300);
  return `HTTP ${response.status}${body ? `: ${body}` : ''}`;
}

function toMessage(error: unknown): string {
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
    if (!response.ok) return { ok: false, models: [], error: await errorText(response) };

    const data = (await response.json()) as Record<string, unknown>;
    const models = extractModelIds(config.api, data);
    return { ok: true, models };
  } catch (error) {
    return { ok: false, models: [], error: toMessage(error) };
  }
}

function extractModelIds(api: ModelApiKind, data: Record<string, unknown>): string[] {
  let list: unknown[] = [];
  if (api === 'ollama') {
    list = Array.isArray(data.models) ? data.models : [];
    return list
      .map(
        (item) =>
          (item as { name?: string; model?: string }).model ?? (item as { name?: string }).name
      )
      .filter((id): id is string => typeof id === 'string');
  }
  if (api === 'google-generative-ai') {
    list = Array.isArray(data.models) ? data.models : [];
    return list
      .map((item) => (item as { name?: string }).name?.replace(/^models\//, ''))
      .filter((id): id is string => typeof id === 'string');
  }
  list = Array.isArray(data.data) ? data.data : [];
  return list
    .map((item) => (item as { id?: string }).id)
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
    if (!response.ok) return { ok: false, latencyMs, message: await errorText(response) };
    return { ok: true, latencyMs, message: model };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, message: toMessage(error) };
  }
}
