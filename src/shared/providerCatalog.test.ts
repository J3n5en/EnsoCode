import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BASE_URLS,
  mergeProviderDefinitions,
  resolvePiProviderBaseUrl,
  STATIC_PROVIDER_DEFINITIONS,
} from './providerCatalog';
import { MODEL_API_KINDS } from './types';

describe('provider catalog', () => {
  it('每种 ModelApiKind 都有唯一共享默认地址', () => {
    expect(Object.keys(DEFAULT_BASE_URLS).sort()).toEqual([...MODEL_API_KINDS].sort());
    expect(Object.values(DEFAULT_BASE_URLS).every((url) => url.length > 0)).toBe(true);
    expect(DEFAULT_BASE_URLS['google-generative-ai']).toBe(
      'https://generativelanguage.googleapis.com/v1beta'
    );
  });

  it('Google 交给 pi 的地址始终带 /v1beta', () => {
    expect(
      resolvePiProviderBaseUrl('google-generative-ai', 'https://generativelanguage.googleapis.com')
    ).toBe('https://generativelanguage.googleapis.com/v1beta');
    expect(
      resolvePiProviderBaseUrl(
        'google-generative-ai',
        'https://generativelanguage.googleapis.com/v1beta/'
      )
    ).toBe('https://generativelanguage.googleapis.com/v1beta');
    expect(resolvePiProviderBaseUrl('google-generative-ai', '')).toBe(
      DEFAULT_BASE_URLS['google-generative-ai']
    );
    expect(resolvePiProviderBaseUrl('openai-completions', 'https://relay.example/v1')).toBe(
      'https://relay.example/v1'
    );
  });

  it('静态厂商完整且 __custom 恒定在最前', () => {
    expect(new Set(STATIC_PROVIDER_DEFINITIONS.map((definition) => definition.id)).size).toBe(
      STATIC_PROVIDER_DEFINITIONS.length
    );
    expect(STATIC_PROVIDER_DEFINITIONS[0]).toMatchObject({
      id: '__custom',
      supportsApiKey: true,
    });
    expect(STATIC_PROVIDER_DEFINITIONS[1]).toMatchObject({
      id: 'mock',
      instantSetup: true,
      supportsApiKey: false,
    });
  });

  it('运行时 OAuth 合并到同 id 静态厂商，扩展 provider 接在 custom 之后', () => {
    const merged = mergeProviderDefinitions([
      { id: 'anthropic', name: 'Anthropic Subscription' },
      { id: 'cursor', name: 'Cursor' },
    ]);
    expect(merged[0]?.id).toBe('__custom');
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
    expect(merged.findIndex((definition) => definition.id === 'cursor')).toBeGreaterThan(0);
  });
});
