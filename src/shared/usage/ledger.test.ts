import { describe, expect, it } from 'vitest';
import type { ActivitySpan } from './aggregate';
import { mergeUsageSources, type UsageSessionSlice } from './ledger';
import type { UsageRecord } from './types';

function rec(overrides: Partial<UsageRecord> & { id: string; sessionId: string }): UsageRecord {
  return {
    ts: 1,
    model: 'm',
    provider: 'p',
    project: 'demo',
    input: 10,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    ...overrides,
  };
}

function slice(
  sessionId: string,
  records: UsageRecord[],
  spans: ActivitySpan[] = []
): UsageSessionSlice {
  return { sessionId, records, spans };
}

describe('mergeUsageSources — 按 entry id 去重', () => {
  it('同一 jsonl entry id 在源会话和 fork 副本各出现一次时只计一份 token', () => {
    const shared = rec({ id: 'e1', sessionId: 'src', input: 100 });
    const forked = rec({ id: 'e1', sessionId: 'fork', input: 100 });
    const extra = rec({ id: 'e2', sessionId: 'fork', input: 5, ts: 2 });
    const merged = mergeUsageSources([slice('src', [shared]), slice('fork', [forked, extra])], []);
    expect(merged.records).toHaveLength(2);
    expect(merged.records.reduce((s, r) => s + r.input, 0)).toBe(105);
  });

  it('live 与账本同一 id 时以 live 为准', () => {
    const ledger = rec({ id: 'e1', sessionId: 's', input: 1 });
    const live = rec({ id: 'e1', sessionId: 's', input: 99 });
    const merged = mergeUsageSources([slice('s', [live])], [slice('s', [ledger])]);
    expect(merged.records).toEqual([live]);
  });

  it('jsonl 已删、账本仍在时用量保留', () => {
    const kept = rec({ id: 'e1', sessionId: 'gone', input: 40 });
    const merged = mergeUsageSources([], [slice('gone', [kept])]);
    expect(merged.records).toEqual([kept]);
  });
});

describe('mergeUsageSources — rewind / activity', () => {
  it('rewind 后旧 entry 与新 entry 都计（调用已经发生）', () => {
    const oldTurn = rec({ id: 'old', sessionId: 's', input: 10, ts: 1 });
    const newTurn = rec({ id: 'new', sessionId: 's', input: 20, ts: 2 });
    const merged = mergeUsageSources([slice('s', [oldTurn, newTurn])], []);
    expect(merged.records.reduce((s, r) => s + r.input, 0)).toBe(30);
  });

  it('fork 前缀 record 归源会话后，fork 的前缀 span 不计入 activeMs 素材', () => {
    const shared = rec({ id: 'e1', sessionId: 'src', input: 100, ts: 50 });
    const copy = rec({ id: 'e1', sessionId: 'fork', input: 100, ts: 50 });
    const later = rec({ id: 'e2', sessionId: 'fork', input: 1, ts: 200 });
    const merged = mergeUsageSources(
      [
        slice('src', [shared], [{ start: 0, end: 100 }]),
        slice(
          'fork',
          [copy, later],
          [
            { start: 0, end: 100 },
            { start: 150, end: 250 },
          ]
        ),
      ],
      []
    );
    const prefixOwners = merged.activity.filter((a) =>
      a.spans.some((s) => s.start === 0 && s.end === 100)
    );
    expect(prefixOwners).toHaveLength(1);
    const forkActivity = merged.activity.find((a) => a.sessionId === 'fork');
    expect(forkActivity?.spans.some((s) => s.start === 150 && s.end === 250)).toBe(true);
  });
});
