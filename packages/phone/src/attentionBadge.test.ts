import { describe, expect, it } from 'vitest';
import { applyAppBadge, attentionBadgeCount } from './attentionBadge';

describe('attentionBadgeCount', () => {
  it('把各会话待提问与待审批加总', () => {
    expect(
      attentionBadgeCount([
        { pendingAskCount: 1 },
        { pendingApprovalCount: 2 },
        { pendingAskCount: 1, pendingApprovalCount: 1 },
        {},
      ])
    ).toBe(5);
  });

  it('缺字段、空列表、非正数都当 0', () => {
    expect(attentionBadgeCount([])).toBe(0);
    expect(attentionBadgeCount([{}])).toBe(0);
    expect(attentionBadgeCount([{ pendingAskCount: 0, pendingApprovalCount: 0 }])).toBe(0);
    expect(attentionBadgeCount([{ pendingAskCount: -2, pendingApprovalCount: 1.8 }])).toBe(1);
  });

  it('静音会话不计入主屏幕角标，未静音的仍计入', () => {
    expect(
      attentionBadgeCount([
        { pendingAskCount: 2, pendingApprovalCount: 1, muted: true },
        { pendingApprovalCount: 1 },
      ])
    ).toBe(1);
  });
});

describe('applyAppBadge', () => {
  it('count > 0 走 setAppBadge，否则 clearAppBadge', () => {
    const calls: Array<['set', number] | ['clear']> = [];
    const api = {
      setAppBadge: (n: number) => {
        calls.push(['set', n]);
      },
      clearAppBadge: () => {
        calls.push(['clear']);
      },
    };
    applyAppBadge(3, api);
    applyAppBadge(0, api);
    applyAppBadge(-1, api);
    expect(calls).toEqual([['set', 3], ['clear'], ['clear']]);
  });

  it('API 缺失时不抛', () => {
    expect(() => applyAppBadge(2, {})).not.toThrow();
    expect(() => applyAppBadge(0, {})).not.toThrow();
  });
});
