import { describe, expect, it } from 'vitest';
import { nextUnread } from './unread';

describe('nextUnread', () => {
  it('后台会话 running→idle 标未读', () => {
    expect(nextUnread({ prevStatus: 'running', nextStatus: 'idle', viewed: false })).toBe(true);
  });

  it('当前查看中的会话完成不标未读', () => {
    expect(nextUnread({ prevStatus: 'running', nextStatus: 'idle', viewed: true })).toBe(false);
  });

  it('查看时清掉已有未读', () => {
    expect(
      nextUnread({ prevStatus: 'idle', nextStatus: 'idle', prevUnread: true, viewed: true })
    ).toBe(false);
  });

  it('非完成转换保留原未读值', () => {
    expect(
      nextUnread({ prevStatus: 'running', nextStatus: 'running', prevUnread: true, viewed: false })
    ).toBe(true);
    expect(nextUnread({ prevStatus: 'idle', nextStatus: 'running', viewed: false })).toBe(false);
  });

  it('失败不算完成未读（红点已表达）', () => {
    expect(nextUnread({ prevStatus: 'running', nextStatus: 'failed', viewed: false })).toBe(false);
  });
});
