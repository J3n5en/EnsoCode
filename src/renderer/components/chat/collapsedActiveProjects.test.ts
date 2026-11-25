import { describe, expect, it, vi } from 'vitest';
import { collapsedActiveProjects, openCollapsedActiveProject } from './collapsedActiveProjects';

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
