import {
  type Model,
  normalizeContext,
  type Provider,
  type ProviderRequestOptions,
} from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { RequestBodyUsage } from '@shared/requestBodyUsage';
import { describe, expect, it, vi } from 'vitest';
import { withRequestBodyBudget } from './requestBodyBudget';
import { type RequestBodyRequestMarker, runWithRequestBodyObserver } from './requestBodyTelemetry';

const model: Model<'anthropic-messages'> = {
  id: 'fixture',
  name: 'fixture',
  api: 'anthropic-messages',
  provider: 'fixture',
  baseUrl: 'https://budget.invalid',
  input: ['text'],
  reasoning: false,
  contextWindow: 128_000,
  maxTokens: 10,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  inputLimits: { maxRequestBytes: 1000 },
};

function requestOptions(extra: ProviderRequestOptions & RequestBodyRequestMarker = {}) {
  let options: ProviderRequestOptions | undefined;
  const stream = (_model: unknown, _context: unknown, value?: ProviderRequestOptions) => {
    options = value;
    return new AssistantMessageEventStream();
  };
  const delegate = vi.fn(async () => new Response('OK'));
  const provider = withRequestBodyBudget({
    id: 'fixture',
    models: [],
    stream,
    streamSimple: stream,
  } as unknown as Provider);
  provider.streamSimple(model, normalizeContext({ messages: [] }), {
    ...extra,
    fetch: delegate,
    headers: { 'X-Private': 'fixture-secret' },
  });
  if (!options?.onPayload || !options.fetch) throw new Error('missing request options');
  return { payload: options.onPayload, fetch: options.fetch, delegate };
}

describe('请求体遥测与预算共用真实发送出口', () => {
  it('压缩摘要与同 sessionId 的预热不覆盖被阻止的主请求，但仍执行预算守卫', async () => {
    const signal = new AbortController().signal;
    const marker = { sessionId: 'main', signal };
    const main = requestOptions(marker);
    const summary = requestOptions({ sessionId: 'summary', signal });
    const warmup = requestOptions({ sessionId: 'main', signal: new AbortController().signal });
    const events: RequestBodyUsage[] = [];
    await runWithRequestBodyObserver(
      (usage) => events.push(usage),
      async () => {
        await expect(main.payload({ system: '中'.repeat(500) }, model)).rejects.toThrow(
          'request_too_large'
        );
        for (const opts of [summary, warmup]) {
          const body = await opts.payload({ system: 'maintenance' }, model);
          await opts.fetch('https://budget.invalid', {
            method: 'POST',
            body: JSON.stringify(body),
          });
          await expect(opts.payload({ system: '中'.repeat(500) }, model)).rejects.toThrow(
            'request_too_large'
          );
          expect(opts.delegate).toHaveBeenCalledTimes(1);
        }
      },
      marker
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ blocked: true, stage: 'payload' });
    expect(main.delegate).not.toHaveBeenCalled();
  });
  it('同一次主请求的 payload / wire 都保留，过滤只影响遥测不改 SDK 选项', async () => {
    const marker = { sessionId: 'main', signal: new AbortController().signal };
    const main = requestOptions(marker);
    const events: RequestBodyUsage[] = [];
    await runWithRequestBodyObserver(
      (usage) => events.push(usage),
      async () => {
        const body = await main.payload({ system: 'main' }, model);
        await main.fetch('https://budget.invalid', { method: 'POST', body: JSON.stringify(body) });
      },
      marker
    );
    expect(events.map((e) => e.stage)).toEqual(['payload', 'wire']);
    expect(main.delegate).toHaveBeenCalledTimes(1);
  });
  it('计量 caller 之后的 payload 与最终 wire，不泄露正文/鉴权且不宣称响应成功', async () => {
    const events: RequestBodyUsage[] = [];
    const opts = requestOptions();
    const body = { stream: true, system: 'fixture-private-prompt', messages: [] };
    await runWithRequestBodyObserver(
      (value) => events.push(value),
      async () => {
        const prepared = await opts.payload(body, model);
        await opts.fetch('https://budget.invalid', {
          method: 'POST',
          body: JSON.stringify(prepared),
        });
      }
    );
    expect(events.map((e) => e.stage)).toEqual(['payload', 'wire']);
    for (const event of events) {
      expect(event.bytes).toBe(Buffer.byteLength(JSON.stringify(body)));
      expect(event.limitBytes).toBe(1000);
      expect(event.blocked).toBe(false);
      expect(Object.keys(event).sort()).toEqual(['at', 'blocked', 'bytes', 'limitBytes', 'stage']);
    }
    expect(JSON.stringify(events)).not.toContain('fixture-private');
    expect(opts.delegate).toHaveBeenCalledTimes(1);
  });
  it('无图 500 个汉字小于 128K token 窗口，仍会越过 1000 字节上限并本地报告阻止', async () => {
    const opts = requestOptions();
    const events: RequestBodyUsage[] = [];
    const body = { stream: true, system: '中'.repeat(500) };
    await expect(
      runWithRequestBodyObserver(
        (v) => events.push(v),
        () => opts.payload(body, model)
      )
    ).rejects.toThrow('request_too_large');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      bytes: Buffer.byteLength(JSON.stringify(body)),
      limitBytes: 1000,
      stage: 'payload',
      blocked: true,
    });
    expect(opts.delegate).not.toHaveBeenCalled();
  });
  it('共享 provider 的并发会话和异步 hook 不串测量，scope 结束后的调用不回流旧会话', async () => {
    const opts = requestOptions();
    const a: RequestBodyUsage[] = [];
    const b: RequestBodyUsage[] = [];
    const first = { stream: true, system: 'a' };
    const second = { stream: true, system: 'bbb' };
    await Promise.all([
      runWithRequestBodyObserver(
        (v) => a.push(v),
        async () => {
          await Promise.resolve();
          await opts.payload(first, model);
        }
      ),
      runWithRequestBodyObserver(
        (v) => b.push(v),
        async () => {
          await opts.payload(second, model);
        }
      ),
    ]);
    await opts.payload({ stream: true, system: 'outside' }, model);
    expect(a.map((v) => v.bytes)).toEqual([Buffer.byteLength(JSON.stringify(first))]);
    expect(b.map((v) => v.bytes)).toEqual([Buffer.byteLength(JSON.stringify(second))]);
  });
});
