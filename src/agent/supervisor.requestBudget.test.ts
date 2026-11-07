import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelRuntime, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentWorkerEvent } from '@shared/types/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
  createAgentSession: vi.fn(),
}));

// 软预算 2：第 2 次请求注入提示，第 3 次中止并补报告，宽限到第 8 次
vi.mock('./requestBudget', async (importOriginal) => {
  const original = await importOriginal<typeof import('./requestBudget')>();
  return {
    ...original,
    RequestBudget: class extends original.RequestBudget {
      constructor() {
        super(2);
      }
    },
  };
});

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
    resolveModel: vi.fn<ModelRuntime['resolveModel']>(),
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

import { budgetWrapUpPrompt } from './requestBudget';
import { SessionSupervisor } from './supervisor';

const parent = { sessionId: 'parent', generation: '11111111-1111-4111-8111-111111111111' };
const child = {
  sessionId: 'parent::cw-worker',
  generation: '22222222-2222-4222-8222-222222222222',
  parent,
  instanceId: '33333333-3333-4333-8333-333333333333',
  instanceName: 'Worker-33333333',
  typeKey: 'builtin:worker' as const,
};
const model = {
  api: 'openai-completions' as const,
  baseUrl: 'https://example.test/v1',
  apiKey: 'secret',
  modelId: 'model',
  settingsProviderId: 'settings-provider',
};

type Listener = (event: { type: string; [key: string]: unknown }) => void;

function session(options: Record<string, unknown>) {
  const listeners = new Set<Listener>();
  const value = {
    model: options.model,
    resourceLoader: options.resourceLoader,
    sessionManager: options.sessionManager,
    sessionFile: `/tmp/session-${mocks.sessions.length}.jsonl`,
    messages: [] as unknown[],
    agent: { state: { messages: [] }, continue: vi.fn(async () => undefined) },
    subscribe: vi.fn((listener: Listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    emit(event: { type: string; [key: string]: unknown }) {
      for (const listener of listeners) listener(event);
    },
    prompt: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    dispose: vi.fn(),
    setThinkingLevel: vi.fn(),
    activeTools: ((options.customTools as Array<{ name: string }> | undefined) ?? []).map(
      (tool) => tool.name
    ),
    getActiveToolNames(this: { activeTools: string[] }) {
      return [...this.activeTools];
    },
    setActiveToolsByName: vi.fn(function (this: { activeTools: string[] }, names: string[]) {
      this.activeTools = [...names];
    }),
    navigateTree: vi.fn(async () => ({ cancelled: false })),
    isStreaming: false,
    isIdle: true,
    isRetrying: false,
  };
  mocks.sessions.push(value);
  return value;
}

type FakeSession = ReturnType<typeof session>;

async function settle(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

async function waitFor(events: AgentWorkerEvent[], type: AgentWorkerEvent['type']): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (events.some((event) => event.type === type)) return;
    await settle(1);
  }
  throw new Error(`timed out waiting for ${type}`);
}

/** 模拟一次模型请求：assistant 消息开始到结束，并进入 pi 的权威消息列表 */
function request(target: FakeSession, message: Record<string, unknown>): void {
  const full = { role: 'assistant', ...message };
  target.messages.push(full);
  target.emit({ type: 'message_start', message: full });
  target.emit({ type: 'message_end', message: full });
}

const toolCall = (n: number) => ({
  content: [{ type: 'toolCall', id: `call-${n}`, name: 'read', arguments: {} }],
  stopReason: 'toolUse',
});
const finalAnswer = (text: string) => ({ content: [{ type: 'text', text }], stopReason: 'stop' });

function endRound(target: FakeSession): void {
  target.emit({ type: 'agent_end', willRetry: false });
  target.emit({ type: 'agent_settled' });
}

const completed = (events: AgentWorkerEvent[]) =>
  events.filter(
    (event): event is Extract<AgentWorkerEvent, { type: 'turn-completed' }> =>
      event.type === 'turn-completed'
  );

describe('SessionSupervisor 子代理请求预算', () => {
  let sessionDir = '';

  beforeEach(() => {
    mocks.sessions.length = 0;
    mocks.createAgentSession.mockReset();
    mocks.createAgentSession.mockImplementation(async (options: Record<string, unknown>) => ({
      session: session(options),
    }));
    sessionDir = mkdtempSync(path.join(tmpdir(), 'enso-request-budget-'));
  });

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true });
  });

  async function spawnChild(): Promise<{
    events: AgentWorkerEvent[];
    supervisor: SessionSupervisor;
    worker: FakeSession;
  }> {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir,
    });
    supervisor.handleCommand({ type: 'spawn-parent', identity: parent, cwd: '/workspace', model });
    await waitFor(events, 'parent-ready');
    supervisor.handleCommand({
      type: 'spawn-child',
      identity: child,
      cwd: '/workspace',
      config: {
        typeKey: 'builtin:worker',
        displayName: 'Worker',
        description: 'worker',
        spawnSpecId: 'spawn-worker',
        systemPrompt: 'worker role',
        model,
        tools: 'readonly',
        skillPaths: [],
        skillBindingIds: [],
        mcpServers: [],
        mcpBindingIds: [],
        systemPromptHash: 'worker-hash',
      },
    });
    await waitFor(events, 'child-ready');
    return { events, supervisor, worker: mocks.sessions.at(-1) as FakeSession };
  }

  function promptRun(supervisor: SessionSupervisor, requestId: string): void {
    supervisor.handleCommand({
      type: 'prompt-child',
      identity: child,
      requestId,
      requestBudget: true,
      task: { text: 'inspect files', images: [], fileMentions: [] },
    });
  }

  it('主会话 ImageGen 读取实时配置并遵循工具开关，readonly 子会话不挂生图工具', async () => {
    const { supervisor } = await spawnChild();
    try {
      const options = mocks.createAgentSession.mock.calls[0][0] as {
        customTools: ToolDefinition[];
      };
      const tool = options.customTools.find((entry) => entry.name === 'ImageGen');
      expect(tool).toBeDefined();
      const run = (params: unknown) =>
        tool!.execute('image-call', params as never, undefined, undefined, undefined as never);
      const text = (result: Awaited<ReturnType<typeof run>>) => JSON.stringify(result.content);
      expect(text(await run({ prompt: 'draw' }))).toContain(
        'Select a default image generation model'
      );
      supervisor.handleCommand({
        type: 'set-image-generation-config',
        config: {
          providerId: 'image-provider',
          modelId: 'image',
          protocol: 'openai',
          baseUrl: 'https://images.example/v1',
          apiKey: 'fixture-only',
        },
      });
      expect(text(await run({ prompt: '' }))).toContain('Invalid ImageGen arguments');
      supervisor.handleCommand({
        type: 'set-image-generation-config',
        config: null,
        error: 'Model disabled',
      });
      expect(text(await run({ prompt: 'draw' }))).toContain(
        'selected image generation model is unavailable'
      );
      supervisor.handleCommand({
        type: 'set-builtin-tools',
        identity: parent,
        disabledTools: ['image_generation'],
      });
      await settle();
      const parentSession = mocks.sessions[0] as FakeSession;
      expect(parentSession.getActiveToolNames()).not.toContain('ImageGen');
      supervisor.handleCommand({ type: 'set-builtin-tools', identity: parent, disabledTools: [] });
      await settle();
      expect(parentSession.getActiveToolNames()).toContain('ImageGen');
      const childOptions = mocks.createAgentSession.mock.calls[1][0] as {
        customTools: ToolDefinition[];
      };
      expect(childOptions.customTools.some((entry) => entry.name === 'ImageGen')).toBe(false);
    } finally {
      await supervisor.shutdown();
    }
  });

  it('到 1.5 倍中止时不发 turn-completed，补报告那轮用原 turnId 带预算停止标记收口', async () => {
    const { events, supervisor, worker } = await spawnChild();
    promptRun(supervisor, 'run-1');
    await settle();
    for (let n = 1; n <= 3; n++) request(worker, toolCall(n));
    expect(worker.abort).toHaveBeenCalledTimes(1);

    endRound(worker);
    await settle();
    expect(completed(events)).toHaveLength(0);
    expect(worker.prompt).toHaveBeenLastCalledWith(budgetWrapUpPrompt());

    request(worker, finalAnswer('partial findings'));
    endRound(worker);
    await settle();
    expect(completed(events)).toEqual([
      expect.objectContaining({ turnId: 'run-1', requestBudgetStop: true }),
    ]);
    expect(completed(events)[0]).not.toHaveProperty('requestBudgetError');
    await supervisor.shutdown();
  });

  it('补报告那轮报错：仍按预算停止收口，错误随结果交回', async () => {
    const { events, supervisor, worker } = await spawnChild();
    promptRun(supervisor, 'run-1');
    await settle();
    for (let n = 1; n <= 3; n++) request(worker, toolCall(n));
    endRound(worker);
    await settle();

    request(worker, { content: [], stopReason: 'error', errorMessage: '529 overloaded' });
    endRound(worker);
    await settle();
    expect(completed(events)).toEqual([
      expect.objectContaining({
        turnId: 'run-1',
        requestBudgetStop: true,
        requestBudgetError: '529 overloaded',
      }),
    ]);
    expect(events.some((event) => event.type === 'turn-failed')).toBe(false);
    await supervisor.shutdown();
  });

  it('中止期间用户按 stop：不再补发报告，收口不带预算标记', async () => {
    const { events, supervisor, worker } = await spawnChild();
    promptRun(supervisor, 'run-1');
    await settle();
    for (let n = 1; n <= 3; n++) request(worker, toolCall(n));
    expect(worker.abort).toHaveBeenCalledTimes(1);
    const prompts = worker.prompt.mock.calls.length;

    supervisor.handleCommand({ type: 'abort', identity: child });
    await settle();
    endRound(worker);
    await settle();
    expect(worker.prompt).toHaveBeenCalledTimes(prompts);
    expect(completed(events).every((event) => event.requestBudgetStop === undefined)).toBe(true);
    await supervisor.shutdown();
  });

  it('补报告排队后用户按 stop：排队的补报告不再发出', async () => {
    const { supervisor, worker } = await spawnChild();
    promptRun(supervisor, 'run-1');
    await settle();
    for (let n = 1; n <= 3; n++) request(worker, toolCall(n));
    const prompts = worker.prompt.mock.calls.length;
    // agent_settled 已把补报告排进 setImmediate，用户的 stop 抢在它之前
    endRound(worker);
    supervisor.handleCommand({ type: 'abort', identity: child });
    await settle();
    expect(worker.prompt).toHaveBeenCalledTimes(prompts);
    await supervisor.shutdown();
  });

  it('第 1.5 倍那次请求本身是最终回答：不中止，正常收口', async () => {
    const { events, supervisor, worker } = await spawnChild();
    promptRun(supervisor, 'run-1');
    await settle();
    request(worker, toolCall(1));
    request(worker, toolCall(2));
    request(worker, finalAnswer('all done'));
    expect(worker.abort).not.toHaveBeenCalled();
    endRound(worker);
    await settle();
    expect(completed(events)).toEqual([expect.objectContaining({ turnId: 'run-1' })]);
    expect(completed(events)[0]).not.toHaveProperty('requestBudgetStop');
    await supervisor.shutdown();
  });

  it('Run 结束后用户自己在 coworker 里发起的回合不计数', async () => {
    const { events, supervisor, worker } = await spawnChild();
    promptRun(supervisor, 'run-1');
    await settle();
    request(worker, toolCall(1));
    request(worker, finalAnswer('done'));
    endRound(worker);
    await settle();
    expect(completed(events)).toHaveLength(1);

    supervisor.handleCommand({ type: 'prompt', identity: child, text: 'keep going' });
    await settle();
    for (let n = 2; n <= 10; n++) request(worker, toolCall(n));
    expect(worker.abort).not.toHaveBeenCalled();
    endRound(worker);
    await settle();
    expect(completed(events)).toHaveLength(2);
    expect(completed(events)[1]).not.toHaveProperty('requestBudgetStop');
    await supervisor.shutdown();
  });

  it('预算中止收口后再来新 Run 重新计数', async () => {
    const { events, supervisor, worker } = await spawnChild();
    promptRun(supervisor, 'run-1');
    await settle();
    for (let n = 1; n <= 3; n++) request(worker, toolCall(n));
    endRound(worker);
    await settle();
    request(worker, finalAnswer('partial'));
    endRound(worker);
    await settle();
    expect(worker.abort).toHaveBeenCalledTimes(1);

    promptRun(supervisor, 'run-2');
    await settle();
    request(worker, toolCall(4));
    request(worker, toolCall(5));
    expect(worker.abort).toHaveBeenCalledTimes(1);
    request(worker, toolCall(6));
    expect(worker.abort).toHaveBeenCalledTimes(2);
    expect(completed(events).map((event) => event.turnId)).toEqual(['run-1']);
    await supervisor.shutdown();
  });
});
