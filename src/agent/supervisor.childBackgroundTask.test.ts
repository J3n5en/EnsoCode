import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AgentCommand, AgentWorkerEvent } from '@shared/types/agent';
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

import { AGENT_RUN_HOLD_LIMIT_MS, SessionSupervisor } from './supervisor';

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
  execute(id: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
};
type FakeSession = {
  prompt: ReturnType<typeof vi.fn>;
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
    prompt: vi.fn(async () => undefined),
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

/** 模拟子代理的一整轮：开始、给出结论、收口 */
function round(target: FakeSession, text: string, during?: () => Promise<unknown>) {
  target.emit({ type: 'agent_start' });
  return (async () => {
    await during?.();
    const message = { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' };
    target.messages.push(message);
    target.emit({ type: 'message_start', message });
    target.emit({ type: 'message_end', message });
    target.emit({ type: 'agent_end', willRetry: false });
    target.emit({ type: 'agent_settled' });
  })();
}

const turnsCompleted = (events: AgentWorkerEvent[]) =>
  events.filter(
    (event): event is Extract<AgentWorkerEvent, { type: 'turn-completed' }> =>
      event.type === 'turn-completed'
  );

describe('子代理起的后台任务归属子代理', () => {
  beforeEach(() => {
    mocks.sessions.length = 0;
    mocks.loaderOptions.length = 0;
    mocks.createAgentSession.mockReset();
    mocks.createAgentSession.mockImplementation(async (options: Record<string, unknown>) => ({
      session: session(options),
    }));
  });

  async function setup(tools: 'all' | 'readonly' = 'all') {
    const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'enso-child-bg-')));
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: path.join(cwd, 'agent'),
      sessionDir: path.join(cwd, 'sessions'),
    });
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd,
      model,
      approvalMode: 'full',
    });
    await until(() => events.some((event) => event.type === 'parent-ready'));
    const parentLoaders = mocks.loaderOptions.length;
    const command: AgentCommand = {
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
        tools,
        skillPaths: [],
        skillBindingIds: [],
        mcpServers: [],
        mcpBindingIds: [],
        systemPromptHash: 'worker-hash',
      },
    };
    supervisor.handleCommand(command);
    await until(() => events.some((event) => event.type === 'child-ready'));
    const [parentSession, childSession] = mocks.sessions as unknown as FakeSession[];
    const childOptions = mocks.createAgentSession.mock.calls[1]?.[0] as { customTools: Tool[] };
    const parentOptions = mocks.createAgentSession.mock.calls[0]?.[0] as { customTools: Tool[] };
    // 模拟一次工具结果：返回 system-reminders 扩展搭上去的文本
    const nextToolResult = (from: number, to?: number) => {
      const extension = mocks.loaderOptions
        .slice(from, to)
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
      return () =>
        (handler?.({ content: [{ type: 'text', text: 'ok' }] })?.content ?? [])
          .map((part) => part.text ?? '')
          .join('\n');
    };
    return {
      events,
      supervisor,
      parentSession,
      childSession,
      childBash: childOptions.customTools.find((tool) => tool.name === 'bash') as Tool,
      childTools: childOptions.customTools,
      parentBash: parentOptions.customTools.find((tool) => tool.name === 'bash') as Tool,
      parentToolResult: nextToolResult(0, parentLoaders),
      childToolResult: nextToolResult(parentLoaders),
    };
  }

  it('任务记在子会话名下；没在等任务的子代理只在下一条工具结果里收到通知，不唤醒父会话也不唤醒子代理', async () => {
    const ctx = await setup();
    await ctx.childBash.execute('call-1', {
      command: 'echo child-bg-out',
      background: true,
    });
    await until(() => ctx.events.some((event) => event.type === 'task-ended'));
    await new Promise((resolve) => setTimeout(resolve, 400));
    await settle();

    const started = ctx.events.find((event) => event.type === 'task-started');
    expect(started && 'identity' in started && started.identity.sessionId).toBe(child.sessionId);
    expect(promptTexts(ctx.parentSession).some((text) => text.includes('Background task'))).toBe(
      false
    );
    expect(promptTexts(ctx.childSession).some((text) => text.includes('Background task'))).toBe(
      false
    );
    expect(ctx.parentToolResult()).not.toContain('Background task');
    const childNotice = ctx.childToolResult();
    expect(childNotice).toContain('<background-task-update>');
    expect(childNotice).toContain('child-bg-out');
    expect(ctx.childToolResult()).not.toContain('<background-task-update>');
    await ctx.supervisor.shutdown();
  });

  it('回合结束时还有自己的后台任务：先持有 Run，任务完成时唤醒空闲的子代理，收尾那一轮接上被持有的 Run', async () => {
    const ctx = await setup();
    ctx.supervisor.handleCommand({
      type: 'prompt-child',
      identity: child,
      requestId: 'run-1',
      requestBudget: true,
      task: { text: 'start the server', images: [], fileMentions: [] },
    });
    await round(ctx.childSession, '服务已起，等它跑完', () =>
      ctx.childBash.execute('call-1', {
        command: 'sleep 0.3; echo child-bg-out',
        background: true,
      })
    );
    expect(turnsCompleted(ctx.events).at(-1)).toMatchObject({
      turnId: 'run-1',
      awaitingTasks: true,
    });

    await until(() =>
      promptTexts(ctx.childSession).some(
        (text) => text.includes('child-bg-out') && !text.includes('task_settle')
      )
    );
    await round(ctx.childSession, '服务跑完了，结论是 X');
    const last = turnsCompleted(ctx.events).at(-1);
    expect(last).toMatchObject({ continues: 'run-1' });
    expect(last?.turnId).not.toBe('run-1');
    expect(last).not.toHaveProperty('awaitingTasks');
    expect(promptTexts(ctx.parentSession).some((text) => text.includes('child-bg-out'))).toBe(
      false
    );
    await ctx.supervisor.shutdown();
  });

  it('持有中空闲时被 abort：发出接上被持有 Run 的 aborted 终态，之后任务结束不再唤醒', async () => {
    const ctx = await idleHold();
    ctx.supervisor.handleCommand({ type: 'abort', identity: child });
    await settle();
    const last = turnsCompleted(ctx.events).at(-1);
    expect(last).toMatchObject({ aborted: true, continues: 'run-1' });
    expect(last?.turnId).not.toBe('run-1');

    const prompts = ctx.childSession.prompt.mock.calls.length;
    const stop = ctx.childTools.find((tool) => tool.name === 'task_stop') as Tool;
    await stop.execute('s1', { taskId: ctx.taskId });
    await until(() => ctx.events.some((event) => event.type === 'task-ended'));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(ctx.childSession.prompt.mock.calls.length).toBe(prompts);
    await ctx.supervisor.shutdown();
  });

  it('子代理还在跑的后台任务不算进父会话的收尾清单', async () => {
    const ctx = await setup();
    await ctx.childBash.execute('call-1', { command: 'sleep 30', background: true });
    await until(() => ctx.events.some((event) => event.type === 'task-started'));
    const internals = ctx.supervisor as unknown as {
      taskWrapUp(sessionId: string): string | undefined;
    };
    expect(internals.taskWrapUp(parent.sessionId)).toBeUndefined();
    await ctx.supervisor.shutdown();
  });

  describe('持有有上限、可被父会话打断', () => {
    let current: Awaited<ReturnType<typeof setup>> | undefined;
    afterEach(async () => {
      vi.useRealTimers();
      await current?.supervisor.shutdown();
      current = undefined;
    });

    /** 子代理 Run 开局；hold() 走完起了后台任务就结束的那一轮 */
    async function startRun() {
      const ctx = await setup();
      current = ctx;
      ctx.supervisor.handleCommand({
        type: 'prompt-child',
        identity: child,
        requestId: 'run-1',
        requestBudget: true,
        task: { text: 'start the server', images: [], fileMentions: [] },
      });
      const startTask = () =>
        ctx.childBash.execute('call-1', { command: 'sleep 30', background: true });
      const hold = async () => {
        await round(ctx.childSession, '服务已起，等它跑完', startTask);
        await until(() =>
          promptTexts(ctx.childSession).some((text) => text.includes('task_settle'))
        );
        await round(ctx.childSession, '还在等');
        expect(turnsCompleted(ctx.events).at(-1)).toMatchObject({ awaitingTasks: true });
      };
      return { ctx, startTask, hold };
    }

    /** 子会话被回收后不再有带 identity 的 task-ended，直接看任务表 */
    const taskEnded = (ctx: Awaited<ReturnType<typeof setup>>) =>
      (
        ctx.supervisor as unknown as {
          bgTasks: { snapshot(sessionId: string): Array<{ status: string }> };
        }
      ).bgTasks
        .snapshot(child.sessionId)
        .every((task) => task.status !== 'running');

    it('任务一直不结束（常驻服务）：到时限唤醒子代理要它表态并交报告，那一轮结束 Run 收口', async () => {
      const { ctx, hold } = await startRun();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await hold();
      const before = ctx.childSession.prompt.mock.calls.length;

      vi.advanceTimersByTime(AGENT_RUN_HOLD_LIMIT_MS);
      const woken = promptTexts(ctx.childSession).slice(before).join('\n');
      expect(woken).toContain('task_settle');
      expect(woken).toContain('sleep 30');

      vi.useRealTimers();
      await round(ctx.childSession, '服务留着，报告如下');
      const last = turnsCompleted(ctx.events).at(-1);
      expect(last).toMatchObject({ continues: 'run-1' });
      expect(last).not.toHaveProperty('awaitingTasks');
    });

    it('持有中空闲时收到父会话的插话：开新一轮送达，不排进没人取的插话队列', async () => {
      const { ctx, hold } = await startRun();
      await hold();

      ctx.supervisor.handleCommand({ type: 'steer', identity: child, text: 'parent asks status' });
      await until(() =>
        promptTexts(ctx.childSession).some((text) => text.includes('parent asks status'))
      );
      await round(ctx.childSession, '状态是 Y');
      expect(turnsCompleted(ctx.events).at(-1)).toMatchObject({ continues: 'run-1' });
    });

    it('持有中被 abort（父会话 stop）：在等的后台任务一并停掉', async () => {
      const { ctx, hold } = await startRun();
      await hold();
      ctx.supervisor.handleCommand({ type: 'abort', identity: child });
      await until(() => taskEnded(ctx));
    });

    it('持有中被 dismiss：在等的后台任务一并停掉', async () => {
      const { ctx, hold } = await startRun();
      await hold();
      ctx.supervisor.handleCommand({ type: 'dismiss-child', parent, child });
      await until(() => taskEnded(ctx));
    });

    it('还没进入持有的回合被 abort：后台任务照旧留着，与根会话一致', async () => {
      const { ctx, startTask } = await startRun();
      ctx.childSession.emit({ type: 'agent_start' });
      await startTask();
      ctx.supervisor.handleCommand({ type: 'abort', identity: child });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(taskEnded(ctx)).toBe(false);
    });
  });

  async function holdOnLongTask() {
    const ctx = await setup();
    ctx.supervisor.handleCommand({
      type: 'prompt-child',
      identity: child,
      requestId: 'run-1',
      requestBudget: true,
      task: { text: 'start the server', images: [], fileMentions: [] },
    });
    await round(ctx.childSession, '服务已起', () =>
      ctx.childBash.execute('call-1', { command: 'sleep 30', background: true })
    );
    expect(turnsCompleted(ctx.events).at(-1)).toMatchObject({
      turnId: 'run-1',
      awaitingTasks: true,
    });
    const started = ctx.events.find((event) => event.type === 'task-started');
    const taskId = started && 'task' in started ? started.task.taskId : '';
    return { ...ctx, taskId };
  }

  /** 第一次持有的提醒已交给子代理、它答完又空闲下来：真正空闲的持有态 */
  async function idleHold() {
    const ctx = await holdOnLongTask();
    await until(
      () => promptTexts(ctx.childSession).some((text) => text.includes('task_settle')),
      2000
    );
    await round(ctx.childSession, '还在等');
    expect(turnsCompleted(ctx.events).at(-1)).toMatchObject({ awaitingTasks: true });
    return ctx;
  }

  it('第一次进入持有时提醒并唤醒子代理一次；同一批任务再次结束回合不再唤醒，keep 之后 Run 收口', async () => {
    const ctx = await holdOnLongTask();
    const nudges = () =>
      promptTexts(ctx.childSession).filter(
        (text) => text.includes(ctx.taskId) && text.includes('task_settle')
      );
    await until(() => nudges().length === 1, 2000);

    await round(ctx.childSession, '还在等构建');
    expect(turnsCompleted(ctx.events).at(-1)).toMatchObject({
      continues: 'run-1',
      awaitingTasks: true,
    });
    const prompts = ctx.childSession.prompt.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(ctx.childSession.prompt.mock.calls.length).toBe(prompts);

    const settleTool = ctx.childTools.find((tool) => tool.name === 'task_settle');
    await round(ctx.childSession, '服务留着给用户看', () =>
      (settleTool as Tool).execute('call-2', {
        tasks: [{ taskId: ctx.taskId, action: 'keep', reason: 'dev server' }],
      })
    );
    const last = turnsCompleted(ctx.events).at(-1);
    expect(last).toMatchObject({ continues: 'run-1' });
    expect(last).not.toHaveProperty('awaitingTasks');
    await ctx.supervisor.shutdown();
  });

  it('只读子代理没有 task 工具；非只读子代理有，且只看得到、停得了自己起的任务', async () => {
    const readonly = await setup('readonly');
    expect(
      readonly.childTools.map((tool) => tool.name).filter((name) => name.startsWith('task_'))
    ).toEqual([]);
    await readonly.supervisor.shutdown();
    mocks.sessions.length = 0;
    mocks.loaderOptions.length = 0;
    mocks.createAgentSession.mockClear();

    const ctx = await setup();
    const tool = (name: string) => ctx.childTools.find((item) => item.name === name) as Tool;
    expect(['task_output', 'task_stop', 'task_settle'].every((name) => tool(name))).toBe(true);
    await ctx.parentBash.execute('call-p', { command: 'sleep 30', background: true });
    await ctx.childBash.execute('call-c', { command: 'sleep 30', background: true });
    await until(() => ctx.events.filter((event) => event.type === 'task-started').length === 2);
    const owners = new Map(
      ctx.events.flatMap((event) =>
        event.type === 'task-started' ? [[event.identity.sessionId, event.task.taskId]] : []
      )
    );
    const parentTask = owners.get(parent.sessionId) ?? '';
    const childTask = owners.get(child.sessionId) ?? '';

    await expect(tool('task_output').execute('o1', { taskId: parentTask })).rejects.toThrow(
      /unknown task/
    );
    await expect(tool('task_output').execute('o2', { taskId: childTask })).resolves.toBeDefined();
    expect(
      JSON.stringify(await tool('task_stop').execute('s1', { taskId: parentTask }))
    ).not.toContain('Stopped');
    expect(JSON.stringify(await tool('task_stop').execute('s2', { taskId: childTask }))).toContain(
      'Stopped'
    );
    await until(() =>
      ctx.events.some((event) => event.type === 'task-ended' && event.taskId === childTask)
    );
    expect(
      ctx.events.some((event) => event.type === 'task-ended' && event.taskId === parentTask)
    ).toBe(false);
    await ctx.supervisor.shutdown();
  });

  it('子代理的 task 工具碰不到兄弟子代理（含同名前缀）的任务，task_settle 也表态不了别人的任务', async () => {
    const ctx = await setup();
    const tool = (name: string) => ctx.childTools.find((item) => item.name === name) as Tool;
    const bgTasks = (
      ctx.supervisor as unknown as {
        bgTasks: {
          start(sessionId: string, command: string, cwd: string): string;
          taskInfo(taskId: string): { status: string; keep?: unknown } | undefined;
        };
      }
    ).bgTasks;
    const foreign = ['parent::cw-other', `${child.sessionId}2`, parent.sessionId].map((owner) =>
      bgTasks.start(owner, 'sleep 30', tmpdir())
    );

    for (const taskId of foreign) {
      await expect(tool('task_output').execute(`o-${taskId}`, { taskId })).rejects.toThrow(
        /unknown task/
      );
      expect(
        JSON.stringify(await tool('task_stop').execute(`s-${taskId}`, { taskId }))
      ).not.toContain('Stopped');
    }
    const settled = await tool('task_settle').execute('settle', {
      tasks: foreign.map((taskId, index) => ({
        taskId,
        action: index === 0 ? 'stop' : 'keep',
        reason: 'not mine',
      })),
    });
    const parsed = JSON.parse(
      (settled as { content: Array<{ text: string }> }).content[0]?.text ?? '{}'
    ) as { settled: Array<{ ok: boolean }> };
    expect(parsed.settled.map((entry) => entry.ok)).toEqual([false, false, false]);
    for (const taskId of foreign) {
      expect(bgTasks.taskInfo(taskId)).toMatchObject({ status: 'running' });
      expect(bgTasks.taskInfo(taskId)?.keep).toBeUndefined();
    }
    await ctx.supervisor.shutdown();
  });
});
