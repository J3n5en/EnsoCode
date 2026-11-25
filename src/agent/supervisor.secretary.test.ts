import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { SECRETARY_TOOL_ALLOWLIST } from '@shared/secretary/tools';
import type { AgentCommand, AgentWorkerEvent } from '@shared/types/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
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
    return {
      getBranch: vi.fn(() => branch),
      appendCustomEntry: vi.fn(() => `entry-${branch.length}`),
      buildSessionContext: vi.fn(() => ({ messages: [] })),
    };
  };
  const runtime = {
    models: new Map<string, Record<string, unknown>>(),
    registerProvider(providerId: string, config: { models?: Record<string, unknown>[] }) {
      for (const model of config.models ?? [])
        this.models.set(`${providerId}/${model.id}`, { ...model, provider: providerId });
    },
    getModel(providerId: string, modelId: string) {
      return this.models.get(`${providerId}/${modelId}`);
    },
    getModels() {
      return [...this.models.values()];
    },
    resolveModel: vi
      .fn<ModelRuntime['resolveModel']>()
      .mockRejectedValue(new Error('Unexpected virtual model routing in secretary fixture')),
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
  sessionId: 'secretary',
  generation: '11111111-1111-4111-8111-111111111111',
};
const model = {
  api: 'openai-completions' as const,
  baseUrl: 'https://example.test/v1',
  apiKey: 'secret',
  modelId: 'model',
  settingsProviderId: 'settings-provider',
};

function session(options: Record<string, unknown>) {
  const activeTools = ((options.customTools as Array<{ name: string }> | undefined) ?? []).map(
    (tool) => tool.name
  );
  const value = {
    model: options.model,
    resourceLoader: options.resourceLoader,
    sessionManager: options.sessionManager,
    messages: [],
    sessionFile: `/tmp/secretary-${mocks.sessions.length}.jsonl`,
    subscribe: vi.fn(() => () => undefined),
    prompt: vi.fn(
      async (_text: string, options?: { preflightResult?: (disposition: string) => void }) => {
        options?.preflightResult?.('started');
      }
    ),
    abort: vi.fn(async () => undefined),
    waitForIdle: vi.fn(async () => undefined),
    dispose: vi.fn(),
    setThinkingLevel: vi.fn(),
    activeTools,
    getActiveToolNames() {
      return [...activeTools];
    },
    setActiveToolsByName(names: string[]) {
      activeTools.splice(0, activeTools.length, ...names);
    },
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

/** 会话里实际注册的工具名：customTools 加扩展工厂注册的工具（codemode 走扩展，不在 customTools 里） */
function visibleToolNames(): string[] {
  const options = mocks.createAgentSession.mock.calls.at(-1)?.[0] as
    | Record<string, unknown>
    | undefined;
  const names = ((options?.customTools as Array<{ name: string }> | undefined) ?? []).map(
    (tool) => tool.name
  );
  const factories = mocks.loaderOptions.at(-1)?.extensionFactories as
    | Array<{ name?: string; factory(pi: unknown): void }>
    | undefined;
  for (const factory of factories ?? []) {
    if (factory.name !== 'enso-codemode') continue;
    factory.factory({
      registerTool: (tool: { name: string }) => names.push(tool.name),
      getSettings: () => ({}),
      getAllTools: () => [],
      appendEntry: () => undefined,
      on: () => undefined,
    });
  }
  return names;
}

async function spawnSecretary(
  events: AgentWorkerEvent[],
  extra: Partial<Extract<AgentCommand, { type: 'spawn-parent' }>> = {}
): Promise<void> {
  const supervisor = new SessionSupervisor({
    emit: (event) => events.push(event),
    agentDir: path.join(tmpdir(), 'enso-secretary-agent'),
    sessionDir: path.join(tmpdir(), 'enso-secretary-sessions'),
  });
  try {
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
      secretaryMode: true,
      ...extra,
    });
    await waitFor(events, 'parent-ready');
  } finally {
    await supervisor.shutdown();
  }
}

describe('SessionSupervisor secretary tool loadout', () => {
  beforeEach(() => {
    mocks.sessions.length = 0;
    mocks.loaderOptions.length = 0;
    mocks.createAgentSession.mockReset();
    mocks.mcpToolsFor.mockReset().mockResolvedValue([]);
    mocks.mcpResolve.mockReset();
    mocks.createAgentSession.mockImplementation(async (options: Record<string, unknown>) => ({
      session: session(options),
    }));
  });

  it('只装配白名单工具，核心工具与内置分组一个都不出现', async () => {
    const events: AgentWorkerEvent[] = [];
    await spawnSecretary(events);
    const names = visibleToolNames();
    expect(new Set(names)).toEqual(new Set(SECRETARY_TOOL_ALLOWLIST));
    // 磁盘扩展能自行 registerTool，绕过按名字的允许列表
    expect(mocks.loaderOptions.at(-1)?.noExtensions).toBe(true);
    for (const banned of [
      'bash',
      'read',
      'grep',
      'find',
      'ls',
      'apply_patch',
      'codemode',
      'subagent',
      'workflow',
      'browser_open',
      'computer',
      'todo',
      'submit_plan',
      'image_gen',
      'task_run',
      'turn_discard',
      'goal_set',
    ])
      expect(names, banned).not.toContain(banned);
  });

  it('只放行 Main 本次下发的插件工具，MCP 工具对秘书仍不可见', async () => {
    const events: AgentWorkerEvent[] = [];
    mocks.mcpToolsFor.mockResolvedValue([
      {
        name: 'mcp_github_comment',
        label: 'x',
        description: 'x',
        parameters: {},
        execute: vi.fn(),
      },
    ]);
    await spawnSecretary(events, {
      mcpServers: [{ name: 'github', transport: 'stdio', command: 'gh-mcp' }],
      pluginTools: [
        {
          name: 'plugin_enso-tgclient__tg_send_message',
          description: 'send',
          parameters: { type: 'object', properties: {} },
          pluginId: 'enso.tgclient',
        },
      ],
    });
    const names = visibleToolNames();
    expect(names).toContain('plugin_enso-tgclient__tg_send_message');
    expect(names).not.toContain('mcp_github_comment');
    expect(names).not.toContain('plugin_enso-tgclient__tg_watch');
    expect(new Set(names)).toEqual(
      new Set([...SECRETARY_TOOL_ALLOWLIST, 'plugin_enso-tgclient__tg_send_message'])
    );
  });

  it('运行时恢复内置工具组后，插件工具仍在、白名单外的名字进不来', async () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: path.join(tmpdir(), 'enso-secretary-agent'),
      sessionDir: path.join(tmpdir(), 'enso-secretary-sessions'),
    });
    try {
      supervisor.handleCommand({
        type: 'spawn-parent',
        identity: parent,
        cwd: '/workspace',
        model,
        secretaryMode: true,
        pluginTools: [
          {
            name: 'plugin_x__echo',
            description: 'echo',
            parameters: { type: 'object', properties: {} },
            pluginId: 'x',
            readOnly: true,
          },
        ],
      });
      await waitFor(events, 'parent-ready');
      supervisor.handleCommand({ type: 'set-builtin-tools', identity: parent, disabledTools: [] });
      await settle();
      const active = (
        mocks.sessions[0] as unknown as { getActiveToolNames(): string[] }
      ).getActiveToolNames();
      expect(active).toContain('plugin_x__echo');
      for (const name of active)
        expect(SECRETARY_TOOL_ALLOWLIST.has(name) || name === 'plugin_x__echo', name).toBe(true);
    } finally {
      await supervisor.shutdown();
    }
  });

  it('运行时恢复内置工具组后激活名仍是白名单子集', async () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: path.join(tmpdir(), 'enso-secretary-agent'),
      sessionDir: path.join(tmpdir(), 'enso-secretary-sessions'),
    });
    try {
      supervisor.handleCommand({
        type: 'spawn-parent',
        identity: parent,
        cwd: '/workspace',
        model,
        secretaryMode: true,
      });
      await waitFor(events, 'parent-ready');
      supervisor.handleCommand({ type: 'set-builtin-tools', identity: parent, disabledTools: [] });
      await settle();
      const active = (
        mocks.sessions[0] as unknown as { getActiveToolNames(): string[] }
      ).getActiveToolNames();
      expect(active.length).toBeGreaterThan(0);
      for (const name of active) expect(SECRETARY_TOOL_ALLOWLIST.has(name), name).toBe(true);
    } finally {
      await supervisor.shutdown();
    }
  });

  it('非秘书会话照旧拿到核心工具与内置分组，白名单只作用于秘书', async () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: path.join(tmpdir(), 'enso-secretary-agent'),
      sessionDir: path.join(tmpdir(), 'enso-secretary-sessions'),
    });
    try {
      supervisor.handleCommand({
        type: 'spawn-parent',
        identity: parent,
        cwd: '/workspace',
        model,
      });
      await waitFor(events, 'parent-ready');
      const names = visibleToolNames();
      expect(names).toContain('read');
      expect(names).toContain('todo');
      expect(names).toContain('codemode');
    } finally {
      await supervisor.shutdown();
    }
  });
});
