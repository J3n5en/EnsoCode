import { describe, expect, it } from 'vitest';
import * as sessionSwitchSlots from './sessionSwitchSlots';
import {
  COLLAPSED_SESSION_LIMIT,
  SESSION_SWITCH_SLOT_LIMIT,
  sessionSwitchSlotIds,
} from './sessionSwitchSlots';

type IncrementalExpandHelpers = {
  SESSION_EXPAND_STEP: number;
  shownConversationCount: (total: number, revealedExtra: number) => number;
  nextRevealedExtra: (total: number, revealedExtra: number) => number;
  prevRevealedExtra: (revealedExtra: number) => number;
};

const expandHelpers = sessionSwitchSlots as typeof sessionSwitchSlots &
  Partial<IncrementalExpandHelpers>;

type Minimal = {
  projectId: string;
  pinned?: boolean;
  archived?: boolean;
  createdAt: number;
  messages: { timestamp?: number }[];
};

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

describe('增量展开辅助函数', () => {
  it('每次固定多展示 15 条', () => {
    expect(expandHelpers.SESSION_EXPAND_STEP).toBe(15);
  });

  it('未展开时最多展示默认的 5 条', () => {
    expect(expandHelpers.shownConversationCount).toBeTypeOf('function');
    expect(expandHelpers.shownConversationCount?.(20, 0)).toBe(COLLAPSED_SESSION_LIMIT);
    expect(expandHelpers.shownConversationCount?.(3, 0)).toBe(3);
  });

  it('按已揭示数量展示且永不超过总数', () => {
    expect(expandHelpers.shownConversationCount).toBeTypeOf('function');
    expect(expandHelpers.shownConversationCount?.(91, 15)).toBe(20);
    expect(expandHelpers.shownConversationCount?.(7, 15)).toBe(7);
  });

  it('已展示全部时下一次操作收起', () => {
    expect(expandHelpers.nextRevealedExtra).toBeTypeOf('function');
    expect(expandHelpers.nextRevealedExtra?.(20, 15)).toBe(0);
    expect(expandHelpers.nextRevealedExtra?.(3, 0)).toBe(0);
  });

  it('未展示完时每次增加 15 条并在总数处封顶', () => {
    expect(expandHelpers.nextRevealedExtra).toBeTypeOf('function');
    expect(expandHelpers.nextRevealedExtra?.(91, 0)).toBe(15);
    expect(expandHelpers.nextRevealedExtra?.(91, 15)).toBe(30);
    expect(expandHelpers.nextRevealedExtra?.(27, 15)).toBe(22);
  });

  it('收起与展开对称：每次回收 15 条，到折叠上限为止', () => {
    expect(expandHelpers.prevRevealedExtra).toBeTypeOf('function');
    expect(expandHelpers.prevRevealedExtra?.(30)).toBe(15);
    expect(expandHelpers.prevRevealedExtra?.(15)).toBe(0);
    expect(expandHelpers.prevRevealedExtra?.(7)).toBe(0);
    expect(expandHelpers.prevRevealedExtra?.(0)).toBe(0);
  });
});

describe('sessionSwitchSlotIds', () => {
  it('空列表返回空', () => {
    expect(
      sessionSwitchSlotIds({
        order: [],
        conversations: {},
        projectIds: [],
      })
    ).toEqual([]);
  });

  it('活跃中栏目优先于 Pinned 与项目列表', () => {
    const conversations = {
      pin: conv('p1', 1, 30, { pinned: true }),
      run: conv('p1', 2, 25),
      a: conv('p1', 3, 20),
      b: conv('p2', 4, 10),
    };
    expect(
      sessionSwitchSlotIds({
        order: ['pin', 'run', 'a', 'b'],
        conversations,
        projectIds: ['p1', 'p2'],
        leadingIds: ['run'],
      })
    ).toEqual(['run', 'pin', 'a', 'b']);
  });

  it('活跃中已出现的会话不在后面重复占槽', () => {
    const conversations = {
      pin: conv('p1', 1, 40, { pinned: true }),
      other: conv('p1', 2, 10),
    };
    expect(
      sessionSwitchSlotIds({
        order: ['pin', 'other'],
        conversations,
        projectIds: ['p1'],
        leadingIds: ['pin'],
      })
    ).toEqual(['pin', 'other']);
  });

  it('Pinned 可见行在前，再接已展开项目的可见行', () => {
    const conversations = {
      pin: conv('p1', 1, 30, { pinned: true }),
      a: conv('p1', 2, 20),
      b: conv('p2', 3, 10),
    };
    expect(
      sessionSwitchSlotIds({
        order: ['pin', 'a', 'b'],
        conversations,
        projectIds: ['p1', 'p2'],
      })
    ).toEqual(['pin', 'a', 'b']);
  });

  it('归档项目的会话（含置顶）不占槽位', () => {
    const conversations = {
      pin: conv('p1', 1, 30, { pinned: true }),
      a: conv('p1', 2, 20),
      b: conv('p2', 3, 10),
    };
    expect(
      sessionSwitchSlotIds({
        order: ['pin', 'a', 'b'],
        conversations,
        projectIds: ['p2'],
        archivedProjectIds: ['p1'],
      })
    ).toEqual(['b']);
  });

  it('同一会话只保留第一次出现（Pinned 优先）', () => {
    const conversations = {
      pin: conv('p1', 1, 40, { pinned: true }),
      other: conv('p1', 2, 10),
    };
    expect(
      sessionSwitchSlotIds({
        order: ['pin', 'other'],
        conversations,
        projectIds: ['p1'],
      })
    ).toEqual(['pin', 'other']);
  });

  it('折起项目的会话不入列', () => {
    const conversations = {
      a: conv('p1', 1, 20),
      b: conv('p2', 2, 10),
    };
    expect(
      sessionSwitchSlotIds({
        order: ['a', 'b'],
        conversations,
        projectIds: ['p1', 'p2'],
        collapsedProjects: { p2: true },
      })
    ).toEqual(['a']);
  });

  it('未展开 Show more 时每个项目只取折叠上限条', () => {
    const conversations: Record<string, Minimal> = {};
    const order: string[] = [];
    for (let i = 0; i < COLLAPSED_SESSION_LIMIT + 2; i++) {
      const id = `s${i}`;
      order.push(id);
      conversations[id] = conv('p1', i, 100 - i);
    }
    expect(
      sessionSwitchSlotIds({
        order,
        conversations,
        projectIds: ['p1'],
      })
    ).toEqual(order.slice(0, COLLAPSED_SESSION_LIMIT));
  });

  it('展开 Show more 后收入该项目全部可见会话', () => {
    const conversations: Record<string, Minimal> = {};
    const order: string[] = [];
    for (let i = 0; i < COLLAPSED_SESSION_LIMIT + 2; i++) {
      const id = `s${i}`;
      order.push(id);
      conversations[id] = conv('p1', i, 100 - i);
    }
    expect(
      sessionSwitchSlotIds({
        order,
        conversations,
        projectIds: ['p1'],
        revealedExtras: { p1: 15 },
      })
    ).toEqual(order);
  });

  it('归档会话不入列', () => {
    const conversations = {
      live: conv('p1', 1, 20),
      dead: conv('p1', 2, 10, { archived: true }),
    };
    expect(
      sessionSwitchSlotIds({
        order: ['live', 'dead'],
        conversations,
        projectIds: ['p1'],
      })
    ).toEqual(['live']);
  });

  it('超过槽位上限截断', () => {
    const conversations: Record<string, Minimal> = {};
    const order: string[] = [];
    for (let i = 0; i < SESSION_SWITCH_SLOT_LIMIT + 3; i++) {
      const id = `n${i}`;
      order.push(id);
      conversations[id] = conv('p1', i, 200 - i);
    }
    expect(
      sessionSwitchSlotIds({
        order,
        conversations,
        projectIds: ['p1'],
        revealedExtras: { p1: 100 },
      })
    ).toHaveLength(SESSION_SWITCH_SLOT_LIMIT);
  });
});
