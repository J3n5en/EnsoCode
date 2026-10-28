import { describe, expect, it } from 'vitest';
import * as pinned from './pinned';
import {
  activeConversationIds,
  activeRetentionRemainingMs,
  archivedConversationGroups,
  archivedConversationIds,
  pinnedConversationIds,
  projectConversationIds,
  sortProjectsByActivity,
  staleArchivedConversationIds,
  waitingConversationCount,
} from './pinned';

type CandidateHelpers = {
  staleUnarchivedConversationIds: (input: {
    order: readonly string[];
    conversations: Record<string, unknown>;
    now: number;
    idleDays: number;
    activeId?: string | null;
    cleanupMergedWorktrees?: boolean;
    worktreeStatuses?: Record<string, { exists: boolean; dirty: boolean; ahead: number }>;
  }) => string[];
  staleArchivedConversationIdsToDelete: (
    order: readonly string[],
    conversations: Record<string, unknown>,
    days: number,
    now: number,
    activeId?: string | null
  ) => string[];
};

const candidateHelpers = pinned as typeof pinned & Partial<CandidateHelpers>;

type Minimal = {
  projectId: string;
  pinned?: boolean;
  archived?: boolean;
  archivedAt?: number;
  parentId?: string;
  createdAt: number;
  lastActiveAt?: number;
  messages: { timestamp?: number }[];
  status?: string;
  spawning?: boolean;
  unread?: boolean;
  pendingAsks?: { requestId: string }[];
  pendingApprovals?: unknown[];
  pendingCapabilityAsks?: unknown[];
  coworkerIds?: string[];
  worktree?: { path: string };
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

describe('sortProjectsByActivity', () => {
  it('跨项目取最新会话时间，不按会话置顶抢排序，不改输入', () => {
    const projects = [{ id: 'p2' }, { id: 'p1' }, { id: 'empty' }];
    expect(sortProjectsByActivity(projects, order, conversations)).toEqual([
      projects[1],
      projects[0],
      projects[2],
    ]);
    expect(projects.map((project) => project.id)).toEqual(['p2', 'p1', 'empty']);
  });

  it('忽略归档会话、目录外子会话及失效会话 id', () => {
    const projects = [{ id: 'p1' }, { id: 'p2' }];
    const sessions = {
      old: conv('p1', 1, 10),
      archived: conv('p1', 1, 999, { archived: true }),
      child: conv('p1', 1, 999),
      latest: conv('p2', 1, 20),
    };
    expect(
      sortProjectsByActivity(projects, ['missing', 'archived', 'old', 'latest'], sessions)
    ).toEqual([projects[1], projects[0]]);
  });

  it('冷会话按持久化活跃时间，空会话回落创建时间，同时间保持项目原序', () => {
    const projects = [{ id: 'empty' }, { id: 'p1' }, { id: 'p2' }, { id: 'p3' }];
    const sessions = {
      cold: conv('p1', 1, undefined, { lastActiveAt: 50 }),
      live: conv('p2', 2, 50, { lastActiveAt: 999 }),
      fresh: conv('p3', 30),
    };
    expect(sortProjectsByActivity(projects, ['fresh', 'live', 'cold'], sessions)).toEqual([
      projects[1],
      projects[2],
      projects[3],
      projects[0],
    ]);
  });
});

describe('recentProjects', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = 20 * DAY;

  it('只保留 7 天内有未归档会话的项目，空项目和更早的项目不出现', () => {
    const projects = [{ id: 'old' }, { id: 'new' }, { id: 'empty' }, { id: 'edge' }];
    const sessions = {
      stale: conv('old', 1, now - 8 * DAY),
      latest: conv('new', 1, now - DAY),
      boundary: conv('edge', 1, now - 7 * DAY),
    };
    expect(
      pinned
        .recentProjects(projects, ['stale', 'latest', 'boundary'], sessions, now)
        .map((project) => project.id)
    ).toEqual(['new', 'edge']);
  });

  it('归档会话和会话置顶不能把过期项目留在最近', () => {
    const projects = [{ id: 'old' }, { id: 'live' }];
    const sessions = {
      archived: conv('old', 1, now, { archived: true, pinned: true }),
      stale: conv('old', 1, now - 8 * DAY),
      current: conv('live', 1, now - 2 * DAY),
    };
    expect(
      pinned
        .recentProjects(projects, ['archived', 'stale', 'current'], sessions, now)
        .map((project) => project.id)
    ).toEqual(['live']);
  });
});

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

  it('误入 order 的子会话不进项目分组', () => {
    expect(projectConversationIds(['ghost', ...order], conversations, 'p1')).toEqual([
      'e',
      'b',
      'a',
      'd',
    ]);
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

describe('自动归档与删除候选', () => {
  const day = 86_400_000;
  const now = 40 * day;
  const candidates = (
    order: string[],
    conversations: Record<string, Minimal>,
    activeId = '',
    extra: {
      cleanupMergedWorktrees?: boolean;
      worktreeStatuses?: Record<string, { exists: boolean; dirty: boolean; ahead: number }>;
    } = {}
  ) =>
    candidateHelpers.staleUnarchivedConversationIds?.({
      order,
      conversations,
      now,
      idleDays: 30,
      activeId,
      ...extra,
    });

  it('闲置归档设为从不时没有候选', () => {
    expect(
      candidateHelpers.staleUnarchivedConversationIds?.({
        order: ['old'],
        conversations: { old: conv('p1', 0) },
        now,
        idleDays: 0,
      })
    ).toEqual([]);
  });

  it('按消息、持久化时间、创建时间依次判定，实时消息可保住会话', () => {
    const items = {
      created: conv('p1', 0),
      persisted: conv('p1', 0, undefined, { lastActiveAt: now - 31 * day }),
      live: conv('p1', 0, now - day, { lastActiveAt: 0 }),
    };
    expect(candidates(Object.keys(items), items)).toEqual(['created', 'persisted']);
  });

  it('排除已归档、置顶、当前打开与隔离会话', () => {
    const items = {
      archived: conv('p1', 0, undefined, { archived: true }),
      pinned: conv('p1', 0, undefined, { pinned: true }),
      active: conv('p1', 0),
      isolated: conv('p1', 0, undefined, { worktree: { path: '/wt' } }),
      ordinary: conv('p1', 0),
    };
    expect(candidates(Object.keys(items), items, 'active')).toEqual(['ordinary']);
  });

  const CLEAN = { exists: true, dirty: false, ahead: 0 };

  it('清理已合并开：已合并且干净的闲置隔离会话进入候选', () => {
    const items = {
      isolated: conv('p1', 0, undefined, { worktree: { path: '/wt' } }),
      ordinary: conv('p1', 0),
    };
    expect(
      candidates(Object.keys(items), items, '', {
        cleanupMergedWorktrees: true,
        worktreeStatuses: { isolated: CLEAN },
      })
    ).toEqual(['isolated', 'ordinary']);
  });

  it('清理已合并开：dirty / ahead / 未知 status 仍排除隔离会话', () => {
    const items = {
      dirty: conv('p1', 0, undefined, { worktree: { path: '/d' } }),
      ahead: conv('p1', 0, undefined, { worktree: { path: '/a' } }),
      unknown: conv('p1', 0, undefined, { worktree: { path: '/u' } }),
    };
    expect(
      candidates(Object.keys(items), items, '', {
        cleanupMergedWorktrees: true,
        worktreeStatuses: {
          dirty: { exists: true, dirty: true, ahead: 0 },
          ahead: { exists: true, dirty: false, ahead: 2 },
        },
      })
    ).toEqual([]);
  });

  it('清理已合并开：worktree 已不存在的闲置隔离会话进入候选', () => {
    const items = { gone: conv('p1', 0, undefined, { worktree: { path: '/gone' } }) };
    expect(
      candidates(Object.keys(items), items, '', {
        cleanupMergedWorktrees: true,
        worktreeStatuses: { gone: { exists: false, dirty: false, ahead: 0 } },
      })
    ).toEqual(['gone']);
  });

  it('排除运行、等待、失败、未读、启动中及有运行子项的会话', () => {
    const items = {
      run: conv('p1', 0, undefined, { status: 'running' }),
      wait: conv('p1', 0, undefined, { pendingAsks: [{ requestId: 'a' }] }),
      fail: conv('p1', 0, undefined, { status: 'failed' }),
      unread: conv('p1', 0, undefined, { unread: true }),
      spawn: conv('p1', 0, undefined, { spawning: true }),
      parent: conv('p1', 0, undefined, { coworkerIds: ['kid'] }),
      kid: conv('p1', 0, undefined, { status: 'running' }),
      ordinary: conv('p1', 0),
    };
    expect(
      candidates(
        Object.keys(items).filter((id) => id !== 'kid'),
        items
      )
    ).toEqual(['ordinary']);
  });

  it('自动删除设为从不时不会沿用手动入口的全部删除语义', () => {
    const items = { old: conv('p1', 0, undefined, { archived: true, archivedAt: 0 }) };
    expect(candidateHelpers.staleArchivedConversationIdsToDelete?.(['old'], items, 0, now)).toEqual(
      []
    );
  });

  it('自动删除只选超期归档且跳过当前打开会话', () => {
    const items = {
      active: conv('p1', 0, undefined, { archived: true, archivedAt: 0 }),
      stale: conv('p1', 0, undefined, { archived: true, archivedAt: 0 }),
      recent: conv('p1', 0, undefined, { archived: true, archivedAt: now - day }),
    };
    expect(
      candidateHelpers.staleArchivedConversationIdsToDelete?.(
        Object.keys(items),
        items,
        30,
        now,
        'active'
      )
    ).toEqual(['stale']);
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

describe('activeConversationIds', () => {
  const live = {
    run: {
      ...conv('p1', 1, 40),
      status: 'running',
      spawning: false,
    },
    wait: {
      ...conv('p1', 2, 30),
      status: 'idle',
      spawning: false,
      pendingAsks: [{ requestId: 'a1' }],
    },
    fail: {
      ...conv('p2', 3, 50),
      status: 'failed',
      spawning: false,
      unread: true,
    },
    readFail: {
      ...conv('p1', 9, 60),
      status: 'failed',
      spawning: false,
    },
    idle: {
      ...conv('p1', 4, 80),
      status: 'idle',
      spawning: false,
      unread: true,
    },
    spawn: {
      ...conv('p1', 5, 20),
      status: 'idle',
      spawning: true,
    },
    childParent: {
      ...conv('p1', 6, 10),
      status: 'idle',
      spawning: false,
      coworkerIds: ['kid'],
    },
    kid: {
      ...conv('p1', 7, 9),
      status: 'running',
      spawning: false,
    },
    archivedFail: {
      ...conv('p1', 8, 90),
      status: 'failed',
      spawning: false,
      archived: true,
    },
  };
  const liveOrder = [
    'run',
    'wait',
    'fail',
    'readFail',
    'idle',
    'spawn',
    'childParent',
    'archivedFail',
  ];

  it('只收蓝绿红活跃态(含未读绿点、未读失败),按最后活跃时间倒序', () => {
    expect(activeConversationIds(liveOrder, live)).toEqual([
      'idle',
      'fail',
      'run',
      'wait',
      'spawn',
      'childParent',
    ]);
  });

  it('已读的失败会话退出活跃栏', () => {
    expect(activeConversationIds(liveOrder, live)).not.toContain('readFail');
  });

  it('归档会话与归档项目不进活跃栏', () => {
    expect(activeConversationIds(liveOrder, live, ['p2'])).toEqual([
      'idle',
      'run',
      'wait',
      'spawn',
      'childParent',
    ]);
  });

  it('order 之外的 coworker 不进栏', () => {
    expect(activeConversationIds(liveOrder, live)).not.toContain('kid');
  });

  it('误入 order 的子会话不进活跃栏和置顶栏', () => {
    const leaked = {
      ...live,
      kid: { ...live.kid, parentId: 'childParent' },
    };
    expect(activeConversationIds([...liveOrder, 'kid'], leaked)).not.toContain('kid');
    expect(activeConversationIds([...liveOrder, 'kid'], leaked)).toContain('childParent');
    expect(
      pinnedConversationIds(['ghost', ...order], {
        ...conversations,
        ghost: { ...conversations.ghost, pinned: true },
      })
    ).toEqual(['e', 'c', 'b']);
  });

  describe('留存窗口', () => {
    const now = 1000;
    const retention = { now, ms: 100 };
    const kept = {
      readRecent: { ...conv('p1', 1, 950), status: 'idle' },
      readOld: { ...conv('p1', 2, 800), status: 'idle' },
      unreadOld: { ...conv('p1', 3, 800), status: 'idle', unread: true },
      readFailRecent: { ...conv('p1', 4, 960), status: 'failed' },
      runningOld: { ...conv('p1', 5, 0), status: 'running' },
      waitingOld: { ...conv('p1', 6, 0), status: 'idle', pendingAsks: [{ requestId: 'q' }] },
      emptyNew: { ...conv('p1', 990), status: 'idle' },
      persistedRecent: { ...conv('p1', 7), status: 'idle', lastActiveAt: 970 },
      archivedRecent: { ...conv('p1', 8, 990), status: 'idle', archived: true },
    };
    const keptOrder = Object.keys(kept);

    it('窗口内已读会话保留;超窗回到原规则(已读退出、未读保留);运行与待处理不受窗口影响', () => {
      expect(activeConversationIds(keptOrder, kept, [], retention)).toEqual([
        'persistedRecent',
        'readFailRecent',
        'readRecent',
        'unreadOld',
        'runningOld',
        'waitingOld',
      ]);
    });

    it('没有任何活动时间的空会话不进栏', () => {
      expect(activeConversationIds(keptOrder, kept, [], retention)).not.toContain('emptyNew');
    });

    it('窗口内点开续期:按续期时刻重新计时', () => {
      const renewed = {
        renewed: { ...conv('p1', 1, 0), status: 'idle', activeRenewedAt: 950 },
        stale: { ...conv('p1', 2, 0), status: 'idle', activeRenewedAt: 850 },
      };
      expect(activeConversationIds(['renewed', 'stale'], renewed, [], retention)).toEqual([
        'renewed',
      ]);
    });

    it('留存为 0 时保持原有规则', () => {
      expect(activeConversationIds(liveOrder, live, [], { now, ms: 0 })).toEqual(
        activeConversationIds(liveOrder, live)
      );
    });

    it('剩余时间只给靠留存留下的会话,按最后消息与续期中较晚者计算', () => {
      const renewed = { ...conv('p1', 9, 900), status: 'idle', activeRenewedAt: 980 };
      const all = { ...kept, renewed };
      expect(activeRetentionRemainingMs('readRecent', all, retention)).toBe(50);
      expect(activeRetentionRemainingMs('persistedRecent', all, retention)).toBe(70);
      expect(activeRetentionRemainingMs('renewed', all, retention)).toBe(80);
    });

    it('不会因超时移出的会话与已超时的会话没有剩余时间', () => {
      const unreadRecent = { ...conv('p1', 9, 990), status: 'idle', unread: true };
      const failedUnread = { ...conv('p1', 10, 990), status: 'failed', unread: true };
      const all = { ...kept, unreadRecent, failedUnread };
      for (const id of [
        'runningOld',
        'waitingOld',
        'unreadRecent',
        'failedUnread',
        'readOld',
        'emptyNew',
        'missing',
      ]) {
        expect(activeRetentionRemainingMs(id, all, retention), id).toBeUndefined();
      }
      expect(activeRetentionRemainingMs('readRecent', all, { now, ms: 0 })).toBeUndefined();
    });
  });
});

describe('等你处理优先', () => {
  const ask = { pendingAsks: [{ requestId: 'r1' }] };
  const withWaiting = (patch: Record<string, Partial<Minimal>>): Record<string, Minimal> => {
    const next = { ...conversations };
    for (const [id, extra] of Object.entries(patch)) next[id] = { ...conversations[id], ...extra };
    return next;
  };

  it('项目分组内等你处理的排最前,其余保持原顺序', () => {
    expect(projectConversationIds(order, withWaiting({ d: ask }), 'p1')).toEqual([
      'd',
      'e',
      'b',
      'a',
    ]);
    expect(projectConversationIds(order, withWaiting({ a: ask, e: ask }), 'p1')).toEqual([
      'e',
      'a',
      'b',
      'd',
    ]);
  });

  it('判定与侧栏圆点一致:failed 不算等待,failed 但 spawning 仍算', () => {
    expect(
      projectConversationIds(order, withWaiting({ d: { ...ask, status: 'failed' } }), 'p1')
    ).toEqual(['e', 'b', 'a', 'd']);
    expect(
      projectConversationIds(
        order,
        withWaiting({ d: { ...ask, status: 'failed', spawning: true } }),
        'p1'
      )
    ).toEqual(['d', 'e', 'b', 'a']);
  });

  it('置顶无手动顺序时等你处理的排最前', () => {
    expect(pinnedConversationIds(order, withWaiting({ b: ask }))).toEqual(['b', 'e', 'c']);
  });

  it('置顶手动顺序不动,只在按活跃追加的尾部内优先', () => {
    expect(pinnedConversationIds(order, withWaiting({ b: ask }), ['c'])).toEqual(['c', 'b', 'e']);
    expect(pinnedConversationIds(order, withWaiting({ e: ask }), ['c', 'e', 'b'])).toEqual([
      'c',
      'e',
      'b',
    ]);
  });

  it('waitingConversationCount 只数 order 内与圆点 waiting 同口径的会话', () => {
    const live = withWaiting({
      a: ask,
      b: { ...ask, status: 'failed' },
      c: { ...ask, status: 'failed', spawning: true },
      d: { pendingAsks: [] },
      ghost: ask,
    });
    expect(waitingConversationCount(order, live)).toBe(2);
    expect(waitingConversationCount([], live)).toBe(0);
    expect(waitingConversationCount(['missing'], live)).toBe(0);
  });

  it('待审批 / 待能力确认同样算等你处理', () => {
    const approval = { pendingApprovals: [{ requestId: 'x' }] };
    const capability = { pendingCapabilityAsks: [{ requestId: 'y' }] };
    const live = withWaiting({ d: approval, a: capability });
    expect(projectConversationIds(order, live, 'p1')).toEqual(['a', 'd', 'e', 'b']);
    expect(waitingConversationCount(order, live)).toBe(2);
  });
});
