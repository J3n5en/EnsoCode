import type { Api, AssistantMessageEventStream, Context, Model } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import type { ContextMessage } from './imageContext';
import { installModelContextCompat } from './modelContextCompat';

// 真实故障：signed thinking + toolCall、没有 text 的 assistant 在 xAI 的 openai-responses
// 出口需要空 message 项，否则下一轮重放失败；同一段上下文给 Kimi 补空则 400
// （$.input[2].content[0].text 为空串）。兼容只属于 Grok 的 wire 出口。
const SIGNATURE = '{"id":"rs_fixture","type":"reasoning"}';
const thinking = { type: 'thinking', thinking: 'need the file', thinkingSignature: SIGNATURE };
const toolCall = { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'a.ts' } };
const STREAM = { fixture: 'stream' } as unknown as AssistantMessageEventStream;
const text = (value: string) => ({ type: 'text', text: value });
const user = (value: string): ContextMessage => ({ role: 'user', content: value, timestamp: 1 });

const XAI = { provider: 'xai', baseUrl: 'https://api.x.ai/v1' };
const RATES = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const LIMITS = { reasoning: true, contextWindow: 256_000, maxTokens: 32_000, cost: RATES };
const USAGE = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: RATES };
const model = (api: Api, id: string) =>
  Object.assign({}, XAI, { id, name: id, api, input: ['text'] }, LIMITS) as unknown as Model<Api>;
const BASE = { role: 'assistant', api: 'openai-responses' };
const assistant = (
  content: unknown,
  from = { model: 'grok-4.7', provider: 'xai' }
): ContextMessage =>
  Object.assign({}, BASE, from, { usage: USAGE, stopReason: 'toolUse', content });

const contextOf = (messages: ContextMessage[], extra = {}): Context =>
  ({ messages: messages as unknown as Context['messages'], tools: [], ...extra }) as Context;

type StreamSpy = ReturnType<typeof vi.fn>;
type FakeRuntime = ModelRuntime & { stream: StreamSpy; streamSimple: StreamSpy };
const fakeRuntime = (methods: Record<string, unknown>) => methods as unknown as FakeRuntime;

/** 只伪造 runtime 出口；stream/streamSimple 返回同一个流，installer 不消费它。 */
function harness() {
  const stream = vi.fn(() => STREAM);
  const streamSimple = vi.fn(() => STREAM);
  const runtime = fakeRuntime({ stream, streamSimple });
  installModelContextCompat(runtime);
  return { runtime, stream, streamSimple };
}

const passedContext = (spy: StreamSpy, call = 0): Context => spy.mock.calls[call]?.[1] as Context;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function expectPadded(ctx: Context, index: number): void {
  expect(ctx.messages[index]?.content).toEqual([thinking, { type: 'text', text: '' }, toolCall]);
}

describe('installModelContextCompat', () => {
  it.each(['grok-4.7', '  GROK-4.7 ', 'xai/grok-4.7', ' X-AI/Grok-4.7 '])(
    '目标模型 id %j 的 Responses 出口补一个空 text',
    (id) => {
      const { runtime, stream } = harness();
      runtime.stream(
        model('openai-responses', id),
        contextOf([user('go'), assistant([thinking, toolCall])])
      );
      expectPadded(passedContext(stream), 1);
    }
  );
  it.each<[string, Api, string]>([
    ['Kimi', 'openai-responses', 'kimi-k2-thinking'],
    ['DeepSeek', 'openai-responses', 'deepseek-v3'],
    ['未知 id', 'openai-responses', 'mystery-model'],
    ['图片模型', 'openai-responses', 'grok-2-image'],
    ['imagine 模型', 'openai-responses', 'grok-imagine-v0.9'],
    ['embed 模型', 'openai-responses', 'grok-embed'],
    ['未知 vendor', 'openai-responses', 'openrouter/grok-4.7'],
    ['多层 xai', 'openai-responses', 'xai/xai/grok-4.7'],
    ['空尾段', 'openai-responses', 'xai/'],
    ['api anthropic-messages', 'anthropic-messages', 'grok-4.7'],
    ['api openai-completions', 'openai-completions', 'grok-4.7'],
    ['api openai-codex-responses', 'openai-codex-responses', 'grok-4.7'],
    ['api pi-virtual', 'pi-virtual', 'grok-4.7'],
  ])('%s 不碰上下文', (_label, api, id) => {
    const { runtime, stream } = harness();
    const ctx = contextOf([assistant([thinking, toolCall])]);
    runtime.stream(model(api, id), ctx);
    expect(passedContext(stream)).toBe(ctx);
  });
  it.each<[string, unknown]>([
    ['thinking 没有 thinkingSignature', [{ type: 'thinking', thinking: 'no signature' }, toolCall]],
    ['没有 toolCall', [thinking, text('done')]],
    ['已有空 text', [thinking, text(''), toolCall]],
    ['已有空白 text', [thinking, text('  \n'), toolCall]],
    ['text 在 toolCall 之后', [thinking, toolCall, text('trailing')]],
  ])('%s 时不补空 text', (_name, content) => {
    const { runtime, stream } = harness();
    const ctx = contextOf([assistant(content)]);
    runtime.stream(model('openai-responses', 'grok-4.7'), ctx);
    expect(passedContext(stream)).toBe(ctx);
  });
  // Pi 的 transform-messages 把旧 history 的 assistant.content null/undefined 归一为 []，出口包装也必须先判数组。
  const malformed: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['非数组字符串', 'plain text'],
  ];
  it.each(malformed)(
    'assistant 的 content 为 %s 时 raw/simple 都原样透传、不抛错',
    (_name, content) => {
      const { runtime, stream, streamSimple } = harness();
      const ctx = contextOf([assistant(content)]);
      expect(() => runtime.stream(model('openai-responses', 'grok-4.7'), ctx)).not.toThrow();
      expect(() => runtime.streamSimple(model('openai-responses', 'grok-4.7'), ctx)).not.toThrow();
      expect(passedContext(stream)).toBe(ctx);
      expect(passedContext(streamSimple)).toBe(ctx);
    }
  );
  it('只克隆需补空的 message 与父容器：其它消息、metadata、签名和 toolCall 对象不动', () => {
    const { runtime, stream } = harness();
    const signedThinking = { ...thinking };
    const call = { ...toolCall };
    const untouched = assistant([thinking, text('done')]);
    const target = assistant([signedThinking, call], { model: 'kimi-k2', provider: 'moonshotai' });
    const ctx = deepFreeze(contextOf([user('go'), untouched, target], { systemPrompt: 'system' }));
    runtime.stream(model('openai-responses', 'grok-4.7'), ctx);
    const out = passedContext(stream);
    expect(out).not.toBe(ctx);
    expect(out.messages).not.toBe(ctx.messages);
    expect(out.systemPrompt).toBe('system');
    expect(out.messages[0]).toBe(ctx.messages[0]);
    expect(out.messages[1]).toBe(ctx.messages[1]);
    const padded = out.messages[2] as ContextMessage;
    expect(padded).not.toBe(ctx.messages[2]);
    expect(padded).toMatchObject({
      model: 'kimi-k2',
      provider: 'moonshotai',
      stopReason: 'toolUse',
    });
    const content = padded.content as Record<string, unknown>[];
    expect(content[0]).toBe(signedThinking);
    expect(content[1]).toEqual({ type: 'text', text: '' });
    expect(content[2]).toBe(call);
  });
  it('按目标模型判定，不看历史记录里的 model/provider', () => {
    const { runtime, streamSimple } = harness();
    const fromGrok = assistant([thinking, toolCall], { model: 'grok-4.7', provider: 'xai' });
    const fromKimi = assistant([thinking, toolCall], { model: 'kimi-k2', provider: 'moonshotai' });
    const [toKimi, toGrok] = [contextOf([fromGrok]), contextOf([fromKimi])];
    runtime.streamSimple(model('openai-responses', 'kimi-k2'), toKimi);
    runtime.streamSimple(model('openai-responses', 'grok-4.7'), toGrok);
    expect(passedContext(streamSimple, 0)).toBe(toKimi);
    expectPadded(passedContext(streamSimple, 1), 0);
  });
  it('stream / streamSimple 都包，model、options、this 与返回的流原样透传', () => {
    const { runtime, stream, streamSimple } = harness();
    const grok = model('openai-responses', 'grok-4.7');
    const options = { maxTokens: 64 };
    const ctx = contextOf([user('go'), assistant([thinking, toolCall])]);
    expect(runtime.stream(grok, ctx, options)).toBe(STREAM);
    expect(runtime.streamSimple(grok, ctx, options)).toBe(STREAM);
    for (const spy of [stream, streamSimple]) {
      expect(spy).toHaveBeenCalledTimes(1);
      const [modelArg, contextArg, optionsArg] = spy.mock.calls[0] as unknown[];
      expect(modelArg).toBe(grok);
      expect(optionsArg).toBe(options);
      expect(spy.mock.contexts[0]).toBe(runtime);
      expectPadded(contextArg as Context, 1);
    }
  });
  it('重复安装不叠加，runtime 缺方法时不抛错', () => {
    const { runtime, stream } = harness();
    const firstStream = runtime.stream;
    installModelContextCompat(runtime);
    expect(runtime.stream).toBe(firstStream);
    const ctx = contextOf([assistant([thinking, toolCall])]);
    runtime.stream(model('openai-responses', 'grok-4.7'), ctx);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(passedContext(stream).messages[0]?.content).toHaveLength(3);
    const onlyStreamSpy = vi.fn(() => STREAM);
    const onlyStream = fakeRuntime({ stream: onlyStreamSpy });
    expect(() => installModelContextCompat(onlyStream)).not.toThrow();
    onlyStream.stream(model('openai-responses', 'grok-4.7'), ctx);
    expect(passedContext(onlyStreamSpy).messages[0]?.content).toHaveLength(3);
    expect(() => installModelContextCompat(fakeRuntime({}))).not.toThrow();
  });
});
