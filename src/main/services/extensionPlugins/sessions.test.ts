import { describe, expect, it } from 'vitest';
import { listAllSessions, listProjectSessions } from './sessions';

const conv = (conversationId: string, projectId: string, patch: Record<string, unknown> = {}) => ({
  conversationId,
  projectId,
  kind: 'root' as const,
  lifecycle: 'ready' as const,
  version: 1,
  ...patch,
});

describe('listProjectSessions', () => {
  const conversations = [
    conv('a', 'p1'),
    conv('b', 'p1'),
    conv('c', 'p2'),
    conv('d', 'p1', { lifecycle: 'ended' }),
    conv('e', 'p1', { bot: { botId: 'x' } }),
    conv('f', 'p1'),
  ];
  const persisted: Record<string, Record<string, unknown>> = {
    a: { title: '  看板 ', createdAt: 1, lastActiveAt: 50 },
    b: { title: '旧的', createdAt: 100, archived: true },
    f: { createdAt: 10 },
  };

  it('只列同项目、未结束、非 Bot 的主会话，按最近活动排序', () => {
    const list = listProjectSessions({
      origin: 'a',
      conversations,
      persisted: (id) => persisted[id] ?? null,
      running: (id) => id === 'f',
      state: (id) => (id === 'b' ? 'error' : 'idle'),
    });
    expect(list).toEqual([
      { id: 'b', title: '旧的', updatedAt: 100, state: 'error', archived: true },
      { id: 'a', title: '看板', updatedAt: 50, state: 'idle' },
      // 启动中（索引算运行、尚无状态事件）也报 running
      { id: 'f', title: '', updatedAt: 10, state: 'running', running: true },
    ]);
  });

  it('子会话按所属主会话的项目取；未知会话返回空', () => {
    const input = {
      conversations,
      persisted: () => null,
      running: () => false,
      state: () => 'idle' as const,
    };
    expect(listProjectSessions({ ...input, origin: 'c::child-1' }).map((s) => s.id)).toEqual(['c']);
    expect(listProjectSessions({ ...input, origin: 'zzz' })).toEqual([]);
  });
});

describe('listAllSessions', () => {
  it('跨项目列出主会话并带项目标识，排除已移除项目与 Bot 工作区', () => {
    const projects = [
      { projectId: 'p1', canonicalPath: '/w/alpha', state: 'active' as const, version: 1 },
      {
        projectId: 'p2',
        canonicalPath: '/w/beta',
        kind: 'ssh' as const,
        state: 'active' as const,
        version: 1,
      },
      { projectId: 'p3', canonicalPath: '/w/gone', state: 'removed' as const, version: 1 },
      {
        projectId: 'p4',
        canonicalPath: '/w/bot',
        kind: 'bot-home' as const,
        state: 'active' as const,
        version: 1,
      },
    ];
    const activity: Record<string, Record<string, unknown>> = {
      a: { lastActiveAt: 5 },
      b: { lastActiveAt: 9 },
    };
    const list = listAllSessions({
      conversations: [
        conv('a', 'p1'),
        conv('b', 'p2'),
        conv('c', 'p3'),
        conv('d', 'p4'),
        conv('e', 'p1', { bot: { botId: 'x' } }),
        conv('f', 'p1', { lifecycle: 'ended' }),
      ],
      projects,
      persisted: (id) => activity[id] ?? null,
      running: () => false,
      state: (id) => (id === 'b' ? 'waiting' : 'idle'),
    });
    expect(list).toEqual([
      { id: 'b', title: '', updatedAt: 9, state: 'waiting', projectId: 'p2', projectName: 'beta' },
      { id: 'a', title: '', updatedAt: 5, state: 'idle', projectId: 'p1', projectName: 'alpha' },
    ]);
  });
});
