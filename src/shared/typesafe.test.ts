import { describe, expect, it } from 'vitest';
import { modelUsability, resolveChatModel, sanitizeDefaultModel } from './defaultModel';
import { STATIC_PROVIDER_DEFINITIONS } from './providerCatalog';
import type { ModelProvider } from './types';
import {
  canBeVirtualMember,
  classifierBaseUrlFor,
  classifierProviderFor,
  VIRTUAL_PROVIDER_ID,
} from './virtualModels';

const typesafe: ModelProvider = {
  id: 'typesafe-fixture',
  name: 'TypeSafe',
  api: 'openai-completions',
  baseUrl: 'https://api.typesafe.ai/v1/',
  catalogId: 'typesafe',
  apiKey: 'fixture-key',
  enabled: true,
  models: [{ id: 'jev-latest' }],
};
const ref = { providerId: typesafe.id, modelId: 'jev-latest' };
const ready = {
  oauthCredentials: { status: 'ready' as const, authenticatedAccountKeys: new Set<string>() },
};

describe('TypeSafe classifier-only boundary', () => {
  it('official API-key catalog entry uses the classifier protocol', () => {
    expect(STATIC_PROVIDER_DEFINITIONS.find((entry) => entry.id === 'typesafe')).toMatchObject({
      label: 'TypeSafe',
      supportsApiKey: true,
      defaultApi: 'typesafe-system-one',
      defaultBaseUrl: 'https://api.typesafe.ai/v1/',
    });
  });

  it('recognizes TypeSafe by hostname without trusting catalog id or lookalike domains', () => {
    expect(classifierProviderFor(typesafe)).toBe('typesafe');
    expect(
      classifierProviderFor({ ...typesafe, baseUrl: 'https://relay.example/v1' })
    ).toBeUndefined();
    expect(
      classifierProviderFor({ ...typesafe, baseUrl: 'https://api.typesafe.ai.evil.example' })
    ).toBeUndefined();
    expect(classifierProviderFor({ ...typesafe, baseUrl: 'https://openrouter.ai/api/v1' })).toBe(
      'openrouter'
    );
  });

  it('uses the protocol default for an empty address and the relay itself for an explicit relay', () => {
    const provider: ModelProvider = { ...typesafe, api: 'typesafe-system-one', baseUrl: '  ' };
    expect(classifierProviderFor(provider)).toBe('typesafe');
    expect(classifierBaseUrlFor(provider)).toBeUndefined();
    const relay = { ...provider, baseUrl: 'https://relay.example/v1' };
    expect(classifierProviderFor(relay)).toBe('typesafe');
    expect(classifierBaseUrlFor(relay)).toBe('https://relay.example/v1');
  });

  it('rejects chat, default/session/project/group overrides and virtual members', () => {
    expect(modelUsability(ref, [typesafe], ready)).toBe('classifier-only');
    expect(canBeVirtualMember(typesafe)).toBe(false);
    expect(
      resolveChatModel({
        defaultModel: ref,
        projectDefaultModel: ref,
        groupDefaultModel: ref,
        lastProviderId: ref.providerId,
        lastModelId: ref.modelId,
        providers: [typesafe],
        credentials: ready,
      })
    ).toMatchObject({ providerId: null, modelId: null, reason: 'no-usable-model' });
    expect(
      sanitizeDefaultModel({ defaultModel: ref, providers: [typesafe], credentials: ready })
    ).toMatchObject({ status: 'sanitized', defaultModel: null });
    expect(
      modelUsability({ providerId: VIRTUAL_PROVIDER_ID, modelId: 'auto' }, [typesafe], ready, [
        { id: 'auto', name: 'Auto', enabled: true, primary: ref, fast: ref, fallbacks: [ref] },
      ])
    ).toBe('classifier-only');
  });
});
