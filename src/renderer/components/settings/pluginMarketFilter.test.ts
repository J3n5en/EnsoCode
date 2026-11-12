import { describe, expect, it } from 'vitest';
import { filterMarketPlugins, marketSections } from './pluginMarketFilter';

const item = (over: Record<string, unknown>) => ({
  id: 'x.y',
  name: 'X',
  description: '',
  tier: 'community' as const,
  tags: [] as string[],
  updateAvailable: false,
  ...over,
});
const plugins = [
  item({
    id: 'enso.notes',
    name: 'Notes',
    description: '便签',
    tags: ['notes'],
    category: 'productivity',
    tier: 'official',
  }),
  item({ id: 'z.theme', name: 'Aurora', category: 'themes', installedVersion: '1.0.0' }),
  item({
    id: 'a.theme',
    name: 'Nord',
    category: 'themes',
    tier: 'official',
    installedVersion: '1.0.0',
    updateAvailable: true,
  }),
  item({ id: 'b.misc', name: 'Misc', description: '播放' }),
];

describe('marketSections', () => {
  it('按固定顺序列出有插件的分类与数量，没分类的归「其他」，另有已安装和可更新', () => {
    expect(marketSections(plugins)).toEqual([
      { id: 'all', count: 4 },
      { id: 'installed', count: 2 },
      { id: 'updates', count: 1 },
      { id: 'themes', count: 2 },
      { id: 'productivity', count: 1 },
      { id: 'other', count: 1 },
    ]);
  });
});

describe('filterMarketPlugins', () => {
  it('官方排前，再按名字排序；搜索匹配 id、名字、描述和标签', () => {
    expect(filterMarketPlugins(plugins, { query: '', section: 'all' }).map((p) => p.id)).toEqual([
      'a.theme',
      'enso.notes',
      'z.theme',
      'b.misc',
    ]);
    expect(
      filterMarketPlugins(plugins, { query: 'NOTES', section: 'all' }).map((p) => p.id)
    ).toEqual(['enso.notes']);
    expect(
      filterMarketPlugins(plugins, { query: '播放', section: 'other' }).map((p) => p.id)
    ).toEqual(['b.misc']);
  });

  it('分区：分类、已安装、可更新', () => {
    expect(filterMarketPlugins(plugins, { query: '', section: 'themes' }).map((p) => p.id)).toEqual(
      ['a.theme', 'z.theme']
    );
    expect(
      filterMarketPlugins(plugins, { query: '', section: 'installed' }).map((p) => p.id)
    ).toEqual(['a.theme', 'z.theme']);
    expect(
      filterMarketPlugins(plugins, { query: '', section: 'updates' }).map((p) => p.id)
    ).toEqual(['a.theme']);
    expect(filterMarketPlugins(plugins, { query: 'notes', section: 'themes' })).toEqual([]);
  });
});
