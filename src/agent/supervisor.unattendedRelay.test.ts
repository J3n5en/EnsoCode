import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AgentCommand, AgentWorkerEvent } from '@shared/types/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ASK_NO_USER_ERROR } from './ask';
import {
  UNATTENDED_OFF_NOTE,
  UNATTENDED_ON_NOTE,
  UNATTENDED_PROMPT,
  UNATTENDED_RELAY_ON_NOTE,
  UNATTENDED_RELAY_PROMPT,
} from './unattended';

const mocks = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
  createAgentSession: vi.fn(),
  loaderOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock('./cursor/loadProvider', () => ({
  CURSOR_PROVIDER_ID: 'cursor',
  loadCursorProvider: vi.fn(async () => undefined),
}));

vi.mock('./mcp', () => ({
  McpManager: class {
    toolsFor = vi.fn(async () => []);
    resolve = vi.fn();
    refresh = vi.fn();
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

type Tool = {
  name: string;
  execute(id: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
};

function fakeSession(options: Record<string, unknown>) {
  const value = {
    model: options.model,
    resourceLoader: options.resourceLoader,
    sessionManager: options.sessionManager,
    messages: [],
    sessionFile: `/tmp/session-${mocks.sessions.length}.jsonl`,
    subscribe: vi.fn(() => () => undefined),
    prompt: vi.fn(async () => undefined),
    agent: { steeringQueue: { messages: [] as unknown[] } },
    getSteeringMessages: () => [],
    _emitQueueUpdate: vi.fn(),
    steer: vi.fn(async () => 'queued'),
    abort: vi.fn(async () => undefined),
    waitForIdle: vi.fn(async () => undefined),
    dispose: vi.fn(),
    setThinkingLevel: vi.fn(),
    activeTools: ((options.customTools as Tool[] | undefined) ?? []).map((tool) => tool.name),
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

async function settleUntil(check: () => boolean, tries = 30): Promise<void> {
  for (let i = 0; i < tries && !check(); i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

const ofType = <T extends AgentWorkerEvent['type']>(events: AgentWorkerEvent[], type: T) =>
  events.filter((event): event is Extract<AgentWorkerEvent, { type: T }> => event.type === type);

/** 跑一遍 loader 上名为 unattended 的扩展，取它追加进系统提示词的文本 */
function unattendedSection(options: Record<string, unknown>): string | undefined {
  const ext = (
    (options.extensionFactories as Array<{ name?: string; factory(pi: unknown): void }>) ?? []
  ).find((factory) => factory.name === 'unattended');
  if (!ext) return undefined;
  let handler: ((event: unknown) => void) | undefined;
  ext.factory({ on: (_: string, fn: (event: unknown) => void) => (handler = fn) });
  const event = { systemPromptOptions: {} as { appendSystemPrompt?: string } };
  handler?.(event);
  return event.systemPromptOptions.appendSystemPrompt;
}

async function spawnParent(extra: Partial<Extract<AgentCommand, { type: 'spawn-parent' }>>) {
  const events: AgentWorkerEvent[] = [];
  const supervisor = new SessionSupervisor({
    emit: (event) => events.push(event),
    agentDir: '/tmp/agent',
    sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-unattended-relay-')),
  });
  supervisor.handleCommand({
    type: 'spawn-parent',
    identity: parent,
    cwd: '/workspace',
    model,
    approvalMode: 'supervised',
    ...extra,
  });
  await settleUntil(() => events.some((event) => event.type === 'parent-ready'));
  const tools = (mocks.createAgentSession.mock.calls[0][0] as { customTools: Tool[] }).customTools;
  const session = mocks.sessions[0] as { prompt: ReturnType<typeof vi.fn> };
  /** 发一条用户消息，返回实际进模型的文本（带上待发的一次性提示） */
  const promptText = async (text: string): Promise<string> => {
    const before = session.prompt.mock.calls.length;
    supervisor.handleCommand({ type: 'prompt', deliveryId: 'd-190', identity: parent, text });
    await settleUntil(() => session.prompt.mock.calls.length > before);
    const sent = session.prompt.mock.calls[before]?.[0] as string;
    // mock 不发 agent_end，手动回到 idle 以便下一条照常走 prompt
    (supervisor as unknown as { sessions: Map<string, { status: string }> }).sessions.get(
      parent.sessionId
    )!.status = 'idle';
    return sent;
  };
  return {
    events,
    supervisor,
    loader: mocks.loaderOptions[0],
    askTool: tools.find((tool) => tool.name === 'ask_user')!,
    promptText,
  };
}

describe('无人值守 + 提问转发', () => {
  beforeEach(() => {
    mocks.sessions.length = 0;
    mocks.loaderOptions.length = 0;
    mocks.createAgentSession.mockReset();
    mocks.createAgentSession.mockImplementation(async (options: Record<string, unknown>) => ({
      session: fakeSession(options),
    }));
  });

  it('普通无人值守：常驻说明是原文，ask_user 直接按「没人回答」失败', async () => {
    const ctx = await spawnParent({ autoRejectApprovals: true });
    expect(unattendedSection(ctx.loader)).toBe(UNATTENDED_PROMPT);
    await expect(ctx.askTool.execute('c1', { question: '删旧配置吗？' })).rejects.toThrow(
      ASK_NO_USER_ERROR
    );
    expect(ofType(ctx.events, 'ask-request')).toHaveLength(0);
    await ctx.supervisor.shutdown();
  });

  it('无人值守且开着转发：用转发变体，ask_user 挂起转给秘书并拿到秘书的回答', async () => {
    const ctx = await spawnParent({ autoRejectApprovals: true, askRelay: { name: '小秘' } });
    expect(unattendedSection(ctx.loader)).toBe(UNATTENDED_RELAY_PROMPT);
    const pending = ctx.askTool.execute('c1', {
      question: '删旧配置吗？',
      options: ['删', '保留'],
      default_option: '保留',
    });
    await settleUntil(() => ofType(ctx.events, 'ask-request').length > 0);
    const [request] = ofType(ctx.events, 'ask-request');
    expect(request.ask).toMatchObject({ question: '删旧配置吗？', relay: { name: '小秘' } });
    ctx.supervisor.handleCommand({
      type: 'ask-respond',
      identity: parent,
      requestId: request.ask.requestId,
      answer: '保留',
      by: 'relay',
      name: '小秘',
    });
    await expect(pending).resolves.toMatchObject({ content: [{ type: 'text', text: '保留' }] });
    await ctx.supervisor.shutdown();
  });

  it('只有转发、没开无人值守：不挂无人值守说明', async () => {
    const ctx = await spawnParent({ askRelay: { name: '小秘' } });
    expect(unattendedSection(ctx.loader)).toBeUndefined();
    await ctx.supervisor.shutdown();
  });

  it('中途开关转发：下一条消息前置对应变体的一次性提示', async () => {
    const ctx = await spawnParent({ autoRejectApprovals: true });
    ctx.supervisor.handleCommand({
      type: 'set-ask-relay',
      identity: parent,
      relay: { name: '小秘' },
    });
    expect(await ctx.promptText('继续')).toBe(`${UNATTENDED_RELAY_ON_NOTE}\n\n继续`);
    ctx.supervisor.handleCommand({ type: 'set-ask-relay', identity: parent });
    expect(await ctx.promptText('继续')).toBe(`${UNATTENDED_ON_NOTE}\n\n继续`);
    // 状态没变不重复提示
    ctx.supervisor.handleCommand({ type: 'set-ask-relay', identity: parent });
    expect(await ctx.promptText('继续')).toBe('继续');
    await ctx.supervisor.shutdown();
  });

  it('有转发时切无人值守：开用转发变体，关照旧 OFF；普通会话切换与原来一致', async () => {
    const relayed = await spawnParent({ askRelay: { name: '小秘' } });
    const toggle = (autoReject: boolean) =>
      relayed.supervisor.handleCommand({
        type: 'set-approval-mode',
        identity: parent,
        mode: 'supervised',
        autoReject,
      });
    toggle(true);
    expect(await relayed.promptText('继续')).toBe(`${UNATTENDED_RELAY_ON_NOTE}\n\n继续`);
    toggle(false);
    expect(await relayed.promptText('继续')).toBe(`${UNATTENDED_OFF_NOTE}\n\n继续`);
    await relayed.supervisor.shutdown();

    mocks.sessions.length = 0;
    mocks.loaderOptions.length = 0;
    mocks.createAgentSession.mockClear();
    const plain = await spawnParent({});
    plain.supervisor.handleCommand({
      type: 'set-approval-mode',
      identity: parent,
      mode: 'supervised',
      autoReject: true,
    });
    expect(await plain.promptText('继续')).toBe(`${UNATTENDED_ON_NOTE}\n\n继续`);
    await plain.supervisor.shutdown();
  });

  it('子代理：没有 ask_user、拿不到转发，保持原无人值守说明', async () => {
    const ctx = await spawnParent({ autoRejectApprovals: true, askRelay: { name: '小秘' } });
    const identity = {
      sessionId: 'parent::cw-worker',
      generation: '44444444-4444-4444-8444-444444444444',
      parent,
      instanceId: '55555555-5555-4555-8555-555555555555',
      instanceName: 'worker-1',
      typeKey: 'builtin:worker' as const,
    };
    const calls = mocks.createAgentSession.mock.calls.length;
    const loaders = mocks.loaderOptions.length;
    ctx.supervisor.handleCommand({
      type: 'spawn-child',
      identity,
      cwd: '/workspace',
      config: {
        typeKey: identity.typeKey,
        displayName: 'WORKER',
        description: 'worker',
        spawnSpecId: 'spawn-worker',
        systemPrompt: 'worker role',
        model,
        tools: 'all',
        skillPaths: [],
        skillBindingIds: [],
        mcpServers: [],
        mcpBindingIds: [],
        systemPromptHash: 'worker-hash',
      },
    });
    await settleUntil(() => ofType(ctx.events, 'child-ready').length > 0);
    const childTools = (
      mocks.createAgentSession.mock.calls[calls][0] as { customTools: Tool[] }
    ).customTools.map((tool) => tool.name);
    expect(childTools).not.toContain('ask_user');
    expect(unattendedSection(mocks.loaderOptions[loaders])).toBe(UNATTENDED_PROMPT);
    await ctx.supervisor.shutdown();
  });
});
