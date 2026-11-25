import { describe, expect, it } from 'vitest';
import { parseSettingsDeepLink, relocateSettingsLink } from './settingsDeepLink';

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

  it('只给分区时落到该分区根', () => {
    expect(parseSettingsDeepLink({ category: 'logs' })).toEqual({
      category: 'logs',
      rowId: 'logs.root',
    });
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

describe('插件市场搜索深链', () => {
  it('只在插件分类下接受短标签', () => {
    expect(
      parseSettingsDeepLink({ category: 'plugins', rowId: 'plugins.enso', marketQuery: 'contact' })
    ).toEqual({ category: 'plugins', rowId: 'plugins.enso', marketQuery: 'contact' });
    expect(
      parseSettingsDeepLink({ category: 'plugins', rowId: 'plugins.enso', marketQuery: 'a b<' })
    ).toBeNull();
    expect(
      parseSettingsDeepLink({ category: 'secretary', rowId: 'x', marketQuery: 'contact' })
    ).toBeNull();
  });
});
describe('拆分后的旧深链', () => {
  const MOVED: [string, string][] = [
    ['general.generationStallTimeout', 'runtime'],
    ['general.autoRetryLimit', 'runtime'],
    ['general.longCacheRetention', 'runtime'],
    ['general.smartCompactEnabled', 'runtime'],
    ['general.compactReserveTokens', 'runtime'],
    ['general.autoArchiveIdleDays', 'runtime'],
    ['general.autoArchiveMergedWorktrees', 'runtime'],
    ['general.autoDeleteArchivedDays', 'runtime'],
    ['general.activeRetentionMinutes', 'runtime'],
    ['general.worktreeRoot', 'runtime'],
    ['general.terminalShell', 'terminal'],
    ['general.windowsLocalShell', 'terminal'],
    ['appearance.fileOpening', 'general'],
    ['terminal.context-menu-opening', 'general'],
    ['appearance.chatTypography', 'conversation'],
    ['appearance.navRailSide', 'conversation'],
    ['appearance.openChangesOnFileEdit', 'conversation'],
    ['appearance.compactReadOnlyTools', 'conversation'],
    ['appearance.expandLiveEdits', 'conversation'],
    ['appearance.expandLiveReasoning', 'conversation'],
    ['appearance.autoCollapseTurns', 'conversation'],
    ['appearance.quoteSelectionButton', 'conversation'],
    ['appearance.collapseCompletedActivity', 'conversation'],
    ['appearance.collapseLiveActivity', 'conversation'],
    ['appearance.liveActivityFoldDelaySec', 'conversation'],
    ['appearance.pinUnfinishedTodos', 'conversation'],
    ['appearance.headerSessionTabs', 'conversation'],
  ];

  it.each(MOVED)('%s 落到 %s，行号不变（继续闪那一行）', (rowId, category) => {
    const oldCategory = rowId.split('.')[0];
    expect(parseSettingsDeepLink({ category: oldCategory, rowId })).toEqual({ category, rowId });
  });

  it('没挪的行和旧分区根照常解析', () => {
    for (const rowId of ['general.language', 'general.proxy', 'appearance.theme', 'general.root']) {
      const category = rowId.split('.')[0];
      expect(parseSettingsDeepLink({ category, rowId })).toEqual({ category, rowId });
    }
  });

  it('新分区可以直接打开', () => {
    for (const category of ['conversation', 'terminal', 'runtime']) {
      expect(parseSettingsDeepLink({ category })).toEqual({ category, rowId: `${category}.root` });
    }
  });

  it('应用内直接打开的链接（不经过 main）同样改落新分区', () => {
    expect(
      relocateSettingsLink({ category: 'general', rowId: 'general.autoArchiveIdleDays' })
    ).toEqual({ category: 'runtime', rowId: 'general.autoArchiveIdleDays' });
  });
});

describe('秘书组的旧深链', () => {
  it('秘书页与它的行升为一级后照常落地，联系方式与主人可以直接打开', () => {
    for (const rowId of [
      'secretary.root',
      'secretary.profile',
      'secretary.dispatchLimit',
      'secretary.reset',
    ]) {
      expect(parseSettingsDeepLink({ category: 'secretary', rowId })).toEqual({
        category: 'secretary',
        rowId,
      });
    }
    expect(parseSettingsDeepLink({ category: 'secretary' })).toEqual({
      category: 'secretary',
      rowId: 'secretary.root',
    });
    expect(
      parseSettingsDeepLink({ category: 'experimental', rowId: 'experimental.secretary' })
    ).toEqual({
      category: 'experimental',
      rowId: 'experimental.secretary',
    });
    expect(parseSettingsDeepLink({ category: 'contacts' })).toEqual({
      category: 'contacts',
      rowId: 'contacts.root',
    });
    expect(parseSettingsDeepLink({ category: 'contacts', rowId: 'contacts.owner' })).toEqual({
      category: 'contacts',
      rowId: 'contacts.owner',
    });
  });
});
