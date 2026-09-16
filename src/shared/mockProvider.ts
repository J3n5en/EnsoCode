import type { ModelEntry, ModelProvider, ProviderApiConfig } from './types';

/** 向导 / 归组 / 设置条目共用的厂商 id */
export const MOCK_PROVIDER_ID = 'mock';

/** pi composer 要求自定义 streamSimple 必须带独立 api 标识 */
export const MOCK_API_ID = 'enso-mock';

/** 占位钥匙：满足 hasProviderCredentials，从不发往真实厂商 */
export const MOCK_API_KEY = 'enso-mock';

/** 哨兵地址：spawn / list / test 用它识别 mock，不发起网络 */
export const MOCK_BASE_URL = 'enso-mock://local';

export const MOCK_CHAT_MODEL_ID = 'mock-chat';

export interface MockModelSpec {
  id: string;
  name: string;
}

export const MOCK_MODELS: readonly MockModelSpec[] = [
  { id: MOCK_CHAT_MODEL_ID, name: 'Mock Chat' },
  { id: 'mock-tools', name: 'Mock Tools' },
];

export interface MockToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export type MockTurn = { kind: 'text'; text: string } | { kind: 'toolUse'; calls: MockToolCall[] };

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/** catalogId / 哨兵地址 / 占位 key 任一命中即视为 mock，避免只改一项后路由漂走 */
export function isMockProviderConfig(
  config: Partial<Pick<ProviderApiConfig, 'apiKey' | 'baseUrl'>> & { catalogId?: string }
): boolean {
  if (config.catalogId === MOCK_PROVIDER_ID) return true;
  if (normalizeBaseUrl(config.baseUrl ?? '') === MOCK_BASE_URL) return true;
  return (config.apiKey ?? '').trim() === MOCK_API_KEY;
}

export function createMockProviderEntry(id: string): ModelProvider {
  const models: ModelEntry[] = MOCK_MODELS.map((model) => ({
    id: model.id,
    label: model.name,
    enabled: true,
  }));
  return {
    id,
    name: 'Mock',
    api: 'openai-completions',
    apiKey: MOCK_API_KEY,
    baseUrl: MOCK_BASE_URL,
    enabled: true,
    catalogId: MOCK_PROVIDER_ID,
    models,
  };
}

export function messageText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const text = (part as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .join('\n');
}

export function lastUserText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object') continue;
    if ((message as { role?: unknown }).role !== 'user') continue;
    const text = messageText(message).trim();
    if (text) return text;
  }
  return '';
}

export function hasToolResult(messages: readonly unknown[]): boolean {
  return messages.some((message) => {
    if (!message || typeof message !== 'object') return false;
    const role = (message as { role?: unknown }).role;
    if (role === 'toolResult' || role === 'tool') return true;
    const content = (message as { content?: unknown }).content;
    return Array.isArray(content)
      ? content.some((part) => (part as { type?: unknown } | null)?.type === 'tool_result')
      : false;
  });
}

const TOOL_DIRECTIVE = /\[\[tool:([\w./-]+)\s*(\{[\s\S]*?\}|[^\]]+)?\]\]/g;

export function parseMockToolDirectives(text: string): MockToolCall[] {
  const calls: MockToolCall[] = [];
  const source = text ?? '';
  for (const match of source.matchAll(TOOL_DIRECTIVE)) {
    const name = match[1];
    if (!name) continue;
    let args: Record<string, unknown> = {};
    const raw = match[2]?.trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        args = {};
      }
    }
    calls.push({ name, arguments: args });
  }
  return calls;
}

function conversationText(messages: readonly unknown[]): string {
  return messages.map(messageText).filter(Boolean).join('\n');
}

function wrapUserQuote(text: string): string {
  const clipped = text.length > 400 ? `${text.slice(0, 397)}...` : text;
  return clipped
    .split('\n')
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
}

export function buildMockReplyText(userText: string, afterTools: boolean): string {
  if (afterTools) {
    return [
      'Mock finished the requested tool turn and is wrapping up locally.',
      'No vendor API was called; this is a built-in demo reply.',
    ].join('\n');
  }
  const quoted = userText.trim() ? wrapUserQuote(userText.trim()) : '> (empty prompt)';
  return [
    'Mock here — a local demo model with no API key and no network.',
    '',
    'You said:',
    quoted,
    '',
    'I can stream assistant text, and `[[tool:name {"arg":"value"}]]` will demo a tool call.',
  ].join('\n');
}

export function buildMockTurn(messages: readonly unknown[]): MockTurn {
  const safe = Array.isArray(messages) ? messages : [];
  const afterTools = hasToolResult(safe);
  const directives = afterTools ? [] : parseMockToolDirectives(conversationText(safe));
  if (directives.length > 0) return { kind: 'toolUse', calls: directives };
  return { kind: 'text', text: buildMockReplyText(lastUserText(safe), afterTools) };
}

export function chunkText(text: string, size = 24): string[] {
  if (!text) return [''];
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}
