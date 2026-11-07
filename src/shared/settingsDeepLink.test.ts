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
      'experimental',
      'bots',
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

  it('插件安装地址必须是 http(s)', () => {
    expect(
      parseSettingsDeepLink({
        category: 'plugins',
        rowId: 'plugins.enso',
        pluginInstallUrl: 'https://github.com/acme/demo',
      })
    ).toEqual({
      category: 'plugins',
      rowId: 'plugins.enso',
      pluginInstallUrl: 'https://github.com/acme/demo',
    });
    expect(
      parseSettingsDeepLink({
        category: 'plugins',
        rowId: 'plugins.enso',
        pluginInstallUrl: 'file:///tmp/x.zip',
      })
    ).toBeNull();
  });

  it('插件 id 只在插件页接受，非法 id 整条作废', () => {
    expect(
      parseSettingsDeepLink({
        category: 'plugins',
        rowId: 'plugins.enso',
        pluginId: 'example.demo',
      })
    ).toEqual({ category: 'plugins', rowId: 'plugins.enso', pluginId: 'example.demo' });
    expect(
      parseSettingsDeepLink({
        category: 'general',
        rowId: 'general.language',
        pluginId: 'example.demo',
      })
    ).toBeNull();
    expect(
      parseSettingsDeepLink({ category: 'plugins', rowId: 'plugins.enso', pluginId: '../x' })
    ).toBeNull();
  });
});
