import { rmSync } from 'node:fs';
import type { AgentWorkerEvent, SessionIdentity } from '@shared/types/agent';
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
    messages: [] as Record<string, unknown>[],
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

interface CoworkerToolLike {
  execute(
    id: string,
    params: Record<string, unknown>,
    a?: unknown,
    b?: unknown,
    c?: unknown
  ): Promise<{ content: Array<{ type: string; text: string }> }>;
}

async function textOf(
  result: Promise<{ content: Array<{ type: string; text: string }> }>
): Promise<string> {
  const r = await result;
  return (r.content[0] as { text: string }).text;
}

/** 常规起手式：spawn 一个父会话 + 一个名为 bob 的 coworker（首轮任务不驱动完成态）。 */
async function spawnParentAndCoworker(events: AgentWorkerEvent[]) {
  const supervisor = new SessionSupervisor({
    emit: (event) => events.push(event),
    agentDir: '/tmp/agent',
    sessionDir: '/tmp/sessions',
  });
  supervisor.handleCommand({ type: 'spawn-parent', identity: parent, cwd: '/workspace', model });
  await settle();
  const parentSession = mocks.sessions[0] as ReturnType<typeof session>;
  const parentOptions = mocks.createAgentSession.mock.calls[0][0] as {
    customTools: CoworkerToolLike[];
  };
  const coworkerTool = parentOptions.customTools.find(
    (tool) => (tool as unknown as { name: string }).name === 'coworker'
  ) as unknown as CoworkerToolLike;

  await coworkerTool.execute(
    't1',
    { operation: 'spawn', name: 'bob', task: 'first task' },
    undefined,
    undefined,
    {} as never
  );
  await settle();
  const coworkerSession = mocks.sessions[1] as ReturnType<typeof session>;
  const coworkerId = 'parent::cw-bob';
  const statusEvent = events.find(
    (event) =>
      event.type === 'status' &&
      (event as { identity: SessionIdentity }).identity.sessionId === coworkerId
  ) as { identity: SessionIdentity } | undefined;
  const coworkerIdentity = statusEvent?.identity as SessionIdentity;
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
  return {
    supervisor,
    parentSession,
    coworkerTool,
    coworkerSession,
    coworkerId,
    coworkerIdentity,
    childOptions,
  };
}

describe('SessionSupervisor coworker wait/report', () => {
  beforeEach(() => {
    mocks.sessions.length = 0;
    mocks.managers.length = 0;
    mocks.createAgentSession.mockReset();
    rmSync('/tmp/sessions', { recursive: true, force: true });
    mocks.mcpToolsFor.mockReset().mockResolvedValue([]);
    mocks.createAgentSession.mockImplementation(async (options: Record<string, unknown>) => ({
      session: session(options),
    }));
    // 本文件多个用例会触发 ParentNotifier 的非紧急通知(真实 setTimeout 去抖),
    // 且每个 supervisor 都会起自己的 evictionTimer(真实 setInterval,测试从不 shutdown);
    // 全部假掉并在 afterEach 清空,避免残留定时器泄漏到后续测试文件的事件循环里。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('对没有跑过一轮的空闲 coworker 调用 wait,返回文案含 no round completed yet', async () => {
    const events: AgentWorkerEvent[] = [];
    const { coworkerTool } = await spawnParentAndCoworker(events);

    const text = await textOf(
      coworkerTool.execute(
        't1',
        { operation: 'wait', name: 'bob' },
        undefined,
        undefined,
        {} as never
      )
    );
    expect(text).toMatch(/no round completed yet/);
  });

  it('对没有跑过一轮的空闲 coworker 调用 report,返回文案含 no round completed yet', async () => {
    const events: AgentWorkerEvent[] = [];
    const { coworkerTool } = await spawnParentAndCoworker(events);

    const text = await textOf(
      coworkerTool.execute(
        't1',
        { operation: 'report', name: 'bob' },
        undefined,
        undefined,
        {} as never
      )
    );
    expect(text).toMatch(/no round completed yet/);
  });

  it('running 期间 wait 阻塞,agent_end(willRetry=false) 后以最后一条 assistant 文本resolve', async () => {
    const events: AgentWorkerEvent[] = [];
    const { coworkerTool, coworkerSession } = await spawnParentAndCoworker(events);

    coworkerSession.emit({ type: 'agent_start' });
    const waitPromise = textOf(
      coworkerTool.execute(
        't1',
        { operation: 'wait', name: 'bob' },
        undefined,
        undefined,
        {} as never
      )
    );

    coworkerSession.messages.push({ role: 'assistant', content: 'round result text' });
    coworkerSession.emit({ type: 'agent_end', willRetry: false });

    const text = await waitPromise;
    expect(text).toMatch(/round result text/);
  });

  it('agent_end(willRetry=true) 不 resolve wait,随后终态 agent_end 才 resolve', async () => {
    const events: AgentWorkerEvent[] = [];
    const { coworkerTool, coworkerSession } = await spawnParentAndCoworker(events);

    coworkerSession.emit({ type: 'agent_start' });
    let resolved = false;
    const waitPromise = textOf(
      coworkerTool.execute(
        't1',
        { operation: 'wait', name: 'bob' },
        undefined,
        undefined,
        {} as never
      )
    ).then((text) => {
      resolved = true;
      return text;
    });

    coworkerSession.emit({ type: 'agent_end', willRetry: true });
    await settle();
    expect(resolved).toBe(false);

    coworkerSession.messages.push({ role: 'assistant', content: 'final text' });
    coworkerSession.emit({ type: 'agent_end', willRetry: false });
    const text = await waitPromise;
    expect(resolved).toBe(true);
    expect(text).toMatch(/final text/);
  });

  it('wait 阻塞期间 dismiss-coworker 会 resolve wait,不会挂起', async () => {
    const events: AgentWorkerEvent[] = [];
    const { coworkerTool, coworkerSession, supervisor } = await spawnParentAndCoworker(events);

    coworkerSession.emit({ type: 'agent_start' });
    const waitPromise = textOf(
      coworkerTool.execute(
        't1',
        { operation: 'wait', name: 'bob' },
        undefined,
        undefined,
        {} as never
      )
    );

    supervisor.handleCommand({
      type: 'dismiss-coworker',
      parent,
      coworkerId: 'parent::cw-bob',
    });

    await expect(waitPromise).resolves.toEqual(expect.any(String));
  });

  it('用户在 coworker 自己的 tab 里直接 prompt 完成一轮后,report 也能取到该轮文本', async () => {
    const events: AgentWorkerEvent[] = [];
    const { coworkerTool, coworkerSession, coworkerIdentity, supervisor } =
      await spawnParentAndCoworker(events);
    expect(coworkerIdentity).toBeDefined();

    supervisor.handleCommand({
      type: 'prompt',
      identity: coworkerIdentity,
      text: 'user typed directly in the coworker tab',
    });
    await settle();

    coworkerSession.emit({ type: 'agent_start' });
    coworkerSession.messages.push({ role: 'assistant', content: 'answer from user-driven round' });
    coworkerSession.emit({ type: 'agent_end', willRetry: false });

    const text = await textOf(
      coworkerTool.execute(
        't1',
        { operation: 'report', name: 'bob' },
        undefined,
        undefined,
        {} as never
      )
    );
    expect(text).toMatch(/answer from user-driven round/);
  });

  it('父在 wait 阻塞期间,coworker 的 message_main_agent 返回含 waiting 的文案且不触发 notify', async () => {
    const events: AgentWorkerEvent[] = [];
    const { coworkerTool, coworkerSession, parentSession, childOptions } =
      await spawnParentAndCoworker(events);
    const messageMain = childOptions.customTools.find((tool) => tool.name === 'message_main_agent');
    expect(messageMain).toBeDefined();

    coworkerSession.emit({ type: 'agent_start' });
    // 不 await：只需要 wait 内部同步部分把 parentWaiting 置 true
    const waitPromise = textOf(
      coworkerTool.execute(
        't1',
        { operation: 'wait', name: 'bob' },
        undefined,
        undefined,
        {} as never
      )
    );

    const result = (await messageMain!.execute(
      'call',
      { message: 'progress note', urgent: true },
      undefined
    )) as { content: Array<{ text: string }> };
    const text = result.content[0].text;
    expect(parentSession.prompt).not.toHaveBeenCalled();
    expect(text).toMatch(/waiting/);

    coworkerSession.messages.push({ role: 'assistant', content: 'done' });
    coworkerSession.emit({ type: 'agent_end', willRetry: false });
    await waitPromise;

    // wait 已结束,parentWaiting 复位;此时同样的 urgent 消息应正常触达父
    const result2 = (await messageMain!.execute(
      'call2',
      { message: 'after wait', urgent: true },
      undefined
    )) as { content: Array<{ text: string }> };
    expect(parentSession.prompt).toHaveBeenCalled();
    expect((result2.content[0] as { text: string }).text).not.toMatch(/waiting/);
  });
});
