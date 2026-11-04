import { describe, expect, it } from 'vitest';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { turnMetaTails } from './turnMeta';

const user = (key: string, extra: Partial<Extract<TimelineItem, { kind: 'user' }>> = {}) =>
  ({
    kind: 'user',
    key,
    text: '',
    images: [],
    replyModel: 'm',
    replyAt: 1,
    ...extra,
  }) as TimelineItem;
const row = (kind: TimelineItem['kind'], key: string) => ({ kind, key }) as TimelineItem;

const tailsOf = (rows: TimelineItem[], running = false) =>
  Object.fromEntries([...turnMetaTails(rows, running)].map(([key, owner]) => [key, owner.key]));

describe('turnMetaTails', () => {
  it('每轮回复的末行挂本轮用户行，含不可作回复开头的收尾行', () => {
    const rows = [
      user('0'),
      row('thinking', '0-t'),
      row('tool', '0-a'),
      row('text', '0-b'),
      user('1'),
      row('tool-group', '1-g'),
      row('error', '1-e'),
    ];
    expect(tailsOf(rows)).toEqual({ '0-b': '0', '1-e': '1' });
  });

  it('折叠的轮次、没有回复行的轮次、无元信息的轮次都不挂', () => {
    const rows = [
      user('0', { collapsed: true }),
      user('1'),
      row('error', '1-e'),
      user('2', { replyModel: undefined, replyAt: undefined }),
      row('text', '2-a'),
      user('3'),
    ];
    expect(tailsOf(rows)).toEqual({});
  });

  it('分页时首个用户行之前的回复行没有归属，不挂', () => {
    expect(tailsOf([row('text', 'x'), user('1'), row('text', '1-a')])).toEqual({ '1-a': '1' });
  });

  it('运行中的末轮不挂，回合结束后才出现在末尾', () => {
    const rows = [user('0'), row('text', '0-a'), user('1'), row('tool-group', '1-g')];
    expect(tailsOf(rows, true)).toEqual({ '0-a': '0' });
    expect(tailsOf([...rows, row('text', '1-b')], false)).toEqual({ '0-a': '0', '1-b': '1' });
  });
});
