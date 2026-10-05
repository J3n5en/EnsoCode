import type { ProjectedMessage } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import { emptyProjection } from '@/stores/sessions/reducer';
import {
  directMarker,
  groupReadMark,
  isUnread,
  readKey,
  seedReadMarks,
  unreadMark,
} from './unread';

const msg = (text: string, optimistic = false) =>
  ({ role: 'user', content: [{ type: 'text', text }], optimistic }) as ProjectedMessage;

describe('readKey', () => {
  it('群聊按聊天、私聊按当前会话记已读（新对话从零开始）', () => {
    expect(readKey({ id: 'c', kind: 'group' })).toBe('c');
    expect(readKey({ id: 'c', kind: 'direct' }, 's1')).toBe('c:s1');
    expect(readKey({ id: 'c', kind: 'direct' })).toBe('c:');
  });
});

describe('groupReadMark', () => {
  const entries = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({ seq: from + i }));

  it('最新视图按 lastSeq 记已读', () => {
    expect(groupReadMark({ entries: entries(1, 5), lastSeq: 5 }, 2)).toBe(5);
  });

  it('历史窗口只推进到已加载的末尾，且不回退已有记号', () => {
    const history = { sinceSeq: 100 };
    expect(groupReadMark({ entries: entries(10, 20), lastSeq: 120, history }, 15)).toBe(20);
    expect(groupReadMark({ entries: entries(10, 20), lastSeq: 120, history }, 100)).toBe(100);
    expect(groupReadMark({ entries: [], lastSeq: 120, history }, undefined)).toBe(0);
  });
});

describe('directMarker', () => {
  it('按绝对消息数计，忽略未确认的乐观消息', () => {
    expect(
      directMarker({
        ...emptyProjection,
        historyBaseIndex: 10,
        messages: [msg('a'), msg('b'), msg('c', true)],
      })
    ).toBe(12);
    expect(directMarker(undefined)).toBe(0);
  });
});

describe('isUnread', () => {
  it('标记超过已读水位才算未读，缺省水位为 0', () => {
    expect(isUnread(3, 3)).toBe(false);
    expect(isUnread(4, 3)).toBe(true);
    expect(isUnread(1, undefined)).toBe(true);
    expect(isUnread(0, undefined)).toBe(false);
  });
});

describe('seedReadMarks', () => {
  it('首次使用时把当前活动全部视为已读，避免全部亮红点', () => {
    expect(seedReadMarks(null, { a: 5, b: 0 })).toEqual({ a: 5, b: 0 });
  });

  it('已有记录时原样返回', () => {
    const marks = { a: 1 };
    expect(seedReadMarks(marks, { a: 5, b: 2 })).toBe(marks);
  });
});

describe('unreadMark', () => {
  it('把已读记号退回一格，聊天重新显示未读；没有任何活动时无法标未读', () => {
    expect(isUnread(5, unreadMark(5))).toBe(true);
    expect(unreadMark(0)).toBeUndefined();
  });
});
