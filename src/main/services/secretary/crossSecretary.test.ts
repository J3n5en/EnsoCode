import type { SecretaryDispatchFile } from '@shared/types/secretary';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, unknown>>,
  files: {} as Record<string, SecretaryDispatchFile>,
  worktrees: {} as Record<string, string>,
}));

vi.mock('../../ipc/settings', () => ({ readPersistedConversations: () => state.rows }));
vi.mock('../../ipc/agent', () => ({
  observedSessionStatus: () => ({ state: 'idle', pendingAsks: 0, pendingApprovals: 0 }),
}));
vi.mock('../../ipc/worktree', () => ({
  sessionWorktree: (id: string) => (state.worktrees[id] ? { path: state.worktrees[id] } : null),
}));
vi.mock('./secretaries', () => ({
  secretaryContexts: () => Object.keys(state.files).map((id) => ({ id, dir: id, projectId: null })),
  secretaryRegistry: () => ({ maxRunningTotal: () => 10 }),
}));
vi.mock('./store', () => ({
  SecretaryStore: class {
    constructor(private readonly dir: string) {}
    dispatchView() {
      return state.files[this.dir];
    }
    // 这些都是只读判断：整份复制近 1MB 的派发记录会卡住 Main，一律走缓存视图
    dispatch(): never {
      throw new Error('read-only path must not deep-copy dispatch.json');
    }
  },
}));

const { runningWorktreePaths } = await import('./crossSecretary');

describe('清理时不碰的 worktree', () => {
  beforeEach(() => {
    state.rows = {
      queued: {
        projectId: 'p1',
        secretaryOrigin: { secretaryConversationId: 'sec', secretaryId: 's1' },
        queuedStart: { queuedAt: 1, text: '修构建' },
      },
      done: { projectId: 'p1', sessionFile: '/s/done.jsonl' },
    };
    state.files = {
      s1: {
        version: 1,
        dispatched: {
          queued: {
            conversationId: 'queued',
            projectId: 'p1',
            secretaryConversationId: 'sec',
            createdAt: 1,
            turn: 0,
            lastState: 'idle',
            lastEventAt: 1,
          },
          done: {
            conversationId: 'done',
            projectId: 'p1',
            secretaryConversationId: 'sec',
            createdAt: 1,
            turn: 1,
            lastState: 'idle',
            lastEventAt: 1,
            lastResult: { kind: 'goal-complete', turn: 1, at: 1 },
          },
        },
        named: [],
        proposals: {},
        outbox: [],
      },
    };
    state.worktrees = { queued: '/nonexistent/wt-queued', done: '/nonexistent/wt-done' };
  });

  it('排队会话的 worktree 算占用：分支还在基线上，看着像已合入也不能清', async () => {
    const paths = await runningWorktreePaths();
    expect([...paths]).toEqual(['/nonexistent/wt-queued']);
  });
});
