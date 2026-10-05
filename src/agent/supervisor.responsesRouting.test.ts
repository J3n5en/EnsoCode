import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
  type AssistantMessage,
  type Context,
  hasApi,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Model,
  normalizeContext,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { streamSimple as serializeResponses } from '@earendil-works/pi-ai/api/openai-responses';
import {
  generateSummaryWithUsage,
  ModelRegistry,
  ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveBaseModel } from './supervisor';

const BASE_URL = 'https://responses-routing.invalid/v1';
const API_KEY = 'sk-fixture-responses-not-a-real-secret';
const MODEL_ID = 'responses-routing-fixture';
const PRIVATE_MARKER = 'fixture-private-topic-42';
const USER_TEXT = `Summarize a fictional chat: ${PRIVATE_MARKER} is watering a cactus.`;
const SUMMARY = 'The next step is to water the cactus.';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const MODEL_CONFIG = {
  api: 'openai-responses' as const,
  baseUrl: BASE_URL,
  apiKey: API_KEY,
  modelId: MODEL_ID,
  settingsProviderId: 'responses-routing-fixture-provider',
  contextWindow: 128_000,
  maxTokens: 32_000,
};

interface CapturedRequest {
  body: Record<string, unknown>;
  headers: Headers;
  status: number;
}

/** Only the transport is fake: Pi must parse real Responses events into the summary. */
function summarySse(): Response {
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
      input_tokens: 60,
      output_tokens: 10,
      total_tokens: 70,
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
    {
      type: 'response.content_part.added',
      ...position,
      part: { ...part, text: '' },
    },
    { type: 'response.output_text.delta', ...position, delta: SUMMARY },
    { type: 'response.output_text.done', ...position, text: SUMMARY },
    { type: 'response.content_part.done', ...position, part },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ];
  return new Response(
    events
      .map(
        (event, sequence_number) =>
          `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`
      )
      .join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  );
}

function chatCompletionSse(): Response {
  const chunk = {
    id: 'chatcmpl_fixture',
    object: 'chat.completion.chunk',
    created: 1,
    model: MODEL_ID,
  };
  const events = [
    {
      ...chunk,
      choices: [{ index: 0, delta: { role: 'assistant', content: SUMMARY }, finish_reason: null }],
    },
    {
      ...chunk,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 60, completion_tokens: 10, total_tokens: 70 },
    },
  ];
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  );
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Expected a Responses request object');
  }
  return payload as Record<string, unknown>;
}

function expectConfiguredHeaders(request: CapturedRequest): void {
  expect(request.headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
  expect(request.headers.get('user-agent')).toMatch(/^enso-code\//);
  expect(request.headers.get('x-fixture-caller')).toBe('retained');
}

function userContext(): Context {
  return { messages: [{ role: 'user', content: USER_TEXT, timestamp: 1 }] };
}

function expectSummary(message: AssistantMessage): void {
  expect(message, message.errorMessage).toMatchObject({
    stopReason: 'stop',
    content: [{ type: 'text', text: SUMMARY }],
    usage: { input: 60, output: 10, totalTokens: 70 },
  });
}

describe('Responses 请求出口的摘要 routing key', () => {
  let runtime: ModelRuntime;
  let model: Model<'openai-responses'>;
  let requests: CapturedRequest[];

  beforeEach(async () => {
    requests = [];
    vi.stubEnv('PI_OFFLINE', '1');
    vi.stubEnv('PI_CACHE_RETENTION', 'short');
    const fakeFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url !== `${BASE_URL}/responses` || request.method !== 'POST') {
        throw new Error(`Unexpected fixture request: ${request.method} ${request.url}`);
      }
      const body: Record<string, unknown> = await request.json();
      const key = body.prompt_cache_key;
      const validKey = typeof key === 'string' && key.trim().length > 0 && key.length <= 64;
      const status = validKey ? 200 : 400;
      requests.push({ body, headers: request.headers, status });
      if (!validKey) {
        return Response.json(
          {
            error: {
              message: 'invalid codex request',
              type: 'invalid_request_error',
              code: 'invalid_responses_request',
            },
          },
          { status: 400, statusText: 'Bad Request' }
        );
      }
      return summarySse();
    };
    // Block every HTTP request, including any accidental catalog/auth request.
    vi.stubGlobal('fetch', fakeFetch);
    runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const resolved = resolveBaseModel(runtime, MODEL_CONFIG);
    if (!hasApi(resolved, 'openai-responses')) throw new Error('Expected Responses fixture model');
    model = resolved;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('native 摘要保持 none 缓存策略和 13107 预算，仍能通过网关拿到摘要', async () => {
    // 真实场景：Pi native compaction 创建了 fresh sessionId，但 none 会让 serializer 删掉 key。
    const sdkOptions: SimpleStreamOptions[] = [];
    const streamFn: StreamFn = (summaryModel, context, options) => {
      sdkOptions.push(options ?? {});
      return runtime.streamSimple(summaryModel, context, options);
    };
    const summary = generateSummaryWithUsage(
      userContext().messages,
      model,
      16_384,
      API_KEY,
      undefined,
      undefined,
      undefined,
      undefined,
      'off',
      streamFn
    );
    // Inspect the actual failed request before surfacing the rejected summary assertion.
    await summary.catch(() => undefined);
    expect(sdkOptions).toHaveLength(1);
    expect(sdkOptions[0]).toMatchObject({
      cacheRetention: 'none',
      maxTokens: 13_107,
      sessionId: expect.any(String),
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toMatchObject({
      model: MODEL_ID,
      stream: true,
      store: false,
      max_output_tokens: 13_107,
    });
    expect(requests[0].body).not.toHaveProperty('tools');
    expect(requests[0].body).not.toHaveProperty('prompt_cache_retention');
    expect(requests[0].body).not.toHaveProperty('prompt_cache_options');
    for (const header of ['session_id', 'x-client-request-id', 'x-session-affinity']) {
      expect(requests[0].headers.has(header)).toBe(false);
    }
    await expect(summary).resolves.toMatchObject({
      text: SUMMARY,
      usage: { input: 60, output: 10, totalTokens: 70 },
    });
    expect(requests[0].status).toBe(200);
  });

  it('normal 已有 session key 原样保留，输出预算、tools 和 role 与 Pi serializer 一致', async () => {
    const context: Context = {
      ...userContext(),
      systemPrompt: 'Summarize only the fictional conversation.',
      tools: [
        {
          name: 'echo_fixture',
          description: 'Echo fictional text.',
          parameters: Type.Object({ text: Type.String() }),
        },
      ],
    };
    const options: SimpleStreamOptions = {
      sessionId: SESSION_ID,
      maxTokens: 32_000,
      cacheRetention: 'short',
    };
    // A positive control also proves the fake SSE is accepted by the unmodified Pi parser.
    expectSummary(
      await serializeResponses(model, normalizeContext(context), {
        ...options,
        apiKey: API_KEY,
      }).result()
    );
    expectSummary(await runtime.streamSimple(model, context, options).result());
    expect(requests).toHaveLength(2);
    expect(requests[1].body).toEqual(requests[0].body);
    expect(requests[1].body).toMatchObject({
      prompt_cache_key: SESSION_ID,
      max_output_tokens: 32_000,
      store: false,
      input: [
        { role: 'developer', content: context.systemPrompt },
        { role: 'user', content: [{ type: 'input_text', text: USER_TEXT }] },
      ],
      tools: [{ type: 'function', name: 'echo_fixture' }],
    });
  });

  it.each(['runtime.completeSimple', 'Smart ModelRegistry.complete'] as const)(
    '%s 只有 user/maxTokens 且无 sessionId：独立请求拿到不同的非敏感 key 并成功',
    async (entry) => {
      const registry = new ModelRegistry(runtime);
      const complete = () =>
        entry === 'runtime.completeSimple'
          ? runtime.completeSimple(model, userContext(), { maxTokens: 13_107 })
          : registry.complete(model, userContext(), { maxTokens: 13_107 });
      const first = await complete();
      const second = await complete();
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.body).toMatchObject({ store: false, max_output_tokens: 13_107 });
        expect(request.body).not.toHaveProperty('tools');
      }
      expectSummary(first);
      expectSummary(second);
      const keys = requests.map((request) => request.body.prompt_cache_key);
      expect(new Set(keys).size).toBe(2);
      for (const key of keys) {
        expect(key).toEqual(expect.any(String));
        expect(key).not.toContain(API_KEY);
        expect(key).not.toContain(PRIVATE_MARKER);
      }
    }
  );

  it.each([
    {
      label: '旧式 long retention',
      cacheRetention: 'long' as const,
      explicitMode: false,
      expectedRetention: '24h',
      expectedOptions: undefined,
    },
    {
      label: '显式 cache mode 的 none',
      cacheRetention: 'none' as const,
      explicitMode: true,
      expectedRetention: undefined,
      expectedOptions: { mode: 'explicit' },
    },
    {
      label: '显式 cache mode 的 long',
      cacheRetention: 'long' as const,
      explicitMode: true,
      expectedRetention: undefined,
      expectedOptions: { ttl: '30m' },
    },
  ])('$label：补 routing key 不改 store:false 或 SDK 的缓存 payload', async (scenario) => {
    const cacheModel: Model<'openai-responses'> = {
      ...model,
      compat: { ...model.compat, supportsExplicitPromptCacheMode: scenario.explicitMode },
    };
    const options: SimpleStreamOptions = {
      maxTokens: 13_107,
      cacheRetention: scenario.cacheRetention,
    };
    const response = await runtime.completeSimple(cacheModel, userContext(), options);
    expect(options.cacheRetention).toBe(scenario.cacheRetention);
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toMatchObject({ store: false, max_output_tokens: 13_107 });
    expect(requests[0].body.prompt_cache_retention).toBe(scenario.expectedRetention);
    expect(requests[0].body.prompt_cache_options).toEqual(scenario.expectedOptions);
    expectSummary(response);
    expect(requests[0].status).toBe(200);
  });

  it('raw complete 保留 reasoning/summary/serviceTier/预算以及鉴权、Enso UA 和 caller headers', async () => {
    const response = await runtime.complete(model, userContext(), {
      maxTokens: 12_345,
      reasoningEffort: 'high',
      reasoningSummary: 'detailed',
      serviceTier: 'priority',
      cacheRetention: 'none',
      headers: { 'X-Fixture-Caller': 'retained' },
    });
    expectSummary(response);
    expect(requests).toHaveLength(1);
    expectConfiguredHeaders(requests[0]);
    expect(response.api).toBe('openai-responses');
    expect(requests[0].body).toMatchObject({
      model: MODEL_ID,
      store: false,
      max_output_tokens: 12_345,
      reasoning: { effort: 'high', summary: 'detailed' },
      service_tier: 'priority',
      include: ['reasoning.encrypted_content'],
    });
  });

  it.each(['replacement', 'in-place/undefined'] as const)(
    '先等待 caller 的异步 %s payload，再为最终缺 key 的 body 补路由',
    async (mode) => {
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const initialKeys: unknown[] = [];
      const onPayload = vi.fn(async (payload: unknown) => {
        const original = payloadRecord(payload);
        initialKeys.push(original.prompt_cache_key);
        entered.resolve();
        await resume.promise;
        const replacement: Record<string, unknown> = {
          ...original,
          temperature: 0.25,
          metadata: { fixture: 'caller-payload' },
        };
        delete replacement.prompt_cache_key;
        if (mode === 'replacement') return replacement;
        delete original.prompt_cache_key;
        Object.assign(original, replacement);
        return undefined;
      });
      const completion = runtime.completeSimple(model, userContext(), {
        sessionId: SESSION_ID,
        cacheRetention: 'short',
        maxTokens: 13_107,
        onPayload,
      });
      await entered.promise;
      const requestsBeforeResume = requests.length;
      resume.resolve();
      expectSummary(await completion);
      expect(requestsBeforeResume).toBe(0);
      expect(onPayload).toHaveBeenCalledTimes(1);
      expect(initialKeys).toEqual([SESSION_ID]);
      expect(requests).toHaveLength(1);
      expect(requests[0].body).toMatchObject({
        max_output_tokens: 13_107,
        store: false,
        temperature: 0.25,
        metadata: { fixture: 'caller-payload' },
        prompt_cache_key: expect.any(String),
      });
      expect(requests[0].body.prompt_cache_key).not.toBe(SESSION_ID);
    }
  );

  it.each([
    { label: '合法字符串', key: 'caller-owned-routing-key', status: 200 },
    { label: '空字符串', key: '', status: 400 },
    { label: '显式 null', key: null, status: 400 },
  ])('caller 已提供 $label key 时原样保留，不擅自改写', async (scenario) => {
    const onPayload = vi.fn((payload: unknown) => ({
      ...payloadRecord(payload),
      prompt_cache_key: scenario.key,
    }));
    const response = await runtime.completeSimple(model, userContext(), {
      cacheRetention: 'none',
      maxTokens: 13_107,
      onPayload,
    });
    expect(onPayload).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(requests[0].body.prompt_cache_key).toBe(scenario.key);
    expect(requests[0].status).toBe(scenario.status);
    if (scenario.status === 200) {
      expectSummary(response);
    } else {
      // Explicit invalid values belong to the caller; only a missing key is filled in.
      expect(response.stopReason).toBe('error');
      expect(response.errorMessage).toContain('invalid_responses_request');
    }
  });

  it('refresh(false) 与重复 resolve 后仍保留鉴权、独立 key/已有 key，caller callback 每请求只执行一次', async () => {
    const onPayload = vi.fn((payload: unknown) => {
      payloadRecord(payload).metadata = { fixture: 'lifecycle' };
    });
    const options: SimpleStreamOptions = {
      cacheRetention: 'none',
      maxTokens: 13_107,
      headers: { 'X-Fixture-Caller': 'retained' },
      onPayload,
    };
    expectSummary(await runtime.completeSimple(model, userContext(), options));
    expect(onPayload).toHaveBeenCalledTimes(1);
    await runtime.refresh({ allowNetwork: false });
    expect(requests).toHaveLength(1);
    expectSummary(await runtime.completeSimple(model, userContext(), options));
    expect(onPayload).toHaveBeenCalledTimes(2);

    resolveBaseModel(runtime, MODEL_CONFIG);
    const resolvedAgain = resolveBaseModel(runtime, MODEL_CONFIG);
    expect(resolvedAgain.provider).toBe(model.provider);
    expectSummary(
      await runtime.completeSimple(resolvedAgain, userContext(), {
        ...options,
        sessionId: SESSION_ID,
        cacheRetention: 'short',
      })
    );
    expectSummary(await runtime.completeSimple(resolvedAgain, userContext(), options));
    expect(onPayload).toHaveBeenCalledTimes(4);
    expect(requests).toHaveLength(4);
    for (const request of requests) {
      expectConfiguredHeaders(request);
      expect(request.body).toMatchObject({
        model: MODEL_ID,
        store: false,
        max_output_tokens: 13_107,
        metadata: { fixture: 'lifecycle' },
        prompt_cache_key: expect.any(String),
      });
    }
    expect(requests[2].body.prompt_cache_key).toBe(SESSION_ID);
    expect(new Set(requests.map((request) => request.body.prompt_cache_key)).size).toBe(4);
  });

  it('非 Responses 的 API-key provider 不增加 Responses routing 字段', async () => {
    const baseUrl = 'https://chat-routing.invalid/v1';
    const fakeFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url !== `${baseUrl}/chat/completions` || request.method !== 'POST') {
        throw new Error(`Unexpected fixture request: ${request.method} ${request.url}`);
      }
      requests.push({ body: await request.json(), headers: request.headers, status: 200 });
      return chatCompletionSse();
    };
    vi.stubGlobal('fetch', fakeFetch);
    const chatModel = resolveBaseModel(runtime, {
      ...MODEL_CONFIG,
      api: 'openai-completions',
      baseUrl,
      settingsProviderId: 'chat-routing-fixture-provider',
    });
    expectSummary(
      await runtime.completeSimple(chatModel, userContext(), {
        cacheRetention: 'none',
        maxTokens: 13_107,
      })
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].body).not.toHaveProperty('prompt_cache_key');
    expect(requests[0].body).not.toHaveProperty('input');
    expect(requests[0].body).toHaveProperty('messages');
  });

  it('oauthAccountKey 选中的既有 Responses provider 不额外补 routing key', async () => {
    // Test account routing, not OAuth login: auth remains a fake key in the isolated runtime.
    const accountKey = 'oauth-responses-fixture';
    runtime.registerProvider(accountKey, {
      api: 'openai-responses',
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      authHeader: true,
      models: [
        {
          id: MODEL_ID,
          name: 'OAuth-selected fixture',
          reasoning: true,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 32_000,
        },
      ],
    });
    const accountModel = resolveBaseModel(runtime, {
      ...MODEL_CONFIG,
      apiKey: '',
      oauthAccountKey: accountKey,
    });
    expect(accountModel.provider).toBe(accountKey);
    const response = await runtime.completeSimple(accountModel, userContext(), {
      cacheRetention: 'none',
      maxTokens: 13_107,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].body).not.toHaveProperty('prompt_cache_key');
    expect(requests[0].headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
    expect(response.stopReason).toBe('error');
    expect(response.errorMessage).toContain('invalid_responses_request');
  });

  it('并发请求共享 options 和 none 策略的 sessionId，仍使用独立 key 且不污染 options', async () => {
    const options: SimpleStreamOptions = {
      sessionId: SESSION_ID,
      cacheRetention: 'none',
      maxTokens: 13_107,
    };
    const originalOptions = { ...options };
    const responses = await Promise.all([
      runtime.completeSimple(model, userContext(), options),
      runtime.completeSimple(model, userContext(), options),
    ]);
    for (const response of responses) expectSummary(response);
    expect(requests).toHaveLength(2);
    const keys = requests.map((request) => request.body.prompt_cache_key);
    for (const key of keys) {
      expect(key).toEqual(expect.any(String));
      expect(key).not.toBe(SESSION_ID);
    }
    expect(keys[0]).not.toBe(keys[1]);
    expect(options).toEqual(originalOptions);
  });

  it.each(['raw', 'simple'] as const)(
    '整包守卫同时覆盖 Responses $0 出口，仍保留 routing 和缓存策略',
    async (mode) => {
      const limited = { ...model, inputLimits: { maxRequestBytes: 1000 } };
      const context: Context = {
        messages: [{ role: 'user', content: 'X'.repeat(1000), timestamp: 1 }],
      };
      const response = await (mode === 'raw'
        ? runtime.complete(limited, context, { maxTokens: 100, cacheRetention: 'none' })
        : runtime.completeSimple(limited, context, { maxTokens: 100, cacheRetention: 'none' }));
      expect(response.stopReason).toBe('error');
      expect(response.errorMessage).toContain('request_too_large');
      expect(requests).toHaveLength(0);
    }
  );

  it('caller 的 onPayload 异步拒绝时保留原错误，不发起任何 HTTP 请求', async () => {
    const fetchSpy = vi.fn(globalThis.fetch);
    vi.stubGlobal('fetch', fetchSpy);
    const failure = new Error('fixture payload callback rejected');
    const onPayload = vi.fn(async () => {
      await Promise.resolve();
      throw failure;
    });
    const response = await runtime.complete(model, userContext(), {
      maxTokens: 13_107,
      cacheRetention: 'none',
      onPayload,
    });
    expect(onPayload).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({ stopReason: 'error', content: [] });
    expect(response.errorMessage).toContain(failure.message);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });
});
