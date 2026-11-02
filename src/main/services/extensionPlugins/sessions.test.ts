import { describe, expect, it } from 'vitest';
import { listProjectSessions } from './sessions';

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
    });
    expect(list).toEqual([
      { id: 'b', title: '旧的', updatedAt: 100, archived: true },
      { id: 'a', title: '看板', updatedAt: 50 },
      { id: 'f', title: '', updatedAt: 10, running: true },
    ]);
  });

  it('子会话按所属主会话的项目取；未知会话返回空', () => {
    const input = { conversations, persisted: () => null, running: () => false };
    expect(listProjectSessions({ ...input, origin: 'c::child-1' }).map((s) => s.id)).toEqual(['c']);
    expect(listProjectSessions({ ...input, origin: 'zzz' })).toEqual([]);
  });
});
