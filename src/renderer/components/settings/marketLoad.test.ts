import { describe, expect, it } from 'vitest';
import { nextMarketLoadRequest, openMarketLoadRequest } from './marketLoad';

describe('market load request', () => {
  it('打开市场时刷新索引', () => {
    expect(openMarketLoadRequest('a@1')).toEqual({ installedKey: 'a@1', refresh: true });
  });

  it('已装版本没变时沿用同一次请求', () => {
    const current = openMarketLoadRequest('a@1');
    expect(nextMarketLoadRequest(current, 'a@1')).toBe(current);
  });

  it('已装版本变化时只读缓存，用来更新安装状态', () => {
    const current = openMarketLoadRequest('a@1');
    expect(nextMarketLoadRequest(current, 'a@2')).toEqual({
      installedKey: 'a@2',
      refresh: false,
    });
  });
});
