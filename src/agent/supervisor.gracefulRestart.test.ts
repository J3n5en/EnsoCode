import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RESTART_CHECKPOINT_FILE, type RestartCheckpoint } from '@shared/gracefulRestart';
import type { AgentWorkerEvent } from '@shared/types/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wakeColdRestartSession } from '../main/services/coldRestart';
import { buildRestartManifest } from '../main/services/restartManifest';
import type { BackgroundTaskManager } from './backgroundTasks';
import {
  DETACHED_TASKS_FILE,
  type DetachedTaskRecord,
  INTERRUPTED_TASKS_FILE,
  writeDetachedTasksManifest,
} from './detachedTasksManifest';
import { runFiles } from './shell/detachedRun';

const mocks = vi.hoisted(() => ({
  sessions: [] as Array<ReturnType<typeof fakeSessionShape>>,
  prefill: [] as unknown[][],
  createAgentSession: vi.fn(),
  continueSessionActivity: vi.fn(async () => undefined),
  editUnfinishedAssistantForResume: vi.fn(
    (session: {
      agent: { state: { messages: Array<{ role?: string; stopReason?: string }> } };
    }) => {
      const last = session.agent.state.messages.at(-1);
      if (last?.role !== 'assistant' || last.stopReason !== 'aborted') return false;
      session.agent.state.messages.pop();
      return true;
    }
  ),
}));

// 仅供 hoisted 声明类型
function fakeSessionShape() {
  return {} as {
    messages: unknown[];
    sessionFile: string;
    isStreaming: boolean;
    agent: {
      state: { messages: unknown[] };
      prepareRequest: (turn: unknown, signal?: AbortSignal) => Promise<unknown>;
    };
    requestPrepared: ReturnType<typeof vi.fn>;
    prompt: ReturnType<typeof vi.fn>;
    steer: ReturnType<typeof vi.fn>;
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
  editUnfinishedAssistantForResume: mocks.editUnfinishedAssistantForResume,
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
  const requestPrepared = vi.fn(async () => undefined);
  const value = {
    model: options.model,
    resourceLoader: options.resourceLoader,
    sessionManager: options.sessionManager,
    messages,
    sessionFile: SESSION_FILE,
    agent: { state: { messages }, prepareRequest: requestPrepared },
    requestPrepared,
    pendingMessageCount: 0,
    getFollowUpMessages: () => [],
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
      {
        identity: parent,
        reason: 'turn-in-progress',
        toolsInFlight: [],
        reply: { requestStartMs: expect.any(Number) },
      },
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
      {
        identity: parent,
        reason: 'tool-in-flight',
        toolsInFlight: ['call-1'],
        toolNames: ['bash'],
      },
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
    void session.agent.prepareRequest({}, undefined).then(() => {
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
    expect(session.requestPrepared).not.toHaveBeenCalled();
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

  it('回复写到一半等不到安全点被中止（This operation was aborted）：断点记成 model-request，新进程拿掉中止的回复同一轮续跑', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'enso-graceful-abort-stream-'));
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
    session.emit({ type: 'turn_start' });
    session.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    const turnId = ofType(first.events, 'status').find((event) => event.turnId)?.turnId;
    expect(turnId).toBeTruthy();

    first.supervisor.handleCommand({ type: 'graceful-restart' });
    await settle();
    expect(ofType(first.events, 'graceful-restart-deferred').at(-1)?.sessions).toEqual([
      {
        identity: parent,
        reason: 'turn-in-progress',
        toolsInFlight: [],
        reply: { requestStartMs: expect.any(Number) },
      },
    ]);

    // Main 等安全点超时后终止 worker：收尾中止模型请求，pi 写下 stopReason=aborted 的半截回复
    const abortedReply = {
      role: 'assistant',
      content: [{ type: 'text', text: '先看一下' }],
      stopReason: 'aborted',
      errorMessage: 'This operation was aborted',
      timestamp: 4,
    };
    session.abort.mockImplementation(async () => {
      await Promise.resolve();
      session.messages.push(abortedReply);
      session.emit({ type: 'message_end', message: abortedReply });
      session.emit({ type: 'turn_end', message: abortedReply, toolResults: [] });
      session.emit({ type: 'agent_end', messages: [abortedReply] });
      session.emit({ type: 'agent_settled' });
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await first.supervisor.shutdown();
    expect(session.abort).toHaveBeenCalled();
    const [ready] = ofType(first.events, 'graceful-restart-ready');
    expect(ready?.checkpoint.sessions).toEqual([
      expect.objectContaining({
        sessionId: 'parent',
        nextStep: 'model-request',
        turnId,
        toolsInFlight: [],
        messageCount: 2,
      }),
    ]);
    expect(log.mock.calls.flat().join('\n')).toContain('parent 回复写到一半被重启中止');
    log.mockRestore();
    // Main 据此写的清单冷启动会主动续跑
    const manifest = buildRestartManifest({
      reason: 'update',
      checkpoint: ready!.checkpoint,
      settingsOf: () => ({ providerId: 'p', modelId: 'm', cwd: '/workspace' }),
    });
    expect(manifest.sessions.map((entry) => entry.nextStep)).toEqual(['model-request']);

    mocks.prefill.push([user, abortedReply]);
    const second = await startSupervisor(dataDir, path.join(dataDir, RESTART_CHECKPOINT_FILE));
    second.supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
      resumeFile: SESSION_FILE,
    });
    await waitFor(second.events, 'parent-ready');
    const resumed = mocks.sessions[1];
    expect(mocks.editUnfinishedAssistantForResume).toHaveBeenCalledWith(resumed);
    expect(resumed.agent.state.messages).toEqual([user]);
    expect(mocks.continueSessionActivity).toHaveBeenCalledExactlyOnceWith(resumed);
    expect(resumed.prompt).not.toHaveBeenCalled();
    resumed.emit({ type: 'agent_start' });
    expect(ofType(second.events, 'status').find((event) => event.turnId)?.turnId).toBe(turnId);
    await second.supervisor.shutdown();
  });

  it('回复在写：推迟报告带请求发出 / 首 token / 最近出 token 时刻并按秒重报，写完时计时随消息落盘', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(1_000_000);
      const dataDir = mkdtempSync(path.join(tmpdir(), 'enso-graceful-reply-progress-'));
      const { events, supervisor } = await startSupervisor(dataDir);
      supervisor.handleCommand({
        type: 'spawn-parent',
        identity: parent,
        cwd: '/workspace',
        model,
      });
      await waitFor(events, 'parent-ready');
      const session = mocks.sessions[0];
      session.messages.push(user);
      session.emit({ type: 'agent_start' });
      session.emit({ type: 'turn_start' });
      session.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
      supervisor.handleCommand({ type: 'graceful-restart' });
      await settle();
      const reports = () =>
        ofType(events, 'graceful-restart-deferred').map((event) => event.sessions[0]?.reply);
      expect(reports().at(-1)).toEqual({ requestStartMs: 1_000_000 });

      const partial = (text: string) => ({
        role: 'assistant',
        content: [{ type: 'text', text }],
        stopReason: 'pending',
      });
      const token = async (at: number, text: string) => {
        vi.setSystemTime(at);
        session.emit({ type: 'message_update', message: partial(text) });
        await settle();
      };
      await token(1_002_000, '先');
      expect(reports().at(-1)).toEqual({
        requestStartMs: 1_000_000,
        firstTokenMs: 1_002_000,
        lastOutputMs: 1_002_000,
      });
      const count = reports().length;
      // 同一秒里的新 token 不重报，进下一秒才带着最新时刻重报
      await token(1_002_400, '先看');
      expect(reports()).toHaveLength(count);
      await token(1_003_100, '先看一');
      expect(reports()).toHaveLength(count + 1);
      expect(reports().at(-1)?.lastOutputMs).toBe(1_003_100);

      const done = { ...partial('先看一下'), stopReason: 'stop' } as Record<string, unknown>;
      vi.setSystemTime(1_005_000);
      session.emit({ type: 'message_end', message: done });
      await settle();
      // pi 在监听者之后才落盘这条消息：计时已挂在它上面
      expect(done.timing).toMatchObject({
        stepStartMs: 1_000_000,
        firstTokenMs: 1_002_000,
        completedMs: 1_005_000,
      });
      expect(reports().at(-1)).toBeUndefined();
      await supervisor.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('工具在跑时被中止（超过上限 / 强制退出）：不自动续跑，断点记成 await-user', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'enso-graceful-abort-tool-'));
    const { events, supervisor } = await startSupervisor(dataDir);
    supervisor.handleCommand({ type: 'spawn-parent', identity: parent, cwd: '/workspace', model });
    await waitFor(events, 'parent-ready');
    const session = mocks.sessions[0];
    session.messages.push(user, assistantCall);
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'message_end', message: assistantCall });
    session.emit({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash' });
    supervisor.handleCommand({ type: 'graceful-restart' });
    await settle();
    const abortedResult = {
      ...toolResult,
      isError: true,
      content: [{ type: 'text', text: 'aborted' }],
    };
    session.abort.mockImplementation(async () => {
      await Promise.resolve();
      session.messages.push(abortedResult);
      session.emit({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'bash' });
      session.emit({ type: 'message_end', message: abortedResult });
      session.emit({ type: 'agent_end', messages: [abortedResult] });
      session.emit({ type: 'agent_settled' });
    });
    await supervisor.shutdown();
    expect(ofType(events, 'graceful-restart-ready')[0]?.checkpoint.sessions).toEqual([
      expect.objectContaining({ sessionId: 'parent', nextStep: 'await-user', turnId: null }),
    ]);
  });

  it('父会话有工具在跑时子会话不挂起（subagent wait 正等它）；父会话开新工具时放开已挂起的子会话', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'enso-graceful-child-'));
    const { events, supervisor } = await startSupervisor(dataDir);
    const child = {
      sessionId: 'parent::cw-worker',
      generation: '22222222-2222-4222-8222-222222222222',
      parent,
      instanceId: '33333333-3333-4333-8333-333333333333',
      instanceName: 'worker-1',
      typeKey: 'builtin:worker' as const,
    };
    supervisor.handleCommand({ type: 'spawn-parent', identity: parent, cwd: '/workspace', model });
    await waitFor(events, 'parent-ready');
    supervisor.handleCommand({
      type: 'spawn-child',
      identity: child,
      cwd: '/workspace',
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
    await waitFor(events, 'child-ready');
    const [owner, worker] = mocks.sessions;
    owner.emit({ type: 'agent_start' });
    worker.emit({ type: 'agent_start' });
    owner.emit({ type: 'tool_execution_start', toolCallId: 'wait-1', toolName: 'subagent' });
    supervisor.handleCommand({ type: 'graceful-restart' });

    await worker.agent.prepareRequest({}, undefined);
    expect(worker.requestPrepared).toHaveBeenCalledTimes(1);

    // 父会话的工具结束、停在边界：子会话下一次模型请求前挂起
    owner.emit({ type: 'tool_execution_end', toolCallId: 'wait-1', toolName: 'subagent' });
    let ownerProceeded = false;
    void owner.agent.prepareRequest({}, undefined).then(() => {
      ownerProceeded = true;
    });
    let workerProceeded = false;
    void worker.agent.prepareRequest({}, undefined).then(() => {
      workerProceeded = true;
    });
    await settle();
    expect(ownerProceeded).toBe(false);
    expect(workerProceeded).toBe(false);
    await waitFor(events, 'graceful-restart-ready');
    expect(worker.requestPrepared).toHaveBeenCalledTimes(1);
    await supervisor.shutdown();
  });

  it('等安全点期间空闲会话收到新消息：消息先落盘、模型请求挂起，断点记成同一轮续跑', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'enso-graceful-fresh-'));
    const { events, supervisor } = await startSupervisor(dataDir);
    const other = { sessionId: 'other', generation: '22222222-2222-4222-8222-222222222222' };
    supervisor.handleCommand({ type: 'spawn-parent', identity: parent, cwd: '/workspace', model });
    supervisor.handleCommand({ type: 'spawn-parent', identity: other, cwd: '/workspace', model });
    for (let i = 0; i < 40 && ofType(events, 'parent-ready').length < 2; i++) await settle();
    const [idle, busy] = mocks.sessions;
    busy.emit({ type: 'agent_start' });
    busy.emit({ type: 'tool_execution_start', toolCallId: 'call-b', toolName: 'bash' });
    supervisor.handleCommand({ type: 'graceful-restart' });

    // goal 续跑 / 投递：pi 先写入 user 消息再在首个模型请求前进 prepareRequest
    supervisor.handleCommand({
      type: 'prompt',
      identity: parent,
      text: 'continue the goal',
      deliveryId: 'delivery-goal',
    });
    await settle();
    idle.messages.push(user);
    idle.emit({ type: 'agent_start' });
    let proceeded = false;
    void idle.agent.prepareRequest({}, undefined).then(() => {
      proceeded = true;
    });
    await settle();
    expect(proceeded).toBe(false);

    busy.messages.push(user, assistantCall, toolResult);
    busy.emit({ type: 'tool_execution_end', toolCallId: 'call-b', toolName: 'bash' });
    void busy.agent.prepareRequest({}, undefined);
    await waitFor(events, 'graceful-restart-ready');
    expect(proceeded).toBe(false);
    expect(idle.requestPrepared).not.toHaveBeenCalled();
    expect(ofType(events, 'graceful-restart-ready')[0]?.checkpoint.sessions).toEqual([
      expect.objectContaining({ sessionId: 'parent', nextStep: 'model-request' }),
      expect.objectContaining({ sessionId: 'other', nextStep: 'model-request' }),
    ]);
    await supervisor.shutdown();
  });

  it('只剩等人回答的提问挡着：取消提问（说明是重启打断），会话停到下一次模型请求前落断点', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'enso-graceful-ask-'));
    const { events, supervisor } = await startSupervisor(dataDir);
    supervisor.handleCommand({ type: 'spawn-parent', identity: parent, cwd: '/workspace', model });
    await waitFor(events, 'parent-ready');
    const session = mocks.sessions[0];
    const managed = (
      supervisor as unknown as {
        sessions: Map<string, { asks: { ask(question: string): Promise<string> } }>;
      }
    ).sessions.get('parent');
    session.messages.push(user, assistantCall);
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'ask_user' });
    const answer = managed?.asks.ask('which one?');
    supervisor.handleCommand({ type: 'graceful-restart' });
    await expect(answer).rejects.toThrow('The app restarted before the user answered');

    session.messages.push(toolResult);
    session.emit({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'ask_user' });
    void session.agent.prepareRequest({}, undefined);
    await waitFor(events, 'graceful-restart-ready');
    expect(ofType(events, 'graceful-restart-ready')[0]?.checkpoint.sessions).toEqual([
      expect.objectContaining({ sessionId: 'parent', nextStep: 'model-request' }),
    ]);
    await supervisor.shutdown();
  });

  it('两个会话交替跑工具：各自停在下一次模型请求前，不因对方有工具在跑就放行（活锁到 5 分钟上限）', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'enso-graceful-leapfrog-'));
    const { events, supervisor } = await startSupervisor(dataDir);
    const other = { sessionId: 'other', generation: '22222222-2222-4222-8222-222222222222' };
    supervisor.handleCommand({ type: 'spawn-parent', identity: parent, cwd: '/workspace', model });
    supervisor.handleCommand({ type: 'spawn-parent', identity: other, cwd: '/workspace', model });
    for (let i = 0; i < 40 && ofType(events, 'parent-ready').length < 2; i++) await settle();
    const [first, second] = mocks.sessions;
    first.messages.push(user, assistantCall, toolResult);
    second.messages.push(user, assistantCall);
    first.emit({ type: 'agent_start' });
    second.emit({ type: 'agent_start' });
    second.emit({ type: 'tool_execution_start', toolCallId: 'call-b', toolName: 'bash' });
    supervisor.handleCommand({ type: 'graceful-restart' });

    // 第一个会话的工具批跑完：哪怕另一个会话还有工具在跑，也停在这里，不再发下一次模型请求
    first.emit({ type: 'turn_end', message: assistantCall, toolResults: [toolResult] });
    let firstProceeded = false;
    void first.agent.prepareRequest({}, undefined).then(() => {
      firstProceeded = true;
    });
    await settle();
    expect(firstProceeded).toBe(false);
    expect(ofType(events, 'graceful-restart-ready')).toEqual([]);

    // 另一个会话的工具结束、到边界：两个都停住，立即落断点，都按同一轮续跑
    second.messages.push(toolResult);
    second.emit({ type: 'tool_execution_end', toolCallId: 'call-b', toolName: 'bash' });
    second.emit({ type: 'turn_end', message: assistantCall, toolResults: [toolResult] });
    void second.agent.prepareRequest({}, undefined);
    await waitFor(events, 'graceful-restart-ready');
    expect(firstProceeded).toBe(false);
    expect(first.requestPrepared).not.toHaveBeenCalled();
    expect(second.requestPrepared).not.toHaveBeenCalled();
    expect(ofType(events, 'graceful-restart-ready')[0]?.checkpoint.sessions).toEqual([
      expect.objectContaining({ sessionId: 'parent', nextStep: 'model-request' }),
      expect.objectContaining({ sessionId: 'other', nextStep: 'model-request' }),
    ]);
    await supervisor.shutdown();
  });

  it('停在边界后用户又插话：放开挂起让插话先写进会话文件，不按挂起时的边界落断点', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'enso-graceful-steer-'));
    const { events, supervisor } = await startSupervisor(dataDir);
    const other = { sessionId: 'other', generation: '22222222-2222-4222-8222-222222222222' };
    supervisor.handleCommand({ type: 'spawn-parent', identity: parent, cwd: '/workspace', model });
    supervisor.handleCommand({ type: 'spawn-parent', identity: other, cwd: '/workspace', model });
    for (let i = 0; i < 40 && ofType(events, 'parent-ready').length < 2; i++) await settle();
    const [session, busy] = mocks.sessions;
    // 另一个会话的回合还没结束：父会话停在边界也提交不了
    busy.emit({ type: 'agent_start' });
    session.messages.push(user, assistantCall, toolResult);
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'turn_end', message: assistantCall, toolResults: [toolResult] });
    supervisor.handleCommand({ type: 'graceful-restart' });
    let proceeded = false;
    void session.agent.prepareRequest({}, undefined).then(() => {
      proceeded = true;
    });
    await settle();
    expect(proceeded).toBe(false);
    expect(ofType(events, 'graceful-restart-ready')).toEqual([]);

    // 用户插话：pi 只放进内存队列，prepareNextTurn 返回后才写进 jsonl
    (session as unknown as { pendingMessageCount: number }).pendingMessageCount = 1;
    session.emit({ type: 'queue_update', steering: ['wait, also check X'], followUp: [] });
    // 阻塞消失，且没有新的 tool_execution_start
    busy.emit({ type: 'agent_end', messages: [] });
    busy.emit({ type: 'agent_settled' });
    await settle();
    expect(proceeded).toBe(true);
    expect(session.requestPrepared).toHaveBeenCalledTimes(1);
    expect(ofType(events, 'graceful-restart-ready')).toEqual([]);
    expect(existsSync(path.join(dataDir, RESTART_CHECKPOINT_FILE))).toBe(false);

    // pi 写入插话、跑完这一轮；之后空闲才落断点，会话文件里有这句话
    const steer = { role: 'user', content: [{ type: 'text', text: 'wait, also check X' }] };
    (session as unknown as { pendingMessageCount: number }).pendingMessageCount = 0;
    session.messages.push(steer);
    session.emit({ type: 'message_start', message: steer });
    session.emit({ type: 'message_end', message: steer });
    const reply = {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'stop',
    };
    session.messages.push(reply);
    session.emit({ type: 'message_end', message: reply });
    session.emit({ type: 'turn_end', message: reply, toolResults: [] });
    session.emit({ type: 'agent_end', messages: [steer, reply] });
    session.emit({ type: 'agent_settled' });
    await waitFor(events, 'graceful-restart-ready');
    const parentEntry = ofType(events, 'graceful-restart-ready')[0]?.checkpoint.sessions.find(
      (entry) => entry.sessionId === 'parent'
    );
    expect(parentEntry).toMatchObject({ nextStep: 'await-user', messageCount: 5 });
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
    void session.agent.prepareRequest({}, undefined);
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
    void session.agent.prepareRequest({}, undefined);
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

describe('SessionSupervisor 重启保留转后台命令', () => {
  const logDir = path.join('/tmp/agent', 'task-logs');
  // 通知补投走 150ms 的 setTimeout：用假时钟推进，真等会在高负载下和中间态断言赛跑
  const holdTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const releaseTimers = async () => {
    await vi.advanceTimersByTimeAsync(400);
    vi.useRealTimers();
  };
  afterEach(() => {
    vi.useRealTimers();
  });
  beforeEach(() => {
    mocks.sessions.length = 0;
    mocks.prefill.length = 0;
    mocks.createAgentSession.mockReset();
    mocks.createAgentSession.mockImplementation(async (options: Record<string, unknown>) => ({
      session: fakeSession(options),
    }));
  });

  /** 文件直写进程的句柄替身：release 返回已读偏移，不碰真实进程 */
  function fakeRun() {
    const runId = randomUUID();
    const files = runFiles(logDir, runId);
    return {
      runId,
      pid: 424242,
      startedAt: Date.now() - 50_000,
      cwd: '/workspace',
      outputFile: files.outputFile,
      exitFile: files.exitFile,
      sink: vi.fn(),
      flush: vi.fn(),
      readError: () => null,
      done: new Promise<never>(() => {}),
      kill: vi.fn(),
      release: vi.fn(() => 42),
    };
  }

  it('能脱离的转后台命令不挡安全点；脱离不了的照等并单独列出；交出后写清单、收尾不再停它', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'enso-graceful-keep-'));
    const { events, supervisor } = await startSupervisor(dataDir);
    supervisor.handleCommand({ type: 'spawn-parent', identity: parent, cwd: '/workspace', model });
    await waitFor(events, 'parent-ready');
    const session = mocks.sessions[0];
    session.messages.push(user, assistantCall);
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash' });
    const bgTasks = (supervisor as unknown as { bgTasks: BackgroundTaskManager }).bgTasks;
    const run = fakeRun();
    const detachedKill = vi.fn();
    const devServer = bgTasks.adopt(
      'parent',
      {
        output: () => 'ready on :5173\n',
        pipe: () => {},
        done: new Promise(() => {}),
        kill: detachedKill,
        detachable: () => run,
      },
      {
        command: 'API_TOKEN=tok-0123456789abcdef pnpm dev',
        startedAt: run.startedAt,
        cwd: '/workspace',
      }
    );
    const exit = Promise.withResolvers<number | null>();
    const remote = bgTasks.adopt(
      'parent',
      { output: () => '', pipe: () => {}, done: exit.promise, kill: () => exit.resolve(null) },
      { command: 'ssh box make', startedAt: Date.now() }
    );
    session.messages.push(toolResult);
    session.emit({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'bash' });
    session.emit({ type: 'turn_end', message: assistantCall, toolResults: [toolResult] });

    supervisor.handleCommand({ type: 'graceful-restart', keepBackgroundTasks: true });
    void session.agent.prepareRequest({}, undefined);
    await settle();
    expect(ofType(events, 'graceful-restart-deferred').at(-1)?.sessions).toEqual([
      {
        identity: parent,
        reason: 'tool-in-flight',
        toolsInFlight: [remote],
        undetachableTasks: [remote],
      },
    ]);
    exit.resolve(0);
    await waitFor(events, 'graceful-restart-ready');

    supervisor.handleCommand({ type: 'detach-background-tasks' });
    expect(ofType(events, 'background-tasks-detached')).toEqual([
      { type: 'background-tasks-detached', detached: 1 },
    ]);
    expect(run.release).toHaveBeenCalledTimes(1);
    const raw = readFileSync(path.join(dataDir, DETACHED_TASKS_FILE), 'utf8');
    expect(raw).not.toContain('tok-0123456789abcdef');
    expect(JSON.parse(raw).tasks).toEqual([
      expect.objectContaining({
        taskId: devServer,
        sessionId: 'parent',
        pid: 424242,
        runId: run.runId,
        outputOffset: 42,
        cwd: '/workspace',
      }),
    ]);
    await supervisor.shutdown();
    expect(detachedKill).not.toHaveBeenCalled();
    expect(run.kill).not.toHaveBeenCalled();
  });

  it('两处组合：停在边界被脱离不了的命令挡住时插话，命令结束后先写插话；只剩后台命令的空闲会话记成 await-user，唤醒能打开', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'enso-graceful-combo-'));
    const { events, supervisor } = await startSupervisor(dataDir);
    const other = { sessionId: 'other', generation: '22222222-2222-4222-8222-222222222222' };
    supervisor.handleCommand({ type: 'spawn-parent', identity: parent, cwd: '/workspace', model });
    supervisor.handleCommand({ type: 'spawn-parent', identity: other, cwd: '/workspace', model });
    for (let i = 0; i < 40 && ofType(events, 'parent-ready').length < 2; i++) await settle();
    const [session] = mocks.sessions;
    const bgTasks = (supervisor as unknown as { bgTasks: BackgroundTaskManager }).bgTasks;
    // other：回合早已结束，只剩一个能脱离的转后台命令（dev server）
    const run = fakeRun();
    const devServer = bgTasks.adopt(
      'other',
      {
        output: () => 'ready\n',
        pipe: () => {},
        done: new Promise(() => {}),
        kill: vi.fn(),
        detachable: () => run,
      },
      { command: 'pnpm dev', startedAt: run.startedAt, cwd: '/workspace' }
    );
    // parent：工具批结束停在边界，但还有一个脱离不了的转后台命令在跑
    session.messages.push(user, assistantCall);
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash' });
    const exit = Promise.withResolvers<number | null>();
    const remote = bgTasks.adopt(
      'parent',
      { output: () => '', pipe: () => {}, done: exit.promise, kill: () => exit.resolve(null) },
      { command: 'ssh box make', startedAt: Date.now() }
    );
    session.messages.push(toolResult);
    session.emit({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'bash' });
    session.emit({ type: 'turn_end', message: assistantCall, toolResults: [toolResult] });

    supervisor.handleCommand({ type: 'graceful-restart', keepBackgroundTasks: true });
    let proceeded = false;
    void session.agent.prepareRequest({}, undefined).then(() => {
      proceeded = true;
    });
    await settle();
    expect(ofType(events, 'graceful-restart-deferred').at(-1)?.sessions).toEqual([
      {
        identity: parent,
        reason: 'tool-in-flight',
        toolsInFlight: [remote],
        undetachableTasks: [remote],
      },
    ]);

    // 用户插话，然后挡着的命令结束，期间没有新的 tool_execution_start
    (session as unknown as { pendingMessageCount: number }).pendingMessageCount = 1;
    session.emit({ type: 'queue_update', steering: ['also run lint'], followUp: [] });
    exit.resolve(0);
    await waitFor(events, 'task-ended');
    await settle();
    expect(proceeded).toBe(true);
    expect(ofType(events, 'graceful-restart-ready')).toEqual([]);

    const steer = { role: 'user', content: [{ type: 'text', text: 'also run lint' }] };
    (session as unknown as { pendingMessageCount: number }).pendingMessageCount = 0;
    session.messages.push(steer);
    session.emit({ type: 'message_end', message: steer });
    const reply = {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'stop',
    };
    session.messages.push(reply);
    session.emit({ type: 'message_end', message: reply });
    session.emit({ type: 'turn_end', message: reply, toolResults: [] });
    session.emit({ type: 'agent_end', messages: [steer, reply] });
    session.emit({ type: 'agent_settled' });
    await waitFor(events, 'graceful-restart-ready');
    const checkpoint = ofType(events, 'graceful-restart-ready')[0]?.checkpoint;
    expect(checkpoint?.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: 'parent', nextStep: 'await-user', messageCount: 5 }),
        expect.objectContaining({ sessionId: 'other', nextStep: 'await-user', toolsInFlight: [] }),
      ])
    );

    // Main 据此写清单：只剩后台命令的空闲会话在清单里，命令结束时的唤醒能把它打开
    supervisor.handleCommand({ type: 'detach-background-tasks' });
    expect(JSON.parse(readFileSync(path.join(dataDir, DETACHED_TASKS_FILE), 'utf8')).tasks).toEqual(
      [expect.objectContaining({ taskId: devServer, sessionId: 'other' })]
    );
    const manifest = buildRestartManifest({
      reason: 'update',
      checkpoint: checkpoint as RestartCheckpoint,
      settingsOf: () => ({ providerId: 'p', modelId: 'm', cwd: '/workspace' }),
    });
    const resume = vi.fn(async () => ({ ok: true }));
    const plan = { checkpointFile: '', manifest, resume: [], children: [] };
    expect(await wakeColdRestartSession('other', resume, plan)).toEqual({ ok: true });
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'other' }));
    await supervisor.shutdown();
  });

  it('不要求保留时（普通退出）：转后台命令照旧要等', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'enso-graceful-nokeep-'));
    const { events, supervisor } = await startSupervisor(dataDir);
    supervisor.handleCommand({ type: 'spawn-parent', identity: parent, cwd: '/workspace', model });
    await waitFor(events, 'parent-ready');
    const bgTasks = (supervisor as unknown as { bgTasks: BackgroundTaskManager }).bgTasks;
    const taskId = bgTasks.adopt(
      'parent',
      {
        output: () => '',
        pipe: () => {},
        done: new Promise(() => {}),
        kill: () => {},
        detachable: () => fakeRun(),
      },
      { command: 'pnpm dev', startedAt: Date.now() }
    );
    supervisor.handleCommand({ type: 'graceful-restart' });
    await settle();
    expect(ofType(events, 'graceful-restart-deferred').at(-1)?.sessions).toEqual([
      { identity: parent, reason: 'tool-in-flight', toolsInFlight: [taskId] },
    ]);
    (supervisor as unknown as { bgTasks: BackgroundTaskManager }).bgTasks.detachForRestart();
    await supervisor.shutdown();
  });

  it('冷启动：已结束的任务按文件收尾，通知落盘等会话打开；会话打开时快照带上任务', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'enso-graceful-recover-'));
    mkdirSync(logDir, { recursive: true });
    const runId = randomUUID();
    const files = runFiles(logDir, runId);
    writeFileSync(files.outputFile, 'seen\nafter restart\n');
    writeFileSync(files.exitFile, '0');
    const taskId = `task-9-${Date.now().toString(36)}`;
    writeDetachedTasksManifest(path.join(dataDir, DETACHED_TASKS_FILE), {
      version: 1,
      writtenAt: Date.now(),
      workerPid: 1,
      tasks: [
        {
          taskId,
          sessionId: 'parent',
          command: 'pnpm build',
          commandKey: null,
          cwd: '/workspace',
          pid: spawnSync('true').pid as number,
          runId,
          startedAt: Date.now() - 60_000,
          yieldedAt: Date.now() - 50_000,
          deadlineAt: null,
          outputFile: files.outputFile,
          outputOffset: 5,
          exitCodeFile: files.exitFile,
          logPath: path.join(logDir, `${taskId}.log`),
        },
      ],
    });
    const { events, supervisor } = await startSupervisor(dataDir);
    holdTimers();
    expect(existsSync(path.join(dataDir, DETACHED_TASKS_FILE))).toBe(false);
    const pending = readFileSync(
      path.join(dataDir, 'sessions', 'pending-notifications', 'parent.json'),
      'utf8'
    );
    expect(pending).toContain(`Background task ${taskId} finished (exit 0`);
    expect(pending).toContain('after restart');
    expect(pending).not.toContain('seen');

    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
      resumeFile: SESSION_FILE,
    });
    await waitFor(events, 'parent-ready');
    const snapshot = ofType(events, 'snapshot').find((event) =>
      event.sessions.some((entry) => entry.identity.sessionId === 'parent')
    );
    expect(snapshot?.sessions[0]?.backgroundTasks).toEqual([
      expect.objectContaining({ taskId, status: 'done', exitCode: 0 }),
    ]);
    const managed = (
      supervisor as unknown as { sessions: Map<string, { pendingTaskReminders: string[] }> }
    ).sessions.get('parent');
    expect(managed?.pendingTaskReminders.join('\n')).toContain(taskId);
    // 会话本来空闲：已请 Main 打开，打开后立即开一轮把完成通知交给模型
    expect(ofType(events, 'session-wake-requested')).toEqual([
      { type: 'session-wake-requested', sessionId: 'parent' },
    ]);
    await releaseTimers();
    expect(mocks.sessions[0].prompt).toHaveBeenCalledTimes(1);
    expect(String(mocks.sessions[0].prompt.mock.calls[0]?.[0])).toContain(taskId);
    expect(managed?.pendingTaskReminders).toEqual([]);
    await supervisor.shutdown();
  });

  /** pid 已不在、按文件收尾的认回记录：recover 时立即结束 */
  function goneRecord(sessionId: string): DetachedTaskRecord {
    mkdirSync(logDir, { recursive: true });
    const runId = randomUUID();
    const files = runFiles(logDir, runId);
    writeFileSync(files.outputFile, 'built\n');
    writeFileSync(files.exitFile, '0');
    const taskId = `task-9-${randomUUID().slice(0, 8)}`;
    return {
      taskId,
      sessionId,
      command: 'pnpm build',
      commandKey: null,
      cwd: '/workspace',
      pid: spawnSync('true').pid as number,
      runId,
      startedAt: Date.now() - 60_000,
      yieldedAt: Date.now() - 50_000,
      deadlineAt: null,
      outputFile: files.outputFile,
      outputOffset: 0,
      exitCodeFile: files.exitFile,
      logPath: path.join(logDir, `${taskId}.log`),
    };
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const reminders = (supervisor: SessionSupervisor) =>
    (
      supervisor as unknown as { sessions: Map<string, { pendingTaskReminders: string[] }> }
    ).sessions.get('parent')?.pendingTaskReminders ?? [];
  const bgTasksOf = (supervisor: SessionSupervisor) =>
    (supervisor as unknown as { bgTasks: BackgroundTaskManager }).bgTasks;

  it('冷启动：认回任务所在会话没打开也下发给渲染层，快照请求可补拉；不开会话、不发模型请求', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'enso-graceful-unopened-'));
    const ended = goneRecord('other');
    writeDetachedTasksManifest(path.join(dataDir, DETACHED_TASKS_FILE), {
      version: 1,
      writtenAt: Date.now(),
      workerPid: 1,
      tasks: [ended],
    });
    const { events, supervisor } = await startSupervisor(dataDir);
    const unopened = () => ofType(events, 'unopened-background-tasks');
    const endedTask = expect.objectContaining({
      taskId: ended.taskId,
      status: 'done',
      exitCode: 0,
    });
    expect(unopened().at(-1)).toEqual({
      type: 'unopened-background-tasks',
      sessionId: 'other',
      tasks: [endedTask],
    });

    let alive = true;
    const running = goneRecord('parent');
    rmSync(runFiles(logDir, running.runId).exitFile);
    bgTasksOf(supervisor).recover([running], { alive: () => alive, matches: () => alive });
    const runningTask = expect.objectContaining({ taskId: running.taskId, status: 'running' });
    expect(unopened().at(-1)).toEqual({
      type: 'unopened-background-tasks',
      sessionId: 'parent',
      tasks: [runningTask],
    });

    events.length = 0;
    supervisor.handleCommand({ type: 'snapshot' });
    await settle();
    expect(unopened()).toEqual(
      expect.arrayContaining([
        { type: 'unopened-background-tasks', sessionId: 'parent', tasks: [runningTask] },
        { type: 'unopened-background-tasks', sessionId: 'other', tasks: [endedTask] },
      ])
    );
    events.length = 0;
    supervisor.handleCommand({ type: 'snapshot', sessionId: 'parent' });
    await settle();
    expect(unopened()).toEqual([
      { type: 'unopened-background-tasks', sessionId: 'parent', tasks: [runningTask] },
    ]);
    expect(mocks.createAgentSession).not.toHaveBeenCalled();

    // 进程退出：状态照常更新，完成通知照旧请 Main 叫醒会话
    writeFileSync(runFiles(logDir, running.runId).exitFile, '0');
    alive = false;
    for (let i = 0; i < 40 && !unopened().some((e) => e.tasks[0]?.status === 'done'); i++)
      await sleep(50);
    expect(unopened().at(-1)?.tasks).toEqual([
      expect.objectContaining({ taskId: running.taskId, status: 'done' }),
    ]);
    expect(ofType(events, 'session-wake-requested')).toEqual([
      { type: 'session-wake-requested', sessionId: 'parent' },
    ]);
    expect(mocks.createAgentSession).not.toHaveBeenCalled();
    await supervisor.shutdown();
  });

  it('未打开会话里的任务也能停：按会话 id 寻址，别的会话停不了，不开会话', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'enso-task-stop-unopened-'));
    const { events, supervisor } = await startSupervisor(dataDir);
    const taskId = bgTasksOf(supervisor).start('other', 'sleep 30', dataDir, {
      detachable: true,
      file: '/bin/bash',
      argsPrefix: ['-c'],
    });
    const status = () =>
      ofType(events, 'unopened-background-tasks')
        .filter((event) => event.sessionId === 'other')
        .at(-1)
        ?.tasks.find((task) => task.taskId === taskId)?.status;
    expect(status()).toBe('running');
    supervisor.handleCommand({ type: 'task-stop', sessionId: 'parent', taskId });
    await settle();
    expect(status()).toBe('running');
    supervisor.handleCommand({ type: 'task-keep', sessionId: 'other', taskId, reason: 'ssh 在用' });
    expect(ofType(events, 'unopened-background-tasks').at(-1)?.tasks[0]?.keep).toMatchObject({
      by: 'user',
      reason: 'ssh 在用',
    });
    supervisor.handleCommand({ type: 'task-stop', sessionId: 'other', taskId });
    for (let i = 0; i < 60 && status() === 'running'; i++) await sleep(50);
    expect(status()).toBe('failed');
    expect(mocks.createAgentSession).not.toHaveBeenCalled();
    await supervisor.shutdown();
  });

  it('回合收尾还有没表态的任务：时间线记一次提醒，清单搭下一条消息，不另起一轮', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'enso-task-wrap-up-'));
    const { events, supervisor } = await startSupervisor(dataDir);
    supervisor.handleCommand({ type: 'spawn-parent', identity: parent, cwd: '/workspace', model });
    await waitFor(events, 'parent-ready');
    const session = mocks.sessions[0];
    const taskId = bgTasksOf(supervisor).start('parent', 'sleep 30', dataDir);
    const runTurn = async () => {
      const reply = {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'stop',
        timestamp: Date.now(),
      };
      session.emit({ type: 'agent_start' });
      session.emit({ type: 'turn_start' });
      session.messages.push(user, reply);
      session.emit({ type: 'message_end', message: reply });
      session.emit({ type: 'turn_end', message: reply, toolResults: [] });
      session.emit({ type: 'agent_end', messages: [reply] });
      session.emit({ type: 'agent_settled' });
      await settle();
    };
    const nudges = () =>
      ofType(events, 'session-custom-entry').filter(
        (event) => event.entry.kind === 'task-wrap-up-nudge'
      );
    await runTurn();
    expect(nudges().map((event) => event.entry)).toEqual([
      { kind: 'task-wrap-up-nudge', count: 1, at: expect.any(Number) },
    ]);
    expect(session.prompt).not.toHaveBeenCalled();
    supervisor.handleCommand({
      type: 'prompt',
      deliveryId: 'd-1232',
      identity: parent,
      text: '继续',
    });
    for (let i = 0; i < 20 && session.prompt.mock.calls.length === 0; i++) await settle();
    const sent = String(session.prompt.mock.calls[0]?.[0]);
    expect(sent.startsWith('<background-tasks-wrap-up>')).toBe(true);
    expect(sent).toContain(`${taskId}: sleep 30`);
    expect(sent.endsWith('继续')).toBe(true);
    await runTurn();
    expect(nudges()).toHaveLength(1);
    bgTasksOf(supervisor).stop(taskId, true);
    await supervisor.shutdown();
  });

  it('认回的任务在会话空闲时结束：开一轮把完成通知交给模型', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'enso-graceful-wake-idle-'));
    const { events, supervisor } = await startSupervisor(dataDir);
    supervisor.handleCommand({ type: 'spawn-parent', identity: parent, cwd: '/workspace', model });
    await waitFor(events, 'parent-ready');
    const record = goneRecord('parent');
    holdTimers();
    bgTasksOf(supervisor).recover([record]);
    await releaseTimers();
    const session = mocks.sessions[0];
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(String(session.prompt.mock.calls[0]?.[0])).toContain(
      `Background task ${record.taskId} finished`
    );
    expect(ofType(events, 'session-wake-requested')).toEqual([]);
    await supervisor.shutdown();
  });

  it('认回的任务在会话正忙时结束：不开第二轮，排队等轮末', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'enso-graceful-wake-busy-'));
    const { events, supervisor } = await startSupervisor(dataDir);
    supervisor.handleCommand({ type: 'spawn-parent', identity: parent, cwd: '/workspace', model });
    await waitFor(events, 'parent-ready');
    const session = mocks.sessions[0];
    session.emit({ type: 'agent_start' });
    const record = goneRecord('parent');
    holdTimers();
    bgTasksOf(supervisor).recover([record]);
    await releaseTimers();
    expect(session.prompt).not.toHaveBeenCalled();
    expect(reminders(supervisor).join('\n')).toContain(record.taskId);
    expect(ofType(events, 'session-wake-requested')).toEqual([]);
    await supervisor.shutdown();
  });

  it('重启收尾期间认回的任务结束：只存盘，不开一轮也不请求叫醒', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'enso-graceful-wake-closing-'));
    const { events, supervisor } = await startSupervisor(dataDir);
    supervisor.handleCommand({ type: 'spawn-parent', identity: parent, cwd: '/workspace', model });
    await waitFor(events, 'parent-ready');
    supervisor.handleCommand({ type: 'graceful-restart', keepBackgroundTasks: true });
    await waitFor(events, 'graceful-restart-ready');
    const own = goneRecord('parent');
    const unopened = goneRecord('other');
    holdTimers();
    bgTasksOf(supervisor).recover([own, unopened]);
    await releaseTimers();
    expect(mocks.sessions[0].prompt).not.toHaveBeenCalled();
    expect(ofType(events, 'session-wake-requested')).toEqual([]);
    const pendingDir = path.join(dataDir, 'sessions', 'pending-notifications');
    expect(readFileSync(path.join(pendingDir, 'parent.json'), 'utf8')).toContain(own.taskId);
    expect(readFileSync(path.join(pendingDir, 'other.json'), 'utf8')).toContain(unopened.taskId);
    await supervisor.shutdown();
  });

  it('新一代：断点里空闲的会话带着收尾期间存下的通知，请求叫醒并在打开后开一轮', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'enso-graceful-wake-next-'));
    const entry = {
      generation: parent.generation,
      sessionFile: SESSION_FILE,
      seq: 7,
      turnId: null,
      lastCompletedToolCallId: null,
      messageCount: 0,
      toolsInFlight: [],
    };
    const checkpointFile = path.join(dataDir, RESTART_CHECKPOINT_FILE);
    writeFileSync(
      checkpointFile,
      JSON.stringify({
        version: 1,
        pid: 1,
        writtenAt: Date.now(),
        sessions: [
          { ...entry, sessionId: 'parent', nextStep: 'await-user' },
          { ...entry, sessionId: 'busy', nextStep: 'model-request', turnId: 'turn-1' },
        ],
      } satisfies RestartCheckpoint)
    );
    const pendingDir = path.join(dataDir, 'sessions', 'pending-notifications');
    mkdirSync(pendingDir, { recursive: true });
    writeFileSync(path.join(pendingDir, 'parent.json'), JSON.stringify(['task-9-x finished']));
    writeFileSync(path.join(pendingDir, 'busy.json'), JSON.stringify(['task-9-y finished']));
    const { events, supervisor } = await startSupervisor(dataDir, checkpointFile);
    expect(ofType(events, 'session-wake-requested')).toEqual([
      { type: 'session-wake-requested', sessionId: 'parent' },
    ]);
    holdTimers();
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
      resumeFile: SESSION_FILE,
    });
    await waitFor(events, 'parent-ready');
    await releaseTimers();
    expect(mocks.sessions[0].prompt).toHaveBeenCalledTimes(1);
    expect(String(mocks.sessions[0].prompt.mock.calls[0]?.[0])).toContain('task-9-x finished');
    await supervisor.shutdown();
  });

  it('空闲会话只剩后台任务时重启：任务被停但记进台账，新一代任务表标因重启中断、通知一次并叫醒，再换代不重复', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'enso-graceful-interrupted-'));
    const checkpointFile = path.join(dataDir, RESTART_CHECKPOINT_FILE);
    const first = await startSupervisor(dataDir);
    first.supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
    });
    await waitFor(first.events, 'parent-ready');
    // 会话说完「后台跑完再合并」就空闲了：直接后台起的命令不挡安全点
    const taskId = bgTasksOf(first.supervisor).start('parent', 'echo started; sleep 30', dataDir);
    await sleep(200);
    first.supervisor.handleCommand({ type: 'graceful-restart' });
    await waitFor(first.events, 'graceful-restart-ready');
    expect(ofType(first.events, 'graceful-restart-ready')[0]?.checkpoint.sessions).toEqual([
      expect.objectContaining({ sessionId: 'parent', nextStep: 'await-user' }),
    ]);
    await first.supervisor.shutdown();
    await sleep(300);
    const pendingFile = path.join(dataDir, 'sessions', 'pending-notifications', 'parent.json');
    expect(existsSync(pendingFile)).toBe(false);
    expect(existsSync(path.join(dataDir, INTERRUPTED_TASKS_FILE))).toBe(true);

    mocks.sessions.length = 0;
    const second = await startSupervisor(dataDir, checkpointFile);
    expect(existsSync(path.join(dataDir, INTERRUPTED_TASKS_FILE))).toBe(false);
    expect(ofType(second.events, 'unopened-background-tasks').at(-1)).toEqual({
      type: 'unopened-background-tasks',
      sessionId: 'parent',
      tasks: [expect.objectContaining({ taskId, status: 'failed', interrupted: 'restart' })],
    });
    expect(ofType(second.events, 'session-wake-requested')).toEqual([
      { type: 'session-wake-requested', sessionId: 'parent' },
    ]);
    const notices = JSON.parse(readFileSync(pendingFile, 'utf8')) as string[];
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(
      `Background task ${taskId} was terminated because the app restarted`
    );
    expect(notices[0]).toContain('interrupted-by-restart');
    expect(notices[0]).toContain('started');

    holdTimers();
    second.supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
      resumeFile: SESSION_FILE,
    });
    await waitFor(second.events, 'parent-ready');
    await releaseTimers();
    expect(mocks.sessions[0].prompt).toHaveBeenCalledTimes(1);
    expect(String(mocks.sessions[0].prompt.mock.calls[0]?.[0])).toContain(taskId);
    expect(bgTasksOf(second.supervisor).snapshot('parent')).toEqual([
      expect.objectContaining({ taskId, status: 'failed', interrupted: 'restart' }),
    ]);
    await second.supervisor.shutdown();

    const third = await startSupervisor(dataDir);
    expect(ofType(third.events, 'session-wake-requested')).toEqual([]);
    expect(bgTasksOf(third.supervisor).snapshot('parent')).toEqual([]);
    await third.supervisor.shutdown();
  });

  it('空闲父会话收到 steer（例如等异步子代理期间）：改为 promptFresh 开新轮，不落入无活轮的 steeringQueue', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'enso-steer-idle-parent-'));
    const { events, supervisor } = await startSupervisor(dataDir);
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
    });
    await waitFor(events, 'parent-ready');
    const session = mocks.sessions[0];
    session.isStreaming = false;
    supervisor.handleCommand({
      type: 'steer',
      identity: parent,
      text: '在吗？进度如何',
      deliveryId: 'd-idle-steer',
    });
    await settle();
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(String(session.prompt.mock.calls[0]?.[0])).toContain('在吗？进度如何');
    expect(session.steer).not.toHaveBeenCalled();
    await supervisor.shutdown();
  });

  it('优雅重启时父会话正停在阻塞等待（如 subagent wait）：主动 detach 该等待，让父子都干净到达安全点', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'enso-graceful-detach-wait-'));
    const { events, supervisor } = await startSupervisor(dataDir);
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
    });
    await waitFor(events, 'parent-ready');
    const session = mocks.sessions[0];
    const wait = bgTasksOf(supervisor).trackBlockingWait('parent', 'call-wait');
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'turn_start' });
    session.emit({
      type: 'tool_execution_start',
      toolCallId: 'call-wait',
      toolName: 'subagent',
      args: { operation: 'wait', runId: 'r-1' },
    });
    supervisor.handleCommand({ type: 'graceful-restart' });
    await settle();
    expect(wait.signal.aborted).toBe(true);
    expect(wait.reason()).toBe('restart');
    wait.untrack();
    await supervisor.shutdown();
  });
});
