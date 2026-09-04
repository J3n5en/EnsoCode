import type { ModelProvider } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { toPairProviderEntries } from './pairCatalogProviders';

function provider(id: string, overrides: Partial<ModelProvider> = {}): ModelProvider {
  return {
    id,
    name: id,
    api: 'openai-completions',
    apiKey: `key-${id}`,
    baseUrl: 'https://secret.example/v1',
    enabled: true,
    models: [
      { id: 'enabled', label: 'Enabled' },
      { id: 'disabled', enabled: false },
    ],
    ...overrides,
  };
}

describe('toPairProviderEntries', () => {
  it('includes authenticated subscription providers and strips secrets', () => {
    const entries = toPairProviderEntries(
      [
        provider('api'),
        provider('oauth-live', { apiKey: '', oauthAccountKey: 'anthropic#2' }),
        provider('oauth-logged-out', { apiKey: '', oauthAccountKey: 'anthropic#1' }),
        provider('disabled', { enabled: false }),
      ],
      {
        revision: 1,
        availability: {
          status: 'ready',
          authenticatedAccountKeys: new Set(['anthropic#2']),
        },
      }
    );
    expect(entries).toEqual([
      { id: 'api', name: 'api', models: [{ id: 'enabled', label: 'Enabled' }] },
      { id: 'oauth-live', name: 'oauth-live', models: [{ id: 'enabled', label: 'Enabled' }] },
    ]);
    expect(JSON.stringify(entries)).not.toMatch(/secret|key-api|anthropic#2/);
  });

  it('keeps API-key providers while OAuth is still loading', () => {
    expect(
      toPairProviderEntries(
        [provider('api'), provider('oauth', { apiKey: '', oauthAccountKey: 'anthropic' })],
        { revision: 1, availability: { status: 'loading' } }
      ).map((entry) => entry.id)
    ).toEqual(['api']);
  });
});
