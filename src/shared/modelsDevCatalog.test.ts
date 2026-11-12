import { describe, expect, it } from 'vitest';
import {
  cloneModelsDevOauthModel,
  MODELS_DEV_TTL_MS,
  mergeCatalogEntry,
  modelsDevIsFresh,
  parseModelsDevCache,
  parseModelsDevPayload,
  withModelsDevOauthModels,
} from './modelsDevCatalog';

const NOW = 1_700_000_000_000;

const payload = {
  anthropic: {
    models: {
      'claude-sonnet': {
        id: 'claude-sonnet',
        name: 'Claude Sonnet',
        tool_call: true,
        reasoning: true,
        limit: { context: 200_000, output: 64_000 },
        modalities: { output: ['text'] },
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      },
      'embed-v1': {
        id: 'embed-v1',
        tool_call: false,
        modalities: { output: ['embedding'] },
      },
    },
  },
  openai: {
    models: {
      'gpt-image': {
        id: 'gpt-image',
        tool_call: true,
        modalities: { output: ['image'] },
      },
    },
  },
};

describe('parseModelsDevPayload', () => {
  it('keeps chat models and drops embeddings and non-text output', () => {
    const cache = parseModelsDevPayload(payload, NOW);
    expect(cache?.models).toEqual([
      {
        id: 'claude-sonnet',
        provider: 'anthropic',
        name: 'Claude Sonnet',
        contextWindow: 200_000,
        maxTokens: 64_000,
        reasoning: true,
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      },
    ]);
    expect(cache?.fetchedAt).toBe(NOW);
  });

  it('rejects a payload that yields no chat models', () => {
    expect(parseModelsDevPayload(null, NOW)).toBeUndefined();
    expect(parseModelsDevPayload([], NOW)).toBeUndefined();
    expect(parseModelsDevPayload({ anthropic: { models: {} } }, NOW)).toBeUndefined();
    expect(parseModelsDevPayload({ openai: payload.openai }, NOW)).toBeUndefined();
  });
});

describe('parseModelsDevCache', () => {
  it('rejects a different schema and keeps a valid snapshot', () => {
    expect(
      parseModelsDevCache({ schemaVersion: 2, source: 'x', fetchedAt: NOW, models: [] })
    ).toBeUndefined();
    const cache = parseModelsDevCache({
      schemaVersion: 1,
      source: 'https://models.dev/api.json',
      fetchedAt: NOW,
      etag: '"abc"',
      models: [
        { id: 'claude-sonnet', provider: 'anthropic', contextWindow: 200_000 },
        { id: '', provider: 'anthropic' },
        { provider: 'openai' },
      ],
    });
    expect(cache?.models).toEqual([
      { id: 'claude-sonnet', provider: 'anthropic', contextWindow: 200_000 },
    ]);
    expect(cache?.etag).toBe('"abc"');
  });
});

describe('modelsDevIsFresh', () => {
  it('is fresh inside 4 hours and stale at the boundary', () => {
    expect(modelsDevIsFresh({ fetchedAt: NOW }, NOW + MODELS_DEV_TTL_MS - 1)).toBe(true);
    expect(modelsDevIsFresh({ fetchedAt: NOW }, NOW + MODELS_DEV_TTL_MS)).toBe(false);
    expect(modelsDevIsFresh(undefined, NOW)).toBe(false);
  });
});

describe('mergeCatalogEntry', () => {
  it('lets models.dev replace limits and keeps pi reasoning metadata', () => {
    const merged = mergeCatalogEntry(
      {
        id: 'claude-sonnet',
        provider: 'anthropic',
        contextWindow: 1000,
        maxTokens: 100,
        reasoning: true,
        thinkingLevelMap: { xhigh: 'xhigh' },
      },
      {
        id: 'claude-sonnet',
        provider: 'anthropic',
        contextWindow: 200_000,
        maxTokens: 64_000,
        reasoning: false,
      }
    );
    expect(merged).toMatchObject({
      contextWindow: 200_000,
      maxTokens: 64_000,
      reasoning: true,
      thinkingLevelMap: { xhigh: 'xhigh' },
    });
  });

  it('returns the pi entry unchanged when models.dev has no match', () => {
    const pi = { id: 'local', contextWindow: 8_000 };
    expect(mergeCatalogEntry(pi, undefined)).toBe(pi);
    expect(mergeCatalogEntry(undefined, undefined)).toBeUndefined();
  });
});

describe('withModelsDevOauthModels', () => {
  it('overlays an existing id and appends a same-provider model only', () => {
    const catalog = [
      { id: 'old', provider: 'anthropic', name: 'Old', contextWindow: 1000, reasoning: true },
    ];
    const next = withModelsDevOauthModels('anthropic', catalog, [
      { id: 'old', provider: 'anthropic', contextWindow: 200_000, maxTokens: 64_000 },
      { id: 'new', provider: 'anthropic', name: 'New', contextWindow: 128_000, reasoning: true },
      { id: 'gpt', provider: 'openai', contextWindow: 128_000 },
    ]);
    expect(next.map((model) => model.id)).toEqual(['old', 'new']);
    expect(next[0]).toMatchObject({ contextWindow: 200_000, maxTokens: 64_000, reasoning: true });
    expect(next[1]).toMatchObject({
      id: 'new',
      name: 'New',
      contextWindow: 128_000,
      provider: 'anthropic',
    });
  });

  it('does not invent a callable model when the provider catalog is empty', () => {
    expect(
      withModelsDevOauthModels(
        'anthropic',
        [],
        [{ id: 'new', provider: 'anthropic', contextWindow: 128_000 }]
      )
    ).toEqual([]);
  });
});

describe('cloneModelsDevOauthModel', () => {
  it('clones a same-provider template only for a published models.dev id', () => {
    const catalog = [{ id: 'old', provider: 'anthropic', contextWindow: 1000, reasoning: true }];
    expect(
      cloneModelsDevOauthModel('anthropic', 'new', catalog, [
        {
          id: 'new',
          provider: 'anthropic',
          name: 'New',
          contextWindow: 128_000,
          maxTokens: 8_000,
          reasoning: false,
        },
      ])
    ).toMatchObject({
      id: 'new',
      provider: 'anthropic',
      contextWindow: 128_000,
      maxTokens: 8_000,
      reasoning: false,
    });
    expect(cloneModelsDevOauthModel('anthropic', 'missing', catalog, [])).toBeUndefined();
    expect(
      cloneModelsDevOauthModel('openai', 'new', catalog, [
        { id: 'new', provider: 'anthropic', contextWindow: 128_000 },
      ])
    ).toBeUndefined();
  });
});
