import { describe, expect, it } from 'vitest';
import { filterMarketPlugins, marketCategories } from './pluginMarketFilter';

const plugins = [
  { id: 'enso.notes', name: 'Notes', description: '便签', tags: ['ui', 'notes'] },
  { id: 'enso.stats', name: 'Stats', description: '', tags: ['ui', 'tools', 'ui'] },
  { id: 'enso.video', name: 'Video', description: '播放', tags: ['  ', 'video'] },
];

describe('marketCategories', () => {
  it('收集去重后的标签，丢掉空白并按字母排序', () => {
    expect(marketCategories(plugins)).toEqual(['notes', 'tools', 'ui', 'video']);
  });
});

describe('filterMarketPlugins', () => {
  it('未选分类时保留搜索命中的插件', () => {
    expect(
      filterMarketPlugins(plugins, { query: 'NOTES', category: null }).map((p) => p.id)
    ).toEqual(['enso.notes']);
    expect(filterMarketPlugins(plugins, { query: '', category: null })).toEqual(plugins);
  });

  it('分类与搜索同时生效，标签按去空白后的原文匹配', () => {
    expect(filterMarketPlugins(plugins, { query: '', category: 'ui' }).map((p) => p.id)).toEqual([
      'enso.notes',
      'enso.stats',
    ]);
    expect(
      filterMarketPlugins(plugins, { query: '播放', category: 'video' }).map((p) => p.id)
    ).toEqual(['enso.video']);
    expect(filterMarketPlugins(plugins, { query: 'notes', category: 'tools' })).toEqual([]);
  });
});
