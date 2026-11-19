import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RESTART_CHECKPOINT_FILE, type RestartCheckpoint } from '@shared/gracefulRestart';
import type { AgentWorkerEvent } from '@shared/types/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundTaskManager } from './backgroundTasks';

const mocks = vi.hoisted(() => ({
  sessions: [] as Array<ReturnType<typeof fakeSessionShape>>,
  prefill: [] as unknown[][],
  createAgentSession: vi.fn(),
  continueSessionActivity: vi.fn(async () => undefined),
}));

// 仅供 hoisted 声明类型
function fakeSessionShape() {
  return {} as {
    messages: unknown[];
    sessionFile: string;
    agent: {
      state: { messages: unknown[] };
      prepareNextTurnWithContext: (turn: unknown, signal?: AbortSignal) => Promise<unknown>;
    };
    nextTurnPrepared: ReturnType<typeof vi.fn>;
    prompt: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    emit(event: { type: string; [key: string]: unknown }): void;
  };
}

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

vi.mock('./sessionAdapter', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  continueSessionActivity: mocks.continueSessionActivity,
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
    resolveModel: vi.fn().mockRejectedValue(new Error('unexpected')),
    getAuth: vi.fn().mockResolvedValue(undefined),
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
const SESSION_FILE = '/tmp/enso-graceful-restart-session.jsonl';

function fakeSession(options: Record<string, unknown>) {
  const listeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
  const messages = mocks.prefill.shift() ?? [];
  const nextTurnPrepared = vi.fn(async () => undefined);
  const value = {
    model: options.model,
    resourceLoader: options.resourceLoader,
    sessionManager: options.sessionManager,
    messages,
    sessionFile: SESSION_FILE,
    agent: { state: { messages }, prepareNextTurnWithContext: nextTurnPrepared },
    nextTurnPrepared,
    pendingMessageCount: 0,
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
    activeTools: [] as string[],
    getActiveToolNames(this: { activeTools: string[] }) {
      return [...this.activeTools];
    },
    setActiveToolsByName: vi.fn(),
    navigateTree: vi.fn(async () => ({ cancelled: false })),
    isStreaming: false,
    isRetrying: false,
    isIdle: true,
  };
  mocks.sessions.push(value as unknown as ReturnType<typeof fakeSessionShape>);
  return value;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

async function waitFor(events: AgentWorkerEvent[], type: AgentWorkerEvent['type']): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (events.some((event) => event.type === type)) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${type}`);
}

const user = { role: 'user', content: [{ type: 'text', text: 'run probe' }], timestamp: 1 };
const assistantCall = {
  role: 'assistant',
  content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} }],
  stopReason: 'toolUse',
  timestamp: 2,
};
const toolResult = {
  role: 'toolResult',
  toolCallId: 'call-1',
  toolName: 'bash',
  isError: false,
  content: [{ type: 'text', text: 'probe done' }],
  timestamp: 3,
};

function ofType<T extends AgentWorkerEvent['type']>(events: AgentWorkerEvent[], type: T) {
  return events.filter(
    (event): event is Extract<AgentWorkerEvent, { type: T }> => event.type === type
  );
}

async function startSupervisor(dataDir: string, restartCheckpointFile?: string) {
  const events: AgentWorkerEvent[] = [];
  const supervisor = new SessionSupervisor({
    emit: (event) => events.push(event),
    agentDir: '/tmp/agent',
    sessionDir: path.join(dataDir, 'sessions'),
    dataDir,
    ...(restartCheckpointFile ? { restartCheckpointFile } : {}),
  });
  return { events, supervisor };
}

describe('SessionSupervisor graceful restart', () => {
  beforeEach(() => {
    mocks.sessions.length = 0;
    mocks.prefill.length = 0;
    mocks.continueSessionActivity.mockClear();
    mocks.createAgentSession.mockReset();
    mocks.createAgentSession.mockImplementation(async (options: Record<string, unknown>) => ({
      session: fakeSession(options),
    }));
  });

  it('空闲时立即落断点（await-user），不等任何事件', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'enso-graceful-idle-'));
    const { events, supervisor } = await startSupervisor(dataDir);
    supervisor.handleCommand({ type: 'spawn-parent', identity: parent, cwd: '/workspace', model });
    await waitFor(events, 'parent-ready');

    supervisor.handleCommand({ type: 'graceful-restart' });
    const [ready] = ofType(events, 'graceful-restart-ready');
    expect(ready?.checkpoint.sessions).toEqual([
      expect.objectContaining({ sessionId: 'parent', nextStep: 'await-user', turnId: null }),
    ]);
    expect(ofType(events, 'graceful-restart-deferred')).toEqual([]);
    await supervisor.shutdown();
  });

  it('流式回复中途：推迟到 turn-completed 之后才落断点', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'enso-graceful-stream-'));
    const { events, supervisor } = await startSupervisor(dataDir);
    supervisor.handleCommand({ type: 'spawn-parent', identity: parent, cwd: '/workspace', model });
    await waitFor(events, 'parent-ready');
    const session = mocks.sessions[0];
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'turn_start' });
    session.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });

    supervisor.handleCommand({ type: 'graceful-restart' });
    await settle();
    expect(ofType(events, 'graceful-restart-deferred').at(-1)?.sessions).toEqual([
      { identity: parent, reason: 'turn-in-progress', toolsInFlight: [] },
    ]);
    expect(ofType(events, 'graceful-restart-ready')).toEqual([]);

    const reply = {
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      stopReason: 'stop',
      timestamp: 4,
    };
    session.messages.push(user, reply);
    session.emit({ type: 'message_end', message: reply });
    session.emit({ type: 'turn_end', message: reply, toolResults: [] });
    session.emit({ type: 'agent_end', messages: [reply] });
    session.emit({ type: 'agent_settled' });
    await settle();
    const completed = events.findIndex((event) => event.type === 'turn-completed');
    const ready = events.findIndex((event) => event.type === 'graceful-restart-ready');
    expect(completed).toBeGreaterThan(-1);
    expect(ready).toBeGreaterThan(completed);
    expect(ofType(events, 'graceful-restart-ready')[0]?.checkpoint.sessions[0]).toMatchObject({
      nextStep: 'await-user',
      turnId: null,
    });
    await supervisor.shutdown();
  });

  it('工具进行中推迟；工具结束后在下一次模型请求前落断点；新进程同一轮续跑、不重做工具', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'enso-graceful-tool-'));
    const first = await startSupervisor(dataDir);
    first.supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
    });
    await waitFor(first.events, 'parent-ready');
    const session = mocks.sessions[0];
    session.messages.push(user);
    session.emit({ type: 'agent_start' });
    const turnId = ofType(first.events, 'status').find((event) => event.turnId)?.turnId;
    expect(turnId).toBeTruthy();
    session.messages.push(assistantCall);
    session.emit({ type: 'message_end', message: assistantCall });
    session.emit({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash' });

    // 第 2 条：工具在跑，请求挂起，不落断点
    first.supervisor.handleCommand({ type: 'graceful-restart' });
    await settle();
    expect(ofType(first.events, 'graceful-restart-deferred').at(-1)?.sessions).toEqual([
      { identity: parent, reason: 'tool-in-flight', toolsInFlight: ['call-1'] },
    ]);
    expect(ofType(first.events, 'graceful-restart-ready')).toEqual([]);
    expect(existsSync(path.join(dataDir, RESTART_CHECKPOINT_FILE))).toBe(false);

    session.messages.push(toolResult);
    session.emit({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'bash' });
    session.emit({ type: 'message_end', message: toolResult });
    session.emit({ type: 'turn_end', message: assistantCall, toolResults: [toolResult] });
    await settle();
    expect(ofType(first.events, 'graceful-restart-ready')).toEqual([]);

    // 第 3 条：pi 进入下一次模型请求前的 prepareNextTurn，就地挂起并落断点
    let proceeded = false;
    void session.agent.prepareNextTurnWithContext({}, undefined).then(() => {
      proceeded = true;
    });
    await settle();
    const [ready] = ofType(first.events, 'graceful-restart-ready');
    const expected = {
      sessionId: 'parent',
      generation: parent.generation,
      sessionFile: SESSION_FILE,
      nextStep: 'model-request',
      turnId,
      lastCompletedToolCallId: 'call-1',
      messageCount: 3,
      toolsInFlight: [],
    };
    expect(ready?.checkpoint.sessions).toEqual([expect.objectContaining(expected)]);
    const onDisk = JSON.parse(
      readFileSync(path.join(dataDir, RESTART_CHECKPOINT_FILE), 'utf8')
    ) as RestartCheckpoint;
    expect(onDisk).toEqual(ready?.checkpoint);
    expect(proceeded).toBe(false);
    expect(session.nextTurnPrepared).not.toHaveBeenCalled();
    expect(ofType(first.events, 'turn-completed')).toEqual([]);
    await first.supervisor.shutdown();
    expect(session.abort).not.toHaveBeenCalled();

    // 第 4 条：新进程接管断点，续跑同一轮
    mocks.prefill.push([user, assistantCall, toolResult]);
    const second = await startSupervisor(dataDir, path.join(dataDir, RESTART_CHECKPOINT_FILE));
    expect(existsSync(path.join(dataDir, RESTART_CHECKPOINT_FILE))).toBe(false);
    second.supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
      resumeFile: SESSION_FILE,
    });
    await waitFor(second.events, 'parent-ready');
    const resumed = mocks.sessions[1];
    const seqAtCheckpoint = ready?.checkpoint.sessions[0]?.seq ?? Number.POSITIVE_INFINITY;
    expect(ofType(second.events, 'parent-ready')[0]?.seq).toBeGreaterThan(seqAtCheckpoint);
    expect(mocks.continueSessionActivity).toHaveBeenCalledTimes(1);
    expect(mocks.continueSessionActivity).toHaveBeenCalledWith(resumed);
    expect(resumed.prompt).not.toHaveBeenCalled();

    resumed.emit({ type: 'agent_start' });
    resumed.emit({ type: 'turn_start' });
    const final = {
      role: 'assistant',
      content: [{ type: 'text', text: 'probe done, all good' }],
      stopReason: 'stop',
      timestamp: 5,
    };
    resumed.messages.push(final);
    resumed.emit({ type: 'message_end', message: final });
    resumed.emit({ type: 'turn_end', message: final, toolResults: [] });
    resumed.emit({ type: 'agent_end', messages: [final] });
    resumed.emit({ type: 'agent_settled' });
    await settle();
    expect(ofType(second.events, 'status').find((event) => event.turnId)?.turnId).toBe(turnId);
    expect(ofType(second.events, 'turn-completed').map((event) => event.turnId)).toEqual([turnId]);
    expect(
      ofType(second.events, 'tool-output').filter((event) => event.toolCallId === 'call-1')
    ).toEqual([]);
    await second.supervisor.shutdown();
  });

  it('别的会话有工具在跑时，不在边界上挂起（防止互相等待）', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'enso-graceful-two-'));
    const { events, supervisor } = await startSupervisor(dataDir);
    const other = { sessionId: 'other', generation: '22222222-2222-4222-8222-222222222222' };
    supervisor.handleCommand({ type: 'spawn-parent', identity: parent, cwd: '/workspace', model });
    supervisor.handleCommand({ type: 'spawn-parent', identity: other, cwd: '/workspace', model });
    await waitFor(events, 'parent-ready');
    for (let i = 0; i < 40 && ofType(events, 'parent-ready').length < 2; i++) await settle();
    const [first, second] = mocks.sessions;
    first.emit({ type: 'agent_start' });
    second.emit({ type: 'agent_start' });
    second.emit({ type: 'tool_execution_start', toolCallId: 'delegate-1', toolName: 'delegate' });
    supervisor.handleCommand({ type: 'graceful-restart' });

    await first.agent.prepareNextTurnWithContext({}, undefined);
    expect(first.nextTurnPrepared).toHaveBeenCalledTimes(1);
    expect(ofType(events, 'graceful-restart-ready')).toEqual([]);
    await supervisor.shutdown();
  });

  it('前台命令转后台后进程还在：不算安全点；进程结束、完成通知落下后才落断点', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'enso-graceful-yield-'));
    const { events, supervisor } = await startSupervisor(dataDir);
    supervisor.handleCommand({ type: 'spawn-parent', identity: parent, cwd: '/workspace', model });
    await waitFor(events, 'parent-ready');
    const session = mocks.sessions[0];
    session.messages.push(user);
    session.emit({ type: 'agent_start' });
    session.messages.push(assistantCall);
    session.emit({ type: 'message_end', message: assistantCall });
    session.emit({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash' });
    // 让位到点：ForegroundCommand 把在跑进程交给 BackgroundTaskManager.adopt，工具立即回执
    const exit = Promise.withResolvers<number | null>();
    const bgTasks = (supervisor as unknown as { bgTasks: BackgroundTaskManager }).bgTasks;
    const taskId = bgTasks.adopt(
      'parent',
      { output: () => 'LONG-START\n', pipe: () => {}, done: exit.promise, kill: () => {} },
      { command: 'sleep 120', startedAt: Date.now() - 45_000 }
    );
    session.messages.push(toolResult);
    session.emit({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'bash' });
    session.emit({ type: 'message_end', message: toolResult });
    session.emit({ type: 'turn_end', message: assistantCall, toolResults: [toolResult] });

    supervisor.handleCommand({ type: 'graceful-restart' });
    void session.agent.prepareNextTurnWithContext({}, undefined);
    await settle();
    expect(ofType(events, 'graceful-restart-deferred').at(-1)?.sessions).toEqual([
      { identity: parent, reason: 'tool-in-flight', toolsInFlight: [taskId] },
    ]);
    expect(ofType(events, 'graceful-restart-ready')).toEqual([]);
    expect(existsSync(path.join(dataDir, RESTART_CHECKPOINT_FILE))).toBe(false);

    exit.resolve(0);
    await waitFor(events, 'graceful-restart-ready');
    const ended = events.findIndex((event) => event.type === 'task-ended');
    const ready = events.findIndex((event) => event.type === 'graceful-restart-ready');
    expect(ended).toBeGreaterThan(-1);
    expect(ready).toBeGreaterThan(ended);
    expect(ofType(events, 'graceful-restart-ready')[0]?.checkpoint.sessions).toEqual([
      expect.objectContaining({ nextStep: 'model-request', toolsInFlight: [] }),
    ]);
    // 完成通知不随旧进程丢掉：会话停在边界（running），通知进了持久化的待投递队列
    const reminders = (
      supervisor as unknown as {
        sessions: Map<string, { pendingTaskReminders: string[] }>;
      }
    ).sessions.get('parent')?.pendingTaskReminders;
    expect(reminders?.join('\n')).toContain(taskId);
    await supervisor.shutdown();
  });

  it('等转后台命令时 worker 被终止（强制退出）：停掉命令、等它收口后照样落断点', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'enso-graceful-yield-force-'));
    const { events, supervisor } = await startSupervisor(dataDir);
    supervisor.handleCommand({ type: 'spawn-parent', identity: parent, cwd: '/workspace', model });
    await waitFor(events, 'parent-ready');
    const session = mocks.sessions[0];
    session.messages.push(user, assistantCall);
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash' });
    const exit = Promise.withResolvers<number | null>();
    const bgTasks = (supervisor as unknown as { bgTasks: BackgroundTaskManager }).bgTasks;
    const taskId = bgTasks.adopt(
      'parent',
      { output: () => '', pipe: () => {}, done: exit.promise, kill: () => exit.resolve(null) },
      { command: 'sleep 120', startedAt: Date.now() - 45_000 }
    );
    session.messages.push(toolResult);
    session.emit({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'bash' });
    session.emit({ type: 'turn_end', message: assistantCall, toolResults: [toolResult] });
    supervisor.handleCommand({ type: 'graceful-restart' });
    void session.agent.prepareNextTurnWithContext({}, undefined);
    await settle();
    expect(ofType(events, 'graceful-restart-ready')).toEqual([]);

    await supervisor.shutdown();
    const checkpoint = JSON.parse(
      readFileSync(path.join(dataDir, RESTART_CHECKPOINT_FILE), 'utf8')
    ) as RestartCheckpoint;
    expect(checkpoint.sessions).toEqual([
      expect.objectContaining({ nextStep: 'model-request', toolsInFlight: [] }),
    ]);
    // 落了断点就不再中断会话：被挂起的 loop 不会写进会话文件
    expect(session.abort).not.toHaveBeenCalled();
    expect(ofType(events, 'task-ended').map((event) => event.taskId)).toEqual([taskId]);
  });

  it('已经结束的后台任务不挡安全点', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'enso-graceful-yield-done-'));
    const { events, supervisor } = await startSupervisor(dataDir);
    supervisor.handleCommand({ type: 'spawn-parent', identity: parent, cwd: '/workspace', model });
    await waitFor(events, 'parent-ready');
    const bgTasks = (supervisor as unknown as { bgTasks: BackgroundTaskManager }).bgTasks;
    bgTasks.adopt(
      'parent',
      { output: () => '', pipe: () => {}, done: Promise.resolve(0), kill: () => {} },
      { command: 'sleep 1', startedAt: Date.now() - 45_000 }
    );
    await waitFor(events, 'task-ended');
    // 完成通知去抖后投递完（空闲会话被唤起又收口）
    await new Promise((resolve) => setTimeout(resolve, 300));

    supervisor.handleCommand({ type: 'graceful-restart' });
    await settle();
    expect(ofType(events, 'graceful-restart-ready')[0]?.checkpoint.sessions).toEqual([
      expect.objectContaining({ sessionId: 'parent', toolsInFlight: [] }),
    ]);
    await supervisor.shutdown();
  });
});
