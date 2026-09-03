import { describe, expect, it } from 'vitest';
import { parseBrowserSearchTabsResult, parseOpenSettingsRequest } from './searchAnything';

describe('parseBrowserSearchTabsResult', () => {
  it('丢弃非法条目并填充默认值', () => {
    const raw = [
      { tabId: 't1', conversationId: 'c1', url: 'https://a.com' },
      { tabId: 't2', conversationId: 'c2', url: 'https://b.com', title: 'B', at: 42, live: true },
      { tabId: 't3', url: 'https://missing-conv.com' },
      { conversationId: 'c4', url: 'https://missing-tab.com' },
      { tabId: 't5', conversationId: 'c5' },
      null,
      'not an object',
      42,
    ];
    const parsed = parseBrowserSearchTabsResult(raw);
    expect(parsed).toEqual([
      { tabId: 't1', conversationId: 'c1', url: 'https://a.com', title: '', at: 0, live: false },
      { tabId: 't2', conversationId: 'c2', url: 'https://b.com', title: 'B', at: 42, live: true },
    ]);
  });

  it('非数组输入返回空数组', () => {
    expect(parseBrowserSearchTabsResult(null)).toEqual([]);
    expect(parseBrowserSearchTabsResult(undefined)).toEqual([]);
    expect(parseBrowserSearchTabsResult({})).toEqual([]);
  });

  it('at 非有限数时回退为 0', () => {
    const parsed = parseBrowserSearchTabsResult([
      { tabId: 't1', conversationId: 'c1', url: 'https://a.com', at: Number.NaN },
      { tabId: 't2', conversationId: 'c2', url: 'https://b.com', at: Number.POSITIVE_INFINITY },
    ]);
    expect(parsed.map((t) => t.at)).toEqual([0, 0]);
  });
});

describe('parseOpenSettingsRequest', () => {
  it('undefined/null 返回 null（无深链打开）', () => {
    expect(parseOpenSettingsRequest(undefined)).toBeNull();
    expect(parseOpenSettingsRequest(null)).toBeNull();
  });

  it('合法深链对象被解析', () => {
    expect(parseOpenSettingsRequest({ category: 'general', rowId: 'general.language' })).toEqual({
      category: 'general',
      rowId: 'general.language',
    });
  });

  it('非法输入返回 null', () => {
    expect(parseOpenSettingsRequest({ category: 'bogus', rowId: 'x' })).toBeNull();
    expect(parseOpenSettingsRequest('string')).toBeNull();
  });
});
