import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { PluginEventPlan, PluginToolDescriptor } from '@shared/extensionPlugins/types';
import type { AgentCommand, AgentWorkerEvent } from '@shared/types/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
  managers: [] as Array<Record<string, unknown>>,
  mcpToolsFor: vi.fn(),
  mcpResolve: vi.fn(),
  mcpRefresh: vi.fn(),
  createAgentSession: vi.fn(),
  loaderOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock('./cursor/loadProvider', () => ({
  CURSOR_PROVIDER_ID: 'cursor',
  loadCursorProvider: vi.fn(async () => undefined),
}));

vi.mock('./mcp', () => ({
  McpManager: class {
    toolsFor = mocks.mcpToolsFor;
    resolve = mocks.mcpResolve;
    refresh = mocks.mcpRefresh;
    closeAll = vi.fn(async () => undefined);
  },
}));

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  class Loader {
    constructor(options: Record<string, unknown>) {
      mocks.loaderOptions.push(options);
    }
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
    const value = {
      getBranch: vi.fn(() => branch),
      appendCustomEntry: vi.fn((customType: string, data: unknown) => {
        branch.push({ type: 'custom', customType, data });
        return `entry-${branch.length}`;
      }),
      buildSessionContext: vi.fn(() => ({ messages: [] })),
    };
    mocks.managers.push(value);
    return value;
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
      .mockRejectedValue(new Error('Unexpected virtual model routing in ordinary-runtime fixture')),
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

const parent = {
  sessionId: 'parent',
  generation: '11111111-1111-4111-8111-111111111111',
};
const lockedChild = {
  sessionId: 'parent::cw-instance',
  generation: '22222222-2222-4222-8222-222222222222',
  parent,
  instanceId: '33333333-3333-4333-8333-333333333333',
  instanceName: 'Enso-33333333',
  typeKey: 'agent:enso' as const,
  profileId: 'enso-locked-v1' as const,
};
const model = {
  api: 'openai-completions' as const,
  baseUrl: 'https://example.test/v1',
  apiKey: 'secret',
  modelId: 'model',
  settingsProviderId: 'settings-provider',
};

function session(options: Record<string, unknown>) {
  const listeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
  const labels: string[] = [];
  const value = {
    model: options.model,
    resourceLoader: options.resourceLoader,
    sessionManager: options.sessionManager,
    messages: [],
    sessionFile: `/tmp/session-${mocks.sessions.length}.jsonl`,
    subscribe: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    emit(event: { type: string; [key: string]: unknown }) {
      if (event.type === 'message_start' && (event.message as { role?: string })?.role === 'user') {
        value.agent.steeringQueue.messages.shift();
        labels.shift();
      }
      for (const listener of listeners) listener(event);
    },
    prompt: vi.fn(
      async (
        _text?: string,
        _options?: { preflightResult?: (disposition: 'handled' | 'queued' | 'started') => void }
      ) => undefined
    ),
    agent: { steeringQueue: { messages: [] as unknown[] } },
    getSteeringMessages: () => labels,
    _emitQueueUpdate: vi.fn(),
    _queueSteer: async (text: string) => {
      labels.push(text);
      value.agent.steeringQueue.messages.push({ role: 'user', content: text });
    },
    steer: vi.fn(async function (
      this: { _queueSteer(text: string): Promise<void> },
      text: string
    ): Promise<'queued' | 'handled'> {
      await this._queueSteer(text);
      return 'queued';
    }),
    abort: vi.fn(async () => undefined),
    waitForIdle: vi.fn(async () => undefined),
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
    isRetrying: false,
    isCompacting: false,
  };
  mocks.sessions.push(value);
  return value;
}

async function settle(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  await promise;
}

async function waitFor(events: AgentWorkerEvent[], type: AgentWorkerEvent['type']): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (events.some((event) => event.type === type)) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${type}`);
}

/** spawn 链路里的 mock 异步跳数会变（provider 刷新等），settle() 一次不一定够，轮询等它落地。 */
async function settleUntil(check: () => boolean, tries = 20): Promise<void> {
  for (let i = 0; i < tries && !check(); i++) {
    await settle();
  }
}

const pluginTool: PluginToolDescriptor = {
  name: 'plugin_example-demo__lookup',
  description: '查询',
  parameters: { type: 'object' },
  pluginId: 'example.demo',
};
const eventPlan: PluginEventPlan = {
  observe: ['session_start', 'session_end', 'tool_call'],
  intercept: [{ event: 'tool_call' }, { event: 'tool_result' }, { event: 'input' }],
  inject: true,
};

type ChildTool = {
  name: string;
  execute(id: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
};

const typed = (name: string, tools: 'all' | 'readonly', n: number) => {
  const uuid = (digit: number) =>
    `${String(digit).repeat(8)}-${String(digit).repeat(4)}-4${String(digit).repeat(3)}-8${String(digit).repeat(3)}-${String(digit).repeat(12)}`;
  const identity = {
    sessionId: `parent::cw-${name}`,
    generation: uuid(n),
    parent,
    instanceId: uuid(n + 1),
    instanceName: `${name}-1`,
    typeKey: `builtin:${name}` as const,
  };
  const command: AgentCommand = {
    type: 'spawn-child',
    identity,
    cwd: '/workspace',
    config: {
      typeKey: identity.typeKey,
      displayName: name.toUpperCase(),
      description: name,
      spawnSpecId: `spawn-${name}`,
      systemPrompt: `${name} role`,
      model,
      tools,
      skillPaths: [],
      skillBindingIds: [],
      mcpServers: [],
      mcpBindingIds: [],
      systemPromptHash: `${name}-hash`,
    },
  };
  return { identity, command };
};

const lockedCommand: AgentCommand = {
  type: 'spawn-child',
  identity: lockedChild,
  cwd: '/workspace',
  config: {
    typeKey: 'agent:enso',
    displayName: 'Enso',
    description: 'System Agent',
    spawnSpecId: 'spawn-enso',
    systemPrompt: 'locked',
    model,
    tools: 'enso-locked',
    skillPaths: [],
    skillBindingIds: [],
    mcpServers: [],
    mcpBindingIds: [],
    systemPromptHash: 'enso-hash',
    lockedProfileId: 'enso-locked-v1',
  },
};

function setup(approvalMode: 'full' | 'supervised' = 'full') {
  const events: AgentWorkerEvent[] = [];
  const supervisor = new SessionSupervisor({
    emit: (event) => events.push(event),
    agentDir: '/tmp/agent',
    sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-plugin-child-')),
  });
  return { events, supervisor, approvalMode };
}

async function spawnParent(ctx: ReturnType<typeof setup>): Promise<void> {
  ctx.supervisor.handleCommand({
    type: 'spawn-parent',
    identity: parent,
    cwd: '/workspace',
    model,
    approvalMode: ctx.approvalMode,
    pluginTools: [pluginTool],
    pluginEvents: eventPlan,
  });
  await waitFor(ctx.events, 'parent-ready');
}

/** 返回这次 spawn 的 customTools 与 loader 选项 */
async function spawnChild(ctx: ReturnType<typeof setup>, command: AgentCommand) {
  const calls = mocks.createAgentSession.mock.calls.length;
  const loaders = mocks.loaderOptions.length;
  const readyBefore = ctx.events.filter((event) => event.type === 'child-ready').length;
  ctx.supervisor.handleCommand(command);
  await settleUntil(
    () => ctx.events.filter((event) => event.type === 'child-ready').length > readyBefore
  );
  const options = mocks.createAgentSession.mock.calls[calls]?.[0] as { customTools: ChildTool[] };
  return { tools: options.customTools, loaders: mocks.loaderOptions.slice(loaders) };
}

function pluginExtension(loaders: Array<Record<string, unknown>>) {
  const factories = loaders.flatMap(
    (options) =>
      (options.extensionFactories as Array<{ name?: string; factory(pi: unknown): void }>) ?? []
  );
  const extension = factories.find((factory) => factory.name === 'enso-plugin-events');
  if (!extension) return undefined;
  const handlers = new Map<string, (event: unknown) => unknown>();
  extension.factory({
    on: (event: string, handler: (event: unknown) => unknown) => handlers.set(event, handler),
    sendMessage: vi.fn(),
  });
  return handlers;
}

const ofType = <T extends AgentWorkerEvent['type']>(events: AgentWorkerEvent[], type: T) =>
  events.filter((event): event is Extract<AgentWorkerEvent, { type: T }> => event.type === type);

describe('子会话插件能力', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.sessions.length = 0;
    mocks.managers.length = 0;
    mocks.loaderOptions.length = 0;
    mocks.createAgentSession.mockReset();
    mocks.mcpToolsFor.mockReset().mockResolvedValue([]);
    mocks.createAgentSession.mockImplementation(async (options: Record<string, unknown>) => ({
      session: session(options),
    }));
  });

  it('普通子代理与 coworker 拿到插件工具；只读档与 enso-locked 不拿；proof 不含插件工具', async () => {
    const ctx = setup();
    await spawnParent(ctx);
    const parentTools = (
      mocks.createAgentSession.mock.calls[0][0] as { customTools: ChildTool[] }
    ).customTools.map((tool) => tool.name);
    expect(parentTools).toContain(pluginTool.name);

    const worker = typed('worker', 'all', 4);
    const general = await spawnChild(ctx, worker.command);
    expect(general.tools.map((tool) => tool.name)).toContain(pluginTool.name);
    const proof = ofType(ctx.events, 'child-ready').find(
      (event) => event.identity.sessionId === worker.identity.sessionId
    )?.proof;
    expect(proof?.toolIds).not.toContain(pluginTool.name);

    const scout = await spawnChild(ctx, typed('scout', 'readonly', 6).command);
    expect(scout.tools.map((tool) => tool.name)).not.toContain(pluginTool.name);

    const locked = await spawnChild(ctx, lockedCommand);
    expect(locked.tools.map((tool) => tool.name)).toEqual([
      'enso_capabilities',
      'enso_app',
      'ask_user',
    ]);
    expect(pluginExtension(locked.loaders)).toBeUndefined();

    const calls = mocks.createAgentSession.mock.calls.length;
    ctx.supervisor.handleCommand({
      type: 'resume-coworker',
      parent,
      coworkerId: 'parent::cw-helper',
      name: 'helper',
      resumeFile: '/tmp/helper.jsonl',
    });
    await settleUntil(() => mocks.createAgentSession.mock.calls.length > calls);
    const coworker = mocks.createAgentSession.mock.calls[calls]?.[0] as {
      customTools: ChildTool[];
    };
    expect(coworker.customTools.map((tool) => tool.name)).toContain(pluginTool.name);
  });

  it('子会话插件工具走子会话自己的审批，往返带子会话身份与来源；主会话仍不带来源', async () => {
    const ctx = setup('supervised');
    await spawnParent(ctx);
    const worker = typed('worker', 'all', 4);
    const { tools } = await spawnChild(ctx, worker.command);
    const tool = tools.find((item) => item.name === pluginTool.name);
    const pending = tool!.execute('call-1', { q: 'x' });
    await settleUntil(() => ofType(ctx.events, 'approval-request').length > 0);
    const approvals = ofType(ctx.events, 'approval-request');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.identity.sessionId).toBe(worker.identity.sessionId);
    ctx.supervisor.handleCommand({
      type: 'approval-respond',
      identity: worker.identity,
      requestId: approvals[0]!.request.requestId,
      decision: 'allow',
    });
    await settleUntil(() => ofType(ctx.events, 'plugin-tool-invoke').length > 0);
    const invoke = ofType(ctx.events, 'plugin-tool-invoke')[0]!;
    expect(invoke).toMatchObject({
      identity: { sessionId: worker.identity.sessionId, generation: worker.identity.generation },
      toolName: pluginTool.name,
      args: { q: 'x' },
      agent: {
        kind: 'subagent',
        sessionId: worker.identity.sessionId,
        name: 'worker-1',
        agentType: 'WORKER',
      },
    });
    expect(Object.keys(invoke.identity).sort()).toEqual(['generation', 'sessionId']);
    ctx.supervisor.handleCommand({
      type: 'plugin-tool-result',
      identity: invoke.identity,
      requestId: invoke.requestId,
      ok: true,
      result: { content: 'pong' },
    });
    await expect(pending).resolves.toMatchObject({
      content: [{ type: 'text', text: 'pong' }],
    });

    const parentTool = (
      mocks.createAgentSession.mock.calls[0][0] as { customTools: ChildTool[] }
    ).customTools.find((item) => item.name === pluginTool.name);
    ctx.supervisor.handleCommand({ type: 'set-approval-mode', identity: parent, mode: 'full' });
    await settle();
    void parentTool!.execute('call-2', {}).catch(() => {});
    await settleUntil(() => ofType(ctx.events, 'plugin-tool-invoke').length > 1);
    const parentInvoke = ofType(ctx.events, 'plugin-tool-invoke')[1]!;
    expect(parentInvoke.identity).toEqual(parent);
    expect(parentInvoke).not.toHaveProperty('agent');
  });

  it('子会话被解雇时：挂起的插件调用取消并通知 Main，发出 session_end，之后不再上报', async () => {
    const ctx = setup();
    await spawnParent(ctx);
    const worker = typed('worker', 'all', 4);
    const { tools, loaders } = await spawnChild(ctx, worker.command);
    const handlers = pluginExtension(loaders);
    const pending = tools.find((item) => item.name === pluginTool.name)!.execute('call-1', {});
    await settleUntil(() => ofType(ctx.events, 'plugin-tool-invoke').length > 0);
    const invoke = ofType(ctx.events, 'plugin-tool-invoke')[0]!;
    const checking = handlers!.get('tool_call')?.({
      toolCallId: 'c0',
      toolName: 'bash',
      input: {},
    });
    expect(ofType(ctx.events, 'plugin-intercept')).toHaveLength(1);
    ctx.supervisor.handleCommand({
      type: 'dismiss-child',
      parent,
      child: worker.identity,
    });
    await expect(pending).rejects.toThrow();
    // 挂起的拦截立即收敛：按拦下结束，不等本地兜底，也不在解雇后放行
    await expect(checking).resolves.toMatchObject({ block: true });
    expect(ofType(ctx.events, 'plugin-tool-cancel')).toEqual([
      expect.objectContaining({ requestId: invoke.requestId }),
    ]);
    const childEvents = ofType(ctx.events, 'plugin-event').filter(
      (event) => event.identity.sessionId === worker.identity.sessionId
    );
    expect(childEvents.map((event) => event.event)).toEqual(['session_start', 'session_end']);
    expect(childEvents[1]).toMatchObject({
      data: { reason: 'dismissed' },
      agent: { kind: 'subagent', sessionId: worker.identity.sessionId },
    });
    const count = ofType(ctx.events, 'plugin-event').length;
    await expect(
      handlers!.get('tool_call')?.({ toolCallId: 'late', toolName: 'bash', input: {} })
    ).resolves.toBeUndefined();
    expect(ofType(ctx.events, 'plugin-event')).toHaveLength(count);
    expect(ofType(ctx.events, 'plugin-intercept')).toHaveLength(1);
  });

  it('子会话 tool_call 拦截带来源上报、可拦下；input / tool_result 不拦截；主会话拦截照旧', async () => {
    const ctx = setup();
    await spawnParent(ctx);
    const parentHandlers = pluginExtension(mocks.loaderOptions.slice(0, 1));
    const worker = typed('worker', 'all', 4);
    const { loaders } = await spawnChild(ctx, worker.command);
    const handlers = pluginExtension(loaders);
    expect(handlers).toBeDefined();
    expect(handlers!.has('input')).toBe(false);
    expect(handlers!.has('tool_result')).toBe(false);
    const source = {
      kind: 'subagent',
      sessionId: worker.identity.sessionId,
      name: 'worker-1',
      agentType: 'WORKER',
    };
    const childIdentity = {
      sessionId: worker.identity.sessionId,
      generation: worker.identity.generation,
    };
    const blocked = handlers!.get('tool_call')?.({
      toolCallId: 'c0',
      toolName: 'bash',
      input: { command: 'rm' },
    });
    const request = ofType(ctx.events, 'plugin-intercept')[0]!;
    expect(request).toMatchObject({
      identity: childIdentity,
      event: 'tool_call',
      payload: { toolCallId: 'c0', toolName: 'bash', input: { command: 'rm' } },
      agent: source,
    });
    ctx.supervisor.handleCommand({
      type: 'plugin-intercept-result',
      identity: request.identity,
      requestId: request.requestId,
      ok: true,
      result: { block: true, reason: 'denied' },
    });
    await expect(blocked).resolves.toEqual({ block: true, reason: 'denied' });

    const input = { command: 'ls' };
    const allowed = handlers!.get('tool_call')?.({ toolCallId: 'c1', toolName: 'bash', input });
    const second = ofType(ctx.events, 'plugin-intercept')[1]!;
    ctx.supervisor.handleCommand({
      type: 'plugin-intercept-result',
      identity: second.identity,
      requestId: second.requestId,
      ok: true,
      result: {},
    });
    await expect(allowed).resolves.toBeUndefined();
    const childEvents = ofType(ctx.events, 'plugin-event').filter(
      (event) => event.identity.sessionId === worker.identity.sessionId
    );
    expect(childEvents).toEqual([
      expect.objectContaining({
        event: 'session_start',
        data: { reason: 'startup' },
        agent: expect.objectContaining({ kind: 'subagent', name: 'worker-1' }),
      }),
      expect.objectContaining({
        identity: childIdentity,
        event: 'tool_call',
        data: { toolCallId: 'c1', toolName: 'bash', input },
        agent: source,
      }),
    ]);

    void parentHandlers!.get('tool_call')?.({ toolCallId: 'p1', toolName: 'bash', input: {} });
    const parentRequest = ofType(ctx.events, 'plugin-intercept')[2];
    expect(parentRequest).toMatchObject({ identity: parent, event: 'tool_call' });
    expect(parentRequest).not.toHaveProperty('agent');
    expect(parentHandlers!.has('input')).toBe(true);
    expect(parentHandlers!.has('tool_result')).toBe(true);
  });
});
