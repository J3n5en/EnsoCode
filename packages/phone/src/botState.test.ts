import type {
  PairBotActivity,
  PairBotChatSummary,
  PairBotMember,
  PairGroupEntry,
} from '@enso/pair';
import { describe, expect, it } from 'vitest';
import {
  activeMention,
  activityLine,
  activityStateText,
  botChatSections,
  chatActivities,
  formatElapsed,
  inboxLabel,
  insertMention,
  mentionOptions,
  mergeGroupTimeline,
  visibleGroupEntries,
} from './botState';

const member = (id: string, name: string, extra: Partial<PairBotMember> = {}): PairBotMember => ({
  id,
  name,
  title: '',
  avatarColor: '#7c5cff',
  status: 'idle',
  ...extra,
});

const chat = (
  id: string,
  kind: 'direct' | 'group',
  updatedAt: number,
  extra: Partial<PairBotChatSummary> = {}
): PairBotChatSummary => ({
  id,
  kind,
  title: id,
  members: kind === 'direct' ? ['a'] : ['a', 'b'],
  bossBotId: kind === 'group' ? 'a' : null,
  updatedAt,
  lastSeq: 0,
  sessions: {},
  status: 'idle',
  ...extra,
});

const human = (seq: number): Extract<PairGroupEntry, { kind: 'human' }> => ({
  seq,
  id: `e${seq}`,
  at: seq,
  kind: 'human',
  text: `m${seq}`,
  mentions: [],
});
const page = (
  seqs: number[],
  extra: { beforeSeq?: number; hasOlder?: boolean; lastSeq?: number } = {}
) => ({
  type: 'group-timeline' as const,
  chatId: 'c',
  entries: seqs.map(human),
  lastSeq: extra.lastSeq ?? Math.max(0, ...seqs),
  hasOlder: extra.hasOlder ?? (seqs[0] ?? 1) > 1,
  ...(extra.beforeSeq !== undefined ? { beforeSeq: extra.beforeSeq } : {}),
});

describe('Bot 抽屉列表', () => {
  it('群聊在上、私聊在下；各自置顶优先再按活跃倒序', () => {
    const bots = [member('a', '阿后')];
    const sections = botChatSections(
      [
        chat('d1', 'direct', 5),
        chat('g1', 'group', 1),
        chat('g2', 'group', 9),
        chat('g3', 'group', 2, { pinned: true }),
        chat('d2', 'direct', 7),
      ],
      bots
    );
    expect(sections.groups.map((c) => c.id)).toEqual(['g3', 'g2', 'g1']);
    expect(sections.directs.map((c) => c.id)).toEqual(['d2', 'd1']);
  });

  it('已归档成员的私聊不显示', () => {
    const sections = botChatSections(
      [chat('d1', 'direct', 1), chat('d2', 'direct', 2, { members: ['z'] })],
      [member('a', '阿后', { archived: true })]
    );
    expect(sections.directs).toEqual([]);
  });
});

describe('群时间线分页合并', () => {
  it('stops requesting history when an older page is empty', () => {
    const current = mergeGroupTimeline(undefined, page([4, 5]));
    expect(
      mergeGroupTimeline(current, page([], { beforeSeq: 4, hasOlder: false, lastSeq: 5 })).hasOlder
    ).toBe(false);
  });
  it('does not replace a complete message with a relay-truncated projection', () => {
    const current = mergeGroupTimeline(undefined, {
      ...page([1]),
      entries: [{ ...human(1), text: 'complete content' }],
    });
    const next = mergeGroupTimeline(current, {
      ...page([1]),
      entries: [{ ...human(1), text: 'complete', truncated: true }],
    });
    expect(next.entries[0]).toMatchObject({ text: 'complete content' });
  });
  it('leaves the old reading window when a new conversation starts and ignores old-epoch pages', () => {
    const current = {
      ...mergeGroupTimeline(undefined, page([1, 2, 3])),
      history: true as const,
      epochSeq: 0,
    };
    const next = mergeGroupTimeline(current, { ...page([4, 5]), epochSeq: 4 });
    expect(next.entries.map((entry) => entry.seq)).toEqual([4, 5]);
    expect(next.history).toBeUndefined();
    expect(mergeGroupTimeline(next, { ...page([1, 2, 3], { beforeSeq: 4 }), epochSeq: 0 })).toBe(
      next
    );
  });
  it('shows the epoch and current segment until earlier messages are explicitly expanded', () => {
    const entries = [human(1), human(2), human(3)];
    expect(visibleGroupEntries(entries, 2, false).map((entry) => entry.seq)).toEqual([2, 3]);
    expect(visibleGroupEntries(entries, 2, true)).toEqual(entries);
  });
  it('bounds long histories and retains the reading window when live updates arrive', () => {
    const seqs = Array.from({ length: 600 }, (_, i) => i + 1);
    const latest = mergeGroupTimeline(undefined, page(seqs));
    expect(latest.entries).toHaveLength(400);
    expect(latest.entries[0].seq).toBe(201);
    const older = mergeGroupTimeline(
      latest,
      page(seqs.slice(150, 200), { beforeSeq: 201, lastSeq: 600 })
    );
    expect(older.entries).toHaveLength(400);
    expect(older.entries[0].seq).toBe(151);
    expect(older.entries.at(-1)?.seq).toBe(550);
    expect(older.history).toBe(true);
    const updated = mergeGroupTimeline(older, page([600, 601]));
    expect(updated.entries).toEqual(older.entries);
    expect(updated.lastSeq).toBe(601);
  });
  it('首屏直接采用', () => {
    const state = mergeGroupTimeline(undefined, page([3, 4, 5]));
    expect(state.entries.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(state.hasOlder).toBe(true);
    expect(state.lastSeq).toBe(5);
  });

  it('向上分页拼到前面，hasOlder 取最早一页', () => {
    const first = mergeGroupTimeline(undefined, page([3, 4, 5]));
    const older = mergeGroupTimeline(first, page([1, 2], { beforeSeq: 3, lastSeq: 5 }));
    expect(older.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(older.hasOlder).toBe(false);
  });

  it('最新页与已加载区间重叠时按 seq 去重、新内容覆盖，保留更早的页', () => {
    let state = mergeGroupTimeline(undefined, page([3, 4]));
    state = mergeGroupTimeline(state, page([1, 2], { beforeSeq: 3, lastSeq: 4 }));
    const latest = page([4, 5, 6]);
    latest.entries[0] = { ...latest.entries[0], text: 'edited' };
    state = mergeGroupTimeline(state, latest);
    expect(state.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(state.entries[3]).toMatchObject({ text: 'edited' });
    expect(state.hasOlder).toBe(false);
    expect(state.lastSeq).toBe(6);
  });

  it('最新页与已加载区间之间有缺口时丢弃旧区间，避免时间线断档', () => {
    const state = mergeGroupTimeline(
      mergeGroupTimeline(undefined, page([1, 2])),
      page([10, 11], { hasOlder: true })
    );
    expect(state.entries.map((e) => e.seq)).toEqual([10, 11]);
    expect(state.hasOlder).toBe(true);
  });

  it('过期的分页应答（与当前最早条目不衔接）被忽略', () => {
    const state = mergeGroupTimeline(undefined, page([10, 11], { hasOlder: true }));
    const stale = mergeGroupTimeline(state, page([1, 2], { beforeSeq: 5, lastSeq: 11 }));
    expect(stale).toBe(state);
  });
});

describe('@ 补全', () => {
  const members = [member('a', 'Alice'), member('b', '阿后'), member('c', 'alex')];

  it('识别光标前正在输入的 @前缀', () => {
    expect(activeMention('hi @al', 6)).toEqual({ start: 3, query: 'al' });
    expect(activeMention('@', 1)).toEqual({ start: 0, query: '' });
    expect(activeMention('hi @al there', 12)).toBeNull();
    expect(activeMention('mail a@b', 8)).toBeNull();
    expect(activeMention('no mention', 10)).toBeNull();
  });

  it('候选含「所有人」并按前缀过滤', () => {
    expect(mentionOptions('', members).map((m) => m.name)).toEqual([
      '所有人',
      'Alice',
      '阿后',
      'alex',
    ]);
    expect(mentionOptions('AL', members).map((m) => m.name)).toEqual(['Alice', 'alex']);
    expect(mentionOptions('所', members).map((m) => m.name)).toEqual(['所有人']);
  });

  it('插入提及并把光标放到其后', () => {
    expect(insertMention('hi @al', { start: 3, query: 'al' }, 6, 'Alice')).toEqual({
      text: 'hi @Alice ',
      caret: 10,
    });
    expect(insertMention('@ 你好', { start: 0, query: '' }, 1, '阿后')).toEqual({
      text: '@阿后  你好',
      caret: 4,
    });
  });
});

describe('inboxLabel', () => {
  it('按类型给出中文标签，静默显示已安静秒数', () => {
    const item = { key: 'k', chatId: null, createdAt: 1, dismissible: false } as const;
    expect(inboxLabel({ ...item, kind: 'approval' }, 0)).toBe('需要审批');
    expect(inboxLabel({ ...item, kind: 'routine-blocked' }, 0)).toBe('例行任务被阻塞');
    expect(inboxLabel({ ...item, kind: 'silence', since: 1_000 }, 92_500)).toBe('已安静 91 秒');
  });
});

describe('成员运行态', () => {
  const act = (patch: Partial<PairBotActivity>): PairBotActivity => ({
    conversationId: 'c',
    botId: 'b',
    chatId: 'g',
    state: 'thinking',
    steps: [],
    more: 0,
    ...patch,
  });

  it('状态文案含排队原因', () => {
    expect(activityStateText(act({ state: 'tool' }))).toBe('调用工具');
    expect(activityStateText(act({ state: 'typing' }))).toBe('输出中');
    expect(activityStateText(act({ state: 'retrying' }))).toBe('重试中');
    expect(activityStateText(act({ state: 'queued', reason: 'turn' }))).toBe('排队 · 等上一轮结束');
    expect(activityStateText(act({ state: 'queued', reason: 'capacity' }))).toBe('排队 · 并发已满');
    expect(activityStateText(act({ state: 'queued' }))).toBe('排队中');
  });

  it('一行摘要优先显示运行中的工具', () => {
    expect(
      activityLine(
        act({
          state: 'tool',
          steps: [
            { name: 'read', detail: 'a.ts', status: 'done' },
            { name: 'bash', detail: 'pnpm test', status: 'running' },
          ],
        })
      )
    ).toBe('bash pnpm test');
    expect(activityLine(act({ state: 'thinking' }))).toBe('思考中');
  });

  it('按聊天筛选，运行中在前', () => {
    const items = [
      act({ conversationId: 'q', state: 'queued' }),
      act({ conversationId: 'x', chatId: 'other' }),
      act({ conversationId: 'r', state: 'tool' }),
    ];
    expect(chatActivities(items, 'g').map((item) => item.conversationId)).toEqual(['r', 'q']);
  });

  it('耗时格式', () => {
    expect(formatElapsed(-5)).toBe('0s');
    expect(formatElapsed(8_400)).toBe('8s');
    expect(formatElapsed(65_000)).toBe('1m05s');
    expect(formatElapsed(3_723_000)).toBe('1h02m');
  });
});
