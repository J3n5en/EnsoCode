import { describe, expect, it } from 'vitest';
import {
  baseUrlAfterApiChange,
  DEFAULT_BASE_URLS,
  mergeProviderDefinitions,
  resolvePiProviderBaseUrl,
  STATIC_PROVIDER_DEFINITIONS,
} from './providerCatalog';
import { MODEL_API_KINDS } from './types/llm';

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

  it.each([
    [
      { id: 'openai', name: 'OpenAI (ChatGPT)' },
      { id: 'openai-codex', name: 'OpenAI Codex' },
    ],
    [
      { id: 'openai-codex', name: 'OpenAI Codex' },
      { id: 'openai', name: 'OpenAI (ChatGPT)' },
    ],
  ])('OpenAI 使用 Codex 登录，PI 原生登录独立保留且不受枚举顺序影响', (...oauth) => {
    const merged = mergeProviderDefinitions(oauth);
    expect(merged.find((definition) => definition.id === 'openai')).toMatchObject({
      label: 'OpenAI',
      oauthProviderId: 'openai-codex',
      defaultApi: 'openai-responses',
      defaultBaseUrl: 'https://api.openai.com/v1',
      supportsApiKey: true,
    });
    expect(merged.find((definition) => definition.id === 'openai-chatgpt')).toEqual({
      id: 'openai-chatgpt',
      label: 'ChatGPT (PI login)',
      oauthProviderId: 'openai',
      supportsApiKey: false,
    });
    expect(
      merged.filter((definition) => definition.oauthProviderId === 'openai-codex')
    ).toHaveLength(1);
  });

  it('只有 Codex 运行时能力时仍合并到 OpenAI 卡片', () => {
    const merged = mergeProviderDefinitions([{ id: 'openai-codex', name: 'OpenAI Codex' }]);
    expect(merged.find((definition) => definition.id === 'openai')).toMatchObject({
      label: 'OpenAI',
      oauthProviderId: 'openai-codex',
      supportsApiKey: true,
    });
    expect(merged.some((definition) => definition.id === 'openai-codex')).toBe(false);
    expect(merged.some((definition) => definition.id === 'openai-chatgpt')).toBe(false);
  });

  it('Codex 不可用时不把 OpenAI 卡片静默切回 PI 原生登录', () => {
    const merged = mergeProviderDefinitions([{ id: 'openai', name: 'OpenAI (ChatGPT)' }]);
    expect(
      merged.find((definition) => definition.id === 'openai')?.oauthProviderId
    ).toBeUndefined();
    expect(merged.find((definition) => definition.id === 'openai-chatgpt')?.oauthProviderId).toBe(
      'openai'
    );
  });

  it.each([
    ['anthropic-messages', 'https://api.deepseek.com', 'https://api.deepseek.com/anthropic'],
    ['anthropic-messages', 'https://api.deepseek.com/v1/', 'https://api.deepseek.com/anthropic'],
    ['openai-completions', 'https://api.deepseek.com/anthropic', 'https://api.deepseek.com'],
    ['openai-responses', 'https://API.deepseek.com/anthropic/', 'https://api.deepseek.com'],
    ['anthropic-messages', 'https://relay.example.com/v1', 'https://relay.example.com/v1'],
    ['anthropic-messages', 'https://api.deepseek.com/beta', 'https://api.deepseek.com/beta'],
    ['openai-completions', 'https://api.deepseek.com', 'https://api.deepseek.com'],
    ['anthropic-messages', 'not a url', 'not a url'],
  ] as const)('DeepSeek 切换 %s 时 %s → %s', (api, from, to) => {
    expect(baseUrlAfterApiChange(api, from)).toBe(to);
  });
});
