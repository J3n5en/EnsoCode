import { buildSettingsCatalog } from '@shared/searchAnything';
import { describe, expect, it } from 'vitest';
import type { SettingsCategory } from './constants';
import {
  groupCategories,
  isCategoryVisible,
  resolveActiveCategory,
  SETTINGS_GROUPS,
  searchCategories,
  visibleCategories,
} from './settingsCategories';

const cats = [
  { id: 'general' as SettingsCategory },
  { id: 'tools' as SettingsCategory },
  { id: 'memory' as SettingsCategory },
  { id: 'usage' as SettingsCategory },
];

describe('visibleCategories', () => {
  it('hides the memory page while the memory tool is off', () => {
    expect(visibleCategories(cats, ['memory']).map((c) => c.id)).toEqual([
      'general',
      'tools',
      'usage',
    ]);
  });

  it('shows it once the tool is enabled', () => {
    expect(visibleCategories(cats, []).map((c) => c.id)).toContain('memory');
  });

  it('never hides pages that do not depend on a tool', () => {
    const ids = visibleCategories(cats, ['memory', 'browser', 'isolated_sandbox']).map((c) => c.id);
    expect(ids).toEqual(['general', 'tools', 'usage']);
  });

  it('hides the workflows page while the workflow tool is off', () => {
    const withWorkflows = [...cats, { id: 'workflows' as SettingsCategory }];
    expect(visibleCategories(withWorkflows, ['workflow']).map((c) => c.id)).not.toContain(
      'workflows'
    );
    expect(visibleCategories(withWorkflows, ['memory']).map((c) => c.id)).toContain('workflows');
    expect(resolveActiveCategory('workflows', ['workflow'])).toBe('tools');
  });
});

describe('resolveActiveCategory', () => {
  it('falls back to Built-in tools when the active page just got hidden', () => {
    // 落在能把它重新打开的地方，而不是通用页
    expect(resolveActiveCategory('memory', ['memory'])).toBe('tools');
  });

  it('leaves the active page alone when it is still visible', () => {
    expect(resolveActiveCategory('memory', [])).toBe('memory');
    expect(resolveActiveCategory('usage', ['memory'])).toBe('usage');
  });

  it('also catches a deep link pointing at a disabled feature', () => {
    // deeplink 可能来自通知/外部跳转，指向一个当前没启用的功能
    expect(resolveActiveCategory('memory', ['memory'])).toBe('tools');
  });
});

describe('isCategoryVisible', () => {
  it('treats an unrelated disabled tool as irrelevant', () => {
    expect(isCategoryVisible('memory', ['browser'])).toBe(true);
  });
});

const EVERY_SETTINGS_CATEGORY = {
  general: true,
  shortcuts: true,
  voice: true,
  appearance: true,
  providers: true,
  skills: true,
  plugins: true,
  claudePlugins: true,
  mcp: true,
  instructions: true,
  presets: true,
  agents: true,
  workflows: true,
  tools: true,
  memory: true,
  privacy: true,
  phone: true,
  ssh: true,
  usage: true,
  resources: true,
  experimental: true,
  bots: true,
  botTemplates: true,
} satisfies Record<SettingsCategory, true>;

describe('SETTINGS_GROUPS', () => {
  it('covers every settings category exactly once', () => {
    const listed = SETTINGS_GROUPS.flatMap((group) => group.categories);
    const expected = Object.keys(EVERY_SETTINGS_CATEGORY);
    expect(listed).toHaveLength(expected.length);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...expected].sort());
  });
});

describe('groupCategories', () => {
  it('orders groups and items by the table, not the input', () => {
    const shuffled = [
      { id: 'ssh' as const, label: 'ssh' },
      { id: 'privacy' as const, label: 'privacy' },
      { id: 'general' as const, label: 'general' },
      { id: 'voice' as const, label: 'voice' },
      { id: 'phone' as const, label: 'phone' },
    ];
    expect(groupCategories(shuffled)).toEqual([
      {
        id: 'app',
        label: 'Application',
        items: [
          { id: 'general', label: 'general' },
          { id: 'voice', label: 'voice' },
          { id: 'privacy', label: 'privacy' },
        ],
      },
      {
        id: 'connections',
        label: 'Connections',
        items: [
          { id: 'phone', label: 'phone' },
          { id: 'ssh', label: 'ssh' },
        ],
      },
    ]);
  });

  it('drops a group when none of its categories are passed', () => {
    expect(groupCategories([{ id: 'general' }, { id: 'usage' }]).map((group) => group.id)).toEqual([
      'app',
      'system',
    ]);
  });
});

describe('appearance search rows', () => {
  it('会话排版登记在外观页', () => {
    expect(
      buildSettingsCatalog().find((entry) => entry.id === 'appearance.chatTypography')
    ).toMatchObject({
      category: 'appearance',
      title: 'Conversation typography',
    });
  });
});

describe('Bot mode page', () => {
  const withBots = [
    ...cats,
    { id: 'experimental' as SettingsCategory },
    { id: 'bots' as SettingsCategory },
    { id: 'botTemplates' as SettingsCategory },
  ];

  it('is hidden until Bot mode is enabled; Experimental always stays', () => {
    expect(visibleCategories(withBots, []).map((c) => c.id)).not.toContain('bots');
    expect(visibleCategories(withBots, []).map((c) => c.id)).not.toContain('botTemplates');
    expect(visibleCategories(withBots, [], false).map((c) => c.id)).toContain('experimental');
    expect(visibleCategories(withBots, [], true).map((c) => c.id)).toContain('bots');
    expect(visibleCategories(withBots, [], true).map((c) => c.id)).toContain('botTemplates');
  });

  it('falls back to Experimental, where the switch lives', () => {
    expect(resolveActiveCategory('bots', [], false)).toBe('experimental');
    expect(resolveActiveCategory('bots', [], true)).toBe('bots');
    expect(resolveActiveCategory('botTemplates', [], false)).toBe('experimental');
    expect(resolveActiveCategory('botTemplates', [], true)).toBe('botTemplates');
  });
});

describe('searchCategories', () => {
  const items = [
    { id: 'general' as const, label: 'General', mark: 1 },
    { id: 'appearance' as const, label: 'Appearance', mark: 2 },
  ];
  const entries = [
    { id: 'general.root', category: 'general', title: 'Onlyrootmarker' },
    { id: 'general.language', category: 'general', title: 'Language' },
    { id: 'appearance.theme', category: 'appearance', title: 'Theme mode' },
  ];

  it('returns every category with no hits when the query is empty', () => {
    expect(searchCategories(items, entries, '   ')).toEqual([
      { id: 'general', label: 'General', mark: 1, hits: [] },
      { id: 'appearance', label: 'Appearance', mark: 2, hits: [] },
    ]);
  });

  it('keeps a category whose translated name matches, without listing root rows', () => {
    const translate = (text: string) => (text === 'Appearance' ? '外观' : text);
    expect(searchCategories(items, entries, '外观', translate)).toEqual([
      { id: 'appearance', label: 'Appearance', mark: 2, hits: [] },
    ]);
    expect(searchCategories(items, entries, 'Appear').map((item) => item.id)).toEqual([
      'appearance',
    ]);
  });

  it('keeps only the category of a matching row and lists that row', () => {
    expect(searchCategories(items, entries, 'Language')).toEqual([
      {
        id: 'general',
        label: 'General',
        mark: 1,
        hits: [{ id: 'general.language', category: 'general', title: 'Language' }],
      },
    ]);
  });

  it('omits catalog rows whose id ends in .root', () => {
    const found = searchCategories(items, entries, 'general');
    expect(found.map((item) => item.id)).toEqual(['general']);
    expect(found[0]?.hits.map((hit) => hit.id)).toEqual(['general.language']);
  });

  it('returns no categories when nothing matches', () => {
    expect(searchCategories(items, entries, 'zzzz-not-a-setting')).toEqual([]);
  });

  it('does not stop at the default settings search limit', () => {
    const many = Array.from({ length: 25 }, (_, index) => ({
      id: `general.row${index}`,
      category: 'general',
      title: `Zebra option ${index}`,
    }));
    const found = searchCategories([{ id: 'general' as const, label: 'General' }], many, 'Zebra');
    expect(found[0]?.hits).toHaveLength(25);
  });
});
