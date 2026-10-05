import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AgentWorkerEvent } from '@shared/types/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SilentTurnKind } from './silentTurn';

const mocks = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
  managers: [] as Array<Record<string, unknown>>,
  mcpToolsFor: vi.fn(),
  createAgentSession: vi.fn(),
  recoveryCallbacks: [] as Array<(kind: SilentTurnKind) => void>,
}));

vi.mock('./sessionAdapter', async (importOriginal) => {
  const original = await importOriginal<typeof import('./sessionAdapter')>();
  return {
    ...original,
    silentTurnRecoveryExtension(onRecovery: (kind: SilentTurnKind) => void) {
      mocks.recoveryCallbacks.push(onRecovery);
      return original.silentTurnRecoveryExtension(onRecovery);
    },
  };
});

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
    constructor(readonly options: { extensionFactories?: Array<{ name?: string }> }) {}
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
  const agentState = {
    messages: [] as unknown[],
    get systemPrompt() {
      const extra = this.messages.flatMap((message) =>
        typeof message === 'object' &&
        message !== null &&
        'role' in message &&
        message.role === 'system' &&
        'content' in message &&
        typeof message.content === 'string'
          ? [message.content]
          : []
      );
      return ['base system', ...extra].join('\n\n');
    },
  };
  const agent = {
    state: agentState,
    continue: vi.fn(async () => {
      agent.promptAtContinue = agentState.systemPrompt;
    }),
    promptAtContinue: undefined as string | undefined,
  };
  const value = {
    model: options.model,
    resourceLoader: options.resourceLoader,
    sessionManager: options.sessionManager,
    sessionFile: `/tmp/session-${mocks.sessions.length}.jsonl`,
    agent,
    get messages() {
      return agentState.messages;
    },
    set messages(next: unknown[]) {
      agentState.messages = next;
    },
    subscribe: vi.fn((listener: (event: { type: string; [key: string]: unknown }) => void) => {
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
    isIdle: true,
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

describe('SessionSupervisor terminal turn handling', () => {
  let sessionDir = '';

  beforeEach(() => {
    mocks.sessions.length = 0;
    mocks.managers.length = 0;
    mocks.recoveryCallbacks.length = 0;
    mocks.createAgentSession.mockReset();
    mocks.mcpToolsFor.mockReset().mockResolvedValue([]);
    sessionDir = mkdtempSync(path.join(tmpdir(), 'enso-silent-'));
    mocks.createAgentSession.mockImplementation(async (options: Record<string, unknown>) => ({
      session: session(options),
    }));
  });

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true });
  });

  async function spawn(): Promise<{
    events: AgentWorkerEvent[];
    supervisor: SessionSupervisor;
    parentSession: ReturnType<typeof session>;
  }> {
    const events: AgentWorkerEvent[] = [];
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
    });
    await waitFor(events, 'parent-ready');
    return { events, supervisor, parentSession: mocks.sessions[0] as ReturnType<typeof session> };
  }

  it('有正文或 toolCall 的轮次不触发恢复', async () => {
    const { events, supervisor, parentSession } = await spawn();
    parentSession.emit({ type: 'agent_start' });
    await settle();
    parentSession.messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
    });
    parentSession.emit({ type: 'agent_end', willRetry: false });
    parentSession.emit({ type: 'agent_settled' });
    await settle();
    expect(parentSession.agent.continue).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'turn-completed')).toBe(true);

    await supervisor.shutdown();
  });

  it('手动重试由SDK结算：agent_end不人工收口，唯一agent_settled后idle', async () => {
    const { events, supervisor, parentSession } = await spawn();
    Object.assign(mocks.managers[0]!, {
      buildSessionProjection: vi.fn(() => ({ entries: [] })),
    });
    parentSession.messages.push({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
    const finish = Promise.withResolvers<void>();
    const run = vi.fn(async (messages: unknown[]) => {
      expect(messages).toEqual([]);
      parentSession.emit({ type: 'agent_start' });
      parentSession.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] });
      parentSession.emit({ type: 'agent_end', willRetry: false });
      await finish.promise;
      parentSession.emit({ type: 'agent_settled' });
    });
    Object.assign(parentSession, { _runAgentPrompt: run });

    supervisor.handleCommand({ type: 'retry', identity: parent });
    await settle();
    expect(events.filter((event) => event.type === 'turn-completed')).toHaveLength(0);
    finish.resolve();
    await waitFor(events, 'turn-completed');
    expect(run).toHaveBeenCalledTimes(1);
    expect(parentSession.agent.continue).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === 'turn-completed')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'status').at(-1)).toMatchObject({
      status: 'idle',
    });

    await supervisor.shutdown();
  });

  it('compaction/branch summary等非idle状态拒绝retry，不编辑上下文', async () => {
    const { supervisor, parentSession } = await spawn();
    const projection = vi.fn(() => ({ entries: [] }));
    Object.assign(mocks.managers[0]!, { buildSessionProjection: projection });
    parentSession.isIdle = false;
    supervisor.handleCommand({ type: 'retry', identity: parent });
    await settle();
    expect(projection).not.toHaveBeenCalled();
    expect(parentSession.agent.continue).not.toHaveBeenCalled();
    await supervisor.shutdown();
  });

  it('手动重试再遇限流：由 SDK 重试并在最终失败时收口', async () => {
    const { events, supervisor, parentSession } = await spawn();
    Object.assign(mocks.managers[0]!, {
      buildSessionProjection: vi.fn(() => ({
        entries: parentSession.messages.map((message, index) => ({
          sourceEntry: { type: 'message', id: `m${index}`, message },
          messages: [message],
        })),
      })),
    });
    parentSession.messages.push({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
    Object.assign(parentSession, {
      _runAgentPrompt: vi.fn(async () => {
        parentSession.emit({ type: 'agent_start' });
        parentSession.messages.push({
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: '429 rate limited',
        });
        parentSession.emit({ type: 'agent_end', willRetry: false });
        parentSession.emit({ type: 'agent_settled' });
      }),
    });

    supervisor.handleCommand({ type: 'retry', identity: parent });
    await waitFor(events, 'turn-failed');
    expect(events.find((event) => event.type === 'turn-failed')).toMatchObject({
      error: '429 rate limited',
    });
    expect(events.filter((event) => event.type === 'status').at(-1)).toMatchObject({
      status: 'failed',
    });
    expect(events.some((event) => event.type === 'messages-truncated')).toBe(false);

    await supervisor.shutdown();
  });

  it('agent_end 后 pi 续跑（排队消息/扩展续跑）：等 agent_settled 才收口，全程同一轮', async () => {
    const { events, supervisor, parentSession } = await spawn();
    parentSession.emit({ type: 'agent_start' });
    parentSession.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'a' }] });
    parentSession.emit({ type: 'agent_end', willRetry: false });
    await settle();
    expect(events.some((event) => event.type === 'turn-completed')).toBe(false);
    expect(events.filter((event) => event.type === 'status').at(-1)).toMatchObject({
      status: 'running',
    });

    parentSession.emit({ type: 'agent_start' });
    parentSession.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'b' }] });
    parentSession.emit({ type: 'agent_end', willRetry: false });
    parentSession.emit({ type: 'agent_settled' });
    await settle();
    const statuses = events.filter((event) => event.type === 'status').map((e) => e.status);
    expect(statuses.slice(statuses.indexOf('running'))).toEqual(['running', 'running', 'idle']);
    expect(events.filter((event) => event.type === 'turn-completed')).toHaveLength(1);

    await supervisor.shutdown();
  });

  it('上下文溢出错误后 pi 压缩并续跑成功：不先报失败', async () => {
    const { events, supervisor, parentSession } = await spawn();
    parentSession.emit({ type: 'agent_start' });
    parentSession.messages.push({
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'prompt is too long: context length exceeded',
    });
    parentSession.emit({ type: 'agent_end', willRetry: false });
    await settle();
    expect(events.some((event) => event.type === 'turn-failed')).toBe(false);

    parentSession.messages.length = 0;
    parentSession.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] });
    parentSession.emit({ type: 'agent_start' });
    parentSession.emit({ type: 'agent_end', willRetry: false });
    parentSession.emit({ type: 'agent_settled' });
    await settle();
    expect(events.some((event) => event.type === 'turn-failed')).toBe(false);
    expect(events.filter((event) => event.type === 'turn-completed')).toHaveLength(1);

    await supervisor.shutdown();
  });

  it('用户中断：agent_end/agent_settled 回流只收一次轮次终态（renderer 靠它清中断标记）', async () => {
    const { events, supervisor, parentSession } = await spawn();
    parentSession.emit({ type: 'agent_start' });
    await settle();
    supervisor.handleCommand({ type: 'abort', identity: parent });
    await settle();
    parentSession.messages.push({ role: 'assistant', content: [], stopReason: 'aborted' });
    parentSession.emit({ type: 'agent_end', willRetry: false });
    parentSession.emit({ type: 'agent_settled' });
    await settle();
    const terminal = events.filter(
      (event) => event.type === 'turn-completed' || event.type === 'turn-failed'
    );
    expect(terminal).toHaveLength(1);

    await supervisor.shutdown();
  });

  it('重试倒计时中中断：已按失败收口，随后的 agent_settled 不再补发完成', async () => {
    const { events, supervisor, parentSession } = await spawn();
    parentSession.emit({ type: 'agent_start' });
    parentSession.messages.push({ role: 'assistant', content: [], stopReason: 'error' });
    parentSession.emit({ type: 'agent_end', willRetry: true });
    parentSession.emit({
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1000,
      errorMessage: '503',
    });
    parentSession.isRetrying = true;
    await settle();
    supervisor.handleCommand({ type: 'abort', identity: parent });
    await settle();
    parentSession.emit({ type: 'auto_retry_end', success: false, attempt: 1 });
    parentSession.emit({ type: 'agent_settled' });
    await settle();
    expect(events.filter((event) => event.type === 'turn-failed')).toHaveLength(1);
    expect(events.some((event) => event.type === 'turn-completed')).toBe(false);

    await supervisor.shutdown();
  });

  it('willRetry 与终态错误优先，不走空轮次恢复', async () => {
    const { events, supervisor, parentSession } = await spawn();
    parentSession.emit({ type: 'agent_start' });
    await settle();
    parentSession.messages.push({ role: 'assistant', content: [], stopReason: 'error' });
    parentSession.emit({ type: 'agent_end', willRetry: true });
    await settle();
    expect(parentSession.agent.continue).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'turn-completed')).toBe(false);
    expect(events.some((event) => event.type === 'turn-failed')).toBe(false);

    parentSession.messages.push({
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'down',
    });
    parentSession.emit({ type: 'agent_end', willRetry: false });
    parentSession.emit({ type: 'agent_settled' });
    await settle();
    await settle();
    expect(parentSession.agent.continue).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'turn-failed')).toBe(true);

    await supervisor.shutdown();
  });

  it('已注册恢复 hook，工具后恢复仍为空时失败而非完成', async () => {
    const { events, supervisor, parentSession } = await spawn();
    const loader = parentSession.resourceLoader as {
      options: { extensionFactories: Array<{ name?: string }> };
    };
    expect(
      loader.options.extensionFactories.some((item) => item.name === 'silent-turn-recovery')
    ).toBe(true);
    expect(mocks.recoveryCallbacks).toHaveLength(1);
    parentSession.emit({ type: 'agent_start' });
    mocks.recoveryCallbacks[0]!('post-tool');
    parentSession.messages.push(
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'toolResult', content: [{ type: 'text', text: 'done' }] },
      { role: 'assistant', content: [] },
      { role: 'assistant', content: [] }
    );
    parentSession.emit({ type: 'agent_end', willRetry: false });
    parentSession.emit({ type: 'agent_settled' });
    await settle();
    expect(events.some((event) => event.type === 'turn-failed')).toBe(true);
    expect(events.some((event) => event.type === 'turn-completed')).toBe(false);
    expect(parentSession.agent.continue).not.toHaveBeenCalled();
    await supervisor.shutdown();
  });

  it('worker 退出时中止在跑的会话：pi 据中断信号杀掉 bash 进程组，不留孤儿进程', async () => {
    const { supervisor, parentSession } = await spawn();
    parentSession.emit({ type: 'agent_start' });
    parentSession.isStreaming = true;
    await settle();
    parentSession.abort.mockImplementation(() => new Promise<undefined>(() => {}));
    await supervisor.shutdown();
    expect(parentSession.abort).toHaveBeenCalledTimes(1);
  });

  it('流式增量合并下发：窗口内只发首帧与末帧，其他事件前先补发最新正文', async () => {
    const { events, supervisor, parentSession } = await spawn();
    const assistant = (text: string) => ({
      role: 'assistant',
      content: [{ type: 'text', text }],
      stopReason: 'stop',
    });
    const upserts = () =>
      events.flatMap((event) =>
        event.type === 'message-upsert' && event.message.role === 'assistant'
          ? [event.message.content.map((part) => ('text' in part ? part.text : '')).join('')]
          : []
      );
    parentSession.emit({ type: 'agent_start' });
    parentSession.emit({ type: 'message_start', message: assistant('') });
    for (const text of ['a', 'ab', 'abc', 'abcd']) {
      parentSession.emit({ type: 'message_update', message: assistant(text) });
    }
    expect(upserts()).toEqual(['', 'a']);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(upserts()).toEqual(['', 'a', 'abcd']);

    parentSession.emit({ type: 'message_update', message: assistant('abcde') });
    parentSession.emit({ type: 'message_update', message: assistant('abcdef') });
    parentSession.emit({ type: 'tool_execution_start', toolCallId: 't1' });
    const order = events.map((event) => event.type);
    expect(upserts().at(-1)).toBe('abcdef');
    expect(order.lastIndexOf('message-upsert')).toBeLessThan(order.lastIndexOf('tool-output'));

    parentSession.emit({ type: 'message_end', message: assistant('abcdefg') });
    expect(upserts().at(-1)).toBe('abcdefg');
    await supervisor.shutdown();
  });
});
