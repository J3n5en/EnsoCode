import { describe, expect, it } from 'vitest';
import type { SecretaryBoard, SecretaryCard } from '../types/secretary';
import {
  appendFeedPage,
  type FeedEvent,
  feedEvents,
  mergeFeedHead,
  pageFeed,
  parseFeedQuery,
} from './feed';

const at = (id: string, time: number, over: Partial<FeedEvent> = {}): FeedEvent => ({
  id,
  at: time,
  tone: 'idle',
  projectName: '',
  title: id,
  label: 'Idle',
  ...over,
});

const session = (conversationId: string, time: number): SecretaryCard => ({
  kind: 'session',
  conversationId,
  projectId: 'p1',
  projectName: 'enso',
  title: conversationId,
  state: 'idle',
  startedAt: time,
  stateSince: time,
  secretaryConversationId: 'sec',
});

const board = (over: Partial<SecretaryBoard> = {}): SecretaryBoard => ({
  needsYou: [],
  running: [],
  done: [],
  todos: [],
  ...over,
});

describe('pageFeed', () => {
  const events = [at('c', 5), at('a', 5), at('b', 5), at('older', 4), at('newest', 9)];

  it('按时间倒序，同一时刻用 id 升序兜底', () => {
    expect(pageFeed(events, { limit: 10 }).events.map((event) => event.id)).toEqual([
      'newest',
      'a',
      'b',
      'c',
      'older',
    ]);
    expect(pageFeed([...events].reverse(), { limit: 10 }).events.map((event) => event.id)).toEqual([
      'newest',
      'a',
      'b',
      'c',
      'older',
    ]);
  });

  it('游标之后的页不重复也不遗漏，同一时刻从 id 边界接着取', () => {
    const first = pageFeed(events, { limit: 2 });
    expect(first.events.map((event) => event.id)).toEqual(['newest', 'a']);
    expect(first.hasMore).toBe(true);
    const cursor = first.events.at(-1);
    if (!cursor) throw new Error('missing cursor');
    const second = pageFeed(events, { before: { at: cursor.at, id: cursor.id }, limit: 2 });
    expect(second.events.map((event) => event.id)).toEqual(['b', 'c']);
    const edge = second.events.at(-1);
    if (!edge) throw new Error('missing edge');
    const third = pageFeed(events, { before: { at: edge.at, id: edge.id }, limit: 2 });
    expect(third).toEqual({ events: [at('older', 4)], hasMore: false });
    const seen = [...first.events, ...second.events, ...third.events].map((event) => event.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(['newest', 'a', 'b', 'c', 'older']);
  });

  it('真实动态里相同时间的活动条目也按 id 切开两页', () => {
    const done = ['m', 'a', 'z'].map((id) => session(id, 50));
    const activity = ['m', 'a', 'z'].map((id) => ({
      at: 50,
      conversationId: id,
      kind: 'seen' as const,
      text: id,
    }));
    const all = feedEvents(board({ done, activity }));
    const first = pageFeed(all, { limit: 3 });
    const cursor = first.events.at(-1);
    if (!cursor) throw new Error('missing cursor');
    const second = pageFeed(all, { before: { at: cursor.at, id: cursor.id }, limit: 3 });
    const ids = [...first.events, ...second.events].map((event) => event.id);
    expect(ids).toEqual([
      'activity:a:50:seen',
      'activity:m:50:seen',
      'activity:z:50:seen',
      'session:a',
      'session:m',
      'session:z',
    ]);
    expect(new Set(ids).size).toBe(all.length);
  });

  it('拒绝缺字段的游标，放行缺省查询', () => {
    expect(parseFeedQuery(undefined)).toEqual({});
    expect(parseFeedQuery({ limit: 40 })).toEqual({ limit: 40 });
    expect(parseFeedQuery({ before: { at: 1, id: 'a' }, limit: 10 })).toEqual({
      before: { at: 1, id: 'a' },
      limit: 10,
    });
    expect(parseFeedQuery({ before: { at: 1 } })).toBeNull();
    expect(parseFeedQuery({ limit: 0 })).toBeNull();
    expect(parseFeedQuery({ limit: 101 })).toBeNull();
    expect(parseFeedQuery([])).toBeNull();
  });
});

describe('mergeFeedHead', () => {
  const loaded = [at('page1', 30, { label: 'Started' }), at('page2', 10)];

  it('新条目插到顶部时，已经加载的更早一页还在、顺序不变', () => {
    const head = [at('fresh', 40), at('page1', 30, { label: 'Started' })];
    const merged = mergeFeedHead(loaded, head, true);
    expect(merged.pending).toEqual([]);
    expect(merged.events.map((event) => event.id)).toEqual(['fresh', 'page1', 'page2']);
  });

  it('不贴顶时新条目先攒着，已加载的页一个不动', () => {
    const head = [at('fresh', 40), at('page1', 40, { label: 'Goal complete' })];
    const merged = mergeFeedHead(loaded, head, false);
    expect(merged.pending.map((event) => event.id)).toEqual(['fresh']);
    expect(merged.events.map((event) => [event.id, event.label])).toEqual([
      ['page1', 'Goal complete'],
      ['page2', 'Idle'],
    ]);
  });

  it('接更早的一页时，重复的 id 原地更新，不再追加一份', () => {
    const page = [at('page2', 10, { label: 'Turn ended' }), at('page3', 5)];
    expect(appendFeedPage(loaded, page).map((event) => [event.id, event.label])).toEqual([
      ['page1', 'Started'],
      ['page2', 'Turn ended'],
      ['page3', 'Idle'],
    ]);
  });
});
