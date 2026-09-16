import type { Context, Model, Provider } from '@earendil-works/pi-ai';
import { stream } from '@earendil-works/pi-ai/api/openai-responses';
import { describe, expect, it } from 'vitest';
import { withOpenAIResponsesRouting } from './openaiResponsesRouting';
import { withSseEofFlush } from './sseEofFlush';

const SUMMARY = 'The next step is to water the cactus.';
const MODEL_ID = 'responses-sse-eof-fixture';

const model = {
  id: MODEL_ID,
  name: MODEL_ID,
  api: 'openai-responses',
  provider: 'openai',
  baseUrl: 'https://responses-sse-eof.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
} as Model<'openai-responses'>;

const context: Context = {
  messages: [{ role: 'user', content: 'Summarize the cactus.', timestamp: 1 }],
};

function responsesSse(trailing: '\n\n' | '\n' | ''): string {
  const part = { type: 'output_text', text: SUMMARY, annotations: [] };
  const item = {
    id: 'msg_fixture',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [part],
  };
  const response = {
    id: 'resp_fixture',
    object: 'response',
    created_at: 1,
    model: MODEL_ID,
    status: 'completed',
    output: [item],
    usage: {
      input_tokens: 12,
      output_tokens: 8,
      total_tokens: 20,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
  const position = { item_id: item.id, output_index: 0, content_index: 0 };
  const events = [
    {
      type: 'response.created',
      response: { ...response, status: 'in_progress', output: [], usage: null },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, status: 'in_progress', content: [] },
    },
    { type: 'response.content_part.added', ...position, part: { ...part, text: '' } },
    { type: 'response.output_text.delta', ...position, delta: SUMMARY },
    { type: 'response.output_text.done', ...position, text: SUMMARY },
    { type: 'response.content_part.done', ...position, part },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ];
  const body = events
    .map(
      (event, sequence_number) =>
        `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`
    )
    .join('');
  return trailing === '\n\n' ? body : `${body.trimEnd()}${trailing}`;
}

function sseFetch(trailing: '\n\n' | '\n' | ''): typeof fetch {
  return async () =>
    new Response(responsesSse(trailing), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
}

async function complete(fetchFn: typeof fetch) {
  return stream(model, context, { apiKey: 'sk-fixture', fetch: fetchFn, maxRetries: 0 }).result();
}

describe('withSseEofFlush', () => {
  it('非 event-stream 原样返回，不碰 body', async () => {
    const inner: typeof fetch = async () => Response.json({ ok: true });
    const response = await withSseEofFlush(inner)('https://example.invalid/json');
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('openai-node 在最后一帧没有空行时丢掉 response.completed', async () => {
    const conformant = await complete(sseFetch('\n\n'));
    expect(conformant).toMatchObject({
      stopReason: 'stop',
      content: [{ type: 'text', text: SUMMARY }],
    });

    const dropped = await complete(sseFetch('\n'));
    expect(dropped.stopReason).toBe('error');
    expect(dropped.errorMessage).toMatch(/terminal response event/i);
  });

  it.each(['\n', ''] as const)(
    '补上 EOF 空行后，末帧只有 %j 的网关仍能完成 Responses 流',
    async (trailing) => {
      const message = await complete(withSseEofFlush(sseFetch(trailing)));
      expect(message, message.errorMessage).toMatchObject({
        stopReason: 'stop',
        content: [{ type: 'text', text: SUMMARY }],
      });
    }
  );

  it('Responses provider 包装把 flush 接到 stream fetch', async () => {
    const provider = {
      stream(
        nextModel: Model<'openai-responses'>,
        nextContext: Context,
        options?: { fetch?: typeof fetch }
      ) {
        return stream(nextModel, nextContext, {
          apiKey: 'sk-fixture',
          fetch: options?.fetch,
          maxRetries: 0,
        });
      },
      streamSimple() {
        throw new Error('unused');
      },
    } as unknown as Provider;
    const message = await withOpenAIResponsesRouting(provider)
      .stream(model, context, {
        fetch: sseFetch('\n'),
      })
      .result();
    expect(message, message.errorMessage).toMatchObject({
      stopReason: 'stop',
      content: [{ type: 'text', text: SUMMARY }],
    });
  });
});
