import { conversationDotTone } from '@shared/conversationDotTone';
import { describe, expect, it } from 'vitest';
import { isPairViewed, nextUnread, setPairViewedSession } from './unread';

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

  it('后台失败标未读，查看后清除，供活跃栏判断错误是否已读', () => {
    expect(nextUnread({ prevStatus: 'running', nextStatus: 'failed', viewed: false })).toBe(true);
    expect(nextUnread({ prevStatus: 'idle', nextStatus: 'failed', viewed: false })).toBe(true);
    expect(nextUnread({ prevStatus: 'running', nextStatus: 'failed', viewed: true })).toBe(false);
    expect(
      nextUnread({ prevStatus: 'failed', nextStatus: 'failed', prevUnread: false, viewed: false })
    ).toBe(false);
  });

  it('秘书负责的会话跑完不标未读，侧栏不出绿点；普通会话照旧', () => {
    const dot = (unread: boolean) => conversationDotTone({ status: 'idle', unread });
    const finish = (secretaryOwned: boolean) =>
      dot(nextUnread({ prevStatus: 'running', nextStatus: 'idle', viewed: false, secretaryOwned }));
    expect(finish(true)).toBe('idle');
    expect(finish(false)).toBe('unread');
  });
});

describe('pair viewed', () => {
  it('记录手机正在看的会话', () => {
    setPairViewedSession('s1');
    expect(isPairViewed('s1')).toBe(true);
    expect(isPairViewed('s2')).toBe(false);
    setPairViewedSession(null);
    expect(isPairViewed('s1')).toBe(false);
  });
});
