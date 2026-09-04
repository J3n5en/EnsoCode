import { describe, expect, it } from 'vitest';
import {
  defaultApprovalMode,
  type ModelCredentialContext,
  modelUsability,
  resolveChatModel,
  sanitizeDefaultModel,
} from './defaultModel';
import type { ModelProvider } from './types';

function provider(
  id: string,
  modelIds: string[],
  overrides: Partial<ModelProvider> = {}
): ModelProvider {
  return {
    id,
    name: id,
    api: 'openai-completions',
    apiKey: `key-${id}`,
    baseUrl: 'https://example.test/v1',
    enabled: true,
    models: modelIds.map((modelId) => ({ id: modelId })),
    ...overrides,
  };
}

function oauthProvider(id: string, accountKey: string, modelIds: string[]): ModelProvider {
  return provider(id, modelIds, { apiKey: '', oauthAccountKey: accountKey });
}

const ready = (...keys: string[]): ModelCredentialContext => ({
  oauthCredentials: { status: 'ready', authenticatedAccountKeys: new Set(keys) },
});
const oauthError: ModelCredentialContext = {
  oauthCredentials: { status: 'error', error: 'auth unavailable' },
};

describe('modelUsability detailed reasons', () => {
  it('区分 provider/model 缺失或 disabled、API key 缺失与 OAuth ready-missing', () => {
    expect(modelUsability({ providerId: 'x', modelId: 'm' }, [], ready())).toBe('provider-missing');
    expect(
      modelUsability(
        { providerId: 'p', modelId: 'm' },
        [provider('p', ['m'], { enabled: false })],
        ready()
      )
    ).toBe('provider-disabled');
    expect(modelUsability({ providerId: 'p', modelId: 'x' }, [provider('p', ['m'])], ready())).toBe(
      'model-missing'
    );
    expect(
      modelUsability(
        { providerId: 'p', modelId: 'm' },
        [provider('p', ['m'], { models: [{ id: 'm', enabled: false }] })],
        ready()
      )
    ).toBe('model-disabled');
    expect(
      modelUsability(
        { providerId: 'p', modelId: 'm' },
        [provider('p', ['m'], { apiKey: '' })],
        ready()
      )
    ).toBe('api-key-missing');
    expect(
      modelUsability(
        { providerId: 'oauth', modelId: 'm' },
        [oauthProvider('oauth', 'anthropic', ['m'])],
        ready()
      )
    ).toBe('oauth-account-missing');
  });

  it('OAuth 非 ready 只让结构有效 OAuth 条目变未知', () => {
    expect(
      modelUsability(
        { providerId: 'oauth', modelId: 'm' },
        [oauthProvider('oauth', 'anthropic', ['m'])],
        oauthError
      )
    ).toBe('oauth-credentials-error');
    expect(
      modelUsability({ providerId: 'api', modelId: 'm' }, [provider('api', ['m'])], oauthError)
    ).toBe('usable');
  });
});

describe('sanitizeDefaultModel F14', () => {
  it('确定失效 API default 在 OAuth error 下立即 fallback 到可用 API 模型', () => {
    const previous = { providerId: 'broken-api', modelId: 'old' };
    const fallback = { providerId: 'fallback-api', modelId: 'next' };
    expect(
      sanitizeDefaultModel({
        defaultModel: previous,
        providers: [
          provider('broken-api', ['old'], { apiKey: '' }),
          oauthProvider('unknown-oauth', 'anthropic', ['claude']),
          provider('fallback-api', ['next']),
        ],
        credentials: oauthError,
      })
    ).toEqual({
      status: 'sanitized',
      defaultModel: fallback,
      notice: { previous, next: fallback },
    });
  });

  it('provider/model 确定失效同样不受无关 OAuth error 阻断 API fallback', () => {
    const previous = { providerId: 'removed', modelId: 'old' };
    expect(
      sanitizeDefaultModel({
        defaultModel: previous,
        providers: [provider('api', ['m'])],
        credentials: oauthError,
      })
    ).toMatchObject({
      status: 'sanitized',
      defaultModel: { providerId: 'api', modelId: 'm' },
    });
  });

  it('无确定可用项但存在 OAuth unknown 候选才 defer，不误清空', () => {
    const previous = { providerId: 'removed', modelId: 'old' };
    expect(
      sanitizeDefaultModel({
        defaultModel: previous,
        providers: [oauthProvider('unknown-oauth', 'anthropic', ['claude'])],
        credentials: oauthError,
      })
    ).toMatchObject({
      status: 'deferred-oauth-unavailable',
      defaultModel: previous,
      reason: 'oauth-credentials-error',
    });
  });

  it('当前默认自身是结构有效 OAuth unknown 时先 defer', () => {
    const oauth = oauthProvider('oauth', 'anthropic', ['claude']);
    const previous = { providerId: 'oauth', modelId: 'claude' };
    expect(
      sanitizeDefaultModel({
        defaultModel: previous,
        providers: [oauth, provider('api', ['m'])],
        credentials: oauthError,
      })
    ).toMatchObject({ status: 'deferred-oauth-unavailable', defaultModel: previous });
  });

  it('OAuth ready 后仍无候选才清空', () => {
    const previous = { providerId: 'oauth', modelId: 'claude' };
    expect(
      sanitizeDefaultModel({
        defaultModel: previous,
        providers: [oauthProvider('oauth', 'anthropic', ['claude'])],
        credentials: ready(),
      })
    ).toEqual({
      status: 'sanitized',
      defaultModel: null,
      notice: { previous, next: null },
    });
  });
});

describe('resolveChatModel', () => {
  it('普通会话仍优先自身模型，其后才用全局默认', () => {
    const providers = [provider('session', ['s']), provider('default', ['d'])];
    expect(
      resolveChatModel({
        defaultModel: { providerId: 'default', modelId: 'd' },
        lastProviderId: 'session',
        lastModelId: 's',
        providers,
        credentials: oauthError,
      })
    ).toMatchObject({ source: 'session', providerId: 'session', modelId: 's' });
  });
});

describe('defaultApprovalMode', () => {
  it('代审模型可用 → assistant，未选或不可用 → full', () => {
    const providers = [provider('p', ['m'])];
    expect(defaultApprovalMode({ providerId: 'p', modelId: 'm' }, providers, ready())).toBe(
      'assistant'
    );
    expect(defaultApprovalMode(null, providers, ready())).toBe('full');
    expect(defaultApprovalMode({ providerId: 'p', modelId: 'gone' }, providers, ready())).toBe(
      'full'
    );
  });
});
