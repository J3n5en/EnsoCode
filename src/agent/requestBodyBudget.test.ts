import {
  type Api,
  type Model,
  normalizeContext,
  type Provider,
  type ProviderRequestOptions,
} from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { describe, expect, it, vi } from 'vitest';
import { withRequestBodyBudget } from './requestBodyBudget';

const model: Model<'anthropic-messages'> = {
  id: 'fixture',
  name: 'fixture',
  api: 'anthropic-messages',
  provider: 'fixture',
  baseUrl: 'https://body-budget.invalid',
  input: ['text', 'image'],
  reasoning: false,
  contextWindow: 128_000,
  maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  inputLimits: { maxRequestBytes: 1000 },
};

function fixture(requestModel: Model<Api> = model, options?: ProviderRequestOptions) {
  let captured: ProviderRequestOptions | undefined;
  const stream = vi.fn((_model: unknown, _context: unknown, opts?: ProviderRequestOptions) => {
    captured = opts;
    return new AssistantMessageEventStream();
  });
  const provider = {
    id: 'fixture',
    models: [],
    stream,
    streamSimple: stream,
  } as unknown as Provider;
  const wrapped = withRequestBodyBudget(provider);
  wrapped.streamSimple(requestModel, normalizeContext({ messages: [] }), options);
  if (!captured?.onPayload || !captured.fetch)
    throw new Error('Expected guarded public request options');
  return {
    wrapped,
    provider,
    options: captured,
    payload: captured.onPayload,
    fetch: captured.fetch,
  };
}

describe('整包预算的边界与 provider 组合', () => {
  it('装饰同一个 provider 或其浅拷贝是幂等的，避免 resolve 时递归叠层', () => {
    const { wrapped } = fixture();
    expect(withRequestBodyBudget(wrapped)).toBe(wrapped);
    const copy = { ...wrapped };
    expect(withRequestBodyBudget(copy)).toBe(copy);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    '坏 maxRequestBytes=%s 不静默关闭检查',
    async (value) => {
      const bad = { ...model, inputLimits: { maxRequestBytes: value } };
      const { payload } = fixture(bad);
      await expect(payload({ stream: true }, bad)).rejects.toThrow('positive safe integer');
    }
  );

  it('小于等于精确预算可以发送，不多删内容；多一个 UTF-8 字节即拒绝', async () => {
    const body = { stream: true, system: '中' };
    const bytes = Buffer.byteLength(JSON.stringify(body));
    const exact = { ...model, inputLimits: { maxRequestBytes: bytes } };
    const guarded = fixture(exact);
    expect(await guarded.payload(body, exact)).toBe(body);
    await expect(guarded.payload({ ...body, system: '中x' }, exact)).rejects.toThrow(
      'request_too_large'
    );
  });

  it('最终 fetch 的 string / Request 两种形态都检查，包含 SDK 在 hook 后新增的字节', async () => {
    const delegate = vi.fn(async () => new Response('OK'));
    const { payload, fetch } = fixture(model, { fetch: delegate });
    await payload({ stream: true }, model);
    await expect(
      fetch('https://body-budget.invalid', { method: 'POST', body: 'X'.repeat(1001) })
    ).rejects.toThrow('request_too_large');
    await expect(
      fetch(new Request('https://body-budget.invalid', { method: 'POST', body: '中'.repeat(400) }))
    ).rejects.toThrow('request_too_large');
    const streamBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('X'.repeat(1001)));
        controller.close();
      },
    });
    await expect(
      fetch('https://body-budget.invalid', {
        method: 'POST',
        body: streamBody,
        duplex: 'half',
      } as RequestInit)
    ).rejects.toThrow('request_too_large');
    expect(delegate).not.toHaveBeenCalled();
    await fetch('https://body-budget.invalid', { method: 'POST', body: 'X'.repeat(1000) });
    expect(delegate).toHaveBeenCalledTimes(1);
  });

  it('Anthropic replacement 的 stream:true 强制字段必须算入预算', async () => {
    const body = { system: 'abc' };
    const small = {
      ...model,
      inputLimits: { maxRequestBytes: Buffer.byteLength(JSON.stringify(body)) },
    };
    await expect(fixture(small).payload(body, small)).rejects.toThrow('request_too_large');
  });

  it('合格 Request 的预算检查不能消耗原 body，delegate 仍可读取完整请求', async () => {
    const request = new Request('https://body-budget.invalid', {
      method: 'POST',
      body: 'fixture body',
      headers: { 'X-Fixture': 'retained' },
    });
    const delegate = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe(request);
      expect(request.bodyUsed).toBe(false);
      const outbound = new Request(input, init);
      expect(outbound.headers.get('X-Fixture')).toBe('retained');
      return new Response(await outbound.text());
    });
    const response = await fixture(model, { fetch: delegate }).fetch(request);
    expect(await response.text()).toBe('fixture body');
    expect(delegate).toHaveBeenCalledTimes(1);
  });

  it('合格流式 body 的检查不能耗尽待发送的流，保留信号与 header', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('fixture stream'));
        controller.close();
      },
    });
    const controller = new AbortController();
    const init = {
      method: 'POST',
      body,
      duplex: 'half',
      signal: controller.signal,
      headers: { 'X-Fixture': 'retained' },
    };
    const delegate = vi.fn(async (input: RequestInfo | URL, opts?: RequestInit) => {
      expect(opts?.signal).toBe(controller.signal);
      expect(new Headers(opts?.headers).get('X-Fixture')).toBe('retained');
      return new Response(await new Request(input, opts).text());
    });
    const response = await fixture(model, { fetch: delegate }).fetch(
      'https://body-budget.invalid',
      init
    );
    expect(await response.text()).toBe('fixture stream');
    expect(delegate).toHaveBeenCalledTimes(1);
  });

  it('caller hook 原地修改后也检查，异常原样传播且只调用一次', async () => {
    const onPayload = vi.fn(async (body: unknown) => {
      (body as Record<string, unknown>).system = 'X'.repeat(1000);
    });
    await expect(fixture(model, { onPayload }).payload({ stream: true }, model)).rejects.toThrow(
      'request_too_large'
    );
    expect(onPayload).toHaveBeenCalledTimes(1);
    const failure = new Error('caller failure');
    const reject = vi.fn(async () => {
      throw failure;
    });
    await expect(fixture(model, { onPayload: reject }).payload({}, model)).rejects.toBe(failure);
    expect(reject).toHaveBeenCalledTimes(1);
  });

  it('未知协议未声明上限时不凭空设限，caller 返回值和选项仍保留', async () => {
    const unknown = {
      ...model,
      api: 'fixture-custom-api',
      inputLimits: undefined,
    } as unknown as Model<Api>;
    const body = { huge: 'X'.repeat(2000) };
    const onPayload = vi.fn(async () => body);
    const delegate = vi.fn(async () => new Response('OK'));
    const guarded = fixture(unknown, { onPayload, fetch: delegate, timeoutMs: 1234 });
    expect(await guarded.payload({}, unknown)).toBe(body);
    expect(guarded.options.timeoutMs).toBe(1234);
    await guarded.fetch('https://body-budget.invalid', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    expect(delegate).toHaveBeenCalledTimes(1);
  });

  it.each(['constructor', '__proto__'])(
    '未知协议 %s 不误用对象原型当作预算，也不擅自序列化其 payload',
    async (api) => {
      const unknown = { ...model, api, inputLimits: undefined } as Model<Api>;
      const body: Record<string, unknown> = {};
      body.self = body;
      const onPayload = vi.fn(() => body);
      expect(await fixture(unknown, { onPayload, fetch: vi.fn() }).payload({}, unknown)).toBe(body);
      expect(onPayload).toHaveBeenCalledTimes(1);
    }
  );

  it('未声明上限的未知协议不注入 fetch / payload hook，保留 native transport 的默认行为', () => {
    const unknown = { ...model, api: 'fixture-custom-api', inputLimits: undefined } as Model<Api>;
    const stream = vi.fn(
      (_model: unknown, _context: unknown, _options?: ProviderRequestOptions) =>
        new AssistantMessageEventStream()
    );
    const provider = {
      id: 'fixture',
      models: [],
      stream,
      streamSimple: stream,
    } as unknown as Provider;
    const options = { timeoutMs: 1234 };
    withRequestBodyBudget(provider).streamSimple(
      unknown,
      normalizeContext({ messages: [] }),
      options
    );
    expect(stream.mock.calls[0]).toHaveLength(3);
    expect(stream.mock.calls[0][2]).toBe(options);
  });

  it('有明确上限的其他协议同样检查正文，不能以不是 Anthropic 图片请求绕过', async () => {
    const other = { ...model, api: 'openai-responses' } as Model<'openai-responses'>;
    await expect(fixture(other).payload({ input: 'X'.repeat(1000) }, other)).rejects.toThrow(
      'request_too_large'
    );
  });
});
