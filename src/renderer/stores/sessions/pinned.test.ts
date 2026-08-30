import { describe, expect, it } from 'vitest';
import { archivedConversationIds, pinnedConversationIds, projectConversationIds } from './pinned';

type Minimal = {
  projectId: string;
  pinned?: boolean;
  archived?: boolean;
  parentId?: string;
  createdAt: number;
  messages: { timestamp?: number }[];
};

/** 造会话:lastActive 为最后一条消息时间;省略则无消息(回落 createdAt) */
const conv = (
  projectId: string,
  createdAt: number,
  lastActive?: number,
  extra?: Partial<Minimal>
): Minimal => ({
  projectId,
  createdAt,
  messages: lastActive === undefined ? [] : [{ timestamp: lastActive }],
  ...extra,
});

// 创建顺序:e 最新 … a 最旧;活跃时间刻意与创建顺序错开
const conversations: Record<string, Minimal> = {
  a: conv('p1', 1, 50), // 最旧创建,但最近活跃
  b: conv('p1', 2, 20, { pinned: true }),
  c: conv('p2', 3, 30, { pinned: true }),
  d: conv('p1', 4, 10),
  e: conv('p1', 5, 40, { pinned: true }),
  ghost: conv('p1', 6, 60, { pinned: true, parentId: 'a' }), // coworker 不进侧栏
};

// order 新的在前(创建序)
const order = ['e', 'd', 'c', 'b', 'a'];

const withArchived: Record<string, Minimal> = {
  ...conversations,
  b: conv('p1', 2, 20, { pinned: true, archived: true }),
  d: conv('p1', 4, 10, { archived: true }),
};

describe('projectConversationIds', () => {
  it('置顶的排最前,各组内按最后活跃时间倒序', () => {
    // pinned: e(40) b(20);非 pinned: a(50) d(10)
    expect(projectConversationIds(order, conversations, 'p1')).toEqual(['e', 'b', 'a', 'd']);
  });

  it('无消息的会话回落 createdAt 参与排序', () => {
    const plain = {
      old: conv('p1', 1),
      fresh: conv('p1', 2),
    };
    expect(projectConversationIds(['old', 'fresh'], plain, 'p1')).toEqual(['fresh', 'old']);
  });

  it('活跃时间相同保持 order 相对顺序(稳定)', () => {
    const tied = {
      x: conv('p1', 1, 100),
      y: conv('p1', 2, 100),
    };
    expect(projectConversationIds(['y', 'x'], tied, 'p1')).toEqual(['y', 'x']);
  });

  it('脏输入不崩:order 里有 conversations 缺失的 id', () => {
    expect(projectConversationIds(['x', 'b'], conversations, 'p1')).toEqual(['b']);
  });
});

describe('archived 与分组的互斥', () => {
  it('归档的不进项目分组', () => {
    // p1 未归档:e(40, pinned) a(50)
    expect(projectConversationIds(order, withArchived, 'p1')).toEqual(['e', 'a']);
  });

  it('归档的不进置顶栏(即使还残留 pinned 标记)', () => {
    // 置顶未归档:e(40) c(30)
    expect(pinnedConversationIds(order, withArchived)).toEqual(['e', 'c']);
  });

  it('archivedConversationIds 按最后活跃时间倒序收集归档会话', () => {
    // b(20) d(10)
    expect(archivedConversationIds(order, withArchived)).toEqual(['b', 'd']);
    expect(archivedConversationIds(order, conversations)).toEqual([]);
  });
});

describe('pinnedConversationIds', () => {
  it('跨项目收集置顶会话,按最后活跃时间倒序', () => {
    // e(40) c(30) b(20)
    expect(pinnedConversationIds(order, conversations)).toEqual(['e', 'c', 'b']);
  });

  it('不含 order 之外的会话(coworker 等)', () => {
    expect(pinnedConversationIds(order, conversations)).not.toContain('ghost');
  });
});
