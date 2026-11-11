import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  isRetryableAssistantError,
  type Model,
} from '@earendil-works/pi-ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findRepetitionCycle,
  guardStream,
  STREAM_IDLE_TIMEOUT_MS,
  STREAM_MAX_LIFETIME_MS,
} from './streamGuard';

const model = (baseUrl = 'https://api.example.com/v1') =>
  ({ api: 'openai-completions', provider: 'test', id: 'm', baseUrl }) as unknown as Model<Api>;

const message = (text = ''): AssistantMessage => ({
  role: 'assistant',
  api: 'openai-completions',
  provider: 'test',
  model: 'm',
  content: text ? [{ type: 'text', text }] : [],
  timestamp: 0,
  stopReason: 'stop',
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});

function fakeInner() {
  const state: { stream?: AssistantMessageEventStream; signal?: AbortSignal } = {};
  const inner = (_model: Model<Api>, _context: unknown, options?: unknown) => {
    state.signal = (options as { signal?: AbortSignal } | undefined)?.signal;
    state.stream = createAssistantMessageEventStream();
    return state.stream;
  };
  return { inner, state };
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('findRepetitionCycle', () => {
  it('识别短周期的逐字复读', () => {
    const hit = findRepetitionCycle(`Intro text. ${'I will check the file. '.repeat(400)}`);
    expect(hit?.period).toBe('I will check the file. '.length);
    expect(hit?.span).toBeGreaterThanOrEqual(4000);
  });

  it('识别段落级循环', () => {
    const paragraph = `${'The build failed because the config is missing. '.repeat(3)}Let me retry.\n`;
    const hit = findRepetitionCycle(paragraph.repeat(30));
    expect(hit?.period).toBe(paragraph.length);
  });

  it('正常长文本、少量重复与短的重复片段都不算', () => {
    const prose = Array.from(
      { length: 400 },
      (_, i) => `Line ${i}: value ${(i * 7919) % 1000} processed.`
    ).join('\n');
    expect(findRepetitionCycle(prose)).toBeUndefined();
    expect(findRepetitionCycle('ok. '.repeat(200))).toBeUndefined();
    const block = 'x'.repeat(1500);
    expect(findRepetitionCycle(`${block}\n${block}\n${block}`)).toBeUndefined();
  });
});

describe('guardStream', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('正常流原样转发并给出最终结果', async () => {
    const { inner, state } = fakeInner();
    const out = guardStream(inner)(model(), { messages: [] }, {});
    const done = collect(out);
    const partial = message('hi');
    state.stream!.push({ type: 'start', partial: message() });
    state.stream!.push({ type: 'text_delta', contentIndex: 0, delta: 'hi', partial });
    state.stream!.push({ type: 'done', reason: 'stop', message: partial });
    state.stream!.end();
    const events = await done;
    expect(events.map((e) => e.type)).toEqual(['start', 'text_delta', 'done']);
    expect((await out.result()).content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('长时间没有任何事件：中断上游并以可重试错误结束，期间先报一次卡顿', async () => {
    const { inner, state } = fakeInner();
    const stalls: number[] = [];
    const out = guardStream(inner, { onStall: (ms) => stalls.push(ms) })(
      model(),
      { messages: [] },
      {}
    );
    const done = collect(out);
    state.stream!.push({ type: 'start', partial: message() });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(stalls).toEqual([90_000]);
    expect(state.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS);
    expect(state.signal?.aborted).toBe(true);
    const events = await done;
    const last = events.at(-1);
    expect(last?.type).toBe('error');
    const error = (await out.result()) as AssistantMessage;
    expect(error.stopReason).toBe('error');
    expect(error.errorMessage).toMatch(/timed out/);
    expect(isRetryableAssistantError(error)).toBe(true);
    // 上游被中断后迟到的事件不再外泄
    state.stream!.push({ type: 'error', reason: 'aborted', error: message() });
    expect(stalls).toHaveLength(1);
  });

  it('事件持续到达时不会超时', async () => {
    const { inner, state } = fakeInner();
    const out = guardStream(inner)(model(), { messages: [] }, {});
    const done = collect(out);
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS - 1000);
      state.stream!.push({ type: 'text_delta', contentIndex: 0, delta: 'x', partial: message() });
    }
    expect(state.signal?.aborted).toBe(false);
    state.stream!.push({ type: 'done', reason: 'stop', message: message('x') });
    expect((await done).at(-1)?.type).toBe('done');
  });

  it('本机模型放宽空闲上限（长 prefill）', async () => {
    const { inner, state } = fakeInner();
    guardStream(inner)(model('http://127.0.0.1:8080/v1'), { messages: [] }, {});
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1000);
    expect(state.signal?.aborted).toBe(false);
  });

  it('事件持续涓流但总时长超过寿命上限：中断上游并以可重试错误结束', async () => {
    const { inner, state } = fakeInner();
    const out = guardStream(inner)(model(), { messages: [] }, {});
    const done = collect(out);
    const steps = Math.ceil(STREAM_MAX_LIFETIME_MS / 60_000) + 1;
    for (let i = 0; i < steps && !state.signal?.aborted; i++) {
      state.stream!.push({ type: 'text_delta', contentIndex: 0, delta: 'x', partial: message() });
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(state.signal?.aborted).toBe(true);
    expect((await done).at(-1)?.type).toBe('error');
    const error = (await out.result()) as AssistantMessage;
    expect(error.errorMessage).toMatch(/timed out/);
    expect(isRetryableAssistantError(error)).toBe(true);
  });

  it('本机模型不设寿命上限', async () => {
    const { inner, state } = fakeInner();
    guardStream(inner)(model('http://localhost:11434/v1'), { messages: [] }, {});
    for (let i = 0; i < Math.ceil(STREAM_MAX_LIFETIME_MS / 60_000) + 5; i++) {
      state.stream!.push({ type: 'text_delta', contentIndex: 0, delta: 'x', partial: message() });
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(state.signal?.aborted).toBe(false);
  });

  it('输出陷入逐字复读：中断上游，以不可重试错误结束并截掉重复部分', async () => {
    const { inner, state } = fakeInner();
    const out = guardStream(inner)(model(), { messages: [] }, {});
    const done = collect(out);
    const unit = 'Let me look at the file again. ';
    let text = 'Start. ';
    for (let i = 0; i < 300; i++) {
      text += unit;
      state.stream!.push({
        type: 'text_delta',
        contentIndex: 0,
        delta: unit,
        partial: message(text),
      });
    }
    const events = await done;
    expect(state.signal?.aborted).toBe(true);
    expect(events.at(-1)?.type).toBe('error');
    const error = (await out.result()) as AssistantMessage;
    expect(error.errorMessage).toMatch(/repetition/);
    expect(isRetryableAssistantError(error)).toBe(false);
    const kept = error.content[0];
    expect(kept?.type === 'text' && kept.text.length).toBeLessThan(text.length);
    expect(kept?.type === 'text' && kept.text.startsWith('Start. ')).toBe(true);
  });

  it('上游未推终态事件就结束时，以上游 result() 收尾', async () => {
    const { inner, state } = fakeInner();
    const out = guardStream(inner)(model(), { messages: [] }, {});
    state.stream!.push({ type: 'text_delta', contentIndex: 0, delta: 'x', partial: message('x') });
    state.stream!.end(message('x'));
    expect((await out.result()).content).toEqual([{ type: 'text', text: 'x' }]);
  });

  it('调用方中断会传给上游', () => {
    const { inner, state } = fakeInner();
    const controller = new AbortController();
    guardStream(inner)(model(), { messages: [] }, { signal: controller.signal });
    expect(state.signal?.aborted).toBe(false);
    controller.abort();
    expect(state.signal?.aborted).toBe(true);
  });
});
