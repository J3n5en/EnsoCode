import type { AgentWorkerEvent } from '@shared/types/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  completeSimple: vi.fn(),
  streamSimple: vi.fn(),
  missingModelIds: new Set<string>(),
}));

vi.mock('./cursor/loadProvider', () => ({
  CURSOR_PROVIDER_ID: 'cursor',
  loadCursorProvider: vi.fn(async () => undefined),
}));

vi.mock('./mcp', () => ({
  McpManager: class {
    toolsFor = vi.fn(async () => []);
    closeAll = vi.fn(async () => undefined);
  },
}));

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const runtime = {
    models: new Map<string, Record<string, unknown>>(),
    registerProvider(providerId: string, config: { models?: Record<string, unknown>[] }) {
      for (const model of config.models ?? []) {
        this.models.set(`${providerId}/${model.id}`, { ...model, provider: providerId });
      }
    },
    getModel(providerId: string, modelId: string) {
      if (mocks.missingModelIds.has(modelId)) return undefined;
      return this.models.get(`${providerId}/${modelId}`);
    },
    getModels() {
      return [...this.models.values()];
    },
    refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
    completeSimple: mocks.completeSimple,
    streamSimple: mocks.streamSimple,
  };
  return {
    ...original,
    ModelRuntime: { create: vi.fn(async () => runtime) },
  };
});

import { SessionSupervisor } from './supervisor';

const candidate = (modelId: string) => ({
  api: 'openai-completions' as const,
  baseUrl: 'https://example.test/v1',
  apiKey: 'secret',
  modelId,
  settingsProviderId: `provider-${modelId}`,
});

const text = (value: string, stopReason = 'stop') => ({
  role: 'assistant',
  content: [{ type: 'text', text: value }],
  stopReason,
});

function hanging(): (
  model: unknown,
  context: unknown,
  options: { signal: AbortSignal }
) => Promise<unknown> {
  return (_model, _context, { signal }) =>
    new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve(text('', 'aborted')), { once: true });
    });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
}

describe('SessionSupervisor.completeText：用户中止 vs 超时换候选', () => {
  let events: AgentWorkerEvent[];
  let supervisor: SessionSupervisor;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.completeSimple.mockReset();
    mocks.streamSimple.mockReset();
    mocks.missingModelIds.clear();
    events = [];
    supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: '/tmp/sessions',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const complete = (candidates: ReturnType<typeof candidate>[], requestId = 'btw-1') => ({
    type: 'complete-text' as const,
    requestId,
    systemPrompt: 'sys',
    userText: 'hi',
    candidates,
    timeoutMs: 1_000,
  });

  it('用户中止后立刻 text-failed aborted，不再试下一个候选', async () => {
    mocks.completeSimple
      .mockImplementationOnce(hanging())
      .mockResolvedValueOnce(text('不该被调用'));
    supervisor.handleCommand(complete([candidate('slow'), candidate('spare')]));
    await flush();
    expect(mocks.completeSimple).toHaveBeenCalledTimes(1);

    supervisor.handleCommand({ type: 'abort-complete-text', requestId: 'btw-1' });
    await flush();
    expect(events).toEqual([{ type: 'text-failed', requestId: 'btw-1', error: 'aborted' }]);
    expect(mocks.completeSimple).toHaveBeenCalledTimes(1);
  });

  it('中止发生在补全开始前也直接 aborted', async () => {
    mocks.completeSimple.mockResolvedValueOnce(text('不该被调用'));
    supervisor.handleCommand({ type: 'abort-complete-text', requestId: 'btw-2' });
    supervisor.handleCommand(complete([candidate('fast')], 'btw-2'));
    await flush();
    expect(mocks.completeSimple).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: 'text-failed', requestId: 'btw-2', error: 'aborted' }]);
  });

  it('单候选超时仍会换下一个候选', async () => {
    mocks.completeSimple.mockImplementationOnce(hanging()).mockResolvedValueOnce(text('ok'));
    supervisor.handleCommand(complete([candidate('slow'), candidate('good')]));
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(mocks.completeSimple).toHaveBeenCalledTimes(2);
    expect(events).toEqual([{ type: 'text-completed', requestId: 'btw-1', text: 'ok' }]);
  });
});

function live(textValue: string, thinking = '') {
  const content = [
    ...(thinking ? [{ type: 'thinking', text: thinking }] : []),
    ...(textValue ? [{ type: 'text', text: textValue }] : []),
  ];
  return { content };
}

function streaming(chunks: string[], thinkingChunks: string[] = []) {
  const full = chunks.join('');
  return (_model: unknown, _context: unknown, _options: { signal: AbortSignal }) => ({
    async *[Symbol.asyncIterator]() {
      let acc = '';
      let thought = '';
      for (const delta of thinkingChunks) {
        thought += delta;
        yield {
          type: 'thinking_delta',
          delta,
          partial: live(acc, thought),
        };
      }
      for (const delta of chunks) {
        acc += delta;
        yield {
          type: 'text_delta',
          delta,
          partial: live(acc, thought),
        };
      }
    },
    result: async () => text(full),
  });
}

function hangingStream(prefix = 'hel') {
  return (_model: unknown, _context: unknown, { signal }: { signal: AbortSignal }) => {
    const done = new Promise((resolve) => {
      const finish = () => resolve(text('', 'aborted'));
      if (signal.aborted) {
        finish();
        return;
      }
      signal.addEventListener('abort', finish, { once: true });
    });
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'text_delta',
          delta: prefix,
          partial: live(prefix),
        };
        await done;
      },
      result: () => done,
    };
  };
}

describe('SessionSupervisor.completeText：stream 增量', () => {
  let events: AgentWorkerEvent[];
  let supervisor: SessionSupervisor;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.completeSimple.mockReset();
    mocks.streamSimple.mockReset();
    mocks.missingModelIds.clear();
    events = [];
    supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: '/tmp/sessions',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const complete = (
    candidates: ReturnType<typeof candidate>[],
    extra: { requestId?: string; reasoning?: 'high' | 'off' } = {}
  ) => ({
    type: 'complete-text' as const,
    requestId: extra.requestId ?? 'btw-1',
    systemPrompt: 'sys',
    userText: 'hi',
    candidates,
    timeoutMs: 1_000,
    stream: true as const,
    ...(extra.reasoning ? { reasoning: extra.reasoning } : {}),
  });

  it('stream 时推 text-delta 再 text-completed，并把 reasoning 传给 streamSimple', async () => {
    mocks.streamSimple.mockImplementationOnce(streaming(['hel', 'lo'], ['hmm']));
    supervisor.handleCommand(complete([candidate('fast')], { reasoning: 'high' }));
    await flush();
    expect(mocks.completeSimple).not.toHaveBeenCalled();
    expect(mocks.streamSimple.mock.calls[0]?.[2]).toMatchObject({ reasoning: 'high' });
    expect(events).toEqual([
      { type: 'text-delta', requestId: 'btw-1', text: '', thinking: 'hmm' },
      { type: 'text-delta', requestId: 'btw-1', text: 'hel', thinking: 'hmm' },
      { type: 'text-delta', requestId: 'btw-1', text: 'hello', thinking: 'hmm' },
      { type: 'text-completed', requestId: 'btw-1', text: 'hello' },
    ]);
  });

  it('用户中止流式补全后立刻 aborted，不再试下一个候选', async () => {
    mocks.streamSimple
      .mockImplementationOnce(hangingStream('hel'))
      .mockImplementationOnce(streaming(['nope']));
    supervisor.handleCommand(complete([candidate('slow'), candidate('spare')]));
    await flush();
    expect(events).toEqual([{ type: 'text-delta', requestId: 'btw-1', text: 'hel' }]);
    supervisor.handleCommand({ type: 'abort-complete-text', requestId: 'btw-1' });
    await flush();
    expect(events).toEqual([
      { type: 'text-delta', requestId: 'btw-1', text: 'hel' },
      { type: 'text-failed', requestId: 'btw-1', error: 'aborted' },
    ]);
    expect(mocks.streamSimple).toHaveBeenCalledTimes(1);
  });

  it('流式超时换候选时先清空再推新增量', async () => {
    mocks.streamSimple
      .mockImplementationOnce(hangingStream('hel'))
      .mockImplementationOnce(streaming(['ok']));
    supervisor.handleCommand(complete([candidate('slow'), candidate('good')]));
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(mocks.streamSimple).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      { type: 'text-delta', requestId: 'btw-1', text: 'hel' },
      { type: 'text-delta', requestId: 'btw-1', text: '' },
      { type: 'text-delta', requestId: 'btw-1', text: 'ok' },
      { type: 'text-completed', requestId: 'btw-1', text: 'ok' },
    ]);
  });
});
