import { describe, expect, it } from 'vitest';
import {
  isDrawerActive,
  orderDrawerActive,
  orderPinned,
  orderProjectSessions,
  sortByActivity,
} from './drawerOrder';

const s = (id: string, updatedAt?: number, pinned?: boolean) => ({
  id,
  ...(updatedAt !== undefined ? { updatedAt } : {}),
  ...(pinned ? { pinned } : {}),
});

describe('sortByActivity', () => {
  it('按 updatedAt 倒序，缺失视为 0，时间相同保持原序', () => {
    const out = sortByActivity([s('a', 1), s('b', 3), s('c'), s('d', 3)]);
    expect(out.map((x) => x.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('不修改入参', () => {
    const input = [s('a', 1), s('b', 2)];
    sortByActivity(input);
    expect(input.map((x) => x.id)).toEqual(['a', 'b']);
  });
});

describe('orderPinned', () => {
  it('手动顺序命中的排前，未收录的按活跃倒序追加，失效 id 忽略', () => {
    const out = orderPinned([s('a', 1), s('b', 2), s('c', 3)], ['b', 'ghost', 'a']);
    expect(out.map((x) => x.id)).toEqual(['b', 'a', 'c']);
  });

  it('无手动顺序时整体按活跃倒序', () => {
    const out = orderPinned([s('a', 1), s('b', 2)], []);
    expect(out.map((x) => x.id)).toEqual(['b', 'a']);
  });
});

describe('orderProjectSessions', () => {
  it('置顶靠前，置顶组与普通组各自按活跃倒序', () => {
    const out = orderProjectSessions([s('a', 5), s('b', 1, true), s('c', 3, true), s('d', 9)]);
    expect(out.map((x) => x.id)).toEqual(['c', 'b', 'd', 'a']);
  });

  it('待提问 / 待审批的会话整体置前，组内保持原有顺序', () => {
    const out = orderProjectSessions([
      s('a', 5),
      s('b', 1, true),
      { ...s('c', 3), pendingAskCount: 1 },
      { ...s('d', 2), pendingApprovalCount: 2 },
      s('e', 9),
    ]);
    expect(out.map((x) => x.id)).toEqual(['c', 'd', 'b', 'e', 'a']);
  });
});

describe('orderPinned waiting', () => {
  it('手动顺序不动，未收录部分待处理的置前', () => {
    const out = orderPinned(
      [s('a', 1), s('b', 2), { ...s('c', 0), pendingAskCount: 1 }, s('m', 0)],
      ['m']
    );
    expect(out.map((x) => x.id)).toEqual(['m', 'c', 'b', 'a']);
  });
});

describe('isDrawerActive', () => {
  it('运行 / 未读 / 失败 / 待提问 / 子会话在跑 算活跃', () => {
    expect(isDrawerActive({ status: 'running' }, false)).toBe(true);
    expect(isDrawerActive({ status: 'idle', unread: true }, false)).toBe(true);
    expect(isDrawerActive({ status: 'failed' }, false)).toBe(true);
    expect(isDrawerActive({ status: 'idle', pendingAskCount: 1 }, false)).toBe(true);
    expect(isDrawerActive({ status: 'idle' }, true)).toBe(true);
    expect(isDrawerActive({ status: 'queued' }, false)).toBe(true);
  });

  it('空闲且已读不算活跃', () => {
    expect(isDrawerActive({ status: 'idle' }, false)).toBe(false);
  });

  it('等提醒 / 等上游恢复 / 续跑中算活跃，goal 结束后不算', () => {
    expect(isDrawerActive({ status: 'idle', parked: 'reminder' }, false)).toBe(true);
    expect(isDrawerActive({ status: 'idle', parked: 'upstream' }, false)).toBe(true);
    expect(isDrawerActive({ status: 'idle', goal: { status: 'active' } }, false)).toBe(true);
    expect(isDrawerActive({ status: 'idle', goal: { status: 'completed' } }, false)).toBe(false);
  });
});

describe('orderDrawerActive', () => {
  it('只留活跃的；等提醒、排队、等上游恢复排在后面，各档按活跃倒序', () => {
    const out = orderDrawerActive(
      [
        { ...s('remind', 9), status: 'idle', parked: 'reminder' as const },
        { ...s('queued', 8), status: 'queued' },
        { ...s('run', 1), status: 'running' },
        { ...s('cont', 2), status: 'idle', goal: { status: 'active' as const } },
        { ...s('idle', 7), status: 'idle' },
        { ...s('child', 3), status: 'idle' },
      ],
      (id) => id === 'child'
    );
    expect(out.map((x) => x.id)).toEqual(['child', 'cont', 'run', 'remind', 'queued']);
  });
});
