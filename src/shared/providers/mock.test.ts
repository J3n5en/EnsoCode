import { describe, expect, it } from 'vitest';
import { MOCK_API_ID, MOCK_BASE_URL, MOCK_CHAT_MODEL_ID, MOCK_PROVIDER_ID } from '../mockProvider';
import { mockProviderConfig } from './mock';
import type { PiAssistantMessage, PiContext, PiModel } from './piProviderTypes';

const model: PiModel = {
  id: MOCK_CHAT_MODEL_ID,
  name: 'Mock Chat',
  api: MOCK_API_ID,
  provider: MOCK_PROVIDER_ID,
  baseUrl: MOCK_BASE_URL,
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as PiModel;

function context(messages: PiContext['messages']): PiContext {
  return { messages };
}

function userMessage(text: string): PiContext['messages'][number] {
  return { role: 'user', content: text, timestamp: Date.now() } as PiContext['messages'][number];
}

async function collect(
  stream: ReturnType<NonNullable<ReturnType<typeof mockProviderConfig>['streamSimple']>> | undefined
) {
  if (!stream) throw new Error('streamSimple 未注册');
  const types: string[] = [];
  for await (const event of stream) types.push(event.type);
  const message = await stream.result();
  return { types, message };
}

describe('mockProviderConfig', () => {
  it('注册 streamSimple 时同时给出自定义 api 与哨兵 baseUrl', () => {
    const config = mockProviderConfig();
    expect(config.streamSimple).toBeTypeOf('function');
    expect(config.api).toBe(MOCK_API_ID);
    expect(config.baseUrl).toBe(MOCK_BASE_URL);
    expect(config.models?.some((entry) => entry.id === MOCK_CHAT_MODEL_ID)).toBe(true);
  });

  it('可按 spawn 的 modelId 覆盖清单，避免选了别的 id 后 getModel 落空', () => {
    const config = mockProviderConfig({ modelId: 'demo-alt' });
    expect(config.models?.map((entry) => entry.id)).toEqual(['demo-alt']);
  });
});

describe('streamSimple', () => {
  it('把用户消息流成 text_delta，并以 stop 收尾', async () => {
    const stream = mockProviderConfig().streamSimple?.(
      model,
      context([userMessage('Say hello from the mock provider.')])
    );
    const { types, message } = await collect(stream);
    expect(types[0]).toBe('start');
    expect(types).toContain('text_start');
    expect(types).toContain('text_delta');
    expect(types).toContain('text_end');
    expect(types.at(-1)).toBe('done');
    expect(message.role).toBe('assistant');
    expect(message.stopReason).toBe('stop');
    const text = message.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('');
    expect(text).toContain('Say hello from the mock provider.');
  });

  it('工具指令走 toolcall 事件且 stopReason=toolUse', async () => {
    const stream = mockProviderConfig().streamSimple?.(
      model,
      context([userMessage('[[tool:read {"path":"src/app.ts"}]]')])
    );
    const { types, message } = await collect(stream);
    expect(types).toEqual(
      expect.arrayContaining(['start', 'toolcall_start', 'toolcall_delta', 'toolcall_end', 'done'])
    );
    expect(message.stopReason).toBe('toolUse');
    const call = message.content.find((block) => block.type === 'toolCall');
    expect(call).toMatchObject({
      type: 'toolCall',
      name: 'read',
      arguments: { path: 'src/app.ts' },
    });
  });

  it('中止信号时以 aborted error 结束，不抛出未捕获异常', async () => {
    const abort = new AbortController();
    abort.abort();
    const stream = mockProviderConfig().streamSimple?.(
      model,
      context([userMessage('should not finish')]),
      { signal: abort.signal }
    );
    if (!stream) throw new Error('streamSimple 未注册');
    const message = (await stream.result()) as PiAssistantMessage;
    expect(message.stopReason).toBe('aborted');
  });
});
