import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, Model, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { streamSimple as anthropicStream } from '@earendil-works/pi-ai/api/anthropic-messages';
import { streamSimple as completionsStream } from '@earendil-works/pi-ai/api/openai-completions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installLongCacheRetention, withLongCacheRetention } from './longCacheRetention';

const base = {
  reasoning: false,
  input: ['text'],
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  contextWindow: 200_000,
  maxTokens: 8_192,
} as const;
const anthropic = {
  ...base,
  id: 'claude-sonnet-4-5',
  name: 'Claude Sonnet 4.5',
  api: 'anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'https://anthropic.test',
} as unknown as Model<Api>;
const completions = {
  ...base,
  id: 'deepseek-chat',
  name: 'DeepSeek',
  api: 'openai-completions',
  provider: 'custom',
  baseUrl: 'https://compat.test/v1',
} as unknown as Model<Api>;
const context = {
  systemPrompt: 'system',
  messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
} as unknown as Parameters<StreamFn>[1];
const session = { sessionId: 'session-1', apiKey: 'test-key', maxRetries: 0 };

interface Captured {
  body: Record<string, unknown>;
  headers: Record<string, string>;
}
let captured: Captured[];

beforeEach(() => {
  captured = [];
  vi.stubEnv('PI_CACHE_RETENTION', '');
  vi.stubEnv('PI_OFFLINE', '1');
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    captured.push({
      body: await request.json(),
      headers: Object.fromEntries(request.headers.entries()),
    });
    return Response.json(
      { error: { type: 'invalid_request_error', message: 'stub' } },
      {
        status: 400,
      }
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function send(model: Model<Api>, options: SimpleStreamOptions): Promise<Captured> {
  const run = model.api === 'anthropic-messages' ? anthropicStream : completionsStream;
  for await (const _ of run(model as never, context, options));
  const request = captured.at(-1);
  if (!request) throw new Error('no request captured');
  return request;
}

function cacheControls(value: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(value)) for (const item of value) cacheControls(item, out);
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'cache_control') out.push(item);
      else cacheControls(item, out);
    }
  }
  return out;
}

describe('withLongCacheRetention', () => {
  it('只给开启时带 sessionId、未显式指定的 Anthropic Messages 会话请求补 long', () => {
    expect(withLongCacheRetention(anthropic, session, true)).toEqual({
      ...session,
      cacheRetention: 'long',
    });
    expect(withLongCacheRetention(anthropic, session, false)).toBe(session);
    expect(withLongCacheRetention(completions, session, true)).toBe(session);
    const aux = { apiKey: 'test-key' };
    expect(withLongCacheRetention(anthropic, aux, true)).toBe(aux);
    const none = { ...session, cacheRetention: 'none' as const };
    expect(withLongCacheRetention(anthropic, none, true)).toBe(none);
    const noLong = { ...anthropic, compat: { supportsLongCacheRetention: false } } as Model<Api>;
    expect(withLongCacheRetention(noLong, session, true)).toBe(session);
    expect(withLongCacheRetention(anthropic, undefined, true)).toBeUndefined();
  });
});

describe('真实 pi 序列化后的请求体', () => {
  it('开启：Anthropic 每个 cache_control 带 ttl 1h，header 与关闭时一致', async () => {
    const off = await send(anthropic, withLongCacheRetention(anthropic, session, false));
    const on = await send(anthropic, withLongCacheRetention(anthropic, session, true));
    expect(cacheControls(off.body).length).toBeGreaterThan(0);
    expect(cacheControls(off.body)).toEqual(
      cacheControls(off.body).map(() => ({ type: 'ephemeral' }))
    );
    expect(cacheControls(on.body)).toEqual(
      cacheControls(off.body).map(() => ({ type: 'ephemeral', ttl: '1h' }))
    );
    expect(on.headers['anthropic-beta']).toBe(off.headers['anthropic-beta']);
    expect(Object.keys(on.headers).sort()).toEqual(Object.keys(off.headers).sort());
  });

  it('关闭：与不经过开关的原始请求完全一致', async () => {
    const raw = await send(anthropic, session);
    const off = await send(anthropic, withLongCacheRetention(anthropic, session, false));
    expect(off.body).toEqual(raw.body);
    expect(off.headers).toEqual(raw.headers);
  });

  it('非 Anthropic 厂商开启后仍是默认 5m 请求，不多出 prompt_cache_retention', async () => {
    const raw = await send(completions, session);
    const on = await send(completions, withLongCacheRetention(completions, session, true));
    expect(on.body).toEqual(raw.body);
    expect(on.body).not.toHaveProperty('prompt_cache_retention');
  });
});

describe('installLongCacheRetention', () => {
  it('每次请求读开关：切换后下一次请求就生效', async () => {
    const seen: Array<SimpleStreamOptions | undefined> = [];
    const inner: StreamFn = (_model, _context, options) => {
      seen.push(options);
      return undefined as never;
    };
    const agent = { streamFunction: inner };
    let enabled = false;
    installLongCacheRetention(agent, () => enabled);
    await agent.streamFunction(anthropic, context, session);
    enabled = true;
    await agent.streamFunction(anthropic, context, session);
    expect(seen.map((options) => options?.cacheRetention)).toEqual([undefined, 'long']);
  });

  it('包住 runtime 的 stream/streamSimple，虚拟模型路由到的物理模型也生效', () => {
    const seen: Array<SimpleStreamOptions | undefined> = [];
    const record = (_model: Model<Api>, _context: unknown, options?: SimpleStreamOptions) => {
      seen.push(options);
      return undefined as never;
    };
    const runtime = { stream: record, streamSimple: record };
    installLongCacheRetention(runtime, () => true);
    runtime.stream(anthropic, context, session);
    runtime.streamSimple(anthropic, context, session);
    runtime.streamSimple(completions, context, session);
    expect(seen.map((options) => options?.cacheRetention)).toEqual(['long', 'long', undefined]);
  });
});
