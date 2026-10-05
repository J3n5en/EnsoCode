import { describe, expect, it } from 'vitest';
import { closeChatTab, parseChatTabs, revealChatTab } from './browserTabs';

describe('聊天浏览器多标签', () => {
  it('打开新标签追加并激活；已有标签只激活不重复', () => {
    const one = revealChatTab(undefined, 'a');
    expect(one).toEqual({ tabs: ['a'], active: 'a' });
    const two = revealChatTab(one, 'b');
    expect(two).toEqual({ tabs: ['a', 'b'], active: 'b' });
    expect(revealChatTab(two, 'a')).toEqual({ tabs: ['a', 'b'], active: 'a' });
  });

  it('关掉激活标签时激活相邻的（优先右侧，没有则左侧）；关完返回 undefined', () => {
    const s = { tabs: ['a', 'b', 'c'], active: 'b' };
    expect(closeChatTab(s, 'b')).toEqual({ tabs: ['a', 'c'], active: 'c' });
    expect(closeChatTab({ tabs: ['a', 'b'], active: 'b' }, 'b')).toEqual({
      tabs: ['a'],
      active: 'a',
    });
    expect(closeChatTab(s, 'a')).toEqual({ tabs: ['b', 'c'], active: 'b' });
    expect(closeChatTab({ tabs: ['a'], active: 'a' }, 'a')).toBeUndefined();
    expect(closeChatTab(s, 'zzz')).toBe(s);
  });

  it('读取持久化：兼容旧版单 tab 字符串，丢弃坏数据', () => {
    expect(
      parseChatTabs({
        c1: 'browser:1',
        c2: { tabs: ['x', 'y', 7], active: 'y' },
        c3: { tabs: ['x'], active: 'gone' },
        c4: { tabs: [] },
        c5: 3,
      })
    ).toEqual({
      c1: { tabs: ['browser:1'], active: 'browser:1' },
      c2: { tabs: ['x', 'y'], active: 'y' },
      c3: { tabs: ['x'], active: 'x' },
    });
    expect(parseChatTabs(null)).toEqual({});
    expect(parseChatTabs([])).toEqual({});
  });
});
