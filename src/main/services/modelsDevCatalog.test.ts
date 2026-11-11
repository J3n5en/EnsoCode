import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODELS_DEV_TTL_MS, type ModelsDevCache } from '@shared/modelsDevCatalog';
import { afterEach, describe, expect, it } from 'vitest';
import { runModelsDevRefresh } from './modelsDevCatalog';

const NOW = 1_700_000_000_000;

function cache(fetchedAt: number): ModelsDevCache {
  return {
    schemaVersion: 1,
    source: 'https://models.dev/api.json',
    fetchedAt,
    etag: '"old"',
    models: [{ id: 'old', provider: 'anthropic', contextWindow: 1000 }],
  };
}

const liveBody = JSON.stringify({
  anthropic: {
    models: {
      'claude-new': {
        id: 'claude-new',
        name: 'Claude New',
        tool_call: true,
        reasoning: true,
        limit: { context: 200_000, output: 32_000 },
        modalities: { output: ['text'] },
      },
    },
  },
});

describe('runModelsDevRefresh', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function file(): string {
    const dir = mkdtempSync(join(tmpdir(), 'models-dev-'));
    dirs.push(dir);
    return join(dir, 'models-dev-cache.json');
  }

  it('keeps a fresh cache and does not fetch', async () => {
    let called = false;
    const previous = cache(NOW);
    const outcome = await runModelsDevRefresh({
      file: file(),
      previous,
      now: NOW + MODELS_DEV_TTL_MS - 1,
      fetchCatalog: async () => {
        called = true;
        return { status: 500 };
      },
    });
    expect(called).toBe(false);
    expect(outcome.cache).toBe(previous);
    expect(outcome.result).toMatchObject({ ok: true, fromCache: true, modelCount: 1 });
  });

  it('writes a remote snapshot over the previous cache', async () => {
    const path = file();
    const outcome = await runModelsDevRefresh({
      file: path,
      previous: cache(NOW - MODELS_DEV_TTL_MS),
      now: NOW,
      fetchCatalog: async () => ({ status: 200, etag: '"new"', body: liveBody }),
    });
    expect(outcome.result).toMatchObject({
      ok: true,
      fromCache: false,
      modelCount: 1,
      fetchedAt: NOW,
    });
    expect(outcome.cache?.models[0]).toMatchObject({ id: 'claude-new', contextWindow: 200_000 });
    expect(JSON.parse(readFileSync(path, 'utf8')).etag).toBe('"new"');
  });

  it('keeps the previous cache when the refresh fails', async () => {
    const path = file();
    const previous = cache(NOW - MODELS_DEV_TTL_MS);
    const outcome = await runModelsDevRefresh({
      file: path,
      previous,
      now: NOW,
      fetchCatalog: async () => ({ status: 500, body: 'nope' }),
    });
    expect(outcome.result).toMatchObject({ ok: false, fromCache: true, modelCount: 1 });
    expect(outcome.cache).toBe(previous);
    expect(() => readFileSync(path, 'utf8')).toThrow();
  });

  it('refreshes the timestamp on 304 without replacing models', async () => {
    const path = file();
    const previous = cache(NOW - MODELS_DEV_TTL_MS);
    const outcome = await runModelsDevRefresh({
      file: path,
      previous,
      now: NOW,
      fetchCatalog: async (request) => {
        expect(request.etag).toBe('"old"');
        return { status: 304, etag: '"old"' };
      },
    });
    expect(outcome.result.ok).toBe(true);
    expect(outcome.cache?.models).toEqual(previous.models);
    expect(outcome.cache?.fetchedAt).toBe(NOW);
    expect(JSON.parse(readFileSync(path, 'utf8')).fetchedAt).toBe(NOW);
  });

  it('does not replace a good cache with an empty payload', async () => {
    const previous = cache(NOW - MODELS_DEV_TTL_MS);
    const outcome = await runModelsDevRefresh({
      file: file(),
      previous,
      now: NOW,
      fetchCatalog: async () => ({ status: 200, body: '{}' }),
    });
    expect(outcome.result.ok).toBe(false);
    expect(outcome.cache).toBe(previous);
  });
});
