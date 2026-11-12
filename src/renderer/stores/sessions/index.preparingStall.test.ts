import type { ParentHistoryTailResult, SourceAuthorityProjection } from '@shared/types/agent';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindSessionProjection,
  installSessionGlobals,
  loadSessionModules,
  onAgentEvent,
  readParentHistoryTail,
  requestSnapshot,
  seedParent,
  sessionsModule,
  settingsModule,
} from './index.testUtils';
import { chatSurfaceBusy, chatTimelineActivity, PREPARING_STALL_MS } from './messageCache';

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

const parent = () => sessionsModule.useSessionsStore.getState().conversations.parent;

describe('新会话 Preparing 收敛', () => {
  beforeAll(async () => {
    await loadSessionModules();
  });

  beforeEach(async () => {
    requestSnapshot.mockClear();
    readParentHistoryTail.mockReset();
    readParentHistoryTail.mockResolvedValue({ ok: true, messages: [], baseIndex: 0 });
    nextConversationId = 'parent';
    sourceProjection = {
      projects: [
        { projectId: 'project', canonicalPath: '/workspace', state: 'active', version: 1 },
      ],
      conversations: [],
    };
    sessionsModule.useSessionsStore.setState({
      conversations: {},
      order: [],
      activeId: null,
    });
    settingsModule.useSettingsStore.setState({
      projects: [{ id: 'project', name: 'Project', path: '/workspace' }],
    });
    await seedParent();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('正在看的空会话 spawn 完成（parent-ready）后 activity 归零，出现空态', async () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: { ...state.conversations.parent, spawning: true },
      },
    }));
    expect(chatTimelineActivity(parent())).toBe('loading');
    onAgentEvent?.({
      type: 'parent-ready',
      identity: { sessionId: 'parent', generation: 'g1' },
      seq: 1,
      sessionFile: '/tmp/parent.jsonl',
      model: { providerId: 'p', modelId: 'm' },
    });
    expect(readParentHistoryTail).toHaveBeenCalledWith('parent');
    await vi.waitFor(() => expect(chatTimelineActivity(parent())).toBeNull());
    expect(chatSurfaceBusy(parent())).toBe(false);
  });

  it('正在看的空会话被全量快照标为存活后也会补水收敛', async () => {
    onAgentEvent?.({
      type: 'snapshot',
      sessions: [
        {
          identity: { sessionId: 'parent', generation: 'g1' },
          messages: [],
          status: 'idle',
        },
      ],
    } as never);
    await vi.waitFor(() => expect(chatTimelineActivity(parent())).toBeNull());
  });

  it('尾窗读一直不回：超时后降级为空态（syncStalled），重试重新拉取', async () => {
    vi.useFakeTimers();
    readParentHistoryTail.mockImplementation(() => new Promise<ParentHistoryTailResult>(() => {}));
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: { ...state.conversations.parent, started: true },
      },
    }));
    expect(chatTimelineActivity(parent())).toBe('loading');
    await vi.advanceTimersByTimeAsync(PREPARING_STALL_MS + 100);
    expect(parent().syncStalled).toBe(true);
    expect(chatTimelineActivity(parent())).toBeNull();
    expect(chatSurfaceBusy(parent())).toBe(false);

    readParentHistoryTail.mockReset();
    readParentHistoryTail.mockResolvedValue({ ok: true, messages: [], baseIndex: 0 });
    requestSnapshot.mockClear();
    sessionsModule.useSessionsStore.getState().retrySessionSync('parent');
    expect(parent().syncStalled).toBeUndefined();
    expect(requestSnapshot).toHaveBeenCalledWith('parent');
    expect(readParentHistoryTail).toHaveBeenCalledWith('parent');
    await vi.advanceTimersByTimeAsync(0);
    expect(chatTimelineActivity(parent())).toBeNull();
    expect(parent().syncStalled).toBeUndefined();
  });

  it('spawn 一直不回：超时降级，但生成态不受超时影响', async () => {
    vi.useFakeTimers();
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: { ...state.conversations.parent, spawning: true },
      },
    }));
    await vi.advanceTimersByTimeAsync(PREPARING_STALL_MS + 100);
    expect(parent().syncStalled).toBe(true);
    expect(chatTimelineActivity(parent())).toBeNull();

    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          spawning: false,
          started: true,
          status: 'running',
          syncStalled: undefined,
        },
      },
    }));
    await vi.advanceTimersByTimeAsync(PREPARING_STALL_MS * 3);
    expect(parent().syncStalled).toBeUndefined();
    expect(chatTimelineActivity(parent())).toBe('working');
  });

  it('超时降级后 worker 事件到达即清除降级标记', async () => {
    vi.useFakeTimers();
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: { ...state.conversations.parent, spawning: true },
      },
    }));
    await vi.advanceTimersByTimeAsync(PREPARING_STALL_MS + 100);
    expect(parent().syncStalled).toBe(true);
    onAgentEvent?.({
      type: 'parent-ready',
      identity: { sessionId: 'parent', generation: 'g1' },
      seq: 1,
      sessionFile: '/tmp/parent.jsonl',
      model: { providerId: 'p', modelId: 'm' },
    });
    expect(parent().syncStalled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(chatTimelineActivity(parent())).toBeNull();
  });
});
