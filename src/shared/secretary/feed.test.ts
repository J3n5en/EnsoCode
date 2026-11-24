import { describe, expect, it } from 'vitest';
import { zhTranslations } from '../i18n';
import type { SecretaryBoard, SecretaryCard } from '../types/secretary';
import {
  appendFeedPage,
  DONE_NEEDS_USER_LABEL,
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

describe('feedEvents 完成条目', () => {
  const noise = '- | | PR 拆分方式 | 合并为 1 个 PR';

  const goal = (
    over: Partial<Extract<SecretaryCard, { kind: 'session' }>> = {}
  ): Extract<SecretaryCard, { kind: 'session' }> => {
    const card = session('c1', 1);
    if (card.kind !== 'session') throw new Error('session');
    return {
      ...card,
      state: 'idle',
      result: 'goal-complete',
      resultAt: 20,
      lastText: noise,
      ...over,
    };
  };

  it('needsUser 标签是中性的「完成 · 需要你」，不说成「待你决定」', () => {
    expect(DONE_NEEDS_USER_LABEL).toBe('Done · needs you');
    expect(zhTranslations[DONE_NEEDS_USER_LABEL]).toBe('完成 · 需要你');
    expect(Object.values(zhTranslations)).not.toContain('完成 · 待你决定');
  });

  it('活动条目带 needsUser 时换成「完成 · 需要你」标签，正文是条目而不是噪声', () => {
    const events = feedEvents(
      board({
        done: [goal()],
        activity: [
          {
            at: 20,
            conversationId: 'c1',
            kind: 'goal-complete',
            text: noise,
            needsUser: ['是否合并', '确认发版'],
          },
        ],
      })
    );
    expect(events.find((event) => event.id === 'activity:c1:20:goal-complete')).toMatchObject({
      label: 'Done · needs you',
      tone: 'ok',
      detail: '是否合并；确认发版',
    });
    expect(
      events.find((event) => event.id === 'activity:c1:20:goal-complete')?.detail
    ).not.toContain('PR 拆分方式');
  });

  it('活动条目只有 summary 时保持完成标签，正文是 summary', () => {
    const events = feedEvents(
      board({
        done: [session('c1', 1)],
        activity: [
          {
            at: 20,
            conversationId: 'c1',
            kind: 'goal-complete',
            text: noise,
            summary: '已合并上架',
          },
        ],
      })
    );
    expect(events.find((event) => event.id === 'activity:c1:20:goal-complete')).toMatchObject({
      label: 'Goal complete',
      detail: '已合并上架',
    });
  });

  it('活动条目没有 needsUser 和 summary 时正文仍是原文', () => {
    const events = feedEvents(
      board({
        done: [session('c1', 1)],
        activity: [{ at: 20, conversationId: 'c1', kind: 'goal-complete', text: noise }],
      })
    );
    expect(events.find((event) => event.id === 'activity:c1:20:goal-complete')).toMatchObject({
      label: 'Goal complete',
      detail: noise,
    });
  });

  it('老的活动条目靠同时刻同结果的卡片补 needsUser 或 summary', () => {
    const withNeed = goal({ needsUser: ['是否合并', '确认发版'], summary: '卡片摘要' });
    const withSummary = {
      ...goal({ conversationId: 'c2', summary: '已合并上架' }),
      conversationId: 'c2',
    };
    const events = feedEvents(
      board({
        done: [withNeed, withSummary],
        activity: [
          { at: 20, conversationId: 'c1', kind: 'goal-complete', text: noise },
          { at: 9, conversationId: 'c1', kind: 'goal-complete', text: noise },
          { at: 20, conversationId: 'c2', kind: 'goal-complete', text: noise },
        ],
      })
    );
    expect(events.find((event) => event.id === 'activity:c1:20:goal-complete')).toMatchObject({
      label: 'Done · needs you',
      tone: 'ok',
      detail: '是否合并；确认发版',
    });
    expect(events.find((event) => event.id === 'activity:c1:9:goal-complete')).toMatchObject({
      label: 'Goal complete',
      detail: noise,
    });
    expect(events.find((event) => event.id === 'activity:c2:20:goal-complete')).toMatchObject({
      label: 'Goal complete',
      detail: '已合并上架',
    });
  });

  it('needsUser 还在秘书处理中：会话卡片与活动条目都标「完成 · 秘书处理中」，正文只给 summary', () => {
    const triaging = goal({ triage: true, needsUser: ['手动删除临时文件'], summary: '部署完成' });
    const direct = feedEvents(board({ done: [triaging] }));
    expect(direct.find((event) => event.id === 'session:c1')).toMatchObject({
      label: 'Done · with secretary',
      tone: 'ok',
      detail: '部署完成',
    });
    const history = feedEvents(
      board({
        done: [triaging],
        activity: [
          {
            at: 20,
            conversationId: 'c1',
            kind: 'goal-complete',
            text: noise,
            needsUser: ['手动删除临时文件'],
            summary: '部署完成',
          },
        ],
      })
    );
    expect(history.find((event) => event.id === 'activity:c1:20:goal-complete')).toMatchObject({
      label: 'Done · with secretary',
      detail: '部署完成',
    });
    expect(zhTranslations['Done · with secretary']).toBe('完成 · 秘书处理中');
  });

  it('秘书升级后活动条目按卡片现在给用户看的条目显示，不用完成当时的原文', () => {
    const events = feedEvents(
      board({
        needsYou: [goal({ needsUser: ['在 Mac 顶栏点一下确认'] })],
        activity: [
          {
            at: 20,
            conversationId: 'c1',
            kind: 'goal-complete',
            text: noise,
            needsUser: ['手动删除临时文件', '在 Mac 上点一下顶栏按钮'],
          },
        ],
      })
    );
    expect(events.find((event) => event.id === 'activity:c1:20:goal-complete')).toMatchObject({
      label: 'Done · needs you',
      detail: '在 Mac 顶栏点一下确认',
    });
  });

  it('秘书 result_mark_done 收口后，之前那条完成动态是普通完成', () => {
    const events = feedEvents(
      board({
        done: [goal({ resultAt: 30, manual: true })],
        activity: [
          {
            at: 20,
            conversationId: 'c1',
            kind: 'goal-complete',
            text: noise,
            needsUser: ['手动删除临时文件'],
            summary: '部署完成',
          },
        ],
      })
    );
    expect(events.find((event) => event.id === 'activity:c1:20:goal-complete')).toMatchObject({
      label: 'Goal complete',
      detail: '部署完成',
    });
  });

  it('秘书续跑后旧的完成结果被撤下：之前那条完成动态不再说「需要你」', () => {
    const events = feedEvents(
      board({
        done: [goal({ result: undefined, resultAt: undefined })],
        activity: [
          {
            at: 20,
            conversationId: 'c1',
            kind: 'goal-complete',
            text: noise,
            needsUser: ['手动删除临时文件'],
            summary: '部署完成',
          },
        ],
      })
    );
    expect(events.find((event) => event.id === 'activity:c1:20:goal-complete')).toMatchObject({
      label: 'Goal complete',
      detail: '部署完成',
    });
  });

  it('会话投影没有 needsUser 但有 summary 时正文是 summary', () => {
    const events = feedEvents(board({ done: [goal({ summary: '已合并上架' })] }));
    expect(events.find((event) => event.id === 'session:c1')).toMatchObject({
      label: 'Goal complete',
      detail: '已合并上架',
    });
    expect(events.find((event) => event.id === 'session:c1')?.detail).not.toContain('PR 拆分方式');
  });

  it('续跑中的会话仍标进行中，不改用完成文案', () => {
    const events = feedEvents(
      board({
        running: [goal({ continuing: true, needsUser: ['确认'], summary: '摘要' })],
      })
    );
    expect(events.find((event) => event.id === 'session:c1')).toMatchObject({
      label: 'In progress',
      detail: '确认',
    });
  });

  it('同一会话同一次结果只出一条：活动历史在时不再重复投影会话卡片', () => {
    const events = feedEvents(
      board({
        done: [goal({ needsUser: ['是否合并'] })],
        activity: [
          { at: 20, conversationId: 'c1', kind: 'goal-complete', text: noise },
          { at: 9, conversationId: 'c1', kind: 'goal-complete', text: noise },
        ],
      })
    );
    expect(events.map((event) => event.id)).toEqual([
      'activity:c1:20:goal-complete',
      'activity:c1:9:goal-complete',
    ]);
  });

  it('卡片已有新结果或在跑时，旧的活动历史和会话卡片各出一条', () => {
    const newer = feedEvents(
      board({
        done: [goal({ result: 'turn-ended', resultAt: 30 })],
        activity: [{ at: 20, conversationId: 'c1', kind: 'goal-complete', text: noise }],
      })
    );
    expect(newer.map((event) => event.id)).toEqual(['session:c1', 'activity:c1:20:goal-complete']);
    const running = feedEvents(
      board({
        running: [goal({ state: 'running', stateSince: 25 })],
        activity: [{ at: 20, conversationId: 'c1', kind: 'goal-complete', text: noise }],
      })
    );
    expect(running.map((event) => event.id)).toEqual([
      'session:c1',
      'activity:c1:20:goal-complete',
    ]);
  });
});
