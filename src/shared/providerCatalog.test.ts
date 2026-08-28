import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BASE_URLS,
  mergeProviderDefinitions,
  STATIC_PROVIDER_DEFINITIONS,
} from './providerCatalog';
import { MODEL_API_KINDS } from './types';

describe('provider catalog', () => {
  it('每种 ModelApiKind 都有唯一共享默认地址', () => {
    expect(Object.keys(DEFAULT_BASE_URLS).sort()).toEqual([...MODEL_API_KINDS].sort());
    expect(Object.values(DEFAULT_BASE_URLS).every((url) => url.length > 0)).toBe(true);
  });

  it('静态厂商完整且 __custom 恒定在最后', () => {
    expect(new Set(STATIC_PROVIDER_DEFINITIONS.map((definition) => definition.id)).size).toBe(
      STATIC_PROVIDER_DEFINITIONS.length
    );
    expect(STATIC_PROVIDER_DEFINITIONS.at(-1)).toMatchObject({
      id: '__custom',
      supportsApiKey: true,
    });
  });

  it('运行时 OAuth 合并到同 id 静态厂商，并把扩展 provider 放在 custom 前', () => {
    const merged = mergeProviderDefinitions([
      { id: 'anthropic', name: 'Anthropic Subscription' },
      { id: 'cursor', name: 'Cursor' },
    ]);
    expect(merged.find((definition) => definition.id === 'anthropic')).toMatchObject({
      label: 'Anthropic Subscription',
      oauthProviderId: 'anthropic',
      supportsApiKey: true,
    });
    expect(merged.find((definition) => definition.id === 'cursor')).toEqual({
      id: 'cursor',
      label: 'Cursor',
      oauthProviderId: 'cursor',
      supportsApiKey: false,
    });
    expect(merged.at(-1)?.id).toBe('__custom');
  });
});
