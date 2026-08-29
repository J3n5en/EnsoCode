import type { ModelProvider } from '@shared/types';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginOauthCredentialRefresh,
  setOauthCredentialState,
  usableProvidersForOauthSnapshot,
  useOauthCredentialStore,
} from './index';

function provider(id: string, overrides: Partial<ModelProvider> = {}): ModelProvider {
  return {
    id,
    name: id,
    api: 'openai-completions',
    apiKey: `key-${id}`,
    baseUrl: 'https://example.test/v1',
    enabled: true,
    models: [{ id: 'enabled' }, { id: 'disabled', enabled: false }],
    ...overrides,
  };
}

describe('oauth credential runtime store', () => {
  beforeEach(() => {
    useOauthCredentialStore.setState({
      snapshot: { revision: 0, availability: { status: 'unloaded' } },
    });
  });

  it('begin increments revision and makes OAuth loading fail-closed', () => {
    expect(beginOauthCredentialRefresh()).toBe(1);
    expect(beginOauthCredentialRefresh()).toBe(2);
    expect(useOauthCredentialStore.getState().snapshot).toEqual({
      revision: 2,
      availability: { status: 'loading' },
    });
  });

  it('discards stale completion without replacing the current snapshot', () => {
    const staleRevision = beginOauthCredentialRefresh();
    const currentRevision = beginOauthCredentialRefresh();
    expect(
      setOauthCredentialState({
        revision: staleRevision,
        availability: {
          status: 'ready',
          authenticatedAccountKeys: new Set(['anthropic']),
        },
      })
    ).toBe(false);
    expect(useOauthCredentialStore.getState().snapshot.revision).toBe(currentRevision);
    expect(useOauthCredentialStore.getState().snapshot.availability.status).toBe('loading');
  });

  it('accepts the current ready snapshot and derives candidates from real OAuth keys', () => {
    const revision = beginOauthCredentialRefresh();
    const ready = {
      revision,
      availability: {
        status: 'ready' as const,
        authenticatedAccountKeys: new Set(['anthropic#2']),
      },
    };
    expect(setOauthCredentialState(ready)).toBe(true);

    const candidates = usableProvidersForOauthSnapshot(
      [
        provider('api'),
        provider('oauth-live', { apiKey: '', oauthAccountKey: 'anthropic#2' }),
        provider('oauth-logged-out', { apiKey: '', oauthAccountKey: 'anthropic#1' }),
      ],
      ready
    );
    expect(candidates.map((entry) => entry.id)).toEqual(['api', 'oauth-live']);
    expect(
      candidates.every((entry) => entry.models.map((model) => model.id).join() === 'enabled')
    ).toBe(true);
  });

  it('keeps API-key candidates usable while OAuth loading or error excludes subscriptions', () => {
    const providers = [
      provider('api'),
      provider('oauth', { apiKey: '', oauthAccountKey: 'anthropic' }),
    ];
    for (const availability of [
      { status: 'loading' as const },
      { status: 'error' as const, error: 'auth read failed' },
    ]) {
      expect(
        usableProvidersForOauthSnapshot(providers, { revision: 1, availability }).map(
          (entry) => entry.id
        )
      ).toEqual(['api']);
    }
  });
});
