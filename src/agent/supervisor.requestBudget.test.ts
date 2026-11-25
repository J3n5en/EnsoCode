import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelRuntime, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { RESTART_CHECKPOINT_FILE } from '@shared/gracefulRestart';
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

import { INTERRUPTED_TASKS_FILE } from './detachedTasksManifest';
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
    prompt: vi.fn(
      async (_text: string, options?: { preflightResult?: (disposition: string) => void }) => {
        options?.preflightResult?.('started');
      }
    ),
    steer: vi.fn(async () => undefined),
    getFollowUpMessages: () => [],
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

  async function spawnChild(restartDir?: string): Promise<{
    events: AgentWorkerEvent[];
    supervisor: SessionSupervisor;
    worker: FakeSession;
  }> {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: restartDir ?? '/tmp/agent',
      sessionDir,
      ...(restartDir ? { dataDir: restartDir } : {}),
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
    expect(worker.prompt).toHaveBeenLastCalledWith(budgetWrapUpPrompt(), {
      streamingBehavior: 'followUp',
    });

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

  it('用户在子代理 tab 里停止：本轮收口仍带原 Run 的 turnId，Main 才能对上这个 Run', async () => {
    const { events, supervisor, worker } = await spawnChild();
    promptRun(supervisor, 'run-1');
    await settle();
    worker.emit({ type: 'agent_start' });
    request(worker, toolCall(1));
    supervisor.handleCommand({ type: 'abort', identity: child });
    await settle();
    endRound(worker);
    await settle();
    expect(completed(events)).toEqual([
      expect.objectContaining({ turnId: 'run-1', aborted: true }),
    ]);
    await supervisor.shutdown();
  });

  it('重试倒计时中停止：按失败收口也带原 turnId 并标明是中止', async () => {
    const { events, supervisor, worker } = await spawnChild();
    promptRun(supervisor, 'run-1');
    await settle();
    request(worker, toolCall(1));
    worker.isRetrying = true;
    supervisor.handleCommand({ type: 'abort', identity: child });
    await settle();
    expect(events.filter((event) => event.type === 'turn-failed')).toEqual([
      expect.objectContaining({ turnId: 'run-1', aborted: true }),
    ]);
    await supervisor.shutdown();
  });

  it('等安全点超时、收尾中止子代理回复：不发这个 Run 的回合结局，断点照样记下子会话', async () => {
    const restartDir = mkdtempSync(path.join(tmpdir(), 'enso-restart-child-abort-'));
    try {
      const { events, supervisor, worker } = await spawnChild(restartDir);
      promptRun(supervisor, 'run-1');
      await settle();
      worker.emit({ type: 'agent_start' });
      request(worker, toolCall(1));
      supervisor.handleCommand({ type: 'graceful-restart' });
      worker.abort.mockImplementation(async () => {
        request(worker, { content: [], stopReason: 'aborted' });
        endRound(worker);
      });
      await supervisor.shutdown();
      await settle();
      // 发了的话 Main 会把被打断的 Run 记成已完成，重启后既不续跑也认不出它（restart-lost）
      const ofRun = events.filter(
        (event) =>
          (event.type === 'turn-completed' || event.type === 'turn-failed') &&
          (event.turnId === 'run-1' || event.continues === 'run-1')
      );
      expect(ofRun).toEqual([]);
      const checkpoint = JSON.parse(
        readFileSync(path.join(restartDir, RESTART_CHECKPOINT_FILE), 'utf8')
      ) as { sessions: Array<{ sessionId: string }> };
      expect(checkpoint.sessions.map((entry) => entry.sessionId)).toContain(child.sessionId);
    } finally {
      rmSync(restartDir, { recursive: true, force: true });
    }
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

    supervisor.handleCommand({
      type: 'prompt',
      deliveryId: 'd-444',
      identity: child,
      text: 'keep going',
    });
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

  /** 续跑用的 retry：给假会话补上续跑要用到的 pi 私有入口与会话管理器方法 */
  function prepareResume(worker: FakeSession, messages: unknown[]) {
    const appended: Array<Record<string, unknown>> = [];
    const state = worker.agent.state as { messages: unknown[] };
    state.messages = messages;
    Object.assign(worker.sessionManager as object, {
      buildSessionProjection: vi.fn(() => ({
        entries: state.messages.map((message, index) => ({
          sourceEntry: { type: 'message', id: `m${index}`, message },
          messages: [message],
        })),
      })),
      appendMessage: vi.fn((message: Record<string, unknown>) => {
        appended.push(message);
        state.messages.push(message);
        return `m${state.messages.length}`;
      }),
      appendContextEdit: vi.fn(() => {
        state.messages.pop();
        return 'edit';
      }),
    });
    const startRun = vi.fn(async () => undefined);
    Object.assign(worker, { refreshContext: vi.fn(), _prepareRun: vi.fn(), _startRun: startRun });
    return { appended, startRun };
  }

  function resumeRun(supervisor: SessionSupervisor, requestsUsed?: number): void {
    supervisor.handleCommand({
      type: 'retry',
      identity: child,
      unfinishedOnly: true,
      turnId: 'run-2',
      requestBudget: true,
      ...(requestsUsed !== undefined ? { requestsUsed } : {}),
    });
  }

  it('续跑接着原 Run 已用的请求数计预算，不清零', async () => {
    const { supervisor, worker } = await spawnChild();
    const { startRun } = prepareResume(worker, [{ role: 'user', content: 'inspect files' }]);
    resumeRun(supervisor, 2);
    await settle();
    expect(startRun).toHaveBeenCalledTimes(1);
    request(worker, toolCall(3));
    expect(worker.abort).toHaveBeenCalledTimes(1);
    await supervisor.shutdown();
  });

  it('子会话续跑：中断时在跑的工具补一条错误结果后再续，不把那次调用移出上下文重放', async () => {
    const { supervisor, worker } = await spawnChild();
    const { appended, startRun } = prepareResume(worker, [
      { role: 'user', content: 'inspect files' },
      { role: 'assistant', ...toolCall(1) },
    ]);
    resumeRun(supervisor);
    await settle();
    expect(appended).toEqual([
      expect.objectContaining({ role: 'toolResult', toolCallId: 'call-1', isError: true }),
    ]);
    expect(
      (worker.sessionManager as { appendContextEdit: ReturnType<typeof vi.fn> }).appendContextEdit
    ).not.toHaveBeenCalled();
    expect(startRun).toHaveBeenCalledTimes(1);
    await supervisor.shutdown();
  });

  it('重启后续跑：子会话停在已执行完的工具结果后，直接发下一次请求，不重放那次工具', async () => {
    const { events, supervisor, worker } = await spawnChild();
    const { appended, startRun } = prepareResume(worker, [
      { role: 'user', content: 'inspect files' },
      { role: 'assistant', ...toolCall(1) },
      { role: 'toolResult', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }] },
    ]);
    resumeRun(supervisor);
    await settle();
    expect(appended).toEqual([]);
    expect(startRun).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === 'retry-skipped')).toBe(false);
    await supervisor.shutdown();
  });

  it('持有后台任务时被重启：被停掉的任务记给子代理，续跑时把消息交给它、接着原 Run 开一轮', async () => {
    const restartDir = mkdtempSync(path.join(tmpdir(), 'enso-restart-child-task-'));
    try {
      writeFileSync(
        path.join(restartDir, INTERRUPTED_TASKS_FILE),
        JSON.stringify({
          version: 1,
          tasks: [
            {
              taskId: 'task-7-ab',
              sessionId: child.sessionId,
              command: 'pnpm build',
              startedAt: 1,
              stoppedAt: 2,
              logPath: path.join(restartDir, 'task-logs', 'task-7-ab.log'),
              resident: false,
            },
          ],
        })
      );
      const { events, supervisor, worker } = await spawnChild(restartDir);
      prepareResume(worker, [
        { role: 'user', content: 'inspect files' },
        { role: 'assistant', ...finalAnswer('waiting for the build') },
      ]);
      resumeRun(supervisor);
      await vi.waitFor(() => expect(worker.prompt).toHaveBeenCalledTimes(1));
      expect(events.some((event) => event.type === 'retry-skipped')).toBe(false);
      expect(String((worker.prompt.mock.calls[0] as unknown[] | undefined)?.[0])).toContain(
        'pnpm build'
      );
      request(worker, finalAnswer('build was stopped by the restart; rerun needed'));
      endRound(worker);
      await waitFor(events, 'turn-completed');
      expect(completed(events).at(-1)).toMatchObject({ continues: 'run-2' });
      expect(completed(events).at(-1)?.awaitingTasks).toBeUndefined();
      await supervisor.shutdown();
    } finally {
      rmSync(restartDir, { recursive: true, force: true });
    }
  });

  it('续跑时子会话最后一条回复已完整、也没有在等的任务：照旧回执 nothing-to-retry', async () => {
    const { events, supervisor, worker } = await spawnChild();
    prepareResume(worker, [
      { role: 'user', content: 'inspect files' },
      { role: 'assistant', ...finalAnswer('done') },
    ]);
    resumeRun(supervisor);
    await waitFor(events, 'retry-skipped');
    expect(events.find((event) => event.type === 'retry-skipped')).toMatchObject({
      reason: 'nothing-to-retry',
    });
    await supervisor.shutdown();
  });
});
