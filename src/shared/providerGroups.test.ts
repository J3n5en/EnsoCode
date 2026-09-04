import { describe, expect, it } from 'vitest';
import { CUSTOM_VENDOR_ID, groupProviders, vendorOf } from './providerGroups';
import type { ModelProvider } from './types/llm';

const provider = (overrides: Partial<ModelProvider>): ModelProvider => ({
  id: overrides.id ?? crypto.randomUUID(),
  name: overrides.name ?? 'p',
  api: 'openai-completions',
  apiKey: '',
  baseUrl: '',
  enabled: true,
  models: [],
  ...overrides,
});

describe('vendorOf', () => {
  it('订阅条目反解基础 providerId，多账号归同一厂商', () => {
    expect(vendorOf({ oauthAccountKey: 'anthropic', baseUrl: '' })).toBe('anthropic');
    expect(vendorOf({ oauthAccountKey: 'anthropic#2', baseUrl: '' })).toBe('anthropic');
  });

  it('订阅条目优先于 baseUrl —— 订阅条目的 baseUrl 恒为空，不能因此落 __custom', () => {
    expect(vendorOf({ oauthAccountKey: 'openai#3', baseUrl: 'https://api.anthropic.com' })).toBe(
      'openai'
    );
  });

  it('精确 hostname 命中，且大小写与 www. 前缀不影响判定', () => {
    expect(vendorOf({ baseUrl: 'https://api.anthropic.com' })).toBe('anthropic');
    expect(vendorOf({ baseUrl: 'https://API.OpenAI.com/v1' })).toBe('openai');
    expect(vendorOf({ baseUrl: 'https://www.openrouter.ai/api/v1' })).toBe('openrouter');
  });

  it('后缀表处理子域形态', () => {
    expect(vendorOf({ baseUrl: 'https://my-res.openai.azure.com/openai' })).toBe('azure-openai');
    expect(vendorOf({ baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' })).toBe(
      'alibaba'
    );
  });

  it('未知 host 落 __custom', () => {
    expect(vendorOf({ baseUrl: 'https://llm.internal.corp/v1' })).toBe(CUSTOM_VENDOR_ID);
  });

  it('baseUrl 为空或非法时落 __custom 而不是抛异常', () => {
    expect(vendorOf({ baseUrl: '' })).toBe(CUSTOM_VENDOR_ID);
    expect(vendorOf({ baseUrl: 'not a url' })).toBe(CUSTOM_VENDOR_ID);
    expect(vendorOf({ baseUrl: '   ' })).toBe(CUSTOM_VENDOR_ID);
  });

  it('IPv6 loopback 归 local', () => {
    expect(vendorOf({ baseUrl: 'http://[::1]/v1' })).toBe('local');
  });

  it('向导选 Custom 时即使 URL 是官方 xAI 也落 Custom 组', () => {
    expect(
      vendorOf({
        baseUrl: 'https://api.x.ai/v1',
        catalogId: CUSTOM_VENDOR_ID,
      })
    ).toBe(CUSTOM_VENDOR_ID);
  });

  it('向导选中的厂商 id 优先于 hostname，避免改了中转地址后漂到 Custom', () => {
    expect(
      vendorOf({
        baseUrl: 'https://relay.internal/v1',
        catalogId: 'xai',
      })
    ).toBe('xai');
  });

  it('baseUrl 带端口时仍按 hostname 归组', () => {
    expect(vendorOf({ baseUrl: 'https://api.anthropic.com:8443/v1' })).toBe('anthropic');
  });

  it('oauthAccountKey 两位序号同样反解基础 providerId', () => {
    expect(vendorOf({ oauthAccountKey: 'anthropic#10', baseUrl: '' })).toBe('anthropic');
  });
});

describe('groupProviders', () => {
  it('同一厂商的订阅条目与 API-key 条目并入同一组', () => {
    const groups = groupProviders([
      provider({ id: 'a1', oauthAccountKey: 'anthropic' }),
      provider({ id: 'a2', baseUrl: 'https://api.anthropic.com' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].vendorId).toBe('anthropic');
    expect(groups[0].providers.map((p) => p.id)).toEqual(['a1', 'a2']);
  });

  it('组内订阅条目在前并按账号 key 升序 —— 裸 key 排在 #2 之前', () => {
    const groups = groupProviders([
      provider({ id: 'api', baseUrl: 'https://api.anthropic.com' }),
      provider({ id: 'acct2', oauthAccountKey: 'anthropic#2' }),
      provider({ id: 'acct1', oauthAccountKey: 'anthropic' }),
    ]);
    expect(groups[0].providers.map((p) => p.id)).toEqual(['acct1', 'acct2', 'api']);
  });

  it('组内 API-key 条目保持入参原序（用户/导入顺序稳定）', () => {
    const groups = groupProviders([
      provider({ id: 'second', baseUrl: 'https://llm.internal.corp/v1' }),
      provider({ id: 'first', baseUrl: 'https://other.internal.corp/v1' }),
    ]);
    expect(groups[0].providers.map((p) => p.id)).toEqual(['second', 'first']);
  });

  it('__custom 组恒排最后，其余组按展示名升序', () => {
    const groups = groupProviders([
      provider({ id: 'c', baseUrl: 'https://llm.internal.corp/v1' }),
      provider({ id: 'o', baseUrl: 'https://api.openai.com' }),
      provider({ id: 'a', baseUrl: 'https://api.anthropic.com' }),
    ]);
    expect(groups.map((g) => g.vendorId)).toEqual(['anthropic', 'openai', CUSTOM_VENDOR_ID]);
  });

  it('__custom 组的 label 是空串，交由渲染层本地化', () => {
    const groups = groupProviders([provider({ baseUrl: '' })]);
    expect(groups[0].label).toBe('');
  });

  it('展示名优先借订阅 provider 的官方名', () => {
    const groups = groupProviders(
      [provider({ oauthAccountKey: 'xai' })],
      [{ id: 'xai', name: 'xAI (SuperGrok)' }]
    );
    expect(groups[0].label).toBe('xAI (SuperGrok)');
  });
});
