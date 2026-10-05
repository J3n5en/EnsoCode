import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelRuntime, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { childProfileShell, childProfileToolIds } from '@shared/childProfileTools';
import { DEFAULT_PERSONA_PROMPT } from '@shared/systemPrompt';
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

import type { BackgroundTaskManager } from './backgroundTasks';
import { SessionSupervisor } from './supervisor';

const parent = {
  sessionId: 'parent',
  generation: '11111111-1111-4111-8111-111111111111',
};
const child = {
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
      for (const listener of listeners) listener(event);
    },
    prompt: vi.fn(
      async (
        _text?: string,
        _options?: { preflightResult?: (disposition: 'handled' | 'queued' | 'started') => void }
      ) => undefined
    ),
    steer: vi.fn(async (): Promise<'queued' | 'handled'> => 'queued'),
    abort: vi.fn(async () => undefined),
    waitForIdle: vi.fn(async () => undefined),
    dispose: vi.fn(),
    setThinkingLevel: vi.fn(),
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

function applyCustomPersona(options: Record<string, unknown> | undefined, systemPrompt: string) {
  const extension = (
    options?.extensionFactories as
      | Array<{
          name?: string;
          factory(pi: {
            on(
              event: 'before_agent_start',
              handler: (event: { systemPrompt: string }) => { systemPrompt: string }
            ): void;
          }): void;
        }>
      | undefined
  )?.find((factory) => factory.name === 'custom-persona');
  if (!extension) return systemPrompt;
  let transform = (prompt: string) => prompt;
  extension.factory({
    on: (_event, handler) => {
      transform = (prompt) => handler({ systemPrompt: prompt }).systemPrompt;
    },
  });
  return transform(systemPrompt);
}

describe('SessionSupervisor deterministic child lifecycle', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.sessions.length = 0;
    mocks.managers.length = 0;
    mocks.loaderOptions.length = 0;
    mocks.createAgentSession.mockReset();
    rmSync(path.join(tmpdir(), 'enso-dispatch-sessions'), { recursive: true, force: true });
    mocks.mcpToolsFor.mockReset().mockResolvedValue([]);
    mocks.createAgentSession.mockImplementation(async (options: Record<string, unknown>) => ({
      session: session(options),
    }));
  });

  it.each([
    ['replace', ['edit', 'write'], ['apply_patch']],
    ['apply_patch', ['apply_patch'], ['edit', 'write']],
  ] as const)(
    '%s 模式只装配互斥写工具，且所有普通 ResourceLoader 注册 patch 结果 hook',
    async (editMode, included, excluded) => {
      const events: AgentWorkerEvent[] = [];
      const supervisor = new SessionSupervisor({
        emit: (event) => events.push(event),
        agentDir: '/tmp/agent',
        sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-dispatch-mode-')),
      });
      supervisor.handleCommand({
        type: 'spawn-parent',
        identity: parent,
        cwd: '/workspace',
        model,
        editMode,
      });
      await waitFor(events, 'parent-ready');
      const options = mocks.createAgentSession.mock.calls.at(-1)?.[0] as {
        customTools: Array<{
          name: string;
          parameters?: { properties?: Record<string, unknown> };
          description?: string;
          promptGuidelines?: string[];
        }>;
      };
      const names = options.customTools.map((tool) => tool.name);
      for (const name of included) {
        expect(names).toContain(name);
        expect(
          options.customTools.find((tool) => tool.name === name)?.description?.length
        ).toBeGreaterThan(0);
      }
      for (const name of excluded) expect(names).not.toContain(name);
      if (editMode === 'apply_patch') {
        const patch = options.customTools.find((tool) => tool.name === 'apply_patch');
        expect(Object.keys(patch?.parameters?.properties ?? {})).toEqual(['input']);
        expect(patch?.description).toContain('*** Begin Patch');
        expect(patch?.description).not.toMatch(/\b(?:edit|write) tool\b/i);
      }
      const loader = mocks.loaderOptions.at(-1);
      expect(String(loader?.systemPrompt ?? '')).not.toMatch(/\b(?:edit|write)\b/i);
      const factories = (loader?.extensionFactories ?? []) as Array<{ name?: string }>;
      expect(factories.some((factory) => factory.name === 'apply-patch-result')).toBe(true);
      await supervisor.shutdown();
    }
  );

  it('按需 MCP 不在 spawn 与预热时连接，首次 codemode 调用才注册为 deferred 并按真实工具名审批', async () => {
    const events: AgentWorkerEvent[] = [];
    const direct = { id: 'd', name: 'direct', transport: 'stdio' as const, command: 'd' };
    const deferred = {
      id: 'n',
      name: 'notes',
      transport: 'stdio' as const,
      command: 'n',
      loadMode: 'deferred' as const,
      toolNames: ['read'],
    };
    const readTool = {
      name: 'mcp__notes__read',
      label: 'notes: read',
      description: 'Read a note',
      parameters: { type: 'object', properties: {} },
      execute: vi.fn(async () => ({ content: [{ type: 'text', text: 'note' }] })),
    };
    mocks.mcpResolve.mockReset().mockResolvedValue({ ok: true, tools: [readTool] });
    mocks.mcpRefresh.mockReset();
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-dispatch-deferred-mcp-')),
    });
    supervisor.handleCommand({ type: 'warm-mcp', servers: [direct, deferred] });
    expect(mocks.mcpToolsFor).toHaveBeenLastCalledWith([direct]);
    expect(mocks.mcpRefresh).toHaveBeenCalledWith(deferred);
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
      approvalMode: 'supervised',
      mcpServers: [direct, deferred],
    });
    await waitFor(events, 'parent-ready');
    expect(mocks.mcpToolsFor).toHaveBeenLastCalledWith([direct], 3000);
    expect(mocks.mcpResolve).not.toHaveBeenCalled();
    const options = mocks.createAgentSession.mock.calls.at(-1)?.[0] as {
      customTools: Array<ToolDefinition>;
    };
    expect(options.customTools.some((tool) => tool.name === 'mcp')).toBe(false);

    const factories = (mocks.loaderOptions.at(-1) as { extensionFactories: unknown[] })
      .extensionFactories as Array<{ name?: string; factory?: (pi: unknown) => void }>;
    expect(factories[0]?.name).toBe('enso-codemode');
    const handlers = new Map<string, Array<(event: unknown) => unknown>>();
    const registered: ToolDefinition[] = [];
    factories[0]?.factory?.({
      on: (event: string, handler: (event: unknown) => unknown) =>
        handlers.set(event, [...(handlers.get(event) ?? []), handler]),
      registerTool: (tool: ToolDefinition) => registered.push(tool),
      appendEntry: () => {},
      getAllTools: () => [],
      getSettings: () => ({}),
    });
    const sections: Record<string, string> = {};
    for (const handler of handlers.get('before_agent_start') ?? []) {
      await handler({ systemPromptOptions: { sections } });
    }
    expect(sections.mcp_servers).toContain('- mcp__notes: read');
    for (const handler of handlers.get('tool_call') ?? []) {
      await handler({ toolName: 'codemode', toolCallId: 'c1', input: { code: 'return 1;' } });
    }
    expect(mocks.mcpResolve).toHaveBeenCalledWith(deferred);
    const registeredRead = registered.find((tool) => tool.name === 'mcp__notes__read');
    expect(registeredRead?.exposure).toBe('deferred');
    void registeredRead!.execute('c1/1', {}, undefined, undefined, {} as never);
    await settleUntil(() => events.some((event) => event.type === 'approval-request'));
    const request = events.find((event) => event.type === 'approval-request');
    expect(request).toMatchObject({ request: { tool: 'mcp__notes__read', kind: 'mcp' } });
    await supervisor.shutdown();
  });

  it('apply_patch 完整只读预检失败时不会进入 approval', async () => {
    const events: AgentWorkerEvent[] = [];
    const cwd = mkdtempSync(path.join(tmpdir(), 'enso-dispatch-preflight-'));
    writeFileSync(path.join(cwd, 'exists.ts'), 'keep\n');
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-dispatch-preflight-session-')),
    });
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd,
      model,
      editMode: 'apply_patch',
      approvalMode: 'assistant',
    });
    await waitFor(events, 'parent-ready');
    const options = mocks.createAgentSession.mock.calls.at(-1)?.[0] as {
      customTools: Array<ToolDefinition>;
    };
    const patch = options.customTools.find((tool) => tool.name === 'apply_patch');
    await expect(
      patch!.execute(
        'patch',
        { input: '*** Begin Patch\n*** Add File: exists.ts\n+x\n*** End Patch' },
        undefined,
        undefined,
        {} as never
      )
    ).rejects.toThrow(/exists/i);
    expect(events.some((event) => event.type === 'approval-request')).toBe(false);
    await supervisor.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  });

  it('旧 hashline bool 回落 apply_patch，warm 同 generation 不被后续模式改写', async () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-dispatch-legacy-mode-')),
    });
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
      hashlineEditEnabled: true,
    });
    await waitFor(events, 'parent-ready');
    const first = mocks.createAgentSession.mock.calls.at(-1)?.[0] as {
      customTools: Array<{ name: string; parameters?: { properties?: Record<string, unknown> } }>;
    };
    expect(first.customTools.some((tool) => tool.name === 'apply_patch')).toBe(true);
    expect(first.customTools.some((tool) => tool.name === 'edit')).toBe(false);
    expect(first.customTools.some((tool) => tool.name === 'write')).toBe(false);
    const creates = mocks.createAgentSession.mock.calls.length;
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
      editMode: 'replace',
    });
    await settle();
    expect(mocks.createAgentSession).toHaveBeenCalledTimes(creates);
    expect(first.customTools.some((tool) => tool.name === 'apply_patch')).toBe(true);
    expect(first.customTools.some((tool) => tool.name === 'write')).toBe(false);
    await supervisor.shutdown();
  });

  it('emits real parent/child ready, enforces locked tools, and prompts the child exactly once', async () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-dispatch-')),
    });
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
    });
    await waitFor(events, 'parent-ready');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'parent-ready',
        identity: parent,
        model: { providerId: 'settings-provider', modelId: 'model' },
      })
    );
    const parentSession = mocks.sessions[0] as ReturnType<typeof session>;
    expect(parentSession.prompt).not.toHaveBeenCalled();

    supervisor.handleCommand({
      type: 'spawn-child',
      identity: child,
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
    });
    await waitFor(events, 'child-ready');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'child-ready',
        identity: child,
        proof: expect.objectContaining({
          spawnSpecId: 'spawn-enso',
          model: { providerId: 'settings-provider', modelId: 'model' },
          toolIds: ['enso_capabilities', 'enso_app', 'ask_user'],
        }),
      })
    );
    const childSession = mocks.sessions[1] as ReturnType<typeof session>;
    expect(childSession.prompt).not.toHaveBeenCalled();

    const prompt: AgentCommand = {
      type: 'prompt-child',
      identity: child,
      requestId: 'request',
      task: { text: 'child-only task', images: [], fileMentions: [] },
    };
    supervisor.handleCommand(prompt);
    supervisor.handleCommand(prompt);
    for (let i = 0; i < 20 && childSession.prompt.mock.calls.length === 0; i++) {
      await settle();
    }
    expect(childSession.prompt).toHaveBeenCalledOnce();
    expect(childSession.prompt).toHaveBeenCalledWith(
      '<role>\nlocked\n</role>\n\nchild-only task',
      undefined
    );
    expect(parentSession.prompt).not.toHaveBeenCalled();
  });

  it('手动重读活动会话返回水位且不触发模型执行', async () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-dispatch-')),
    });
    supervisor.handleCommand({ type: 'spawn-parent', identity: parent, cwd: '/workspace', model });
    await waitFor(events, 'parent-ready');
    expect(() =>
      supervisor.handleCommand({
        type: 'reload-session',
        requestId: 'manual-1',
        sessionId: parent.sessionId,
      })
    ).not.toThrow();
    expect(events.findLast((event) => event.type === 'session-reloaded')).toMatchObject({
      requestId: 'manual-1',
      result: { ok: true, seq: expect.any(Number), snapshot: { identity: parent } },
    });
    expect((mocks.sessions[0] as ReturnType<typeof session>).prompt).not.toHaveBeenCalled();
  });

  it('手动重读不存在的会话返回明确失败而不创建会话', () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-dispatch-')),
    });
    expect(() =>
      supervisor.handleCommand({
        type: 'reload-session',
        requestId: 'manual-2',
        sessionId: 'missing',
      })
    ).not.toThrow();
    expect(events).toContainEqual({
      type: 'session-reloaded',
      requestId: 'manual-2',
      result: { ok: false, error: expect.any(String) },
    });
    expect(mocks.sessions).toHaveLength(0);
  });

  it('persists custom entries outside buildSessionContext and restores them in snapshot', async () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-dispatch-')),
    });
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
    });
    await waitFor(events, 'parent-ready');
    const entry = {
      kind: 'agent-dispatch' as const,
      child: {
        sessionId: child.sessionId,
        generation: child.generation,
        instanceId: child.instanceId,
        instanceName: child.instanceName,
        typeKey: child.typeKey,
      },
      at: 10,
    };
    supervisor.handleCommand({
      type: 'append-session-custom-entry',
      identity: parent,
      entry,
    });
    await settle();
    const parentManager = mocks.managers[0] as {
      appendCustomEntry: (customType: string, data: unknown) => unknown;
      buildSessionContext: () => unknown;
    };
    expect(parentManager.appendCustomEntry).toHaveBeenCalledWith('enso-agent-session', entry);
    expect(parentManager.buildSessionContext()).toEqual({ messages: [] });

    supervisor.handleCommand({ type: 'snapshot' });
    const snapshot = events.findLast((event) => event.type === 'snapshot');
    expect(snapshot).toMatchObject({
      type: 'snapshot',
      sessions: [expect.objectContaining({ identity: parent, customEntries: [entry] })],
    });
    expect(snapshot).not.toHaveProperty('sessionId');
  });

  it('snapshot 带回 backgroundTasks，切会话不会清空 TaskBar', async () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-dispatch-')),
    });
    supervisor.handleCommand({ type: 'spawn-parent', identity: parent, cwd: '/workspace', model });
    await waitFor(events, 'parent-ready');
    const internals = supervisor as unknown as {
      bgTasks: { snapshot: (sessionId: string) => unknown[] };
    };
    const task = { taskId: 't1', command: 'pnpm test', status: 'running', startedAt: 1, tail: '' };
    internals.bgTasks.snapshot = (sessionId) => (sessionId === parent.sessionId ? [task] : []);

    supervisor.handleCommand({ type: 'snapshot', sessionId: parent.sessionId });
    expect(events.at(-1)).toMatchObject({
      type: 'snapshot',
      sessions: [expect.objectContaining({ backgroundTasks: [task] })],
    });
  });

  it('targeted snapshot 带回请求的 sessionId，会话不在 worker 时 sessions 为空仍可路由', () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-dispatch-')),
    });
    supervisor.handleCommand({ type: 'snapshot', sessionId: 'evicted' });
    expect(events.at(-1)).toEqual({
      type: 'snapshot',
      sessions: [],
      partial: true,
      sessionId: 'evicted',
    });
  });

  it('keeps ordinary coding prompts unchanged and only explicit message_main enters parent context', async () => {
    const supervisor = new SessionSupervisor({
      emit: vi.fn(),
      agentDir: '/tmp/agent',
      sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-dispatch-')),
    });
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
      editMode: 'apply_patch',
    });
    await settleUntil(() => mocks.sessions.length > 0);
    const parentSession = mocks.sessions[0] as ReturnType<typeof session>;
    supervisor.handleCommand({ type: 'prompt', identity: parent, text: 'ordinary coding task' });
    await settle();
    expect(parentSession.prompt).toHaveBeenCalledWith('ordinary coding task', undefined);
    parentSession.prompt.mockClear();
    const scout = {
      sessionId: 'parent::cw-scout',
      generation: '44444444-4444-4444-8444-444444444444',
      parent,
      instanceId: '55555555-5555-4555-8555-555555555555',
      instanceName: 'Scout-55555555',
      typeKey: 'builtin:scout' as const,
    };
    supervisor.handleCommand({
      type: 'spawn-child',
      identity: scout,
      cwd: '/workspace',
      config: {
        typeKey: 'builtin:scout',
        displayName: 'Scout',
        description: 'Read-only scout',
        spawnSpecId: 'spawn-scout',
        systemPrompt: 'scout role',
        model,
        tools: 'readonly',
        skillPaths: [],
        skillBindingIds: [],
        mcpServers: [],
        mcpBindingIds: [],
        systemPromptHash: 'scout-hash',
      },
    });
    await settle();
    expect(parentSession.prompt).not.toHaveBeenCalled();
    const childOptions = mocks.createAgentSession.mock.calls[1][0] as {
      customTools: Array<{
        name: string;
        execute(
          id: string,
          params: { message: string; urgent?: boolean },
          signal?: AbortSignal
        ): Promise<unknown>;
      }>;
    };
    const childNames = childOptions.customTools.map((tool) => tool.name);
    const messageMain = childOptions.customTools.find((tool) => tool.name === 'message_main_agent');

    expect(childNames).not.toEqual(expect.arrayContaining(['apply_patch', 'edit', 'write']));
    expect(messageMain).toBeDefined();
    await messageMain!.execute('call', { message: 'explicit handoff', urgent: true });
    expect(parentSession.prompt).toHaveBeenCalledWith(expect.stringContaining('explicit handoff'));
  });

  it.each(
    [
      {
        label: 'apply_patch + 探后折叠 + 关沙箱',
        editMode: 'apply_patch' as const,
        exploreFold: true,
        isolatedSandbox: false,
        tools: 'all' as const,
      },
      {
        label: 'replace + 默认沙箱',
        editMode: 'replace' as const,
        exploreFold: false,
        isolatedSandbox: true,
        tools: 'all' as const,
      },
      {
        label: 'readonly',
        editMode: 'apply_patch' as const,
        exploreFold: false,
        isolatedSandbox: false,
        tools: 'readonly' as const,
      },
      {
        label: '父会话 readonly + all child',
        editMode: 'replace' as const,
        exploreFold: false,
        isolatedSandbox: false,
        workspaceWrite: false,
        tools: 'all' as const,
      },
    ].flatMap((spec) => [false, true].map((boundMcp) => ({ ...spec, boundMcp })))
  )('$label / boundMcp=$boundMcp 的 child proof 工具与共享推导一致', async (spec) => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-dispatch-profile-')),
    });
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
      editMode: spec.editMode,
      ...(spec.exploreFold ? { exploreFoldEnabled: true } : {}),
      disabledTools: [
        ...(spec.isolatedSandbox ? [] : ['isolated_sandbox']),
        ...('workspaceWrite' in spec && spec.workspaceWrite === false ? ['workspace_write'] : []),
      ],
    });
    await waitFor(events, 'parent-ready');
    const typeKey =
      spec.tools === 'readonly' ? ('builtin:scout' as const) : ('builtin:worker' as const);
    const mcpServers = spec.boundMcp
      ? ['notes', 'search'].map((name) => ({ name, transport: 'stdio' as const, command: 'mock' }))
      : [];
    const mcpTools = mcpServers.map((server) => ({
      name: `mcp__${server.name}__read`,
      label: `${server.name}: read`,
      description: 'Read MCP data',
      parameters: { type: 'object', properties: {} },
      execute: vi.fn(async () => ({ content: [{ type: 'text', text: 'data' }] })),
    }));
    mocks.mcpToolsFor.mockImplementation(async ([server]: [{ name: string }]) =>
      mcpTools.filter((tool) => tool.name === `mcp__${server.name}__read`)
    );
    const mcpBindingIds = mcpServers.map((server) => `binding-${server.name}`);
    supervisor.handleCommand({
      type: 'spawn-child',
      identity: {
        sessionId: 'parent::cw-profile',
        generation: '44444444-4444-4444-8444-444444444444',
        parent,
        instanceId: '55555555-5555-4555-8555-555555555555',
        instanceName: 'profile',
        typeKey,
      },
      cwd: '/workspace',
      config: {
        typeKey,
        displayName: 'Profile',
        description: 'profile proof',
        spawnSpecId: 'spawn-profile',
        systemPrompt: 'role',
        model,
        tools: spec.tools,
        skillPaths: [],
        skillBindingIds: [],
        mcpServers,
        mcpBindingIds,
        systemPromptHash: 'profile-hash',
      },
    });
    await waitFor(events, 'child-ready');
    const ready = events.find(
      (event) => event.type === 'child-ready' && event.identity.typeKey === typeKey
    );
    expect(ready?.type).toBe('child-ready');
    if (ready?.type !== 'child-ready') return;
    if ('workspaceWrite' in spec && spec.workspaceWrite === false) {
      expect(ready.proof.toolIds).not.toEqual(expect.arrayContaining(['edit', 'write']));
      expect(ready.proof.toolIds).not.toContain('bash');
      expect(ready.proof.toolIds).not.toContain('powershell');
    }
    expect(ready.proof.loadedMcpBindingIds).toEqual(mcpBindingIds);
    const options = mocks.createAgentSession.mock.calls.at(-1)?.[0] as {
      customTools: ToolDefinition[];
    };
    expect(
      [
        ...options.customTools.map((tool) => tool.name),
        ...(spec.isolatedSandbox ? ['codemode'] : []),
      ].sort()
    ).toEqual([...ready.proof.toolIds, ...mcpTools.map((tool) => tool.name)].sort());
    expect([...ready.proof.toolIds].sort()).toEqual(
      [
        ...childProfileToolIds(spec.tools, {
          editMode: spec.editMode,
          shell: childProfileShell({ platform: process.platform }),
          exploreFold: spec.exploreFold,
          isolatedSandbox: spec.isolatedSandbox,
          workspaceWrite: !('workspaceWrite' in spec && spec.workspaceWrite === false),
        }),
      ].sort()
    );
    await supervisor.shutdown();
  });

  it('idle 投影但 pi 仍在 streaming（agent_end 尚未回流）：等空闲后按新轮 prompt，不 steer', async () => {
    const supervisor = new SessionSupervisor({
      emit: vi.fn(),
      agentDir: '/tmp/agent',
      sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-dispatch-')),
    });
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
    });
    await settleUntil(() => mocks.sessions.length > 0);
    const parentSession = mocks.sessions[0] as ReturnType<typeof session>;
    parentSession.isStreaming = true;
    parentSession.waitForIdle = vi.fn(async () => {
      parentSession.isStreaming = false;
      return undefined;
    });
    supervisor.handleCommand({ type: 'prompt', identity: parent, text: 'follow up' });
    await vi.waitFor(() =>
      expect(parentSession.prompt).toHaveBeenCalledWith('follow up', undefined)
    );
    expect(parentSession.steer).not.toHaveBeenCalled();
  });

  it('idle 投影但 pi 僵尸轮永不空闲：限时后按失败收口，绝不静默 steer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const events: AgentWorkerEvent[] = [];
      const supervisor = new SessionSupervisor({
        emit: (event) => events.push(event),
        agentDir: '/tmp/agent',
        sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-dispatch-')),
      });
      supervisor.handleCommand({
        type: 'spawn-parent',
        identity: parent,
        cwd: '/workspace',
        model,
      });
      await waitFor(events, 'parent-ready');
      const parentSession = mocks.sessions[0] as ReturnType<typeof session>;
      parentSession.isStreaming = true;
      parentSession.waitForIdle = vi.fn(() => new Promise<undefined>(() => {}));
      supervisor.handleCommand({ type: 'prompt', identity: parent, text: 'follow up' });
      await settle();
      expect(parentSession.steer).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      await settle();
      expect(parentSession.steer).not.toHaveBeenCalled();
      expect(parentSession.prompt).not.toHaveBeenCalled();
      expect(events.find((event) => event.type === 'turn-failed')).toBeDefined();
      expect(
        events.find((event) => event.type === 'status' && event.status === 'failed' && event.error)
      ).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  async function spawnParent() {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-dispatch-')),
    });
    supervisor.handleCommand({ type: 'spawn-parent', identity: parent, cwd: '/workspace', model });
    await waitFor(events, 'parent-ready');
    return { events, supervisor, piSession: mocks.sessions[0] as ReturnType<typeof session> };
  }

  /** 受控压缩：waitForIdle 挂到 finish() 才空闲，模拟 pi 的 isIdle 口径 */
  function holdCompaction(piSession: ReturnType<typeof session>, streaming = false) {
    const idle = Promise.withResolvers<undefined>();
    piSession.isCompacting = true;
    piSession.isStreaming = streaming;
    piSession.waitForIdle = vi.fn(() =>
      piSession.isCompacting || piSession.isStreaming ? idle.promise : Promise.resolve(undefined)
    );
    return () => {
      piSession.isCompacting = false;
      piSession.isStreaming = false;
      idle.resolve(undefined);
    };
  }

  it('轮次收束后压缩进行中收到 prompt：等压完再按新轮 prompt，不报错', async () => {
    const { events, supervisor, piSession } = await spawnParent();
    const finish = holdCompaction(piSession);
    supervisor.handleCommand({ type: 'prompt', identity: parent, text: 'queued' });
    await settle();
    expect(piSession.prompt).not.toHaveBeenCalled();

    finish();
    await vi.waitFor(() => expect(piSession.prompt).toHaveBeenCalledWith('queued', undefined));
    expect(events.some((event) => event.type === 'turn-failed')).toBe(false);
  });

  it('pi 自动压缩超过僵尸时限：继续等压完，不按僵尸轮失败', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { events, supervisor, piSession } = await spawnParent();
      const finish = holdCompaction(piSession, true);
      supervisor.handleCommand({ type: 'prompt', identity: parent, text: 'queued' });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(events.some((event) => event.type === 'turn-failed')).toBe(false);
      expect(piSession.prompt).not.toHaveBeenCalled();

      finish();
      await vi.advanceTimersByTimeAsync(10);
      expect(piSession.prompt).toHaveBeenCalledWith('queued', undefined);
    } finally {
      vi.useRealTimers();
    }
  });

  it('空闲后下一个宏任务才启动的记忆压缩：新轮让一拍复查，等压完再发', async () => {
    const { supervisor, piSession } = await spawnParent();
    const idle = Promise.withResolvers<undefined>();
    piSession.isStreaming = true;
    piSession.waitForIdle = vi.fn(async () => {
      if (piSession.isCompacting) return idle.promise;
      // agent_settled：扩展用 setTimeout(0) 延后触发压缩，空闲等待者先被唤醒
      piSession.isStreaming = false;
      setTimeout(() => {
        piSession.isCompacting = true;
      }, 0);
      return undefined;
    });
    supervisor.handleCommand({ type: 'prompt', identity: parent, text: 'after abort' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(piSession.prompt).not.toHaveBeenCalled();

    piSession.isCompacting = false;
    idle.resolve(undefined);
    await vi.waitFor(() => expect(piSession.prompt).toHaveBeenCalledWith('after abort', undefined));
  });

  it('重试倒计时中 abort：pi 不再发 agent_end，按失败收口并放弃排队压缩', async () => {
    const { events, supervisor, piSession } = await spawnParent();
    piSession.emit({ type: 'agent_start' });
    supervisor.handleCommand({ type: 'compact', identity: parent });
    await settle();
    piSession.isRetrying = true;
    events.length = 0;

    supervisor.handleCommand({ type: 'abort', identity: parent });
    await settle();

    expect(piSession.abort).toHaveBeenCalled();
    expect(events.some((event) => event.type === 'turn-failed')).toBe(true);
    expect(
      events.some(
        (event) => event.type === 'compaction' && event.state === 'end' && event.abandoned
      )
    ).toBe(true);
  });

  describe('乐观回显投递回执 delivery-settled', () => {
    async function spawned() {
      const events: AgentWorkerEvent[] = [];
      const supervisor = new SessionSupervisor({
        emit: (event) => events.push(event),
        agentDir: '/tmp/agent',
        sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-dispatch-')),
      });
      supervisor.handleCommand({
        type: 'spawn-parent',
        identity: parent,
        cwd: '/workspace',
        model,
      });
      await waitFor(events, 'parent-ready');
      const piSession = mocks.sessions[0] as ReturnType<typeof session>;
      // 真实 pi 的 prompt 整轮跑完才 resolve，user 消息在此之前上屏
      piSession.prompt.mockImplementation(() => new Promise<undefined>(() => {}));
      const userMessage = (text: string) =>
        piSession.emit({
          type: 'message_start',
          message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1 },
        });
      const settled = () =>
        events.flatMap((event) => (event.type === 'delivery-settled' ? [event.deliveryId] : []));
      return { events, supervisor, piSession, userMessage, settled };
    }

    it.each(['started', 'queued', 'handled', undefined] as const)(
      'prompt 抛错时，仅 preflightResult 从未回调才视为拒收并允许撤回（disposition=%s）',
      async (disposition) => {
        const { events, supervisor, piSession, userMessage } = await spawned();
        piSession.prompt.mockImplementationOnce(async (_text, options) => {
          if (disposition !== undefined) options?.preflightResult?.(disposition);
          if (disposition === 'started' || disposition === 'queued') userMessage('hi');
          throw new Error('send failed');
        });
        supervisor.handleCommand({
          type: 'prompt',
          identity: parent,
          text: 'hi',
          deliveryId: 'd1',
        });
        await settle();
        expect(events.filter((event) => event.type === 'delivery-rejected')).toEqual(
          disposition === undefined
            ? [expect.objectContaining({ identity: parent, deliveryId: 'd1' })]
            : []
        );
        await supervisor.shutdown();
      }
    );

    it('prompt 的 user 消息上屏后回执 deliveryId，且排在该 upsert 之后', async () => {
      const { events, supervisor, userMessage } = await spawned();
      supervisor.handleCommand({ type: 'prompt', identity: parent, text: 'hi', deliveryId: 'd1' });
      await settle();
      userMessage('pi 改写后的 hi');
      const upsert = events.findIndex(
        (event) => event.type === 'message-upsert' && event.message.role === 'user'
      );
      const receipt = events.findIndex((event) => event.type === 'delivery-settled');
      expect(upsert).toBeGreaterThan(-1);
      expect(receipt).toBeGreaterThan(upsert);
      expect(events[receipt]).toMatchObject({ identity: parent, deliveryId: 'd1' });
      await supervisor.shutdown();
    });

    it('新 prompt 的 user 消息先于滞留的 steer；无 id 的投递占位不串号', async () => {
      const { supervisor, userMessage, settled } = await spawned();
      supervisor.handleCommand({ type: 'steer', identity: parent, text: 'late', deliveryId: 's1' });
      supervisor.handleCommand({ type: 'steer', identity: parent, text: 'phone' });
      await settle();
      supervisor.handleCommand({ type: 'prompt', identity: parent, text: 'new', deliveryId: 'p1' });
      await settle();
      userMessage('new');
      userMessage('late');
      userMessage('phone');
      expect(settled()).toEqual(['p1', 's1']);
      await supervisor.shutdown();
    });

    it('pi 拒收的 steer 不占队列位', async () => {
      const { supervisor, piSession, userMessage, settled } = await spawned();
      piSession.steer.mockRejectedValueOnce(new Error('boom'));
      supervisor.handleCommand({ type: 'steer', identity: parent, text: 'bad', deliveryId: 's1' });
      await settle();
      supervisor.handleCommand({ type: 'steer', identity: parent, text: 'ok', deliveryId: 's2' });
      await settle();
      userMessage('ok');
      expect(settled()).toEqual(['s2']);
      await supervisor.shutdown();
    });

    it('用户插话后把本会话前台命令转后台；拒收的插话不转；tool-background 按调用 id 转', async () => {
      const { supervisor, piSession } = await spawned();
      const bg = (supervisor as unknown as { bgTasks: BackgroundTaskManager }).bgTasks;
      const all = vi.spyOn(bg, 'backgroundAllForeground');
      const one = vi.spyOn(bg, 'backgroundForeground');
      piSession.steer.mockRejectedValueOnce(new Error('boom'));
      supervisor.handleCommand({ type: 'steer', identity: parent, text: 'bad' });
      await settle();
      expect(all).not.toHaveBeenCalled();

      supervisor.handleCommand({ type: 'steer', identity: parent, text: 'hey' });
      await settle();
      expect(all).toHaveBeenCalledWith(parent.sessionId, 'steer');

      supervisor.handleCommand({ type: 'tool-background', identity: parent, toolCallId: 'call-1' });
      await settle();
      expect(one).toHaveBeenCalledWith(parent.sessionId, 'call-1', 'user');
      await supervisor.shutdown();
    });

    it('pi input hook 已处理的 steer 不占队列位', async () => {
      const { supervisor, piSession, userMessage, settled } = await spawned();
      piSession.steer.mockResolvedValueOnce('handled');
      supervisor.handleCommand({
        type: 'steer',
        identity: parent,
        text: 'consumed',
        deliveryId: 's1',
      });
      await settle();
      supervisor.handleCommand({
        type: 'steer',
        identity: parent,
        text: 'queued',
        deliveryId: 's2',
      });
      await settle();
      userMessage('queued');
      expect(settled()).toEqual(['s2']);
      await supervisor.shutdown();
    });
  });

  it('worker 中不存在的会话收到 prompt：发 parent-rejected 而非静默丢弃', async () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-dispatch-')),
    });
    supervisor.handleCommand({ type: 'prompt', identity: parent, text: 'hello' });
    await settle();
    const rejected = events.find((event) => event.type === 'parent-rejected');
    expect(rejected).toMatchObject({ identity: parent, seq: 0 });
    expect((rejected as { reason: string }).reason).toContain('parent');

    supervisor.handleCommand({ type: 'prompt', identity: child, text: 'hello' });
    await settle();
    expect(events.find((event) => event.type === 'child-rejected')).toMatchObject({
      identity: child,
      seq: 0,
    });
  });

  it('dismiss-coworker 遥控解雇 worker 直雇 coworker：exact 父代执行，旧代拒绝', async () => {
    // 双形状过渡命令：工具直雇 coworker 不在 Main sessions 索引，
    // Main 只能按 parent.coworkers 映射发裸 id；worker 侧以 exact 父代为门。
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-dispatch-')),
    });
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
    });
    await settle();

    // 旧代拒绝：不得发出 dismissed 回流（否则旧命令能解雇新代的 coworker）
    supervisor.handleCommand({
      type: 'dismiss-coworker',
      parent: { sessionId: parent.sessionId, generation: 'stale-generation' },
      coworkerId: 'parent::cw-bob',
    });
    await settle();
    expect(
      events.some(
        (event) =>
          event.type === 'coworker-update' &&
          (event as { coworker: { status: string } }).coworker.status === 'dismissed'
      )
    ).toBe(false);

    supervisor.handleCommand({
      type: 'dismiss-coworker',
      parent,
      coworkerId: 'parent::cw-bob',
    });
    await settle();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'coworker-update',
        identity: parent,
        coworker: expect.objectContaining({ id: 'parent::cw-bob', status: 'dismissed' }),
      })
    );
  });

  it('resume-coworker 恢复工具直雇 coworker；容量对 resume 豁免，新雇仍卡上限', async () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-dispatch-')),
    });
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
    });
    await waitFor(events, 'parent-ready');

    // 用 resume 灌满 5 个（上限）：若容量对 resume 不豁免，第 6 个就进不来
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      supervisor.handleCommand({
        type: 'resume-coworker',
        parent,
        coworkerId: `parent::cw-${name}`,
        name,
        resumeFile: `/tmp/coworker-${name}.jsonl`,
      });
    }
    await settleUntil(
      () =>
        events.filter(
          (event) =>
            event.type === 'coworker-update' &&
            (event as { coworker: { status: string } }).coworker.status !== 'dismissed'
        ).length >= 5
    );
    const resumed = events.filter(
      (event) =>
        event.type === 'coworker-update' &&
        (event as { coworker: { status: string } }).coworker.status !== 'dismissed'
    );
    expect(resumed).toHaveLength(5);
    expect(resumed[0]).toMatchObject({ coworker: { id: 'parent::cw-a', name: 'a' } });

    // typed child 带 resumeFile：容量已满仍允许恢复（恢复量受关机前存量约束，不是疯雇）
    const typedChild = {
      sessionId: 'parent::cw-typed',
      generation: '88888888-8888-4888-8888-888888888888',
      parent,
      instanceId: '99999999-9999-4999-8999-999999999999',
      instanceName: 'Scout-99999999',
      typeKey: 'builtin:scout' as const,
    };
    const scoutConfig = {
      typeKey: 'builtin:scout' as const,
      displayName: 'Scout',
      description: 'Read-only scout',
      spawnSpecId: 'spawn-scout-resume',
      systemPrompt: 'scout role',
      model,
      tools: 'readonly' as const,
      skillPaths: [],
      skillBindingIds: [],
      mcpServers: [],
      mcpBindingIds: [],
      systemPromptHash: 'scout-hash',
    };
    supervisor.handleCommand({
      type: 'spawn-child',
      identity: typedChild,
      cwd: '/workspace',
      config: scoutConfig,
      resumeFile: '/tmp/typed.jsonl',
    });
    await settle();
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'child-ready', identity: typedChild })
    );

    // 新雇（无 resumeFile）在满员时仍被拒：豁免只给 resume
    const overflow = {
      ...typedChild,
      sessionId: 'parent::cw-overflow',
      generation: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      instanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      instanceName: 'Scout-bbbbbbbb',
    };
    supervisor.handleCommand({
      type: 'spawn-child',
      identity: overflow,
      cwd: '/workspace',
      config: { ...scoutConfig, spawnSpecId: 'spawn-scout-overflow' },
    });
    await settle();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'child-rejected',
        identity: overflow,
        reason: expect.stringContaining('coworker limit'),
      })
    );
  });

  it('set-max-active-coworkers 把新雇上限改成 1', async () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-dispatch-')),
    });
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
    });
    await waitFor(events, 'parent-ready');
    supervisor.handleCommand({ type: 'set-max-active-coworkers', limit: 1 });

    const first = {
      sessionId: 'parent::cw-first',
      generation: '88888888-8888-4888-8888-888888888888',
      parent,
      instanceId: '99999999-9999-4999-8999-999999999999',
      instanceName: 'Scout-99999999',
      typeKey: 'builtin:scout' as const,
    };
    const scoutConfig = {
      typeKey: 'builtin:scout' as const,
      displayName: 'Scout',
      description: 'Read-only scout',
      spawnSpecId: 'spawn-scout-first',
      systemPrompt: 'scout role',
      model,
      tools: 'readonly' as const,
      skillPaths: [],
      skillBindingIds: [],
      mcpServers: [],
      mcpBindingIds: [],
      systemPromptHash: 'scout-hash',
    };
    supervisor.handleCommand({
      type: 'spawn-child',
      identity: first,
      cwd: '/workspace',
      config: scoutConfig,
    });
    await settle();
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'child-ready', identity: first })
    );

    const second = {
      ...first,
      sessionId: 'parent::cw-second',
      generation: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      instanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      instanceName: 'Scout-bbbbbbbb',
    };
    supervisor.handleCommand({
      type: 'spawn-child',
      identity: second,
      cwd: '/workspace',
      config: { ...scoutConfig, spawnSpecId: 'spawn-scout-second' },
    });
    await settle();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'child-rejected',
        identity: second,
        reason: expect.stringContaining('coworker limit reached (1 active)'),
      })
    );
  });

  it('rejects an ordinary exact profile when a configured MCP fails to establish', async () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-dispatch-')),
    });
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
    });
    await waitFor(events, 'parent-ready');
    const identity = {
      sessionId: 'parent::cw-mcp',
      generation: '66666666-6666-4666-8666-666666666666',
      parent,
      instanceId: '77777777-7777-4777-8777-777777777777',
      instanceName: 'Mcp-77777777',
      typeKey: 'builtin:worker' as const,
    };
    supervisor.handleCommand({
      type: 'spawn-child',
      identity,
      cwd: '/workspace',
      config: {
        typeKey: 'builtin:worker',
        displayName: 'Worker',
        description: 'Worker with MCP',
        spawnSpecId: 'spawn-mcp',
        systemPrompt: 'worker role',
        model,
        tools: 'all',
        skillPaths: [],
        skillBindingIds: [],
        mcpServers: [{ name: 'required', transport: 'stdio', command: 'missing' }],
        mcpBindingIds: ['mcp-binding'],
        systemPromptHash: 'mcp-hash',
      },
    });
    await waitFor(events, 'child-rejected');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'child-rejected',
        identity,
        reason: expect.stringContaining('MCP resource failed to establish'),
      })
    );
    expect(mocks.createAgentSession).toHaveBeenCalledTimes(1);
  });
});

describe('SessionSupervisor idle eviction', () => {
  beforeEach(() => {
    mocks.sessions.length = 0;
    mocks.managers.length = 0;
    mocks.createAgentSession.mockReset();
    rmSync(path.join(tmpdir(), 'enso-dispatch-sessions'), { recursive: true, force: true });
    mocks.mcpToolsFor.mockReset().mockResolvedValue([]);
    mocks.createAgentSession.mockImplementation(async (options: Record<string, unknown>) => ({
      session: session(options),
    }));
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  });

  it('releases an idle unpinned parent after the TTL and keeps the pinned one', async () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-dispatch-')),
    });
    const other = { sessionId: 'other', generation: '44444444-4444-4444-8444-444444444444' };
    supervisor.handleCommand({ type: 'spawn-parent', identity: parent, cwd: '/w', model });
    supervisor.handleCommand({ type: 'spawn-parent', identity: other, cwd: '/w', model });
    await settleUntil(() => events.filter((event) => event.type === 'parent-ready').length >= 2);
    supervisor.handleCommand({ type: 'pin-sessions', sessionIds: ['other'] });

    await vi.advanceTimersByTimeAsync(31 * 60_000);
    await settle();

    const ended = events.filter((event) => event.type === 'parent-ended');
    expect(ended).toEqual([
      expect.objectContaining({ type: 'parent-ended', identity: parent, reason: 'evicted' }),
    ]);
    expect((mocks.sessions[0] as ReturnType<typeof session>).dispose).toHaveBeenCalled();
    expect((mocks.sessions[1] as ReturnType<typeof session>).dispose).not.toHaveBeenCalled();
    await supervisor.shutdown();
    vi.useRealTimers();
  });

  it('a running turn resets the idle clock', async () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-dispatch-')),
    });
    supervisor.handleCommand({ type: 'spawn-parent', identity: parent, cwd: '/w', model });
    await waitFor(events, 'parent-ready');
    const parentSession = mocks.sessions[0] as ReturnType<typeof session>;

    await vi.advanceTimersByTimeAsync(20 * 60_000);
    parentSession.emit({ type: 'agent_start' });
    parentSession.emit({ type: 'agent_end', messages: [] });
    parentSession.emit({ type: 'agent_settled' });
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    await settle();
    expect(events.filter((event) => event.type === 'parent-ended')).toEqual([]);

    await vi.advanceTimersByTimeAsync(11 * 60_000);
    await settle();
    expect(events.filter((event) => event.type === 'parent-ended')).toHaveLength(1);
    await supervisor.shutdown();
    vi.useRealTimers();
  });
});

describe('SessionSupervisor custom parent system prompt', () => {
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

  it('未配置自定义角色时完全沿用 pi 默认提示词组装', async () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-dispatch-default-persona-')),
    });
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
    });
    await waitFor(events, 'parent-ready');

    const options = mocks.loaderOptions.at(-1);
    expect(options?.systemPrompt).toBeUndefined();
    expect(options?.systemPromptOverride).toBeUndefined();
    expect(applyCustomPersona(options, DEFAULT_PERSONA_PROMPT)).toBe(DEFAULT_PERSONA_PROMPT);
    await supervisor.shutdown();
  });

  it('路径字面量仅替换开头角色段落，并保留 pi 动态工具与全部后缀', async () => {
    const events: AgentWorkerEvent[] = [];
    const sessionDir = mkdtempSync(path.join(tmpdir(), 'enso-dispatch-literal-system-prompt-'));
    const promptThatLooksLikePath = path.join(sessionDir, 'sensitive.txt');
    writeFileSync(promptThatLooksLikePath, 'sensitive file contents');
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir,
    });
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
      systemPrompt: promptThatLooksLikePath,
    } as AgentCommand);
    await waitFor(events, 'parent-ready');

    const options = mocks.loaderOptions.at(-1);
    expect(options?.systemPrompt).toBeUndefined();
    expect(options?.systemPromptOverride).toBeUndefined();
    const suffix = [
      'Available tools:',
      '- dynamic_runtime_tool: Added by pi at runtime',
      '',
      'Guidelines:',
      '- Keep dynamic guidance',
      '',
      '<project_context>project rules</project_context>',
      '',
      'Current working directory: /workspace',
    ].join('\n');
    expect(applyCustomPersona(options, `${DEFAULT_PERSONA_PROMPT}\n\n${suffix}`)).toBe(
      `${promptThatLooksLikePath}\n\n${suffix}`
    );
    await supervisor.shutdown();
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it('自定义角色扩展只挂普通 parent，不进入 locked Enso 或 typed child', async () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-dispatch-system-prompt-')),
    });
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
      systemPrompt: 'custom parent base',
    } as AgentCommand);
    await waitFor(events, 'parent-ready');
    const parentLoader = mocks.loaderOptions.at(-1);
    expect(parentLoader?.systemPromptOverride).toBeUndefined();
    expect(applyCustomPersona(parentLoader, DEFAULT_PERSONA_PROMPT)).toBe('custom parent base');
    // 强制提示词会冻结后续扩展对 systemPromptOptions 的修改，必须最后执行
    const factories = parentLoader?.extensionFactories as Array<{ name?: string }>;
    expect(factories.at(-1)?.name).toBe('custom-persona');

    supervisor.handleCommand({
      type: 'spawn-child',
      identity: child,
      cwd: '/workspace',
      config: {
        typeKey: 'agent:enso',
        displayName: 'Enso',
        description: 'System Agent',
        spawnSpecId: 'spawn-enso-system-prompt',
        systemPrompt: 'locked role prompt',
        model,
        tools: 'enso-locked',
        skillPaths: [],
        skillBindingIds: [],
        mcpServers: [],
        mcpBindingIds: [],
        systemPromptHash: 'enso-hash',
        lockedProfileId: 'enso-locked-v1',
      },
    });
    await waitFor(events, 'child-ready');
    const lockedLoader = mocks.loaderOptions.at(-1);
    expect(lockedLoader?.systemPrompt).toBeTruthy();
    expect(applyCustomPersona(lockedLoader, DEFAULT_PERSONA_PROMPT)).toBe(DEFAULT_PERSONA_PROMPT);

    supervisor.handleCommand({
      type: 'spawn-child',
      identity: {
        sessionId: 'parent::cw-reviewer',
        generation: '44444444-4444-4444-8444-444444444444',
        parent,
        instanceId: '55555555-5555-4555-8555-555555555555',
        instanceName: 'Reviewer-55555555',
        typeKey: 'builtin:reviewer',
      },
      cwd: '/workspace',
      config: {
        typeKey: 'builtin:reviewer',
        displayName: 'Reviewer',
        description: 'Review Agent',
        spawnSpecId: 'spawn-reviewer-system-prompt',
        systemPrompt: 'typed child role prompt',
        model,
        tools: 'readonly',
        skillPaths: [],
        skillBindingIds: [],
        mcpServers: [],
        mcpBindingIds: [],
        systemPromptHash: 'reviewer-hash',
      },
    });
    await settleUntil(() => events.filter((event) => event.type === 'child-ready').length === 2);
    const typedChildLoader = mocks.loaderOptions.at(-1);
    expect(typedChildLoader?.systemPrompt).toBeUndefined();
    expect(applyCustomPersona(typedChildLoader, DEFAULT_PERSONA_PROMPT)).toBe(
      DEFAULT_PERSONA_PROMPT
    );
    await supervisor.shutdown();
  });
});
