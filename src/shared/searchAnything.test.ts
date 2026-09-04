import { describe, expect, it } from 'vitest';
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
});

describe('buildSettingsCatalog', () => {
  const staticIds = [
    'general.language',
    'general.openChangesOnFileEdit',
    'general.compactReadOnlyTools',
    'general.generationStallTimeout',
    'general.proxy',
    'general.updates',
    'shortcuts.root',
    'appearance.theme',
    'providers.root',
    'presets.root',
    'agents.root',
    'tools.root',
    'skills.root',
    'mcp.root',
    'instructions.root',
    'phone.root',
    'ssh.root',
  ];

  it('包含所有必需静态条目 id', () => {
    const catalog = buildSettingsCatalog();
    const ids = catalog.map((e) => e.id);
    for (const id of staticIds) {
      expect(ids).toContain(id);
    }
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
    expect(`${entry?.title} ${entry?.description ?? ''}`).toMatch(/pairing|devices/i);
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
    expect(searchSettingsEntries(catalog, 'pairing').map((e) => e.id)).toContain('phone.root');
    expect(searchSettingsEntries(catalog, 'Custom').map((e) => e.id)).toContain('providers.p1');
  });
});
