import type { ProviderDefinition } from '@shared/providerCatalog';
import { describe, expect, it } from 'vitest';
import { availableProviderSetupMethods, initialProviderApiValue } from './providerSetup';

describe('统一提供商向导分支', () => {
  it('同时支持订阅与 API Key 的厂商先展示两种接入方式', () => {
    const definition: ProviderDefinition = {
      id: 'anthropic',
      label: 'Anthropic',
      oauthProviderId: 'anthropic',
      defaultApi: 'anthropic-messages',
      defaultBaseUrl: 'https://api.anthropic.com',
      supportsApiKey: true,
    };
    expect(availableProviderSetupMethods(definition)).toEqual(['oauth', 'api-key']);
  });

  it('纯订阅扩展不伪造 API Key 分支', () => {
    const definition: ProviderDefinition = {
      id: 'subscription-only',
      label: 'Subscription only',
      oauthProviderId: 'subscription-only',
      supportsApiKey: false,
    };
    expect(availableProviderSetupMethods(definition)).toEqual(['oauth']);
  });

  it('已知厂商预填 API 与 Base URL，自定义端点保留空名称和自由地址', () => {
    expect(
      initialProviderApiValue({
        id: 'xai',
        label: 'xAI',
        defaultApi: 'openai-completions',
        defaultBaseUrl: 'https://api.x.ai/v1',
        supportsApiKey: true,
      })
    ).toMatchObject({
      name: 'xAI',
      api: 'openai-completions',
      baseUrl: 'https://api.x.ai/v1',
    });
    expect(
      initialProviderApiValue({
        id: '__custom',
        label: 'Custom',
        defaultApi: 'openai-completions',
        supportsApiKey: true,
      })
    ).toMatchObject({ name: '', baseUrl: '', apiKey: '' });
  });
});
