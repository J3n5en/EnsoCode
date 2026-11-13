import type { CatalogEntry } from '@enso/pair';
import type { RendererAgentEvent } from '@shared/types/agent';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, unknown>>,
  catalog: [] as unknown[],
}));

vi.mock('../ipc/settings', () => ({
  readPersistedConversation: (id: string) => mocks.rows[id] ?? null,
  patchConversationsState: (
    mutate: (state: { conversations: Record<string, Record<string, unknown>> }) => void
  ) => {
    mutate({ conversations: mocks.rows });
    return true;
  },
}));
vi.mock('./pairHost', () => ({
  getPairCatalog: () => mocks.catalog,
  getPairProjects: () => [],
  mutatePairCatalog: (fn: (catalog: unknown[]) => unknown[]) => {
    mocks.catalog = fn(mocks.catalog);
  },
}));

import {
  applyPairQueueActionHeadless,
  configurePairSessionHost,
  handlePairHeadlessAgentEvent,
  type PairSessionHostAgent,
  setPairHeadless,
} from './pairSessionHost';

const SID = 's1';

function fakeAgent(overrides: Partial<PairSessionHostAgent> = {}) {
  const agent = {
    isAlive: () => true,
    requestSnapshot: vi.fn(),
    spawn: vi.fn(async () => ({ ok: true })),
    prompt: vi.fn(),
    steer: vi.fn(),
    abort: vi.fn(),
    setModel: vi.fn(),
    setReasoning: vi.fn(),
    setThinking: vi.fn(),
    compact: vi.fn(),
    rewind: vi.fn(),
    retry: vi.fn(),
    stopTask: vi.fn(),
    stopSubagent: vi.fn(),
    createAuthority: vi.fn(),
    worktreePath: () => undefined,
    worktreeMissing: () => false,
    projectPath: () => undefined,
    loadLocalSkills: () => false,
    summarizeTitle: vi.fn(async () => ({ ok: true })),
    stallTimeoutMs: () => 60_000,
    ...overrides,
  };
  configurePairSessionHost(agent);
  return agent;
}

const status = (value: string) =>
  ({
    type: 'status',
    status: value,
    identity: { sessionId: SID },
  }) as unknown as RendererAgentEvent;
const event = (body: Record<string, unknown>) =>
  ({ identity: { sessionId: SID }, ...body }) as unknown as RendererAgentEvent;

const userMessage = (text: string) =>
  event({
    type: 'message-upsert',
    message: { role: 'user', content: [{ type: 'text', text }] },
  });

beforeEach(() => {
  vi.useFakeTimers();
  mocks.rows = { [SID]: { id: SID, title: '', projectId: 'p' } };
  mocks.catalog = [{ id: SID, title: '', status: 'idle' } as unknown as CatalogEntry];
});

afterEach(() => {
  setPairHeadless(false);
  vi.useRealTimers();
});

describe('headless stall watchdog', () => {
  it('aborts a silent running turn, then retries once it settles', () => {
    const agent = fakeAgent();
    setPairHeadless(true);
    handlePairHeadlessAgentEvent(status('running'));

    vi.advanceTimersByTime(59_000);
    expect(agent.abort).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(agent.abort).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    expect(agent.abort).toHaveBeenCalledTimes(1);

    handlePairHeadlessAgentEvent(status('idle'));
    vi.advanceTimersByTime(1_000);
    expect(agent.retry).toHaveBeenCalledWith(SID);
  });

  it('treats output and running tool deadlines as heartbeats', () => {
    const agent = fakeAgent();
    setPairHeadless(true);
    handlePairHeadlessAgentEvent(status('running'));
    vi.advanceTimersByTime(50_000);
    handlePairHeadlessAgentEvent(
      event({ type: 'tool-output', toolCallId: 't', output: 'x', deadlineAt: Date.now() + 120_000 })
    );
    vi.advanceTimersByTime(150_000);
    expect(agent.abort).not.toHaveBeenCalled();
    vi.advanceTimersByTime(40_000);
    expect(agent.abort).toHaveBeenCalledTimes(1);
  });

  it('stays off when the timeout setting is 0 or approvals are pending', () => {
    const off = fakeAgent({ stallTimeoutMs: () => 0 });
    setPairHeadless(true);
    handlePairHeadlessAgentEvent(status('running'));
    vi.advanceTimersByTime(600_000);
    expect(off.abort).not.toHaveBeenCalled();
    setPairHeadless(false);

    const agent = fakeAgent();
    setPairHeadless(true);
    handlePairHeadlessAgentEvent(status('running'));
    handlePairHeadlessAgentEvent(event({ type: 'approval-request' }));
    vi.advanceTimersByTime(600_000);
    expect(agent.abort).not.toHaveBeenCalled();
  });

  // 真实场景：托盘模式计数只在回合结束归零，审批点完后模型再卡住，看门狗仍以为在等人
  it('审批处理完后生成再次卡住，看门狗照常中止', () => {
    const agent = fakeAgent();
    setPairHeadless(true);
    handlePairHeadlessAgentEvent(status('running'));
    handlePairHeadlessAgentEvent(event({ type: 'approval-request', request: { requestId: 'a1' } }));
    handlePairHeadlessAgentEvent(event({ type: 'approval-resolved', requestId: 'a1' }));
    vi.advanceTimersByTime(61_000);
    expect(agent.abort).toHaveBeenCalledTimes(1);
  });

  // 同上，提问回答完也要从挂起里移除
  it('提问回答完后生成再次卡住，看门狗照常中止', () => {
    const agent = fakeAgent();
    setPairHeadless(true);
    handlePairHeadlessAgentEvent(status('running'));
    handlePairHeadlessAgentEvent(event({ type: 'ask-request', ask: { requestId: 'q1' } }));
    handlePairHeadlessAgentEvent(event({ type: 'ask-resolved', requestId: 'q1' }));
    vi.advanceTimersByTime(61_000);
    expect(agent.abort).toHaveBeenCalledTimes(1);
  });

  // 真实场景：代审转真人会用同一 requestId 再发 approval-request，按次计数会多算一条
  it('同一审批从代审转真人重发，处理完一次就不再算挂起', () => {
    const agent = fakeAgent();
    setPairHeadless(true);
    handlePairHeadlessAgentEvent(status('running'));
    handlePairHeadlessAgentEvent(
      event({ type: 'approval-request', request: { requestId: 'a1', phase: 'reviewing' } })
    );
    handlePairHeadlessAgentEvent(event({ type: 'approval-request', request: { requestId: 'a1' } }));
    handlePairHeadlessAgentEvent(event({ type: 'approval-resolved', requestId: 'a1' }));
    vi.advanceTimersByTime(61_000);
    expect(agent.abort).toHaveBeenCalledTimes(1);
  });

  // 托盘接管时目录只带挂起计数、没有 requestId：逐条处理完才恢复计时，不能处理一条就清零
  it('接管前已挂起的审批逐条处理完才恢复计时', () => {
    mocks.catalog = [
      { id: SID, title: '', status: 'running', pendingApprovalCount: 2 } as unknown as CatalogEntry,
    ];
    const agent = fakeAgent();
    setPairHeadless(true);
    handlePairHeadlessAgentEvent(event({ type: 'approval-resolved', requestId: 'old-1' }));
    vi.advanceTimersByTime(600_000);
    expect(agent.abort).not.toHaveBeenCalled();
    handlePairHeadlessAgentEvent(event({ type: 'approval-resolved', requestId: 'old-2' }));
    vi.advanceTimersByTime(61_000);
    expect(agent.abort).toHaveBeenCalledTimes(1);
  });

  it('gives up after repeated stalls', () => {
    const agent = fakeAgent();
    setPairHeadless(true);
    for (let round = 0; round < 4; round++) {
      handlePairHeadlessAgentEvent(status('running'));
      vi.advanceTimersByTime(61_000);
      handlePairHeadlessAgentEvent(status('idle'));
      vi.advanceTimersByTime(1_000);
    }
    expect(agent.abort).toHaveBeenCalledTimes(4);
    expect(agent.retry).toHaveBeenCalledTimes(3);
  });
});

describe('headless goal continuation', () => {
  it('pumps an active goal once across status idle and turn-completed', () => {
    const agent = fakeAgent();
    setPairHeadless(true);
    applyPairQueueActionHeadless({ type: 'goal-set', sessionId: SID, text: 'ship it' });
    const prompt = agent.prompt as Mock;
    expect(prompt).toHaveBeenCalledTimes(1);
    prompt.mockClear();
    handlePairHeadlessAgentEvent(status('running'));
    handlePairHeadlessAgentEvent(status('idle'));
    expect(prompt).not.toHaveBeenCalled();
    handlePairHeadlessAgentEvent(event({ type: 'turn-completed', turnId: 't1' }));
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(String(prompt.mock.calls[0]?.[1])).toContain('ship it');
  });

  it('does not continue after goal_complete', () => {
    const agent = fakeAgent();
    setPairHeadless(true);
    applyPairQueueActionHeadless({ type: 'goal-set', sessionId: SID, text: 'ship it' });
    (agent.prompt as Mock).mockClear();
    handlePairHeadlessAgentEvent(event({ type: 'goal-signal', kind: 'complete', note: 'shipped' }));
    handlePairHeadlessAgentEvent(status('idle'));
    handlePairHeadlessAgentEvent(event({ type: 'turn-completed', turnId: 't2' }));
    expect(agent.prompt).not.toHaveBeenCalled();
    expect(mocks.rows[SID].goal).toMatchObject({ status: 'completed', note: 'shipped' });
  });
});

describe('headless turn settle', () => {
  const queuedId = () => (mocks.rows[SID].queuedMessages as { id: string }[])[0]?.id ?? '';

  it('sends the interrupting message once the aborted turn settles', () => {
    const agent = fakeAgent();
    setPairHeadless(true);
    handlePairHeadlessAgentEvent(status('running'));
    applyPairQueueActionHeadless({ type: 'enqueue', sessionId: SID, text: 'later' });
    applyPairQueueActionHeadless({
      type: 'queue-interrupt-send',
      sessionId: SID,
      messageId: queuedId(),
    });
    expect(agent.abort).toHaveBeenCalledTimes(1);
    handlePairHeadlessAgentEvent(status('idle'));
    handlePairHeadlessAgentEvent(event({ type: 'turn-completed', turnId: 't', aborted: true }));
    expect((agent.prompt as Mock).mock.calls.map((call) => call[1])).toEqual(['later']);
    expect(mocks.rows[SID].queuedMessages).toEqual([]);
  });

  it('still delivers queued messages after a failed turn without resuming the goal', () => {
    const agent = fakeAgent();
    setPairHeadless(true);
    applyPairQueueActionHeadless({ type: 'goal-set', sessionId: SID, text: 'ship it' });
    handlePairHeadlessAgentEvent(status('running'));
    applyPairQueueActionHeadless({ type: 'enqueue', sessionId: SID, text: 'next' });
    (agent.prompt as Mock).mockClear();
    handlePairHeadlessAgentEvent(event({ type: 'turn-failed', turnId: 't', error: 'boom' }));
    expect((agent.prompt as Mock).mock.calls.map((call) => call[1])).toEqual(['next']);
    expect(mocks.rows[SID].goal).toMatchObject({ status: 'paused', note: 'boom' });
  });
});

describe('headless first-message title', () => {
  it('titles sessions started through the headless queue too', () => {
    fakeAgent();
    setPairHeadless(true);
    applyPairQueueActionHeadless({ type: 'enqueue', sessionId: SID, text: 'queued hello' });
    handlePairHeadlessAgentEvent(userMessage('queued hello'));
    expect(mocks.rows[SID].title).toBe('queued hello');
  });

  it('titles an untitled session from its first prompt and applies the summary', async () => {
    const agent = fakeAgent();
    setPairHeadless(true);
    handlePairHeadlessAgentEvent(userMessage('继续\nFix the login redirect loop'));

    expect(mocks.rows[SID].title).toBe('Fix the login redirect loop');
    expect((mocks.catalog[0] as { title: string }).title).toBe('Fix the login redirect loop');
    expect(agent.summarizeTitle).toHaveBeenCalledWith(
      SID,
      { kind: 'initial', text: 'Fix the login redirect loop' },
      undefined
    );

    handlePairHeadlessAgentEvent({
      type: 'title-generated',
      conversationId: SID,
      title: 'Login redirect fix',
    } as unknown as RendererAgentEvent);
    expect(mocks.rows[SID].title).toBe('Login redirect fix');
    expect((mocks.catalog[0] as { title: string }).title).toBe('Login redirect fix');
  });

  it('keeps existing, locked or user-renamed titles', () => {
    const agent = fakeAgent();
    mocks.rows[SID].title = 'Existing';
    setPairHeadless(true);
    handlePairHeadlessAgentEvent(userMessage('hello'));
    expect(mocks.rows[SID].title).toBe('Existing');
    expect(agent.summarizeTitle).not.toHaveBeenCalled();

    mocks.rows[SID].title = '';
    handlePairHeadlessAgentEvent(userMessage('second'));
    mocks.rows[SID].title = 'Renamed by user';
    handlePairHeadlessAgentEvent({
      type: 'title-generated',
      conversationId: SID,
      title: 'Model title',
    } as unknown as RendererAgentEvent);
    expect(mocks.rows[SID].title).toBe('Renamed by user');
  });
});
