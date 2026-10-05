import type { AgentWorkerEvent } from '@shared/types/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  classify: vi.fn(),
  classifiers: [{ id: 'cls', provider: 'openrouter', name: 'Classifier' }] as Array<
    Record<string, unknown>
  >,
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
    registerProvider: vi.fn(),
    getModel: () => undefined,
    getModels: () => [],
    getModelsOfType: (_type: string, provider: string) =>
      mocks.classifiers.filter((model) => model.provider === provider),
    getProvider: () => undefined,
    resolveModel: vi.fn(),
    getAuth: vi.fn(),
    refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
    classify: mocks.classify,
  };
  return { ...original, ModelRuntime: { create: vi.fn(async () => runtime) } };
});

import { SessionSupervisor } from './supervisor';

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
}

const command = (requestId = 'route-1') => ({
  type: 'classify-choice' as const,
  requestId,
  classifier: { provider: 'openrouter', modelId: 'cls', apiKey: 'secret' },
  state: { message: 'hi' },
  instructions: 'who replies?',
  criteria: { a: 'Alice', b: 'Bob' },
  timeoutMs: 1_000,
});

const hanging = (_model: unknown, _context: unknown, { signal }: { signal: AbortSignal }) =>
  new Promise((resolve) => {
    signal.addEventListener(
      'abort',
      () => resolve({ answers: {}, stopReason: 'aborted', errorMessage: 'aborted' }),
      { once: true }
    );
  });

describe('SessionSupervisor classify-choice', () => {
  let events: AgentWorkerEvent[];
  let supervisor: SessionSupervisor;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.classify.mockReset();
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

  it('用 runtime.classify 跑 choice 问题并回传概率', async () => {
    mocks.classify.mockResolvedValueOnce({
      answers: { choice: { type: 'choice', probabilities: { a: 0.8, b: 0.2 } } },
      stopReason: 'stop',
    });
    supervisor.handleCommand(command());
    await flush();
    const [model, context, options] = mocks.classify.mock.calls[0]!;
    expect(model).toMatchObject({ id: 'cls', provider: 'openrouter' });
    expect(context).toEqual({
      state: { message: 'hi' },
      questions: {
        choice: {
          type: 'choice',
          instructions: 'who replies?',
          criteria: { a: 'Alice', b: 'Bob' },
        },
      },
    });
    expect(options).toMatchObject({ apiKey: 'secret' });
    expect(events).toEqual([
      { type: 'choice-classified', requestId: 'route-1', probabilities: { a: 0.8, b: 0.2 } },
    ]);
  });

  it('分类器不存在或返回错误时 choice-failed', async () => {
    supervisor.handleCommand({
      ...command('missing'),
      classifier: { provider: 'openrouter', modelId: 'nope' },
    });
    mocks.classify.mockResolvedValueOnce({ answers: {}, stopReason: 'error', errorMessage: '401' });
    supervisor.handleCommand(command('error'));
    await flush();
    expect(events).toEqual(
      expect.arrayContaining([
        { type: 'choice-failed', requestId: 'missing', error: expect.stringContaining('nope') },
        { type: 'choice-failed', requestId: 'error', error: '401' },
      ])
    );
  });

  it('超时与中止都以 choice-failed 收尾，中止早于开始时不调用分类器', async () => {
    mocks.classify.mockImplementation(hanging);
    supervisor.handleCommand(command('slow'));
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(events).toEqual([
      { type: 'choice-failed', requestId: 'slow', error: expect.stringContaining('timed out') },
    ]);

    supervisor.handleCommand(command('user'));
    await flush();
    supervisor.handleCommand({ type: 'abort-classify-choice', requestId: 'user' });
    await flush();
    expect(events.at(-1)).toEqual({ type: 'choice-failed', requestId: 'user', error: 'aborted' });

    mocks.classify.mockClear();
    supervisor.handleCommand({ type: 'abort-classify-choice', requestId: 'early' });
    supervisor.handleCommand(command('early'));
    await flush();
    expect(mocks.classify).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: 'choice-failed', requestId: 'early', error: 'aborted' });
  });
});
