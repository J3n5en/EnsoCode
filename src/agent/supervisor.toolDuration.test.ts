import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AgentWorkerEvent, ProjectedMessage } from '@shared/types/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    messages: [] as unknown[],
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
    compact: vi.fn(async () => undefined),
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

async function waitFor(events: AgentWorkerEvent[], type: AgentWorkerEvent['type']): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (events.some((event) => event.type === type)) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${type}`);
}

function assistantWithTools(
  ...calls: Array<{ id: string; name: string }>
): Record<string, unknown> {
  return {
    role: 'assistant',
    content: calls.map((call) => ({
      type: 'toolCall',
      id: call.id,
      name: call.name,
      arguments: {},
    })),
  };
}

function toolResult(id: string, name: string): Record<string, unknown> {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: name,
    isError: false,
    content: [{ type: 'text', text: `${name} done` }],
  };
}

function lastUpsert(
  events: AgentWorkerEvent[],
  toolCallId: string
): Extract<AgentWorkerEvent, { type: 'message-upsert' }> {
  const upserts = events.filter(
    (event): event is Extract<AgentWorkerEvent, { type: 'message-upsert' }> =>
      event.type === 'message-upsert' &&
      event.message.role === 'toolResult' &&
      event.message.toolCallId === toolCallId
  );
  const last = upserts.at(-1);
  if (!last) throw new Error(`missing toolResult upsert for ${toolCallId}`);
  return last;
}

describe('SessionSupervisor tool duration', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    mocks.sessions.length = 0;
    mocks.managers.length = 0;
    mocks.createAgentSession.mockReset();
    rmSync(path.join(tmpdir(), 'enso-tool-duration-sessions'), { recursive: true, force: true });
    mocks.mcpToolsFor.mockReset().mockResolvedValue([]);
    mocks.createAgentSession.mockImplementation(async (options: Record<string, unknown>) => ({
      session: session(options),
    }));
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  it('串行工具各自只记 tool_execution_start/end，不把排队时间算进去', async () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-tool-duration-')),
    });
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
    });
    await vi.runAllTimersAsync();
    await waitFor(events, 'parent-ready');
    const parentSession = mocks.sessions[0] as ReturnType<typeof session>;

    parentSession.emit({ type: 'message_start', message: assistantWithTools() });
    parentSession.emit({
      type: 'message_update',
      message: assistantWithTools({ id: 'bash-1', name: 'bash' }, { id: 'write-1', name: 'write' }),
    });
    parentSession.emit({
      type: 'message_end',
      message: assistantWithTools({ id: 'bash-1', name: 'bash' }, { id: 'write-1', name: 'write' }),
    });

    parentSession.emit({
      type: 'tool_execution_start',
      toolCallId: 'bash-1',
      toolName: 'bash',
      args: { command: 'sleep 400', timeout: 900 },
    });
    const bashStart = events.find(
      (event): event is Extract<AgentWorkerEvent, { type: 'tool-output' }> =>
        event.type === 'tool-output' && event.toolCallId === 'bash-1'
    );
    // 前台命令带截止时间：renderer 的无输出巡检据此不误杀静默长命令
    expect(bashStart).toMatchObject({
      toolCallId: 'bash-1',
      startedAt: 1_000_000,
      deadlineAt: 1_900_000,
      output: '',
    });

    vi.setSystemTime(1_005_000);
    parentSession.messages.push(
      assistantWithTools({ id: 'bash-1', name: 'bash' }, { id: 'write-1', name: 'write' }),
      toolResult('bash-1', 'bash')
    );
    parentSession.emit({
      type: 'tool_execution_end',
      toolCallId: 'bash-1',
      toolName: 'bash',
    });
    parentSession.emit({ type: 'message_start', message: toolResult('bash-1', 'bash') });

    parentSession.emit({
      type: 'tool_execution_start',
      toolCallId: 'write-1',
      toolName: 'write',
    });
    const writeStart = events.find(
      (event): event is Extract<AgentWorkerEvent, { type: 'tool-output' }> =>
        event.type === 'tool-output' && event.toolCallId === 'write-1'
    );
    expect(writeStart).toMatchObject({ toolCallId: 'write-1', startedAt: 1_005_000, output: '' });
    expect(writeStart).not.toHaveProperty('deadlineAt');

    vi.setSystemTime(1_005_200);
    parentSession.messages.push(toolResult('write-1', 'write'));
    parentSession.emit({
      type: 'tool_execution_end',
      toolCallId: 'write-1',
      toolName: 'write',
    });
    parentSession.emit({ type: 'message_start', message: toolResult('write-1', 'write') });

    expect((lastUpsert(events, 'bash-1').message as ProjectedMessage).toolDurationMs).toBe(5_000);
    expect((lastUpsert(events, 'write-1').message as ProjectedMessage).toolDurationMs).toBe(200);
    await supervisor.shutdown();
  });

  it('assistant step 从 turn_start 起算，TTFT 含等待响应头的时间', async () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-step-timing-')),
    });
    supervisor.handleCommand({ type: 'spawn-parent', identity: parent, cwd: '/workspace', model });
    await vi.runAllTimersAsync();
    await waitFor(events, 'parent-ready');
    const parentSession = mocks.sessions[0] as ReturnType<typeof session>;
    const text = { role: 'assistant', content: [{ type: 'text', text: 'hi' }] };

    parentSession.emit({ type: 'turn_start' });
    // pi-ai 收到响应头后才推 start，紧接着就是首个 delta
    vi.setSystemTime(1_002_000);
    parentSession.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    vi.setSystemTime(1_002_010);
    parentSession.emit({ type: 'message_update', message: text });
    vi.setSystemTime(1_003_000);
    parentSession.emit({ type: 'message_end', message: text });

    const upsert = events
      .filter(
        (event): event is Extract<AgentWorkerEvent, { type: 'message-upsert' }> =>
          event.type === 'message-upsert' && event.message.role === 'assistant'
      )
      .at(-1);
    expect(upsert?.message.timing).toMatchObject({
      stepStartMs: 1_000_000,
      firstTokenMs: 1_002_010,
      completedMs: 1_003_000,
    });
    await supervisor.shutdown();
  });
});
