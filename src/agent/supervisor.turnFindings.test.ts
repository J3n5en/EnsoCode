import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AgentWorkerEvent } from '@shared/types/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// turnPhase.formal.test.ts 曾报出的反例，按 pi 1.5.1 agent-session.js 的真实步骤逐条回放。

const mocks = vi.hoisted(() => ({
  sessions: [] as Array<ReturnType<typeof fakePi>>,
  mcpToolsFor: vi.fn(),
  createAgentSession: vi.fn(),
}));

vi.mock('./cursor/loadProvider', () => ({
  CURSOR_PROVIDER_ID: 'cursor',
  loadCursorProvider: vi.fn(async () => undefined),
}));

vi.mock('./mcp', () => ({
  McpManager: class {
    toolsFor = mocks.mcpToolsFor;
    closeAll = vi.fn(async () => undefined);
  },
}));

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  class Loader {
    async reload() {}
    getSkills() {
      return { skills: [] };
    }
    getPrompts() {
      return { prompts: [] };
    }
  }
  const manager = () => {
    const branch: unknown[] = [];
    return {
      getBranch: vi.fn(() => branch),
      appendCustomEntry: vi.fn((customType: string, data: unknown) => {
        branch.push({ type: 'custom', customType, data });
        return `entry-${branch.length}`;
      }),
      buildSessionContext: vi.fn(() => ({ messages: [] })),
    };
  };
  const runtime = {
    models: new Map<string, Record<string, unknown>>(),
    registerProvider(providerId: string, config: { models?: Record<string, unknown>[] }) {
      for (const model of config.models ?? []) {
        this.models.set(`${providerId}/${model.id}`, { ...model, provider: providerId });
      }
    },
    getModel(providerId: string, modelId: string) {
      return this.models.get(`${providerId}/${modelId}`);
    },
    getModels() {
      return [...this.models.values()];
    },
    resolveModel: vi
      .fn<ModelRuntime['resolveModel']>()
      .mockRejectedValue(new Error('Unexpected virtual model routing')),
    getAuth: vi.fn<ModelRuntime['getAuth']>().mockResolvedValue(undefined),
    getProvider(providerId: string) {
      if (![...this.models.keys()].some((key) => key.startsWith(`${providerId}/`)))
        return undefined;
      return { id: providerId, models: [], stream: vi.fn(), streamSimple: vi.fn() };
    },
    registerNativeProvider: vi.fn(),
    refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
    completeSimple: vi.fn(async () => ({ content: [] })),
  };
  return {
    ...original,
    DefaultResourceLoader: Loader,
    ModelRuntime: { create: vi.fn(async () => runtime) },
    SessionManager: { create: vi.fn(manager), open: vi.fn(manager), inMemory: vi.fn(manager) },
    createAgentSession: mocks.createAgentSession,
  };
});

import { SessionSupervisor } from './supervisor';

const parent = { sessionId: 'parent', generation: '11111111-1111-4111-8111-111111111111' };
const model = {
  api: 'openai-completions' as const,
  baseUrl: 'https://example.test/v1',
  apiKey: 'secret',
  modelId: 'model',
  settingsProviderId: 'settings-provider',
};

type PiEvent = { type: string; [key: string]: unknown };
type PromptOptions = {
  streamingBehavior?: string;
  preflightResult?: (disposition: string) => void;
};

/** pi AgentSession 的公开面：prompt 流式中排 followUp，abort 不清队列，取消重试后有排队消息就 agent.continue() */
function fakePi(options: Record<string, unknown>) {
  const listeners = new Set<(event: PiEvent) => void>();
  const messages: unknown[] = [];
  let idleWaiters: (() => void)[] = [];
  let runDone: (() => void) | undefined;
  const pi = {
    model: options.model,
    resourceLoader: options.resourceLoader,
    sessionManager: options.sessionManager,
    sessionFile: '/tmp/turn-findings.jsonl',
    agent: {
      state: { messages },
      continue: vi.fn(async () => {}),
      abort: vi.fn(),
      clearFollowUpQueue: () => void pi.followUps.splice(0),
    },
    get messages() {
      return messages;
    },
    isStreaming: false,
    isCompacting: false,
    isRetrying: false,
    get isIdle() {
      return !pi.isStreaming && !pi.isCompacting;
    },
    /** agent.followUpQueue */
    followUps: [] as string[],
    /** 进入 pi 上下文的 user 消息 */
    delivered: [] as string[],
    /** 公开监听者已收到 agent_start 时，worker 已发出的事件数 */
    agentStarts: [] as number[],
    workerEvents: [] as AgentWorkerEvent[],
    subscribe: vi.fn((listener: (event: PiEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    emit(event: PiEvent) {
      if (event.type === 'agent_start') pi.agentStarts.push(pi.workerEvents.length);
      for (const listener of [...listeners]) listener(event);
    },
    user(text: string) {
      const message = { role: 'user', content: [{ type: 'text', text }], timestamp: 0 };
      pi.delivered.push(text);
      messages.push(message);
      pi.emit({ type: 'message_start', message });
      pi.emit({ type: 'message_end', message });
    },
    reply(stopReason: 'stop' | 'error' | 'aborted') {
      const message = {
        role: 'assistant',
        content: stopReason === 'stop' ? [{ type: 'text', text: 'ok' }] : [],
        stopReason,
        ...(stopReason === 'error' ? { errorMessage: '503 Service Unavailable' } : {}),
      };
      messages.push(message);
      pi.emit({ type: 'message_start', message });
      pi.emit({ type: 'message_end', message });
    },
    /** _emitAgentSettled */
    settle(aborted: boolean) {
      pi.isStreaming = false;
      pi.emit({ type: 'agent_settled', aborted });
      const done = runDone;
      runDone = undefined;
      done?.();
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    },
    prompt: vi.fn(async (text: string, opts?: PromptOptions) => {
      if (pi.isStreaming) {
        if (!opts?.streamingBehavior) throw new Error('Agent is already processing.');
        pi.followUps.push(text);
        opts.preflightResult?.('queued');
        return;
      }
      pi.isStreaming = true;
      opts?.preflightResult?.('started');
      pi.emit({ type: 'agent_start' });
      pi.user(text);
      await new Promise<void>((resolve) => {
        runDone = resolve;
      });
    }),
    getFollowUpMessages: () => pi.followUps,
    _emitQueueUpdate: () => {},
    steer: vi.fn(async () => undefined),
    abort: vi.fn(async () => {
      pi.abortRetry();
      await pi.waitForIdle();
    }),
    /**
     * abortRetry → _prepareRetry 的 sleep 抛出 → _finishCancelledRetry 发 auto_retry_end(false)，
     * _handlePostAgentRun 随后 return hasQueuedMessages()，_startRun 据此 agent.continue()。
     */
    abortRetry: vi.fn(() => {
      if (!pi.isRetrying) return;
      pi.isRetrying = false;
      queueMicrotask(() => {
        pi.emit({
          type: 'auto_retry_end',
          success: false,
          attempt: 1,
          finalError: 'Retry cancelled',
        });
        const next = pi.followUps.shift();
        if (next === undefined) {
          pi.settle(false);
          return;
        }
        pi.emit({ type: 'agent_start' });
        pi.user(next);
        pi.reply('stop');
        pi.emit({ type: 'agent_end', messages: [], willRetry: false });
        pi.settle(false);
      });
    }),
    waitForIdle: () =>
      pi.isIdle ? Promise.resolve() : new Promise<void>((resolve) => idleWaiters.push(resolve)),
    compact: vi.fn(async () => undefined),
    dispose: vi.fn(),
    setThinkingLevel: vi.fn(),
    getActiveToolNames: () => [],
    setActiveToolsByName: vi.fn(),
    navigateTree: vi.fn(async () => ({ cancelled: false })),
    settingsManager: {
      getRetrySettings: () => ({ enabled: true, maxRetries: 1, baseDelayMs: 1000 }),
      getRetryEnabled: () => true,
    },
  };
  mocks.sessions.push(pi);
  return pi;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

/** 消费者按会话把 turn-completed / turn-failed 当作本轮终态，不看 turnId */
function terminals(events: AgentWorkerEvent[]) {
  return events.flatMap((event, index) =>
    event.type === 'turn-completed' || event.type === 'turn-failed'
      ? [{ index, type: event.type, aborted: event.aborted === true }]
      : []
  );
}

/** 未送达回执：按 deliveryId 对账、不属于任何一轮的 delivery-rejected */
function rejected(events: AgentWorkerEvent[]): string[] {
  return events.flatMap((event) => (event.type === 'delivery-rejected' ? [event.deliveryId] : []));
}

describe('worker 轮次相位：formal 模型曾报出的反例', () => {
  let sessionDir = '';

  beforeEach(() => {
    mocks.sessions.length = 0;
    mocks.createAgentSession.mockReset();
    mocks.mcpToolsFor.mockReset().mockResolvedValue([]);
    sessionDir = mkdtempSync(path.join(tmpdir(), 'enso-turn-findings-'));
    mocks.createAgentSession.mockImplementation(async (options: Record<string, unknown>) => ({
      session: fakePi(options),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(sessionDir, { recursive: true, force: true });
  });

  async function spawn() {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir,
    });
    supervisor.handleCommand({ type: 'spawn-parent', identity: parent, cwd: '/workspace', model });
    for (let i = 0; i < 20 && !events.some((e) => e.type === 'parent-ready'); i++) await settle();
    const pi = mocks.sessions[0]!;
    pi.workerEvents = events;
    const prompt = (text: string, deliveryId: string) =>
      supervisor.handleCommand({ type: 'prompt', identity: parent, text, deliveryId });
    return { events, supervisor, pi, prompt };
  }

  it('排进活轮的 prompt 遇上中断：撤出 pi 队列、按 deliveryId 回执，原轮只有一个带 aborted 的终态', async () => {
    const { events, supervisor, pi, prompt } = await spawn();
    prompt('first', 'd1');
    await settle();
    prompt('second', 'd2');
    await settle();
    expect(pi.followUps.some((text) => text.includes('second'))).toBe(true);

    supervisor.handleCommand({ type: 'abort', identity: parent });
    await settle();
    // agent-loop：回复 aborted 直接 agent_end，不取 followUp；_startRun 见 abort 跳出循环直接收束
    pi.reply('aborted');
    pi.emit({ type: 'agent_end', messages: [], willRetry: false });
    pi.settle(true);
    await settle();

    expect({
      stillQueuedInPi: pi.followUps.some((text) => text.includes('second')),
      rejected: rejected(events),
      terminals: terminals(events).map(({ type, aborted }) => ({ type, aborted })),
    }).toEqual({
      stillQueuedInPi: false,
      rejected: ['d2'],
      terminals: [{ type: 'turn-completed', aborted: true }],
    });
    await supervisor.shutdown();
  });

  it('排队 prompt 遇上 503 重试被取消：撤回并回执，这一轮只有一个终态，终态之后 pi 不再为它开跑', async () => {
    const { events, supervisor, pi, prompt } = await spawn();
    prompt('first', 'd1');
    await settle();
    prompt('second', 'd2');
    await settle();

    // 503：agent_end(willRetry) → _prepareRetry 发 auto_retry_start，进入退避
    pi.reply('error');
    pi.emit({ type: 'agent_end', messages: [], willRetry: true });
    pi.emit({
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 1,
      delayMs: 1000,
      errorMessage: '503 Service Unavailable',
    });
    pi.isRetrying = true;
    await settle();

    supervisor.handleCommand({ type: 'abort-retry', identity: parent });
    await settle();

    const all = terminals(events);
    expect({
      terminals: all.map(({ type }) => type),
      rejected: rejected(events),
      piStartsAfterTerminal: pi.agentStarts.filter((at) => at > (all[0]?.index ?? Infinity)).length,
    }).toEqual({ terminals: ['turn-failed'], rejected: ['d2'], piStartsAfterTerminal: 0 });
    await supervisor.shutdown();
  });

  it('中断后 5 秒内再发 prompt 且工具不响应：prompt 按 deliveryId 回执，被中断的那一轮只有一个带 aborted 的终态', async () => {
    const { events, supervisor, pi, prompt } = await spawn();
    prompt('first', 'd1');
    await settle();

    // 工具不响应中断信号：pi 仍在流式
    supervisor.handleCommand({ type: 'abort', identity: parent });
    await settle();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    prompt('second', 'd2');
    await vi.advanceTimersByTimeAsync(5_000);
    vi.useRealTimers();
    expect(rejected(events)).toEqual(['d2']);

    // 工具终于停下：被中断的轮次收束
    pi.reply('aborted');
    pi.emit({ type: 'agent_end', messages: [], willRetry: false });
    pi.settle(true);
    await settle();

    expect(terminals(events).map(({ type, aborted }) => ({ type, aborted }))).toEqual([
      { type: 'turn-completed', aborted: true },
    ]);
    await supervisor.shutdown();
  });
});
