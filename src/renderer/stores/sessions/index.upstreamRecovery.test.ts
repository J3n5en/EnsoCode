import type { RendererAgentEvent, SourceAuthorityProjection } from '@shared/types/agent';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentAbort,
  agentPrompt,
  bindSessionProjection,
  cancelUpstreamWait,
  installSessionGlobals,
  loadSessionModules,
  onAgentEvent,
  onUpstreamHealth,
  onUpstreamWake,
  reportUpstreamFailure,
  resetSessionHarness,
  retryUpstreamNow,
  sessionsModule,
} from './index.testUtils';

let sourceProjection: SourceAuthorityProjection = { projects: [], conversations: [] };
let nextConversationId = 'parent';
bindSessionProjection({
  get sourceProjection() {
    return sourceProjection;
  },
  set sourceProjection(value) {
    sourceProjection = value;
  },
  get nextConversationId() {
    return nextConversationId;
  },
  set nextConversationId(value) {
    nextConversationId = value;
  },
});
installSessionGlobals();

describe('桌面会话上游故障自动恢复', () => {
  beforeAll(async () => {
    await loadSessionModules();
  });

  beforeEach(async () => {
    await resetSessionHarness();
    agentPrompt.mockClear();
    agentAbort.mockClear();
    reportUpstreamFailure.mockReset();
    cancelUpstreamWait.mockClear();
    retryUpstreamNow.mockClear();
  });

  it('瞬态失败进入 waiting（非 paused），收到上游唤醒时注入 goal-continuation 并成功后恢复 active', async () => {
    const retryMeta = {
      reason: 'upstream' as const,
      kind: 'transient' as const,
      provider: 'anthropic',
      attempt: 1,
      since: 1_000,
      at: 61_000,
      lastError: '503 Service Unavailable: No available accounts',
    };
    reportUpstreamFailure.mockResolvedValueOnce({ action: 'wait', retry: retryMeta });

    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          status: 'running' as const,
          lastProviderId: 'anthropic',
          goal: {
            text: '修复上线流程',
            status: 'active' as const,
            autoTurns: 0,
            noProgressRuns: 0,
          },
        },
      },
    }));

    onAgentEvent?.({
      type: 'turn-failed',
      identity: { sessionId: 'parent', generation: 'g1' },
      seq: 1,
      turnId: 't1',
      error: '503 Service Unavailable: No available accounts',
      retryExhausted: true,
      provider: 'anthropic',
    } as RendererAgentEvent);

    await vi.waitFor(() => {
      const conv = sessionsModule.useSessionsStore.getState().conversations.parent;
      expect(conv?.goal?.status).toBe('waiting');
      expect(conv?.goal?.retry).toEqual(retryMeta);
      expect(conv?.status).toBe('idle');
    });

    // 上游健康闸门唤醒：注入 <goal-continuation>
    onUpstreamWake?.({ conversationId: 'parent', reason: 'probe' });
    await vi.waitFor(() => expect(agentPrompt).toHaveBeenCalledTimes(1));
    const sentText = String((agentPrompt.mock.calls[0] as unknown[] | undefined)?.[1] ?? '');
    expect(sentText).toContain('<goal-continuation>');
    expect(sentText).toContain('修复上线流程');

    // 探测成功：恢复 active 并清除 retry
    onAgentEvent?.({
      type: 'turn-completed',
      identity: { sessionId: 'parent', generation: 'g1' },
      seq: 2,
      turnId: 't2',
      digest: { assistantText: '已推进下一步' },
      provider: 'anthropic',
    } as RendererAgentEvent);

    const after = sessionsModule.useSessionsStore.getState().conversations.parent;
    expect(after?.goal?.status).toBe('active');
    expect(after?.goal?.retry).toBeUndefined();
  });

  it('唤醒后 worker 发出 status:running 时 goal 立即收敛为 active 并清掉 retry，不等轮次结束', async () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          status: 'idle' as const,
          lastProviderId: 'anthropic',
          goal: {
            text: '修复上线流程',
            status: 'waiting' as const,
            autoTurns: 1,
            noProgressRuns: 0,
            retry: {
              reason: 'upstream' as const,
              kind: 'transient' as const,
              provider: 'anthropic',
              attempt: 1,
              since: 1_000,
              at: 61_000,
              lastError: '503 Service Unavailable: No available accounts',
            },
          },
        },
      },
    }));

    // worker 真正开跑（wake 注入的 continuation 被接受）：waiting 必须立刻收敛，
    // 否则运行中的几分钟里目标条一直显示「等待上游恢复 · 下次 xx:xx + 立即重试」
    onAgentEvent?.({
      type: 'status',
      identity: { sessionId: 'parent', generation: 'g1' },
      seq: 5,
      status: 'running',
      turnId: 't2',
    } as RendererAgentEvent);

    const conv = sessionsModule.useSessionsStore.getState().conversations.parent;
    expect(conv?.goal?.status).toBe('active');
    expect(conv?.goal?.retry).toBeUndefined();
  });

  it('等待上游恢复期间用户手动停止（abort）取消闸门等待并置 paused，后续唤醒不再续跑', async () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          status: 'idle' as const,
          goal: {
            text: '等待中目标',
            status: 'waiting' as const,
            autoTurns: 0,
            noProgressRuns: 0,
            retry: {
              reason: 'upstream' as const,
              kind: 'transient' as const,
              provider: 'openai',
              attempt: 1,
              since: 1_000,
              at: 61_000,
              lastError: '502 Bad Gateway',
            },
          },
        },
      },
    }));

    await sessionsModule.useSessionsStore.getState().abort('parent');
    expect(cancelUpstreamWait).toHaveBeenCalledWith('parent');
    const conv = sessionsModule.useSessionsStore.getState().conversations.parent;
    expect(conv?.goal?.status).toBe('paused');
    expect(conv?.goal?.note).toBe('stopped by user');
    expect(conv?.goal?.retry).toBeUndefined();

    // 即便再收到唤醒信号也绝不续跑
    onUpstreamWake?.({ conversationId: 'parent', reason: 'recovered' });
    expect(agentPrompt).not.toHaveBeenCalled();
  });

  it('同步上游健康快照并支持 retryUpstreamNow', async () => {
    onUpstreamHealth?.([
      {
        provider: 'anthropic',
        state: 'degraded',
        since: 1_000,
        errorKind: 'transient',
        lastError: '503 No available accounts',
        waitingCount: 2,
        nextProbeAt: 61_000,
      },
    ]);
    expect(sessionsModule.useSessionsStore.getState().upstreamHealth).toHaveLength(1);

    await sessionsModule.useSessionsStore.getState().retryUpstreamNow('parent');
    expect(retryUpstreamNow).toHaveBeenCalledWith('parent');
  });
});
