import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentWorkerEvent } from '@shared/types/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('SessionSupervisor compact failure', () => {
  beforeEach(() => {
    mocks.sessions.length = 0;
    mocks.managers.length = 0;
    mocks.createAgentSession.mockReset();
    rmSync(path.join(tmpdir(), 'enso-compact-sessions'), { recursive: true, force: true });
    mocks.mcpToolsFor.mockReset().mockResolvedValue([]);
    mocks.createAgentSession.mockImplementation(async (options: Record<string, unknown>) => ({
      session: session(options),
    }));
  });

  it('compaction_end 已带错误时不再因 compact() 抛错重复上报', async () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-compact-')),
    });
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
    });
    await waitFor(events, 'parent-ready');
    const parentSession = mocks.sessions[0] as ReturnType<typeof session>;
    parentSession.compact.mockImplementation(async () => {
      parentSession.emit({ type: 'compaction_start' });
      parentSession.emit({
        type: 'compaction_end',
        errorMessage: 'Nothing to compact (session too small)',
      });
      throw new Error('Compaction failed: Nothing to compact (session too small)');
    });

    supervisor.handleCommand({ type: 'compact', identity: parent });
    await settle();
    await settle();

    const ends = events.filter((event) => event.type === 'compaction' && event.state === 'end');
    expect(ends).toEqual([
      expect.objectContaining({
        type: 'compaction',
        state: 'end',
        error: 'Nothing to compact (session too small)',
      }),
    ]);
    await supervisor.shutdown();
  });

  it('compact() 直接抛错且未发 compaction_end 时仍上报一次', async () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-compact-')),
    });
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
    });
    await waitFor(events, 'parent-ready');
    const parentSession = mocks.sessions[0] as ReturnType<typeof session>;
    parentSession.compact.mockRejectedValue(new Error('compact unavailable'));

    supervisor.handleCommand({ type: 'compact', identity: parent });
    await settle();
    await settle();

    const ends = events.filter((event) => event.type === 'compaction' && event.state === 'end');
    expect(ends).toEqual([
      expect.objectContaining({
        type: 'compaction',
        state: 'end',
        error: 'compact unavailable',
      }),
    ]);
    await supervisor.shutdown();
  });
});

describe('SessionSupervisor failTurn compaction cleanup', () => {
  beforeEach(() => {
    mocks.sessions.length = 0;
    mocks.managers.length = 0;
    mocks.createAgentSession.mockReset();
    rmSync(path.join(tmpdir(), 'enso-compact-sessions'), { recursive: true, force: true });
    mocks.mcpToolsFor.mockReset().mockResolvedValue([]);
    mocks.createAgentSession.mockImplementation(async (options: Record<string, unknown>) => ({
      session: session(options),
    }));
  });

  /**
   * 模拟 pi 终态错误轮：agent_end 会用 session.messages 重建投影（reconcileMessages），
   * 故把终态错误 assistant 塞进 session.messages，transcript 才保留它，
   * lastAssistant.stopReason==='error' 才会走 failTurn（而非误报 turn-completed）。
   */
  function failTurnViaAgentEnd(parentSession: ReturnType<typeof session>): void {
    parentSession.messages.push({
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'model down',
    });
    parentSession.emit({ type: 'agent_end', willRetry: false });
  }

  it('忙碌中 compact 进入 queued 后轮次失败：emit compaction end（无 error）并清掉 queued', async () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-compact-')),
    });
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
    });
    await waitFor(events, 'parent-ready');
    const parentSession = mocks.sessions[0] as ReturnType<typeof session>;

    // 进入 running
    parentSession.emit({ type: 'agent_start' });
    await settle();

    // 忙碌中 compact 排队（不打断当前轮次）
    supervisor.handleCommand({ type: 'compact', identity: parent });
    await settle();
    expect(events.some((event) => event.type === 'compaction' && event.state === 'queued')).toBe(
      true
    );

    // 轮次失败：终态错误 assistant + agent_end(willRetry=false) 走 failTurn
    failTurnViaAgentEnd(parentSession);
    await settle();
    await settle();
    expect(events.some((event) => event.type === 'turn-failed')).toBe(true);
    expect(events.some((event) => event.type === 'status' && event.status === 'failed')).toBe(true);

    // 失败应清掉 queued：emit compaction end，且不带 error（避免假「压缩失败」toast）
    const ends = events.filter((event) => event.type === 'compaction' && event.state === 'end');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toEqual(expect.objectContaining({ type: 'compaction', state: 'end' }));
    expect(ends[0]).not.toHaveProperty('error');
    // 放弃排队压缩：end 必须带 abandoned 标记，供投影区分「真正压完」与「放弃」，避免被当成成功而重钉锚点
    expect(ends[0]).toEqual(expect.objectContaining({ abandoned: true }));

    await supervisor.shutdown();
  });

  it('failTurn 后快照投影不再卡 compaction=queued', async () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-compact-')),
    });
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
    });
    await waitFor(events, 'parent-ready');
    const parentSession = mocks.sessions[0] as ReturnType<typeof session>;

    parentSession.emit({ type: 'agent_start' });
    await settle();
    supervisor.handleCommand({ type: 'compact', identity: parent });
    await settle();

    failTurnViaAgentEnd(parentSession);
    await settle();
    await settle();

    supervisor.handleCommand({ type: 'snapshot' });
    await settle();
    const snapshot = events.find((event) => event.type === 'snapshot') as
      | { sessions: { compaction?: string }[] }
      | undefined;
    expect(snapshot?.sessions[0]?.compaction).toBeUndefined();

    await supervisor.shutdown();
  });

  it('failTurn 后 pendingCompact 已清：下一轮成功结束不再自动跑 compact', async () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-compact-')),
    });
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
    });
    await waitFor(events, 'parent-ready');
    const parentSession = mocks.sessions[0] as ReturnType<typeof session>;

    // 第一轮：running + compact 排队，然后失败收口
    parentSession.emit({ type: 'agent_start' });
    await settle();
    supervisor.handleCommand({ type: 'compact', identity: parent });
    await settle();
    failTurnViaAgentEnd(parentSession);
    await settle();
    await settle();
    expect(parentSession.compact).not.toHaveBeenCalled();

    // 第二轮：成功结束。failTurn 应已清掉 pendingCompact，故不再自动 compact。
    // 用一条非错误 assistant 覆盖 session.messages 尾部，使 lastAssistant 非 error 走成功路径。
    parentSession.emit({ type: 'agent_start' });
    await settle();
    parentSession.messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'stop',
    });
    parentSession.emit({ type: 'agent_end', willRetry: false });
    await settle();
    await settle();
    await settle();
    expect(events.some((event) => event.type === 'turn-completed')).toBe(true);
    expect(parentSession.compact).not.toHaveBeenCalled();

    await supervisor.shutdown();
  });

  it('status=failed 时 rewind 不被 idle 守卫空操作：应尝试 navigateTree', async () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: mkdtempSync(path.join(tmpdir(), 'enso-compact-')),
    });
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/workspace',
      model,
    });
    await waitFor(events, 'parent-ready');
    const parentSession = mocks.sessions[0] as ReturnType<typeof session>;

    // 给分支塞一条 user 消息，rewind 才有可回退目标
    (mocks.managers[0] as { getBranch: () => unknown[] }).getBranch().push({
      type: 'message',
      message: {
        role: 'user',
        content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
      },
      id: 'entry-user-1',
      timestamp: 1,
    });

    // 进入 running 后失败收口 → status=failed
    parentSession.emit({ type: 'agent_start' });
    await settle();
    failTurnViaAgentEnd(parentSession);
    await settle();
    await settle();
    expect(events.some((event) => event.type === 'status' && event.status === 'failed')).toBe(true);

    supervisor.handleCommand({
      type: 'rewind',
      identity: parent,
      userIndexFromEnd: 0,
    });
    await settle();
    await settle();

    // failed 不应被 idle 守卫早退空操作：应实际尝试 navigateTree 到那条 user 消息
    expect(parentSession.navigateTree).toHaveBeenCalledWith('entry-user-1');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'rewind-done',
        editorImages: [{ data: 'AAAA', mimeType: 'image/png' }],
      })
    );

    await supervisor.shutdown();
  });
});
