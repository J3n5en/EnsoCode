import { describe, expect, it } from 'vitest';
import {
  archivedConversationGroups,
  archivedConversationIds,
  pinnedConversationIds,
  projectConversationIds,
  staleArchivedConversationIds,
} from './pinned';

type Minimal = {
  projectId: string;
  pinned?: boolean;
  archived?: boolean;
  archivedAt?: number;
  parentId?: string;
  createdAt: number;
  lastActiveAt?: number;
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

  it('messages 被持久化剥离后,用持久化的 lastActiveAt 排序而非 createdAt', () => {
    // 场景:昨晚创建、今早才活跃的会话,重启后 messages=[];
    // 若回落 createdAt 会掉到旧会话堆里(真实事故:白屏会话「消失」)
    const rehydrated = {
      builtLastNightUsedToday: conv('p1', 1, undefined, { lastActiveAt: 100 }),
      usedYesterday: conv('p1', 5, undefined, { lastActiveAt: 50 }),
    };
    expect(
      projectConversationIds(['usedYesterday', 'builtLastNightUsedToday'], rehydrated, 'p1')
    ).toEqual(['builtLastNightUsedToday', 'usedYesterday']);
  });

  it('内存里的最后一条消息时间优先于持久化 lastActiveAt(活会话不被陈旧盘面拖后)', () => {
    const live = {
      stale: conv('p1', 1, 200, { lastActiveAt: 10 }),
      other: conv('p1', 2, 100),
    };
    expect(projectConversationIds(['other', 'stale'], live, 'p1')).toEqual(['stale', 'other']);
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

  it('archivedConversationGroups 按项目顺序分组，组内按活跃时间倒序', () => {
    const mixed: Record<string, Minimal> = {
      ...withArchived,
      c: conv('p2', 3, 30, { pinned: true, archived: true }),
      gone: conv('missing', 6, 5, { archived: true }),
    };
    expect(archivedConversationGroups(order.concat('gone'), mixed, ['p2', 'p1'])).toEqual([
      { projectId: 'p2', ids: ['c'] },
      { projectId: 'p1', ids: ['b', 'd'] },
      { projectId: 'missing', ids: ['gone'] },
    ]);
  });

  it('没有归档的项目不占一组', () => {
    expect(archivedConversationGroups(order, withArchived, ['p2', 'p1'])).toEqual([
      { projectId: 'p1', ids: ['b', 'd'] },
    ]);
  });
});

describe('项目归档(会话自身 archived 标记不动)', () => {
  // p1 归档:其全部会话(含 b/d 已单独归档、e 置顶)一并进归档栏;p2 照常
  const archivedProjects = ['p1'];

  it('归档项目的置顶会话不进置顶栏', () => {
    expect(pinnedConversationIds(order, withArchived, [], archivedProjects)).toEqual(['c']);
  });

  it('archivedConversationIds 计入归档项目的全部会话', () => {
    // p1 全部:a(50) e(40) b(20) d(10)
    expect(archivedConversationIds(order, withArchived, archivedProjects)).toEqual([
      'a',
      'e',
      'b',
      'd',
    ]);
  });

  it('归档项目整组进归档栏并带 projectArchived 标记,组内含已单独归档的会话', () => {
    expect(archivedConversationGroups(order, withArchived, ['p2', 'p1'], archivedProjects)).toEqual(
      [{ projectId: 'p1', ids: ['a', 'e', 'b', 'd'], projectArchived: true }]
    );
  });

  it('归档项目里没有会话也占一组(否则无处恢复)', () => {
    expect(archivedConversationGroups(order, withArchived, ['p2', 'p1'], ['p2', 'p1'])).toEqual([
      { projectId: 'p2', ids: ['c'], projectArchived: true },
      { projectId: 'p1', ids: ['a', 'e', 'b', 'd'], projectArchived: true },
    ]);
    expect(archivedConversationGroups([], {}, ['p2'], ['p2'])).toEqual([
      { projectId: 'p2', ids: [], projectArchived: true },
    ]);
  });

  it('已删项目残留的归档 id 不占组', () => {
    expect(archivedConversationGroups(order, conversations, ['p2'], ['gone'])).toEqual([]);
  });
});

describe('staleArchivedConversationIds', () => {
  const day = 86_400_000;
  const now = 30 * day;
  const stale = {
    recent: conv('p1', 1, 100, { archived: true, archivedAt: now - 2 * day }),
    week: conv('p1', 2, 90, { archived: true, archivedAt: now - 8 * day }),
    month: conv('p1', 3, 80, { archived: true, archivedAt: now - 20 * day }),
    legacy: conv('p1', 4, now - 40 * day, { archived: true }),
    live: conv('p1', 5, 70),
  };
  const ids = ['recent', 'week', 'month', 'legacy', 'live'];

  it('按归档时间筛出超过 N 天的会话，缺 archivedAt 回落最后活跃时间', () => {
    expect(staleArchivedConversationIds(ids, stale, 7, now)).toEqual(['week', 'month', 'legacy']);
    expect(staleArchivedConversationIds(ids, stale, 15, now)).toEqual(['month', 'legacy']);
    expect(staleArchivedConversationIds(ids, stale, 30, now)).toEqual(['legacy']);
    // days=0 = 全部已归档（「全部删除」入口）
    expect(staleArchivedConversationIds(ids, stale, 0, now)).toEqual([
      'recent',
      'week',
      'month',
      'legacy',
    ]);
  });

  it('未归档的不进清理名单', () => {
    expect(staleArchivedConversationIds(ids, stale, 7, now)).not.toContain('live');
  });

  it('可限定到某个项目', () => {
    const mixed = {
      ...stale,
      other: conv('p2', 6, 60, { archived: true, archivedAt: now - 20 * day }),
    };
    expect(staleArchivedConversationIds(['other', ...ids], mixed, 7, now, 'p2')).toEqual(['other']);
    expect(staleArchivedConversationIds(['other', ...ids], mixed, 7, now, 'p1')).not.toContain(
      'other'
    );
  });
});

describe('pinnedConversationIds', () => {
  it('跨项目收集置顶会话,无手动顺序时按最后活跃时间倒序', () => {
    // e(40) c(30) b(20)
    expect(pinnedConversationIds(order, conversations)).toEqual(['e', 'c', 'b']);
  });

  it('不含 order 之外的会话(coworker 等)', () => {
    expect(pinnedConversationIds(order, conversations)).not.toContain('ghost');
  });

  it('手动顺序优先,未收录的新置顶按活跃时间追加末尾', () => {
    // 手动 [b, e];c 不在手动序里 → 追加
    expect(pinnedConversationIds(order, conversations, ['b', 'e'])).toEqual(['b', 'e', 'c']);
  });

  it('手动序里失效的 id 忽略', () => {
    expect(pinnedConversationIds(order, conversations, ['ghost2', 'c'])).toEqual(['c', 'e', 'b']);
  });

  it('手动序里已取消置顶/已归档的不回流', () => {
    // withArchived 里 b 归档了:手动序含 b 也不应出现
    expect(pinnedConversationIds(order, withArchived, ['b', 'c'])).toEqual(['c', 'e']);
  });
});
