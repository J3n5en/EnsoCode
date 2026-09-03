import { describe, expect, it } from 'vitest';
import { parseSettingsDeepLink } from './settingsDeepLink';

describe('parseSettingsDeepLink', () => {
  it('解析合法深链', () => {
    expect(parseSettingsDeepLink({ category: 'general', rowId: 'general.language' })).toEqual({
      category: 'general',
      rowId: 'general.language',
    });
  });

  it('接受所有合法分类', () => {
    const categories = [
      'general',
      'shortcuts',
      'appearance',
      'providers',
      'skills',
      'mcp',
      'instructions',
      'presets',
      'agents',
      'tools',
      'phone',
      'ssh',
    ];
    for (const category of categories) {
      expect(parseSettingsDeepLink({ category, rowId: `${category}.row` })).toEqual({
        category,
        rowId: `${category}.row`,
      });
    }
  });

  it('非法分类返回 null', () => {
    expect(parseSettingsDeepLink({ category: 'nope', rowId: 'x' })).toBeNull();
  });

  it('缺失 rowId 返回 null', () => {
    expect(parseSettingsDeepLink({ category: 'general' })).toBeNull();
  });

  it('空字符串 rowId 返回 null', () => {
    expect(parseSettingsDeepLink({ category: 'general', rowId: '' })).toBeNull();
  });

  it('rowId 非字符串返回 null', () => {
    expect(parseSettingsDeepLink({ category: 'general', rowId: 1 })).toBeNull();
  });

  it('非对象输入返回 null', () => {
    expect(parseSettingsDeepLink(null)).toBeNull();
    expect(parseSettingsDeepLink(undefined)).toBeNull();
    expect(parseSettingsDeepLink('general')).toBeNull();
    expect(parseSettingsDeepLink(42)).toBeNull();
  });
});
