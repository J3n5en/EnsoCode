import type { ProjectedMessage } from '@shared/types/agent';
import type { Delegation, GroupEntry } from '@shared/types/bot';
import { describe, expect, it } from 'vitest';
import {
  anchorDelegations,
  buildRows,
  locateTurn,
  mergeLatest,
  mergeNewer,
  mergeOlder,
  trimTimeline,
  turnSteps,
} from './groupTimeline';

const human = (seq: number, at = seq * 1000): GroupEntry => ({
  kind: 'human',
  seq,
  id: `h${seq}`,
  at,
  text: `t${seq}`,
  mentions: [],
});
const bot = (seq: number, botId: string, at = seq * 1000): GroupEntry => ({
  kind: 'bot',
  seq,
  id: `b${seq}`,
  at,
  botId,
  text: `r${seq}`,
  conversationId: 'c',
  turnId: 't',
});

describe('mergeLatest', () => {
  it('与已有尾部相接时按 seq 去重合并', () => {
    const result = mergeLatest([human(1), human(2)], [human(2), human(3)]);
    expect(result.entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(result.gap).toBe(false);
  });

  it('新页与已有内容之间有空洞时整体替换并标记 gap', () => {
    const result = mergeLatest([human(1)], [human(5), human(6)]);
    expect(result.entries.map((e) => e.seq)).toEqual([5, 6]);
    expect(result.gap).toBe(true);
  });

  it('空页不改动', () => {
    const entries = [human(1)];
    expect(mergeLatest(entries, []).entries).toBe(entries);
  });
});

describe('mergeOlder', () => {
  it('前置更早一页并去重', () => {
    expect(
      mergeOlder([human(3), human(4)], [human(1), human(2), human(3)]).map((e) => e.seq)
    ).toEqual([1, 2, 3, 4]);
  });
});

describe('mergeNewer', () => {
  it('只追加末尾之后的条目，重叠部分按 seq 去重', () => {
    expect(
      mergeNewer([human(3), human(4)], [human(2), human(4), human(5), human(6)]).map((e) => e.seq)
    ).toEqual([3, 4, 5, 6]);
  });

  it('没有更新的条目时原样返回', () => {
    const entries = [human(3)];
    expect(mergeNewer(entries, [human(1), human(3)])).toBe(entries);
  });
});

describe('trimTimeline', () => {
  const seqs = (n: number) => Array.from({ length: n }, (_, i) => human(i + 1));

  it('未超上限不裁剪', () => {
    const entries = seqs(3);
    expect(trimTimeline(entries, 3, 'start')).toEqual({ entries, trimmed: false });
  });

  it('超上限时从远离视口的一端裁掉', () => {
    const start = trimTimeline(seqs(5), 3, 'start');
    expect(start.entries.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(start.trimmed).toBe(true);
    expect(trimTimeline(seqs(5), 3, 'end').entries.map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});

describe('buildRows', () => {
  it('同一作者五分钟内的连续消息合并头像', () => {
    const rows = buildRows([
      bot(1, 'x', 1000),
      bot(2, 'x', 2000),
      bot(3, 'y', 3000),
      human(4, 4000),
    ]);
    const entries = rows.filter((row) => row.kind === 'entry');
    expect(entries.map((row) => row.continued)).toEqual([false, true, false, false]);
  });

  it('跨天插入日期分隔，分隔后不合并', () => {
    const day1 = new Date(2026, 0, 1, 23, 59).getTime();
    const day2 = new Date(2026, 0, 2, 0, 1).getTime();
    const rows = buildRows([bot(1, 'x', day1), bot(2, 'x', day2)]);
    expect(rows.map((row) => row.kind)).toEqual(['day', 'entry', 'day', 'entry']);
    expect(rows[3].kind === 'entry' && rows[3].continued).toBe(false);
  });

  it('系统消息与委派卡片不参与合并', () => {
    const system: GroupEntry = { kind: 'system', seq: 2, id: 's', at: 1500, text: 'x' };
    const rows = buildRows([bot(1, 'x', 1000), system, bot(3, 'x', 2000)]);
    const entries = rows.filter((row) => row.kind === 'entry');
    expect(entries.map((row) => row.continued)).toEqual([false, false, false]);
  });
});

const text = (role: string, value: string): ProjectedMessage => ({
  role,
  content: [{ type: 'text', text: value }],
});
const call = (id: string, name: string, args: Record<string, unknown>): ProjectedMessage => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id, name, arguments: args }],
});
const result = (id: string, isError = false): ProjectedMessage => ({
  role: 'toolResult',
  toolCallId: id,
  isError,
  content: [],
});

describe('locateTurn', () => {
  const messages = [
    text('user', 'q1'),
    text('assistant', 'answer one'),
    text('user', 'q2'),
    call('1', 'read', { path: 'a.ts' }),
    result('1'),
    text('assistant', 'answer two'),
    text('user', 'q3'),
    text('assistant', 'answer three'),
  ];

  it('按最终回复文本定位到该轮（从对应 user 消息起）', () => {
    expect(locateTurn(messages, '  answer two ')).toEqual({ start: 2, end: 6, exact: true });
  });

  it('定位不到时回落到最近一轮', () => {
    expect(locateTurn(messages, 'missing')).toEqual({ start: 6, end: 8, exact: false });
  });

  it('没有消息时返回 null', () => {
    expect(locateTurn([], 'x')).toBeNull();
  });
});

describe('turnSteps', () => {
  it('列出工具调用、关键参数与失败状态', () => {
    const steps = turnSteps([
      call('1', 'read', { path: 'src/a.ts' }),
      result('1'),
      call('2', 'bash', { command: 'pnpm test' }),
      result('2', true),
    ]);
    expect(steps).toEqual([
      { id: '1', name: 'read', detail: 'src/a.ts', error: false },
      { id: '2', name: 'bash', detail: 'pnpm test', error: true },
    ]);
  });
});

describe('anchorDelegations', () => {
  const del = (id: string, createdAt: number, parentConversationId = 'p'): Delegation =>
    ({ id, createdAt, parentConversationId }) as Delegation;
  const reply = (seq: number, at: number, conversationId: string): GroupEntry =>
    ({ ...bot(seq, 'x', at), conversationId }) as GroupEntry;

  it('挂在发起者那一轮的群回复之后，而不是时间线末尾', () => {
    const entries = [human(1, 1000), reply(2, 3000, 'p'), reply(3, 5000, 'q')];
    const { after, head } = anchorDelegations(entries, [del('d1', 2000), del('d2', 2500)]);
    expect(after.get('b2')?.map((d) => d.id)).toEqual(['d1', 'd2']);
    expect(after.has('b3')).toBe(false);
    expect(head).toEqual([]);
  });

  it('发起者这一轮还没回复时挂在创建时间之前的最后一条之后', () => {
    const entries = [human(1, 1000), reply(2, 3000, 'q')];
    const { after } = anchorDelegations(entries, [del('d1', 2000)]);
    expect(after.get('h1')?.map((d) => d.id)).toEqual(['d1']);
  });

  it('早于已加载的第一条时放在最前', () => {
    const { head, after } = anchorDelegations([human(5, 9000)], [del('d1', 100, 'z')]);
    expect(head.map((d) => d.id)).toEqual(['d1']);
    expect(after.size).toBe(0);
  });
});
