import { describe, expect, it, vi } from 'vitest';
import {
  collapsedActiveProjects,
  collapsedProjectSessions,
  openCollapsedActiveProject,
} from './collapsedActiveProjects';

const projects = [
  { id: 'p1', kind: 'local' as const, name: 'Alpha' },
  { id: 'p2', kind: 'local' as const, name: 'Beta' },
  { id: 'scratch', kind: 'scratch' as const, name: 'Scratch' },
  { id: 'sec', kind: 'secretary' as const, name: 'Secretary' },
];

const conv = (
  projectId: string,
  createdAt: number,
  lastActive: number,
  extra?: Record<string, unknown>
) => ({
  projectId,
  createdAt,
  title: extra?.title as string | undefined,
  messages: [{ timestamp: lastActive }],
  ...extra,
});

describe('collapsedProjectSessions', () => {
  it('只列活跃中的会话（running/waiting/unread），idle 且超窗的不进列表', () => {
    const sessions = collapsedProjectSessions('p1', {
      running: conv('p1', 1, 50, { title: 'live', status: 'running' }),
      idle: conv('p1', 2, 10, { title: 'quiet', status: 'idle' }),
      waiting: conv('p1', 3, 30, {
        title: 'asked',
        status: 'idle',
        pendingAsks: [{ requestId: 'a1' }],
      }),
      unreadOne: conv('p1', 4, 40, { title: 'done', status: 'idle', unread: true }),
      archivedOne: conv('p1', 5, 90, { title: 'gone', status: 'running', archived: true }),
      other: conv('p2', 6, 99, { title: 'not mine', status: 'running' }),
    });
    expect(sessions.map((row) => row.conversationId)).toEqual(['running', 'unreadOne', 'waiting']);
    expect(sessions.map((row) => row.tone)).toEqual(['running', 'unread', 'waiting']);
  });

  it('idle 但落在 activeRetention 窗口内的也算活跃（含 activeRenewedAt 续期）', () => {
    const now = 1_000_000;
    const retention = { now, ms: 60_000 };
    const sessions = collapsedProjectSessions(
      'p1',
      {
        recentMsg: conv('p1', 1, now - 30_000, { title: 'recent', status: 'idle' }),
        oldMsg: conv('p1', 2, now - 120_000, { title: 'old', status: 'idle' }),
        renewed: conv('p1', 3, now - 120_000, {
          title: 'renewed',
          status: 'idle',
          activeRenewedAt: now - 10_000,
        }),
      },
      { activeRetention: retention }
    );
    expect(sessions.map((row) => row.conversationId).sort()).toEqual(['recentMsg', 'renewed']);
  });

  it('retention.ms 为 0 时 idle 一律不进列表，即便刚刚活跃过', () => {
    const now = 1_000_000;
    const sessions = collapsedProjectSessions(
      'p1',
      {
        recentMsg: conv('p1', 1, now - 5_000, { title: 'recent', status: 'idle' }),
      },
      { activeRetention: { now, ms: 0 } }
    );
    expect(sessions).toEqual([]);
  });

  it('coworker 子会话带 parentId；排队失败 tone 为 failed；未读只在不运行时出现', () => {
    const sessions = collapsedProjectSessions('p1', {
      parent: conv('p1', 1, 10, { title: 'parent', status: 'idle' }),
      child: conv('p1', 2, 60, {
        title: 'child',
        status: 'running',
        parentId: 'parent',
      }),
      broken: conv('p1', 3, 20, {
        title: 'broken',
        status: 'idle',
        queued: true,
        queueFailed: 'spawn failed',
      }),
    });
    const child = sessions.find((row) => row.conversationId === 'child');
    expect(child?.parentId).toBe('parent');
    const broken = sessions.find((row) => row.conversationId === 'broken');
    expect(broken?.tone).toBe('failed');
  });

  it('queued 会话 tone 为 queued；带提醒的空闲会话 tone 为 reminder', () => {
    const sessions = collapsedProjectSessions(
      'p1',
      {
        q: conv('p1', 1, 30, { title: 'q', status: 'idle', queued: true }),
        r: conv('p1', 2, 20, { title: 'r', status: 'idle' }),
      },
      { pendingReminderIds: new Set(['r']) }
    );
    expect(sessions.find((row) => row.conversationId === 'q')?.tone).toBe('queued');
    expect(sessions.find((row) => row.conversationId === 'r')?.tone).toBe('reminder');
  });
});

describe('collapsedActiveProjects', () => {
  it('只收进行中的普通项目，并打开该项目最近活跃的未归档会话', () => {
    const entries = collapsedActiveProjects(
      projects,
      {
        idle: conv('p1', 1, 10, { title: 'old', status: 'idle' }),
        live: conv('p1', 2, 20, { title: 'running chat', status: 'running' }),
        newer: conv('p1', 3, 40, { title: 'latest idle', status: 'idle' }),
        archivedRun: conv('p1', 4, 90, { title: 'gone', status: 'running', archived: true }),
        pinned: conv('p1', 5, 5, { title: 'pinned', status: 'idle', pinned: true }),
        beta: conv('p2', 6, 30, { title: 'beta run', spawning: true }),
        unread: conv('p2', 7, 100, { title: 'just unread', unread: true, status: 'idle' }),
        scratchRun: conv('scratch', 8, 80, { title: 'scratch', status: 'running' }),
        secRun: conv('sec', 9, 70, { title: 'sec', status: 'running' }),
      },
      { archivedProjectIds: [] }
    );

    expect(entries.map((entry) => entry.projectId)).toEqual(['p2', 'p1']);
    expect(entries[0]).toEqual({
      projectId: 'p2',
      conversationId: 'unread',
      title: 'just unread',
    });
    expect(entries[1]).toEqual({
      projectId: 'p1',
      conversationId: 'newer',
      title: 'latest idle',
    });
  });

  it('子任务、后台任务或 spawning 也算进行中；子会话打开时带上父会话', () => {
    const entries = collapsedActiveProjects([{ id: 'p1', kind: 'local' }], {
      parent: conv('p1', 1, 10, {
        title: 'parent',
        status: 'idle',
        coworkerIds: ['child'],
      }),
      child: conv('p1', 2, 50, {
        title: 'child run',
        status: 'running',
        parentId: 'parent',
      }),
      task: conv('p1', 3, 5, {
        title: 'tasks',
        status: 'idle',
        backgroundTasks: [{ status: 'running' }],
      }),
    });

    expect(entries).toEqual([
      {
        projectId: 'p1',
        conversationId: 'child',
        parentId: 'parent',
        title: 'child run',
      },
    ]);
  });

  it('已投影的 hasRunningChild、归档项目、以及没有进行中会话时都不占位', () => {
    expect(
      collapsedActiveProjects([{ id: 'p1', kind: 'local' }], {
        root: conv('p1', 1, 10, { title: 'root', status: 'idle', hasRunningChild: true }),
      })
    ).toEqual([{ projectId: 'p1', conversationId: 'root', title: 'root' }]);

    expect(
      collapsedActiveProjects(
        [{ id: 'p1', kind: 'local' }],
        { root: conv('p1', 1, 10, { title: 'root', status: 'running' }) },
        { archivedProjectIds: ['p1'] }
      )
    ).toEqual([]);

    expect(
      collapsedActiveProjects([{ id: 'p1', kind: 'local' }], {
        waiting: conv('p1', 1, 10, {
          title: 'ask',
          status: 'idle',
          pendingAsks: [{ requestId: 'a' }],
        }),
      })
    ).toEqual([]);
  });

  it('父会话还在时先选父再选 tab，否则直接打开该会话', () => {
    const selectConversation = vi.fn();
    const selectTab = vi.fn();
    openCollapsedActiveProject(
      { projectId: 'p1', conversationId: 'child', parentId: 'parent', title: 'child' },
      {
        conversations: { parent: {}, child: {} },
        selectConversation,
        selectTab,
      }
    );
    expect(selectConversation).toHaveBeenCalledExactlyOnceWith('parent');
    expect(selectTab).toHaveBeenCalledExactlyOnceWith('parent', 'child');

    selectConversation.mockClear();
    selectTab.mockClear();
    openCollapsedActiveProject(
      { projectId: 'p1', conversationId: 'root', title: 'root' },
      { conversations: { root: {} }, selectConversation, selectTab }
    );
    expect(selectConversation).toHaveBeenCalledExactlyOnceWith('root');
    expect(selectTab).not.toHaveBeenCalled();
  });
});
