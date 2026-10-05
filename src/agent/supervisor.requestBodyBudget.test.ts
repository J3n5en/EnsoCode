import {
  type AssistantMessage,
  type Context,
  hasApi,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Model,
} from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveBaseModel } from './supervisor';

const API_KEY = 'fixture-body-budget-not-a-real-key';
const MiB = 1024 * 1024;
const LIMIT = 12_000;
const SUMMARY = 'fixture OK';

function anthropicSse(): Response {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_fixture',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-opus-5-5',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: SUMMARY } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: 'message_stop' },
  ];
  return new Response(
    events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
    {
      headers: { 'content-type': 'text/event-stream' },
    }
  );
}

const image = (data: string) => ({ type: 'image' as const, data, mimeType: 'image/png' });
const text = (value: string) => ({ type: 'text' as const, text: value });

function imageContext(
  model: Model<'anthropic-messages'>,
  oldCount: number,
  freshCount = 1,
  withUser = true
): Context {
  const messages: Context['messages'] = withUser
    ? [{ role: 'user', content: 'long image task', timestamp: 1 }]
    : [];
  const batch = (prefix: string, count: number) => {
    const calls = Array.from({ length: count }, (_, i) => ({
      type: 'toolCall' as const,
      id: `${prefix}_${i}`,
      name: 'read',
      arguments: { path: `${prefix}_${i}.png` },
    }));
    const assistant: AssistantMessage = {
      role: 'assistant',
      content: calls,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 10,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 12,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'toolUse',
      timestamp: messages.length + 2,
    };
    messages.push(assistant);
    for (const call of calls)
      messages.push({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: 'read',
        content: [
          text(`Read image file ${call.arguments.path}`),
          image(prefix === 'old' ? 'A'.repeat(4096) : 'B'.repeat(4096)),
        ],
        isError: false,
        timestamp: messages.length + 2,
      });
  };
  if (oldCount) batch('old', oldCount);
  batch('fresh', freshCount);
  return { messages };
}

function inlineImages(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const source = record.source as { type?: string; data?: string } | undefined;
  const own =
    record.type === 'image' && source?.type === 'base64' && typeof source.data === 'string'
      ? [source.data]
      : [];
  return [
    ...own,
    ...Object.values(record).flatMap((v) =>
      Array.isArray(v) ? v.flatMap(inlineImages) : inlineImages(v)
    ),
  ];
}

describe('provider 出口的请求整包体积预算', () => {
  let runtime: ModelRuntime;
  let model: Model<'anthropic-messages'>;
  let requests: Array<{ bytes: number; body: unknown; headers: Headers }>;

  beforeEach(async () => {
    requests = [];
    vi.stubEnv('PI_OFFLINE', '1');
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const body = await request.text();
      requests.push({
        bytes: Buffer.byteLength(body),
        body: JSON.parse(body),
        headers: request.headers,
      });
      return anthropicSse();
    });
    runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const resolved = resolveBaseModel(runtime, {
      api: 'anthropic-messages',
      modelId: 'claude-opus-5-5',
      baseUrl: 'https://body-budget.invalid',
      apiKey: API_KEY,
      settingsProviderId: 'body-budget',
    });
    if (!hasApi(resolved, 'anthropic-messages')) throw new Error('Expected Anthropic model');
    model = { ...resolved, api: 'anthropic-messages', inputLimits: { maxRequestBytes: LIMIT } };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('未超限时保留图片、正文、鉴权与 caller 请求选项，不改输入上下文', async () => {
    const context = imageContext(model, 1);
    const before = JSON.stringify(context);
    const response = await runtime.completeSimple(model, context, {
      headers: { 'X-Fixture': 'retained' },
    });
    expect(response.stopReason, response.errorMessage).toBe('stop');
    expect(requests).toHaveLength(1);
    expect(inlineImages(requests[0].body)).toHaveLength(2);
    expect(requests[0].headers.get('x-api-key')).toBe(API_KEY);
    expect(requests[0].headers.get('x-fixture')).toBe('retained');
    expect(JSON.stringify(context)).toBe(before);
  });

  it.each([true, false])(
    '长单轮 / 压缩后无原始 user（withUser=%s）超限时移出已看旧图，保留新图与工具配对',
    async (withUser) => {
      // 真实场景：一个 user 后几十次 read；压缩移走 user 后，旧清理函数直接 fail-open。
      const context = imageContext(model, 6, 1, withUser);
      const before = JSON.stringify(context);
      const response = await runtime.completeSimple(model, context);
      expect(response.stopReason, response.errorMessage).toBe('stop');
      expect(requests).toHaveLength(1);
      expect(requests[0].bytes).toBeLessThanOrEqual(LIMIT);
      expect(inlineImages(requests[0].body)).toContain('B'.repeat(4096));
      expect(JSON.stringify(requests[0].body)).toContain('old_0.png');
      expect(JSON.stringify(requests[0].body)).toContain('image omitted from context');
      expect(JSON.stringify(requests[0].body).match(/"type":"tool_result"/g)).toHaveLength(7);
      expect(JSON.stringify(context)).toBe(before);
    }
  );

  it('最新工具批次的多张新图全部保护，不只保护最后一张', async () => {
    const response = await runtime.completeSimple(model, imageContext(model, 4, 2));
    expect(response.stopReason, response.errorMessage).toBe('stop');
    expect(requests[0].bytes).toBeLessThanOrEqual(LIMIT);
    expect(inlineImages(requests[0].body).filter((data) => data === 'B'.repeat(4096))).toHaveLength(
      2
    );
  });

  it.each(['raw', 'simple'] as const)(
    '$0 出口：只含本次新图且超限时明确失败，不发网络请求、不偷偷删图',
    async (mode) => {
      const context = imageContext(model, 0, 4);
      const response = await (mode === 'raw'
        ? runtime.complete(model, context, { maxTokens: 100 })
        : runtime.completeSimple(model, context));
      expect(response.stopReason).toBe('error');
      expect(response.errorMessage).toContain('request_too_large');
      expect(requests).toHaveLength(0);
      expect(context.messages.filter((m) => m.role === 'toolResult')).toHaveLength(4);
    }
  );

  it('用户附件不当作旧工具图淘汰，包括早于后续 assistant 的附件', async () => {
    const context = imageContext(model, 0);
    context.messages.unshift({
      role: 'user',
      content: [text('reference'), image('A'.repeat(LIMIT))],
      timestamp: 0,
    });
    const response = await runtime.completeSimple(model, context);
    expect(response.stopReason).toBe('error');
    expect(requests).toHaveLength(0);
  });

  it.each(['raw', 'simple'] as const)(
    '$0 出口：终端 base64 等大段普通文本也计入整包，不能绕过',
    async (mode) => {
      const context: Context = {
        messages: [
          { role: 'user', content: `data:image/png;base64,${'A'.repeat(LIMIT)}`, timestamp: 1 },
        ],
      };
      const response = await (mode === 'raw'
        ? runtime.complete(model, context)
        : runtime.completeSimple(model, context));
      expect(response.stopReason).toBe('error');
      expect(response.errorMessage).toContain('request_too_large');
      expect(requests).toHaveLength(0);
    }
  );

  it('按完整 UTF-8 JSON 字节而非字符或解码图片字节衡量，也计入 system', async () => {
    const context: Context = {
      systemPrompt: '中'.repeat(5000),
      messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
    };
    const response = await runtime.completeSimple(model, context);
    expect(response.stopReason).toBe('error');
    expect(requests).toHaveLength(0);
  });

  it('caller 异步替换 payload 后再检查体积，不能在 hook 前检查就放行', async () => {
    const onPayload = vi.fn(async (payload: unknown) => ({
      ...(payload as object),
      system: 'X'.repeat(LIMIT),
    }));
    const response = await runtime.completeSimple(
      model,
      { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] },
      { onPayload }
    );
    expect(response.stopReason).toBe('error');
    expect(requests).toHaveLength(0);
    expect(onPayload).toHaveBeenCalledTimes(1);
  });

  it('上次助手报错未实际看过的工具图片不可淘汰', async () => {
    const context = imageContext(model, 0, 4);
    context.messages.push({
      ...context.messages[1],
      content: [],
      stopReason: 'error',
      errorMessage: '502',
    } as AssistantMessage);
    const response = await runtime.completeSimple(model, context);
    expect(response.stopReason).toBe('error');
    expect(requests).toHaveLength(0);
  });

  it('自定义 Anthropic 模型缺少限制元数据时仍执行协议的 32 MiB 上限', async () => {
    const context: Context = {
      messages: [{ role: 'user', content: [image('A'.repeat(32 * MiB + 1))], timestamp: 1 }],
    };
    const response = await runtime.completeSimple({ ...model, inputLimits: undefined }, context);
    expect(response.stopReason).toBe('error');
    expect(requests).toHaveLength(0);
  });

  it('重复 resolve 和 runtime refresh 后仍执行预算，且不累积 caller hook', async () => {
    await runtime.refresh({ allowNetwork: false });
    resolveBaseModel(runtime, {
      api: 'anthropic-messages',
      modelId: 'claude-opus-5-5',
      baseUrl: 'https://body-budget.invalid',
      apiKey: API_KEY,
      settingsProviderId: 'body-budget',
    });
    const onPayload = vi.fn();
    const response = await runtime.completeSimple(model, imageContext(model, 0, 4), { onPayload });
    expect(response.stopReason).toBe('error');
    expect(requests).toHaveLength(0);
    expect(onPayload).toHaveBeenCalledTimes(1);
  });
});
