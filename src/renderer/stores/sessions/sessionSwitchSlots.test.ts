import { describe, expect, it } from 'vitest';
import {
  COLLAPSED_SESSION_LIMIT,
  SESSION_SWITCH_SLOT_LIMIT,
  sessionSwitchSlotIds,
} from './sessionSwitchSlots';

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
        expandedProjects: { p1: true },
      })
    ).toEqual(order);
  });

  it('搜索时只保留命中行，折起项目也展开参与', () => {
    const conversations = {
      hit: conv('p1', 1, 20),
      miss: conv('p1', 2, 10),
      other: conv('p2', 3, 5),
    };
    expect(
      sessionSwitchSlotIds({
        order: ['hit', 'miss', 'other'],
        conversations,
        projectIds: ['p1', 'p2'],
        collapsedProjects: { p1: true, p2: true },
        searching: true,
        matches: (id) => id === 'hit',
      })
    ).toEqual(['hit']);
  });

  it('搜索命中项目名时该项目全部会话入列', () => {
    const conversations = {
      a: conv('p1', 1, 20),
      b: conv('p1', 2, 10),
    };
    expect(
      sessionSwitchSlotIds({
        order: ['a', 'b'],
        conversations,
        projectIds: ['p1'],
        searching: true,
        matches: () => false,
        projectMatches: (id) => id === 'p1',
      })
    ).toEqual(['a', 'b']);
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
        expandedProjects: { p1: true },
      })
    ).toHaveLength(SESSION_SWITCH_SLOT_LIMIT);
  });
});
