import { describe, expect, it } from 'vitest';
import { orderPinned, orderProjectSessions, sortByActivity } from './drawerOrder';

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
});
