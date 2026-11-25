import { describe, expect, it } from 'vitest';
import { getTranslation, zhTranslations } from './i18n';
import {
  type BrowserSearchTab,
  buildSettingsCatalog,
  mergeBrowserSearchTabs,
  recentBrowserTabs,
  SEARCH_ANYTHING_BROWSER_LIMIT,
  SEARCH_ANYTHING_RECENT_BROWSER,
  SEARCH_ANYTHING_SETTINGS_LIMIT,
  searchBrowserTabs,
  searchSettingsEntries,
} from './searchAnything';
import { relocateSettingsLink, type SettingsCategory } from './settingsDeepLink';

function tab(
  overrides: Partial<BrowserSearchTab> & Pick<BrowserSearchTab, 'tabId'>
): BrowserSearchTab {
  return {
    conversationId: 'conv-1',
    title: 'untitled',
    url: 'https://example.com',
    at: 0,
    live: false,
    ...overrides,
  };
}

describe('mergeBrowserSearchTabs', () => {
  it('live 优先于同 tabId 的 persist', () => {
    const live = [tab({ tabId: 't1', title: 'live title', live: true, at: 100 })];
    const persisted = [
      {
        tabId: 't1',
        conversationId: 'conv-1',
        title: 'persist title',
        url: 'https://x.com',
        at: 50,
      },
    ];
    const merged = mergeBrowserSearchTabs(live, persisted);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.title).toBe('live title');
    expect(merged[0]?.live).toBe(true);
  });

  it('persist-only 保留，live 为 false，at 取 persist.at', () => {
    const merged = mergeBrowserSearchTabs(
      [],
      [
        {
          tabId: 't2',
          conversationId: 'conv-2',
          title: 'sleeping',
          url: 'https://sleep.com',
          at: 30,
        },
      ]
    );
    expect(merged).toEqual([
      {
        tabId: 't2',
        conversationId: 'conv-2',
        title: 'sleeping',
        url: 'https://sleep.com',
        at: 30,
        live: false,
      },
    ]);
  });

  it('persist 缺失 at 时默认 0', () => {
    const merged = mergeBrowserSearchTabs(
      [],
      [{ tabId: 't3', conversationId: 'conv-3', title: 'no at', url: 'https://noat.com' }]
    );
    expect(merged[0]?.at).toBe(0);
  });

  it('persist 缺失或空 url 时被丢弃', () => {
    const merged = mergeBrowserSearchTabs(
      [],
      [
        { tabId: 't4', conversationId: 'conv-4', title: 'no url', url: '' },
        {
          tabId: 't5',
          conversationId: 'conv-5',
          title: 'missing url',
          url: undefined as unknown as string,
        },
      ]
    );
    expect(merged).toEqual([]);
  });
});

describe('recentBrowserTabs', () => {
  it('按 at 降序取前 5', () => {
    const tabs = Array.from({ length: 8 }, (_, i) => tab({ tabId: `t${i}`, at: i }));
    const recent = recentBrowserTabs(tabs);
    expect(recent).toHaveLength(SEARCH_ANYTHING_RECENT_BROWSER);
    expect(recent.map((t) => t.tabId)).toEqual(['t7', 't6', 't5', 't4', 't3']);
  });

  it('支持自定义 limit', () => {
    const tabs = Array.from({ length: 8 }, (_, i) => tab({ tabId: `t${i}`, at: i }));
    const recent = recentBrowserTabs(tabs, 2);
    expect(recent.map((t) => t.tabId)).toEqual(['t7', 't6']);
  });
});

describe('searchBrowserTabs', () => {
  it('CJK 标题子串命中', () => {
    const tabs = [tab({ tabId: 't1', title: '这是一个测试标题', url: 'https://a.com' })];
    const hits = searchBrowserTabs(tabs, '测试标题');
    expect(hits.map((t) => t.tabId)).toEqual(['t1']);
  });

  it('拉丁 url 前缀命中', () => {
    const tabs = [tab({ tabId: 't1', title: 'unrelated', url: 'https://example.com/path' })];
    const hits = searchBrowserTabs(tabs, 'example');
    expect(hits.map((t) => t.tabId)).toEqual(['t1']);
  });

  it('空查询返回空数组', () => {
    const tabs = [tab({ tabId: 't1', title: 'hello', url: 'https://a.com' })];
    expect(searchBrowserTabs(tabs, '')).toEqual([]);
    expect(searchBrowserTabs(tabs, '   ')).toEqual([]);
  });

  it('结果数不超过默认上限 20', () => {
    const tabs = Array.from({ length: 30 }, (_, i) =>
      tab({ tabId: `t${i}`, title: `term ${i}`, url: 'https://a.com' })
    );
    const hits = searchBrowserTabs(tabs, 'term');
    expect(hits.length).toBeLessThanOrEqual(SEARCH_ANYTHING_BROWSER_LIMIT);
  });

  it('标题命中排在仅 url 命中之前，同分按 at 降序', () => {
    const tabs = [
      tab({ tabId: 'url-only', title: 'unrelated', url: 'https://term.com', at: 100 }),
      tab({ tabId: 'title-hit', title: 'term title', url: 'https://b.com', at: 1 }),
    ];
    const hits = searchBrowserTabs(tabs, 'term');
    expect(hits.map((t) => t.tabId)).toEqual(['title-hit', 'url-only']);
  });
});

describe('searchSettingsEntries', () => {
  const entries = [
    {
      id: 'general.proxy',
      category: 'general',
      title: 'Proxy',
      description: 'Configure network proxy',
    },
    { id: 'general.language', category: 'general', title: 'Language' },
    { id: 'providers.p1', category: 'providers', title: 'My Custom Provider' },
  ];

  it('匹配 title/description/id', () => {
    expect(searchSettingsEntries(entries, 'proxy').map((e) => e.id)).toEqual(['general.proxy']);
  });

  it('空查询返回空数组', () => {
    expect(searchSettingsEntries(entries, '')).toEqual([]);
  });

  it('默认上限 20', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `s.${i}`,
      category: 'general',
      title: `term ${i}`,
    }));
    expect(searchSettingsEntries(many, 'term').length).toBeLessThanOrEqual(
      SEARCH_ANYTHING_SETTINGS_LIMIT
    );
  });

  it('标题命中排在前，之后按 id localeCompare', () => {
    const local = [
      {
        id: 'b.desc-only',
        category: 'general',
        title: 'unrelated',
        description: 'has term inside',
      },
      { id: 'a.title-hit', category: 'general', title: 'term hit' },
    ];
    const hits = searchSettingsEntries(local, 'term');
    expect(hits.map((e) => e.id)).toEqual(['a.title-hit', 'b.desc-only']);
  });

  it('精确命中排在前缀、子串和仅说明命中之前', () => {
    const local = [
      { id: 'd.desc', category: 'general', title: '其他', description: '这里提到代理' },
      { id: 'c.mid', category: 'general', title: '网络代理项' },
      { id: 'b.prefix', category: 'general', title: '代理服务器' },
      { id: 'a.exact', category: 'general', title: '代理' },
    ];
    expect(searchSettingsEntries(local, '代理').map((e) => e.id)).toEqual([
      'a.exact',
      'b.prefix',
      'c.mid',
      'd.desc',
    ]);
  });

  it('多词查询按最差的一词排，整句前缀高于标题中段，说明垫底', () => {
    const local = [
      { id: 'd.desc', category: 'general', title: '其他', description: '代理 服务器在说明里' },
      { id: 'c.mid', category: 'general', title: '说明里的代理 服务器' },
      { id: 'b.prefix', category: 'general', title: '代理 服务器更多' },
      { id: 'a.exact', category: 'general', title: '代理 服务器' },
    ];
    expect(searchSettingsEntries(local, '代理 服务器').map((e) => e.id)).toEqual([
      'a.exact',
      'b.prefix',
      'c.mid',
      'd.desc',
    ]);
  });

  it('不传译文函数时，中文仍能命中英文标题的中文译文', () => {
    const local = [{ id: 'general.proxy', category: 'general', title: 'Network proxy' }];
    expect(searchSettingsEntries(local, '网络代理').map((e) => e.id)).toEqual(['general.proxy']);
    expect(searchSettingsEntries(local, 'Network proxy').map((e) => e.id)).toEqual([
      'general.proxy',
    ]);
  });
});

describe('buildSettingsCatalog', () => {
  const staticIds = [
    'general.language',
    'general.windowsLocalShell',
    'general.terminalShell',
    'appearance.openChangesOnFileEdit',
    'appearance.compactReadOnlyTools',
    'appearance.expandLiveEdits',
    'appearance.expandLiveReasoning',
    'appearance.autoCollapseTurns',
    'appearance.collapseCompletedActivity',
    'appearance.collapseLiveActivity',
    'appearance.liveActivityFoldDelaySec',
    'appearance.pinUnfinishedTodos',
    'appearance.headerSessionTabs',
    'appearance.navRailSide',
    'general.notifyMainAgentOnly',
    'general.smartCompactEnabled',
    'general.compactReserveTokens',
    'general.generationStallTimeout',
    'general.autoRetryLimit',
    'general.longCacheRetention',
    'general.proxy',
    'general.caCert',
    'general.updates',
    'general.ensoCommand',
    'general.finderQuickAction',
    'experimental.botMode',
    'experimental.secretary',
    'bots.routeClassifier',
    'shortcuts.root',
    'appearance.theme',
    'providers.root',
    'presets.root',
    'agents.root',
    'agents.maxActiveCoworkers',
    'tools.root',
    'tools.rtkEnabled',
    'tools.editMode',
    'skills.root',
    'mcp.root',
    'instructions.root',
    'phone.root',
    'ssh.root',
    'ssh.timeout',
  ];

  it('包含所有必需静态条目 id', () => {
    const catalog = buildSettingsCatalog();
    const ids = catalog.map((e) => e.id);
    for (const id of staticIds) {
      expect(ids).toContain(id);
    }
  });

  it('拆页后每个条目都指向行现在所在的分区（与深链改落一致）', () => {
    for (const entry of buildSettingsCatalog()) {
      expect(
        relocateSettingsLink({ category: entry.category as SettingsCategory, rowId: entry.id })
          .category,
        entry.id
      ).toBe(entry.category);
    }
    const categoryOf = (id: string) => buildSettingsCatalog().find((e) => e.id === id)?.category;
    expect(categoryOf('appearance.headerSessionTabs')).toBe('conversation');
    expect(categoryOf('appearance.chatTypography')).toBe('conversation');
    expect(categoryOf('appearance.navRailSide')).toBe('conversation');
    expect(categoryOf('general.terminalShell')).toBe('terminal');
    expect(categoryOf('general.autoArchiveIdleDays')).toBe('runtime');
    expect(categoryOf('general.proxy')).toBe('general');
  });

  it('搜「代理」「字体」「归档闲置」命中新位置', () => {
    const catalog = buildSettingsCatalog();
    const hits = (query: string) =>
      searchSettingsEntries(catalog, query, {
        translate: (text) => getTranslation('zh', text),
      }).map((e) => `${e.category}:${e.id}`);
    expect(hits('代理')).toContain('general:general.proxy');
    expect(hits('字体')).toContain('appearance:terminal.font');
    expect(hits('归档闲置')).toContain('runtime:general.autoArchiveIdleDays');
  });

  it('Bot 设置迁到「实验」与「Bot 模式」页，通用页不再有旧条目', () => {
    const catalog = buildSettingsCatalog();
    const ids = catalog.map((e) => e.id);
    expect(ids).not.toContain('general.botMode');
    expect(ids).not.toContain('general.botRouteClassifier');
    expect(catalog.find((e) => e.id === 'experimental.botMode')?.category).toBe('experimental');
    expect(catalog.find((e) => e.id === 'bots.routeClassifier')?.category).toBe('bots');
  });

  it('秘书开关归实验页', () => {
    const catalog = buildSettingsCatalog();
    expect(catalog.find((e) => e.id === 'experimental.secretary')?.category).toBe('experimental');
  });

  it('general.language 标题包含 Language', () => {
    const catalog = buildSettingsCatalog();
    const entry = catalog.find((e) => e.id === 'general.language');
    expect(entry?.title).toMatch(/Language/i);
  });

  it('general.proxy 标题或描述包含 proxy', () => {
    const catalog = buildSettingsCatalog();
    const entry = catalog.find((e) => e.id === 'general.proxy');
    expect(`${entry?.title} ${entry?.description ?? ''}`).toMatch(/proxy/i);
  });

  it('shortcuts.root 分类为 Shortcuts 相关', () => {
    const catalog = buildSettingsCatalog();
    const entry = catalog.find((e) => e.id === 'shortcuts.root');
    expect(entry?.category).toBe('shortcuts');
  });

  it('phone.root 标题或描述包含 pairing 或 Devices', () => {
    const catalog = buildSettingsCatalog();
    const entry = catalog.find((e) => e.id === 'phone.root');
    expect(entry?.title).toBe('Allow connections');
  });

  it('从 snapshot 投影具名条目', () => {
    const catalog = buildSettingsCatalog({
      providers: [{ id: 'p1', name: 'My Custom Provider' }],
      skills: [{ id: 's1', name: 'My Skill' }],
      mcpServers: [{ id: 'm1', name: 'My MCP' }],
      instructions: [{ id: 'i1', name: 'My Instruction' }],
      sshConnections: [{ id: 'c1', name: 'My SSH Host' }],
    });
    expect(catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'providers.p1',
          category: 'providers',
          title: 'My Custom Provider',
        }),
        expect.objectContaining({ id: 'skills.s1', category: 'skills', title: 'My Skill' }),
        expect.objectContaining({ id: 'mcp.m1', category: 'mcp', title: 'My MCP' }),
        expect.objectContaining({
          id: 'instructions.i1',
          category: 'instructions',
          title: 'My Instruction',
        }),
        expect.objectContaining({ id: 'ssh.c1', category: 'ssh', title: 'My SSH Host' }),
      ])
    );
  });

  it('搜索 "proxy" 命中 general.proxy，"pairing" 命中 phone.root，具名 provider 名可命中', () => {
    const catalog = buildSettingsCatalog({ providers: [{ id: 'p1', name: 'My Custom Provider' }] });
    expect(searchSettingsEntries(catalog, 'proxy').map((e) => e.id)).toContain('general.proxy');
    expect(searchSettingsEntries(catalog, 'Devices').map((e) => e.id)).toContain('phone.devices');
    expect(searchSettingsEntries(catalog, 'Custom').map((e) => e.id)).toContain('providers.p1');
  });

  it('目录里的标题和说明都有中文译文', () => {
    const missing = buildSettingsCatalog()
      .flatMap((entry) => [entry.title, entry.description ?? ''])
      // 原文本身就是中文的没有可译的译文，它自己就是界面显示文本
      .filter((text) => text && !/[\u3400-\u9fff]/u.test(text) && !(text in zhTranslations));
    expect(missing).toEqual([]);
  });

  it('传入译文函数后可用界面语言搜索，英文原文仍可命中', () => {
    const catalog = buildSettingsCatalog();
    const translate = (key: string) => getTranslation('zh', key);
    const ids = (query: string) =>
      searchSettingsEntries(catalog, query, { translate }).map((e) => e.id);
    expect(ids('主题')).toContain('appearance.theme');
    expect(ids('代理')).toContain('general.proxy');
    expect(ids('proxy')).toContain('general.proxy');
    expect(ids('自动拉取模型')).toEqual([]);
    expect(ids('Automatically fetch models')).toEqual([]);
    expect(catalog.some(({ id }) => id === 'providers.autoFetchModels')).toBe(false);
    expect(ids('拉取间隔')).not.toContain('providers.modelFetchInterval');
    expect(ids('Model fetch interval')).not.toContain('providers.modelFetchInterval');
  });
});
