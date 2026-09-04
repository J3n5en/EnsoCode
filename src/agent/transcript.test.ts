import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { transcriptMessages } from './transcript';

type Msg = Extract<SessionEntry, { type: 'message' }>;
const msg = (id: string, role: string, text: string, parentId: string | null): Msg =>
  ({
    type: 'message',
    id,
    parentId,
    timestamp: `2026-01-01T00:00:0${id}Z`,
    message: { role, content: [{ type: 'text', text }] },
  }) as unknown as Msg;
const compaction = (
  id: string,
  parentId: string,
  summary: string,
  tokensBefore: number,
  firstKeptEntryId?: string
): SessionEntry =>
  ({
    type: 'compaction',
    id,
    parentId,
    timestamp: `2026-01-01T00:00:0${id}Z`,
    summary,
    tokensBefore,
    ...(firstKeptEntryId ? { firstKeptEntryId } : {}),
  }) as unknown as SessionEntry;

describe('transcriptMessages', () => {
  it('无 compaction 时原样返回 context 消息', () => {
    const entries: SessionEntry[] = [msg('1', 'user', 'a', null), msg('2', 'assistant', 'b', '1')];
    const context = entries.map((e) => (e as Msg).message);
    const result = transcriptMessages({ getBranch: () => entries }, context);
    expect(result).toBe(context);
  });

  it('compaction 之前被摘要掉的历史补回到 context 前面，summary 落在原位', () => {
    const entries: SessionEntry[] = [
      msg('1', 'user', 'old-q', null),
      msg('2', 'assistant', 'old-a', '1'),
      msg('3', 'user', 'kept-q', '2'),
      msg('4', 'assistant', 'kept-a', '3'),
      compaction('5', '4', 'SUMMARY', 1000, '3'),
      msg('6', 'user', 'new-q', '5'),
    ];
    // pi 的 context 视图：summary + firstKept 起的条目 + compaction 之后的条目
    const context = [
      { role: 'compactionSummary', summary: 'SUMMARY', tokensBefore: 1000 },
      (entries[2] as Msg).message,
      (entries[3] as Msg).message,
      (entries[5] as Msg).message,
    ];
    const result = transcriptMessages({ getBranch: () => entries }, context) as {
      role: string;
      content?: { text: string }[];
    }[];
    expect(result.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'compactionSummary',
      'user',
      'assistant',
      'user',
    ]);
    expect(result[0].content?.[0].text).toBe('old-q');
    expect(result[3].content?.[0].text).toBe('kept-q');
  });

  it('firstKeptEntryId 缺失（全部摘要）时补回 compaction 之前的全部历史', () => {
    const entries: SessionEntry[] = [
      msg('1', 'user', 'a', null),
      msg('2', 'assistant', 'b', '1'),
      compaction('3', '2', 'S', 10),
    ];
    const context = [{ role: 'compactionSummary', summary: 'S', tokensBefore: 10 }];
    const result = transcriptMessages({ getBranch: () => entries }, context) as { role: string }[];
    expect(result.map((m) => m.role)).toEqual(['user', 'assistant', 'compactionSummary']);
  });

  it('多次 compaction：更早的 compaction 也以 summary 消息出现在历史中', () => {
    const entries: SessionEntry[] = [
      msg('1', 'user', 'a', null),
      compaction('2', '1', 'S1', 10),
      msg('3', 'user', 'b', '2'),
      compaction('4', '3', 'S2', 20),
      msg('5', 'user', 'c', '4'),
    ];
    const context = [
      { role: 'compactionSummary', summary: 'S2', tokensBefore: 20 },
      (entries[4] as Msg).message,
    ];
    const result = transcriptMessages({ getBranch: () => entries }, context) as {
      role: string;
      summary?: string;
    }[];
    expect(result.map((m) => m.summary ?? m.role)).toEqual(['user', 'S1', 'user', 'S2', 'user']);
  });
});
