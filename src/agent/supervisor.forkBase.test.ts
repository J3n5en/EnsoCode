import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentWorkerEvent } from '@shared/types/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
  createAgentSession: vi.fn(),
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
      appendMessage: vi.fn((message: unknown) => {
        branch.push({ type: 'message', message });
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
    resolveModel: vi.fn().mockRejectedValue(new Error('unexpected')),
    getAuth: vi.fn().mockResolvedValue(undefined),
    getProvider(providerId: string) {
      if (![...this.models.keys()].some((key) => key.startsWith(`${providerId}/`)))
        return undefined;
      return { id: providerId, models: [], stream: vi.fn(), streamSimple: vi.fn() };
    },
    registerNativeProvider: vi.fn(),
    refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
    completeSimple: vi.fn(async () => ({ content: [] })),
  };
  runtime.registerProvider('settings-provider', {
    models: [
      {
        id: 'physical-model',
        api: 'openai-completions',
        name: 'physical',
        reasoning: true,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
    ],
  });
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
const btw = { sessionId: 'btw-1', generation: '22222222-2222-4222-8222-222222222222' };

/** spawn 下发的物理模型配置 */
const physicalSpawn = {
  api: 'openai-completions' as const,
  baseUrl: 'https://example.test/v1',
  apiKey: 'secret',
  modelId: 'physical-model',
  settingsProviderId: 'settings-provider',
};

/**
 * 虚拟模型会话：session.model 是 pi 虚拟模型（provider enso-virtual、id auto、api pi-virtual），
 * 与 pi 的 registerVirtualModel 产物一致；streamFunction 按真实路由行为收到的是物理模型。
 */
function fakeSession(options: Record<string, unknown>) {
  const listeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
  const messages: unknown[] = [];
  const streamFunction = vi.fn(async () => {
    throw new Error('fixture stream should not run');
  });
  const virtualModel = {
    id: 'auto',
    provider: 'enso-virtual',
    api: 'pi-virtual',
    name: 'Auto',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  };
  const physicalModel = {
    id: 'physical-model',
    provider: 'settings-provider',
    api: 'openai-completions',
    name: 'physical',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  };
  // mock 不走真实模型解析：session.model 由 fixture 直接给定为虚拟模型，
  // 模拟 Auto 会话（父会话与旁路在真实场景下都以 enso-virtual/auto spawn）
  const value = {
    model: virtualModel,
    physicalModel,
    virtualModel,
    resourceLoader: options.resourceLoader,
    sessionManager: options.sessionManager,
    messages,
    sessionFile: `/tmp/session-${mocks.sessions.length}.jsonl`,
    sessionId: `session-${mocks.sessions.length}`,
    agent: {
      state: { messages, thinkingLevel: 'medium', tools: [] },
      prepareRequest: vi.fn(async () => undefined),
      streamFunction,
    },
    isCompacting: false,
    pendingMessageCount: 0,
    getFollowUpMessages: () => [],
    subscribe: vi.fn((listener: (event: { type: string; [key: string]: unknown }) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    emit(event: { type: string; [key: string]: unknown }) {
      for (const listener of listeners) listener(event);
    },
    prompt: vi.fn(
      async (_text: string, opts?: { preflightResult?: (disposition: string) => void }) => {
        opts?.preflightResult?.('started');
      }
    ),
    steer: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    compact: vi.fn(async () => undefined),
    dispose: vi.fn(),
    setThinkingLevel: vi.fn(),
    activeTools: [] as string[],
    getActiveToolNames(this: { activeTools: string[] }) {
      return [...this.activeTools];
    },
    setActiveToolsByName: vi.fn(),
    navigateTree: vi.fn(async () => ({ cancelled: false })),
    isStreaming: false,
    isRetrying: false,
    isIdle: true,
  };
  mocks.sessions.push(value as unknown as Record<string, unknown>);
  return value;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

async function waitFor(events: AgentWorkerEvent[], type: AgentWorkerEvent['type']): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (events.some((event) => event.type === type)) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${type}`);
}

describe('SessionSupervisor forkBase 虚拟模型', () => {
  beforeEach(() => {
    mocks.sessions.length = 0;
    mocks.createAgentSession.mockReset();
    mocks.createAgentSession.mockImplementation(async (options: Record<string, unknown>) => ({
      session: fakeSession(options),
    }));
  });

  async function spawnParentWithVirtualModel(events: AgentWorkerEvent[]) {
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-forkbase-')),
    });
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model: physicalSpawn,
    } as never);
    await waitFor(events, 'parent-ready');
    return supervisor;
  }

  /** 模拟一次真实请求：pi 路由后 streamFunction 收到物理模型，supervisor 包层记录 forkBase */
  function driveRequest(session: ReturnType<typeof fakeSession>) {
    const wrapped = session.agent.streamFunction as unknown as (
      model: unknown,
      context: { messages: unknown[] },
      options?: { sessionId?: string }
    ) => Promise<unknown>;
    return wrapped(
      session.physicalModel,
      { messages: [{ role: 'user', content: [] }] },
      {
        sessionId: session.sessionId,
      }
    ).catch(() => undefined);
  }

  it('虚拟模型会话请求后，forkFrom 注入不被「换过模型」误判拦下', async () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = await spawnParentWithVirtualModel(events);
    const parentSession = mocks.sessions[0] as unknown as ReturnType<typeof fakeSession>;

    await driveRequest(parentSession);
    await settle();
    parentSession.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'stop',
        provider: 'settings-provider',
        model: 'physical-model',
      },
    });
    await settle();

    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: btw,
      cwd: '/workspace',
      model: physicalSpawn,
      rolePrompt: 'learn',
      forkFrom: parent.sessionId,
    } as never);
    await waitFor(events, 'parent-ready');
    await settle();

    const btwSession = mocks.sessions[1] as unknown as ReturnType<typeof fakeSession>;
    const appendMessage = (btwSession.sessionManager as { appendMessage: ReturnType<typeof vi.fn> })
      .appendMessage;
    expect(appendMessage.mock.calls.length).toBeGreaterThan(0);
    await supervisor.shutdown();
  });

  it('父会话换成另一个模型后，forkFrom 仍然静默降级', async () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = await spawnParentWithVirtualModel(events);
    const parentSession = mocks.sessions[0] as unknown as ReturnType<typeof fakeSession>;

    await driveRequest(parentSession);
    await settle();

    // 用户从 Auto 换成另一个虚拟模型：选择模型 id 变化，forkBase 必须失效。
    // （注意 fixture 的 session.model 初始是 id=auto 的虚拟模型，不是物理模型）
    (parentSession as { model: unknown }).model = {
      ...(parentSession.virtualModel as object),
      id: 'auto-2',
    };

    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: btw,
      cwd: '/workspace',
      model: physicalSpawn,
      rolePrompt: 'learn',
      forkFrom: parent.sessionId,
    } as never);
    await waitFor(events, 'parent-ready');
    await settle();

    const btwSession = mocks.sessions[1] as unknown as ReturnType<typeof fakeSession>;
    const appendMessage = (btwSession.sessionManager as { appendMessage: ReturnType<typeof vi.fn> })
      .appendMessage;
    expect(appendMessage.mock.calls.length).toBe(0);
    await supervisor.shutdown();
  });
});
