import { describe, expect, it } from 'vitest';
import type { GroupEntry } from '../../../shared/types/bot';
import {
  parseGroupHistoryQuery,
  queryGroupHistory,
  queryGroupHistoryNewestFirst,
} from './groupHistory';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const GONE = '33333333-3333-4333-8333-333333333333';
const names: Record<string, string> = { [ALICE]: 'Alice', [BOB]: 'Bob' };
const nameOf = (id: string) => names[id];

const base = (seq: number) => ({ seq, id: `e${seq}`, at: Date.UTC(2026, 9, 4, 0, 0, seq) });
const entries: GroupEntry[] = [
  { ...base(1), kind: 'human', text: '大家好，我们用 Redis 做缓存', mentions: [] },
  {
    ...base(2),
    kind: 'bot',
    botId: ALICE,
    text: '好的，我负责 redis 部署',
    conversationId: 'c',
    turnId: 't',
  },
  { ...base(3), kind: 'bot', botId: BOB, text: '我来写前端', conversationId: 'c', turnId: 't' },
  {
    ...base(4),
    kind: 'delegation',
    delegationId: 'd',
    from: ALICE,
    to: BOB,
    state: 'completed',
    summary: '登录页做完了',
  },
  { ...base(5), kind: 'system', text: 'Alice 认领了 #1 部署' },
  { ...base(6), kind: 'bot', botId: GONE, text: 'bye', conversationId: 'c', turnId: 't' },
  { ...base(7), kind: 'human', text: 'x'.repeat(5000), mentions: [] },
];

const seqs = (result: unknown) =>
  (result as { entries: { seq: number }[] }).entries.map((entry) => entry.seq);

describe('parseGroupHistoryQuery', () => {
  it('applies defaults and rejects bad types / ranges', () => {
    expect(parseGroupHistoryQuery({})).toEqual({ limit: 30 });
    expect(parseGroupHistoryQuery({ beforeSeq: 10, afterSeq: 2, limit: 5, query: 'a' })).toEqual({
      beforeSeq: 10,
      afterSeq: 2,
      limit: 5,
      query: 'a',
    });
    for (const bad of [
      { beforeSeq: '3' },
      { afterSeq: -1 },
      { limit: 101 },
      { limit: 1.5 },
      { query: 3 },
      { from: 'x'.repeat(200) },
    ])
      expect(parseGroupHistoryQuery(bad)).toEqual(expect.any(String));
  });
});

describe('queryGroupHistory', () => {
  it('returns the latest entries ascending with speakers and readable descriptions', () => {
    const result = queryGroupHistory(entries, nameOf, { limit: 30 });
    expect(result).toMatchObject({ ok: true, hasMore: false, lastSeq: 7 });
    expect(seqs(result)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const list = (result as { entries: { seq: number; from: string; text: string; at: string }[] })
      .entries;
    expect(list[0]).toMatchObject({ from: '用户', at: '2026-10-04T00:00:01.000Z' });
    expect(list[1]).toMatchObject({ from: 'Alice', text: '好的，我负责 redis 部署' });
    expect(list[3]).toMatchObject({ from: '系统' });
    expect(list[3].text).toContain('Alice');
    expect(list[3].text).toContain('Bob');
    expect(list[3].text).toContain('登录页做完了');
    expect(list[5].from).toBe('已删除成员');
  });

  it('truncates long text and marks it', () => {
    const result = queryGroupHistory(entries, nameOf, { limit: 1 });
    const [last] = (result as { entries: { text: string; truncated?: boolean }[] }).entries;
    expect(last.truncated).toBe(true);
    expect(last.text.length).toBeLessThan(2100);
    expect(last.text).toContain('5000');
  });

  it('pages backward with beforeSeq and forward with afterSeq', () => {
    const back = queryGroupHistory(entries, nameOf, { beforeSeq: 6, limit: 2 });
    expect(seqs(back)).toEqual([4, 5]);
    expect(back).toMatchObject({ hasMore: true });
    const forward = queryGroupHistory(entries, nameOf, { afterSeq: 1, limit: 2 });
    expect(seqs(forward)).toEqual([2, 3]);
    expect(forward).toMatchObject({ hasMore: true });
    const range = queryGroupHistory(entries, nameOf, { afterSeq: 1, beforeSeq: 4, limit: 30 });
    expect(seqs(range)).toEqual([2, 3]);
    expect(range).toMatchObject({ hasMore: false });
  });

  it('filters by case-insensitive query and by speaker', () => {
    expect(seqs(queryGroupHistory(entries, nameOf, { query: 'REDIS', limit: 30 }))).toEqual([1, 2]);
    expect(seqs(queryGroupHistory(entries, nameOf, { from: 'alice', limit: 30 }))).toEqual([2]);
    expect(seqs(queryGroupHistory(entries, nameOf, { from: '用户', limit: 30 }))).toEqual([1, 7]);
    expect(seqs(queryGroupHistory(entries, nameOf, { from: 'user', limit: 30 }))).toEqual([1, 7]);
    expect(queryGroupHistory(entries, nameOf, { from: 'Carol', limit: 30 })).toMatchObject({
      ok: false,
      error: expect.stringContaining('Alice'),
    });
  });

  it('caps the total payload and reports hasMore', () => {
    const many: GroupEntry[] = Array.from({ length: 60 }, (_, i) => ({
      ...base(i + 1),
      kind: 'human' as const,
      text: 'y'.repeat(3000),
      mentions: [],
    }));
    const result = queryGroupHistory(many, nameOf, { limit: 100 });
    const got = seqs(result);
    expect(got.length).toBeLessThan(60);
    expect(got.at(-1)).toBe(60);
    expect(result).toMatchObject({ hasMore: true });
  });

  it('consumes a newest-first source lazily and stops once the page is known', () => {
    const many: GroupEntry[] = Array.from({ length: 1000 }, (_, i) => ({
      ...base(i + 1),
      kind: 'human' as const,
      text: `m${i + 1}`,
      mentions: [],
    }));
    let pulled = 0;
    function* source() {
      for (let i = many.length - 1; i >= 0; i--) {
        pulled++;
        yield many[i];
      }
    }
    const page = queryGroupHistoryNewestFirst(source(), nameOf, { limit: 5 });
    expect(seqs(page)).toEqual([996, 997, 998, 999, 1000]);
    expect(page).toMatchObject({ hasMore: true, lastSeq: 1000 });
    expect(pulled).toBeLessThanOrEqual(6);
    pulled = 0;
    const ranged = queryGroupHistoryNewestFirst(source(), nameOf, { afterSeq: 990, limit: 3 });
    expect(seqs(ranged)).toEqual([991, 992, 993]);
    expect(pulled).toBeLessThanOrEqual(11);
  });
});
