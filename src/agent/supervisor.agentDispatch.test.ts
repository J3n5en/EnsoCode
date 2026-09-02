import { rmSync } from 'node:fs';
import type { AgentCommand, AgentWorkerEvent } from '@shared/types/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
  managers: [] as Array<Record<string, unknown>>,
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
    refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
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
    prompt: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    dispose: vi.fn(),
    setThinkingLevel: vi.fn(),
    navigateTree: vi.fn(async () => ({ cancelled: false })),
    isStreaming: false,
    isRetrying: false,
  };
  mocks.sessions.push(value);
  return value;
}

async function settle(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  await promise;
}

describe('SessionSupervisor deterministic child lifecycle', () => {
  beforeEach(() => {
    mocks.sessions.length = 0;
    mocks.managers.length = 0;
    mocks.createAgentSession.mockReset();
    rmSync('/tmp/sessions', { recursive: true, force: true });
    mocks.mcpToolsFor.mockReset().mockResolvedValue([]);
    mocks.createAgentSession.mockImplementation(async (options: Record<string, unknown>) => ({
      session: session(options),
    }));
  });

  it('emits real parent/child ready, enforces locked tools, and prompts the child exactly once', async () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: '/tmp/sessions',
    });
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
    });
    await settle();
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
    await settle();
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
    await settle();
    expect(childSession.prompt).toHaveBeenCalledOnce();
    expect(childSession.prompt).toHaveBeenCalledWith(
      '<role>\nlocked\n</role>\n\nchild-only task',
      undefined
    );
    expect(parentSession.prompt).not.toHaveBeenCalled();
  });

  it('persists custom entries outside buildSessionContext and restores them in snapshot', async () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: '/tmp/sessions',
    });
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
    });
    await settle();
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
  });

  it('keeps ordinary coding prompts unchanged and only explicit message_main enters parent context', async () => {
    const supervisor = new SessionSupervisor({
      emit: vi.fn(),
      agentDir: '/tmp/agent',
      sessionDir: '/tmp/sessions',
    });
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
    });
    await settle();
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
    const messageMain = childOptions.customTools.find((tool) => tool.name === 'message_main_agent');

    expect(messageMain).toBeDefined();
    await messageMain!.execute('call', { message: 'explicit handoff', urgent: true });
    expect(parentSession.prompt).toHaveBeenCalledWith(expect.stringContaining('explicit handoff'));
  });

  it('idle 投影但 pi 仍在 streaming 时 prompt 改走 steer，避免 AgentBusyError', async () => {
    const supervisor = new SessionSupervisor({
      emit: vi.fn(),
      agentDir: '/tmp/agent',
      sessionDir: '/tmp/sessions',
    });
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
    });
    await settle();
    const parentSession = mocks.sessions[0] as ReturnType<typeof session>;
    parentSession.isStreaming = true;
    supervisor.handleCommand({ type: 'prompt', identity: parent, text: 'follow up' });
    await settle();
    expect(parentSession.steer).toHaveBeenCalledWith('follow up', undefined);
    expect(parentSession.prompt).not.toHaveBeenCalled();
  });

  it('dismiss-coworker 遥控解雇 worker 直雇 coworker：exact 父代执行，旧代拒绝', async () => {
    // 双形状过渡命令：工具直雇 coworker 不在 Main sessions 索引，
    // Main 只能按 parent.coworkers 映射发裸 id；worker 侧以 exact 父代为门。
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: '/tmp/sessions',
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
      sessionDir: '/tmp/sessions',
    });
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
    });
    await settle();

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
    await settle();
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

  it('rejects an ordinary exact profile when a configured MCP fails to establish', async () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: '/tmp/sessions',
    });
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
    });
    await settle();
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
    await settle();
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
    rmSync('/tmp/sessions', { recursive: true, force: true });
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
      sessionDir: '/tmp/sessions',
    });
    const other = { sessionId: 'other', generation: '44444444-4444-4444-8444-444444444444' };
    supervisor.handleCommand({ type: 'spawn-parent', identity: parent, cwd: '/w', model });
    supervisor.handleCommand({ type: 'spawn-parent', identity: other, cwd: '/w', model });
    await settle();
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
      sessionDir: '/tmp/sessions',
    });
    supervisor.handleCommand({ type: 'spawn-parent', identity: parent, cwd: '/w', model });
    await settle();
    const parentSession = mocks.sessions[0] as ReturnType<typeof session>;

    await vi.advanceTimersByTimeAsync(20 * 60_000);
    parentSession.emit({ type: 'agent_start' });
    parentSession.emit({ type: 'agent_end', messages: [] });
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
