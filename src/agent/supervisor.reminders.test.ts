import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AgentWorkerEvent } from '@shared/types/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { SessionSupervisor } from './supervisor';

const parent = { sessionId: 'parent', generation: '11111111-1111-4111-8111-111111111111' };
const child = {
  sessionId: 'parent::cw-worker',
  generation: '22222222-2222-4222-8222-222222222222',
  parent,
  instanceId: '33333333-3333-4333-8333-333333333333',
  instanceName: 'worker-1',
  typeKey: 'builtin:worker' as const,
};
const model = {
  api: 'openai-completions' as const,
  baseUrl: 'https://example.test/v1',
  apiKey: 'secret',
  modelId: 'model',
  settingsProviderId: 'settings-provider',
};

type Tool = {
  name: string;
  prepareArguments?: (args: unknown) => unknown;
  execute(id: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
};
type FakeSession = {
  prompt: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  messages: unknown[];
  emit(event: { type: string; [key: string]: unknown }): void;
};

function session(options: Record<string, unknown>) {
  const listeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
  const value = {
    model: options.model,
    resourceLoader: options.resourceLoader,
    sessionManager: options.sessionManager,
    messages: [] as unknown[],
    agent: { state: { messages: [] } },
    sessionFile: `/tmp/session-${mocks.sessions.length}.jsonl`,
    subscribe: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    emit(event: { type: string; [key: string]: unknown }) {
      for (const listener of listeners) listener(event);
    },
    prompt: vi.fn(
      async (_text: string, options?: { preflightResult?: (disposition: string) => void }) => {
        options?.preflightResult?.('started');
      }
    ),
    steer: vi.fn(async () => 'queued'),
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

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(20);
    else await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const promptTexts = (target: FakeSession) =>
  target.prompt.mock.calls.map((call) => String(call[0] ?? ''));

/** 模拟一整轮：开始、给出结论、收口 */
function round(target: FakeSession, text: string, during?: () => Promise<unknown>) {
  target.emit({ type: 'agent_start' });
  return (async () => {
    await during?.();
    endRound(target, text);
  })();
}

function endRound(target: FakeSession, text: string) {
  const message = { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' };
  target.messages.push(message);
  target.emit({ type: 'message_start', message });
  target.emit({ type: 'message_end', message });
  target.emit({ type: 'agent_end', willRetry: false });
  target.emit({ type: 'agent_settled' });
}

const ofType = <T extends AgentWorkerEvent['type']>(events: AgentWorkerEvent[], type: T) =>
  events.filter((event): event is Extract<AgentWorkerEvent, { type: T }> => event.type === type);

const toolOf = (call: number, name: string) =>
  (
    mocks.createAgentSession.mock.calls[call]?.[0] as { customTools: Tool[] } | undefined
  )?.customTools.find((tool) => tool.name === name) as Tool;

function makeSupervisor(sessionDir: string, agentDir: string) {
  const events: AgentWorkerEvent[] = [];
  const supervisor = new SessionSupervisor({
    emit: (event) => events.push(event),
    agentDir,
    sessionDir,
  });
  return { events, supervisor };
}

async function spawnParent(supervisor: SessionSupervisor, events: AgentWorkerEvent[], cwd: string) {
  supervisor.handleCommand({
    type: 'spawn-parent',
    identity: parent,
    cwd,
    model,
    approvalMode: 'full',
  });
  await until(() => events.some((event) => event.type === 'parent-ready'));
}

const NOW = Date.parse('2026-01-01T00:00:00Z');

describe('会话自定提醒', () => {
  let cleanup: Array<() => Promise<void>> = [];
  beforeEach(() => {
    mocks.sessions.length = 0;
    mocks.loaderOptions.length = 0;
    mocks.createAgentSession.mockReset();
    mocks.createAgentSession.mockImplementation(async (options: Record<string, unknown>) => ({
      session: session(options),
    }));
  });
  afterEach(async () => {
    for (const fn of cleanup) await fn();
    cleanup = [];
    vi.useRealTimers();
  });

  async function setup(withChild = false) {
    const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'enso-reminder-')));
    const sessionDir = path.join(cwd, 'sessions');
    const agentDir = path.join(cwd, 'agent');
    const { events, supervisor } = makeSupervisor(sessionDir, agentDir);
    cleanup.push(() => supervisor.shutdown());
    await spawnParent(supervisor, events, cwd);
    if (withChild) {
      supervisor.handleCommand({
        type: 'spawn-child',
        identity: child,
        cwd,
        config: {
          typeKey: child.typeKey,
          displayName: 'Worker',
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
      await until(() => events.some((event) => event.type === 'child-ready'));
    }
    const [parentSession, childSession] = mocks.sessions as unknown as FakeSession[];
    const parentLoaders = mocks.loaderOptions.length;
    const file = path.join(sessionDir, 'reminders.json');
    const disk = () =>
      existsSync(file)
        ? (JSON.parse(readFileSync(file, 'utf8')) as {
            reminders: Array<{ id: string; sessionId: string; label?: string; dueAt: number }>;
            chains: Record<string, number>;
          })
        : { reminders: [], chains: {} };
    const parentToolResult = () => {
      const extension = mocks.loaderOptions
        .slice(0, parentLoaders)
        .flatMap(
          (options) =>
            (options.extensionFactories as
              | Array<{ name?: string; factory(pi: unknown): void }>
              | undefined) ?? []
        )
        .find((factory) => factory.name === 'system-reminders');
      let handler: ((event: unknown) => { content: Array<{ text?: string }> } | undefined) | null =
        null;
      extension?.factory({ on: (_event: string, fn: typeof handler) => (handler = fn) });
      const read = () =>
        (handler?.({ content: [{ type: 'text', text: 'ok' }] })?.content ?? [])
          .map((part) => part.text ?? '')
          .join('\n');
      return read();
    };
    return {
      cwd,
      sessionDir,
      agentDir,
      events,
      supervisor,
      parentSession,
      childSession,
      parentToolResult,
      disk,
      parentRemind: toolOf(0, 'remind_me'),
      childRemind: withChild ? toolOf(1, 'remind_me') : (undefined as unknown as Tool),
    };
  }

  const fakeClock = () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
  };

  it('根会话、子代理都挂上 remind_me / reminder_list / reminder_cancel', async () => {
    await setup(true);
    for (const call of [0, 1])
      for (const name of ['remind_me', 'reminder_list', 'reminder_cancel'])
        expect(toolOf(call, name)).toBeDefined();
  });

  it('根会话到点：发 due 事件（只发一次），Main 回 reminders-fire 后开新一轮，注入带 remind_me 标记与原 prompt', async () => {
    const ctx = await setup();
    fakeClock();
    await round(ctx.parentSession, '定好了', () =>
      ctx.parentRemind.execute('c1', { in: '60s', prompt: 'PING: check CI now', label: 'ci' })
    );
    expect(ofType(ctx.events, 'turn-completed').at(-1)).toMatchObject({ awaitingReminder: true });
    expect(ctx.disk().reminders).toEqual([
      expect.objectContaining({ label: 'ci', dueAt: NOW + 60_000 }),
    ]);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(ofType(ctx.events, 'session-reminder-due')).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ofType(ctx.events, 'session-reminder-due')).toEqual([
      { type: 'session-reminder-due', sessionId: 'parent' },
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ofType(ctx.events, 'session-reminder-due')).toHaveLength(1);

    const before = ctx.parentSession.prompt.mock.calls.length;
    ctx.supervisor.handleCommand({ type: 'reminders-fire', sessionId: 'parent' });
    await until(() => ctx.parentSession.prompt.mock.calls.length > before);
    const injected = promptTexts(ctx.parentSession).at(-1) ?? '';
    expect(injected).toContain('remind_me');
    expect(injected).toContain('PING: check CI now');
    expect(injected).toContain('ci');
    expect(ctx.disk().reminders).toEqual([]);
    expect(ctx.disk().chains).toEqual({ parent: 1 });

    // 再来一次 fire 不会重复投递
    ctx.supervisor.handleCommand({ type: 'reminders-fire', sessionId: 'parent' });
    await vi.advanceTimersByTimeAsync(200);
    expect(ctx.parentSession.prompt.mock.calls.length).toBe(before + 1);

    // 非提醒来源的 prompt 把链计数清零
    endRound(ctx.parentSession, '看过 CI 了');
    ctx.supervisor.handleCommand({
      type: 'prompt',
      identity: parent,
      text: 'user says hi',
      deliveryId: 'd-1',
    });
    await until(() => promptTexts(ctx.parentSession).some((text) => text.includes('user says hi')));
    expect(ctx.disk().chains).toEqual({});
  });

  it('会话正在跑且 ifIdle：不发 due，等这一轮结束再开新一轮', async () => {
    const ctx = await setup();
    fakeClock();
    await round(ctx.parentSession, '定好了', () =>
      ctx.parentRemind.execute('c1', { in: '60s', prompt: 'IDLE-PING' })
    );
    ctx.parentSession.emit({ type: 'agent_start' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ofType(ctx.events, 'session-reminder-due')).toEqual([]);
    expect(promptTexts(ctx.parentSession).some((text) => text.includes('IDLE-PING'))).toBe(false);
    endRound(ctx.parentSession, '手头的事做完了');
    await until(() => promptTexts(ctx.parentSession).some((text) => text.includes('IDLE-PING')));
    expect(ctx.disk().reminders).toEqual([]);
  });

  it('ifIdle=false：正在跑也到点就投，搭这一轮的下一条工具结果', async () => {
    const ctx = await setup();
    fakeClock();
    await round(ctx.parentSession, '定好了', () =>
      ctx.parentRemind.execute('c1', { in: '60s', prompt: 'BUSY-PING', ifIdle: false })
    );
    ctx.parentSession.emit({ type: 'agent_start' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ofType(ctx.events, 'session-reminder-due')).toHaveLength(1);
    ctx.supervisor.handleCommand({ type: 'reminders-fire', sessionId: 'parent' });
    await vi.advanceTimersByTimeAsync(50);
    expect(ctx.parentToolResult()).toContain('BUSY-PING');
    expect(ctx.disk().reminders).toEqual([]);
  });

  it('重启：新一代加载后补发一次，再起一代不再发', async () => {
    fakeClock();
    const first = await setup();
    await round(first.parentSession, '定好了', () =>
      first.parentRemind.execute('c1', { in: '40s', prompt: 'RESTART-PING' })
    );
    await first.supervisor.shutdown();
    vi.setSystemTime(NOW + 5 * 60_000);

    mocks.sessions.length = 0;
    mocks.loaderOptions.length = 0;
    mocks.createAgentSession.mockClear();
    const second = makeSupervisor(first.sessionDir, first.agentDir);
    cleanup.push(() => second.supervisor.shutdown());
    await vi.advanceTimersByTimeAsync(10);
    expect(ofType(second.events, 'session-reminder-due')).toEqual([
      { type: 'session-reminder-due', sessionId: 'parent' },
    ]);
    // 会话还没打开：fire 不动它
    second.supervisor.handleCommand({ type: 'reminders-fire', sessionId: 'parent' });
    await vi.advanceTimersByTimeAsync(10);
    expect(first.disk().reminders).toHaveLength(1);
    // Main 打开会话：就绪后补发
    await spawnParent(second.supervisor, second.events, first.cwd);
    const reopened = mocks.sessions[0] as unknown as FakeSession;
    await until(() => promptTexts(reopened).some((text) => text.includes('RESTART-PING')));
    expect(promptTexts(reopened).find((text) => text.includes('RESTART-PING'))).toMatch(
      /while EnsoCode was restarting or not running.*delivered late/
    );
    expect(first.disk().reminders).toEqual([]);
    await second.supervisor.shutdown();

    mocks.sessions.length = 0;
    mocks.createAgentSession.mockClear();
    const third = makeSupervisor(first.sessionDir, first.agentDir);
    cleanup.push(() => third.supervisor.shutdown());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ofType(third.events, 'session-reminder-due')).toEqual([]);
    await spawnParent(third.supervisor, third.events, first.cwd);
    await vi.advanceTimersByTimeAsync(500);
    const third0 = mocks.sessions[0] as unknown as FakeSession;
    expect(promptTexts(third0).some((text) => text.includes('RESTART-PING'))).toBe(false);
  });

  it('重启：没到点的提醒新一代按原时间触发，通知不标延迟', async () => {
    fakeClock();
    const first = await setup();
    await round(first.parentSession, '定好了', () =>
      first.parentRemind.execute('c1', { in: '5m', prompt: 'ONTIME-PING' })
    );
    await first.supervisor.shutdown();
    vi.setSystemTime(NOW + 60_000);

    mocks.sessions.length = 0;
    mocks.loaderOptions.length = 0;
    mocks.createAgentSession.mockClear();
    const second = makeSupervisor(first.sessionDir, first.agentDir);
    cleanup.push(() => second.supervisor.shutdown());
    await spawnParent(second.supervisor, second.events, first.cwd);
    const reopened = mocks.sessions[0] as unknown as FakeSession;
    await vi.advanceTimersByTimeAsync(4 * 60_000 - 1_000);
    expect(ofType(second.events, 'session-reminder-due')).toEqual([]);
    expect(promptTexts(reopened).some((text) => text.includes('ONTIME-PING'))).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ofType(second.events, 'session-reminder-due')).toHaveLength(1);
    second.supervisor.handleCommand({ type: 'reminders-fire', sessionId: 'parent' });
    await until(() => promptTexts(reopened).some((text) => text.includes('ONTIME-PING')));
    expect(promptTexts(reopened).find((text) => text.includes('ONTIME-PING'))).not.toMatch(
      /delivered late/
    );
    expect(first.disk().reminders).toEqual([]);
  });

  it('reminders-clear（停止、删除）清掉根会话和它子代理的提醒，之后不再唤醒', async () => {
    const ctx = await setup(true);
    fakeClock();
    ctx.supervisor.handleCommand({
      type: 'prompt-child',
      identity: child,
      requestId: 'run-1',
      requestBudget: true,
      task: { text: 'wait for deploy', images: [], fileMentions: [] },
    });
    await until(() => ctx.childSession.prompt.mock.calls.length > 0);
    await round(ctx.childSession, '子代理定好了', () =>
      ctx.childRemind.execute('c2', { in: '5m', prompt: 'CHILD-PING' })
    );
    await round(ctx.parentSession, '父会话定好了', () =>
      ctx.parentRemind.execute('c1', { in: '60s', prompt: 'PARENT-PING' })
    );
    expect(ctx.disk().reminders).toHaveLength(2);
    ctx.supervisor.handleCommand({ type: 'reminders-clear', sessionId: 'parent' });
    await vi.advanceTimersByTimeAsync(10);
    expect(ctx.disk().reminders).toEqual([]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(ofType(ctx.events, 'session-reminder-due')).toEqual([]);
    for (const target of [ctx.parentSession, ctx.childSession])
      expect(promptTexts(target).some((text) => text.includes('-PING'))).toBe(false);
  });

  it('子代理定提醒：Run 被持有，到点唤醒子代理自己，那一轮交报告后 Run 收口；不经过 Main', async () => {
    const ctx = await setup(true);
    fakeClock();
    ctx.supervisor.handleCommand({
      type: 'prompt-child',
      identity: child,
      requestId: 'run-1',
      requestBudget: true,
      task: { text: 'wait for deploy', images: [], fileMentions: [] },
    });
    await until(() => ctx.childSession.prompt.mock.calls.length > 0);
    await round(ctx.childSession, '部署中，5 分钟后看', () =>
      ctx.childRemind.execute('c2', { in: '5m', prompt: 'CHILD-PING: check deploy' })
    );
    expect(ofType(ctx.events, 'turn-completed').at(-1)).toMatchObject({
      turnId: 'run-1',
      awaitingTasks: true,
    });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await until(() => promptTexts(ctx.childSession).some((text) => text.includes('CHILD-PING')));
    expect(ofType(ctx.events, 'session-reminder-due')).toEqual([]);
    expect(promptTexts(ctx.parentSession).some((text) => text.includes('CHILD-PING'))).toBe(false);
    await round(ctx.childSession, '部署好了，报告如下');
    const last = ofType(ctx.events, 'turn-completed').at(-1);
    expect(last).toMatchObject({ continues: 'run-1' });
    expect(last).not.toHaveProperty('awaitingTasks');
  });

  it('子代理持有中被叫停：它的提醒清掉，到点不再唤醒', async () => {
    const ctx = await setup(true);
    fakeClock();
    ctx.supervisor.handleCommand({
      type: 'prompt-child',
      identity: child,
      requestId: 'run-1',
      requestBudget: true,
      task: { text: 'wait for deploy', images: [], fileMentions: [] },
    });
    await until(() => ctx.childSession.prompt.mock.calls.length > 0);
    await round(ctx.childSession, '部署中', () =>
      ctx.childRemind.execute('c2', { in: '5m', prompt: 'CHILD-PING' })
    );
    expect(ofType(ctx.events, 'turn-completed').at(-1)).toMatchObject({ awaitingTasks: true });
    ctx.supervisor.handleCommand({ type: 'abort', identity: child });
    await settle();
    await vi.advanceTimersByTimeAsync(10);
    expect(ctx.disk().reminders).toEqual([]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(promptTexts(ctx.childSession).some((text) => text.includes('CHILD-PING'))).toBe(false);
  });

  it('退出收尾打断子代理的回合：Run 重启后续跑，它的提醒留着', async () => {
    const ctx = await setup(true);
    ctx.supervisor.handleCommand({
      type: 'prompt-child',
      identity: child,
      requestId: 'run-1',
      requestBudget: true,
      task: { text: 'wait for deploy', images: [], fileMentions: [] },
    });
    await until(() => ctx.childSession.prompt.mock.calls.length > 0);
    ctx.childSession.emit({ type: 'agent_start' });
    await ctx.childRemind.execute('c2', { in: '5m', prompt: 'CHILD-PING' });
    ctx.supervisor.handleCommand({ type: 'graceful-restart' });
    // 收尾中止落成错误回合（走 failTurn）
    ctx.childSession.abort.mockImplementation(async () => {
      const message = {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'This operation was aborted',
      };
      ctx.childSession.messages.push(message);
      ctx.childSession.emit({ type: 'message_start', message });
      ctx.childSession.emit({ type: 'message_end', message });
      ctx.childSession.emit({ type: 'agent_end', willRetry: false });
      ctx.childSession.emit({ type: 'agent_settled' });
    });
    await ctx.supervisor.shutdown();
    await settle();
    expect(ofType(ctx.events, 'turn-completed').some((e) => e.identity === child)).toBe(false);
    expect(ctx.disk().reminders).toEqual([expect.objectContaining({ sessionId: child.sessionId })]);
  });

  it('不在 Run 里的子代理不能定提醒', async () => {
    const ctx = await setup(true);
    await expect(ctx.childRemind.execute('c2', { in: '5m', prompt: 'NO-RUN' })).rejects.toThrow(
      /Run/
    );
    expect(ctx.disk().reminders).toEqual([]);
  });

  it('根会话收口才起的在跑后台任务：turn-completed 带 awaitingBackground（headless 靠它保持进程）', async () => {
    const ctx = await setup();
    const bash = toolOf(0, 'bash');
    await round(ctx.parentSession, 'started in background', async () => {
      const result = (await bash.execute('bg1', { command: 'sleep 30', background: true })) as {
        content: Array<{ text?: string }>;
      };
      expect(result.content[0]?.text).toContain('Started background task');
    });
    expect(ofType(ctx.events, 'turn-completed').at(-1)).toMatchObject({
      awaitingBackground: true,
    });
  });

  it('根会话收口时没有后台任务与提醒：turn-completed 不带 awaitingBackground', async () => {
    const ctx = await setup();
    await round(ctx.parentSession, 'all done');
    const last = ofType(ctx.events, 'turn-completed').at(-1);
    expect(last).not.toHaveProperty('awaitingBackground');
  });
});
