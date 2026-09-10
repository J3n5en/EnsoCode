import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Model2VecModel } from './model2vec';
import { writeTinyModel2Vec } from './model2vec.fixture';
import { createEmbeddingProvider } from './provider';
import type { EmbeddingModelSpec, EmbeddingProvider } from './types';

let dir: string;
let provider: EmbeddingProvider | null;
const spec: EmbeddingModelSpec = {
  id: 'test:model2vec',
  runtime: 'model2vec',
  dim: 2,
  approxBytes: 0,
  sources: null,
  files: [],
  prefix: { query: '', passage: '' },
};
beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(path.join(tmpdir(), 'enso-idle-embedding-'));
  writeTinyModel2Vec(dir, { tokens: ['hello'], rows: [[1, 0]] });
});
afterEach(async () => {
  await provider?.close?.();
  provider = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('本地嵌入空闲释放', () => {
  it('远程嵌入不创建空闲卸载定时器', async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }))
    );
    vi.stubGlobal('fetch', fetch);
    provider = await createEmbeddingProvider(
      { ...spec, id: 'remote:test', runtime: 'openai-compatible' },
      {
        modelDir: dir,
        remote: { baseUrl: 'https://example.invalid', apiKey: 'test' },
        idleMinutes: 5,
      }
    );
    await provider!.embed(['hello'], 'passage');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(await provider!.embed(['hello'], 'passage')).toEqual([new Float32Array([1, 0])]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('默认十分钟关闭 Model2Vec 文件，旧 provider 自动重新加载', async () => {
    const close = vi.spyOn(Model2VecModel.prototype, 'close');
    const load = vi.spyOn(Model2VecModel, 'load');
    provider = await createEmbeddingProvider(spec, { modelDir: dir });
    const first = await provider!.embed(['hello'], 'passage');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(close).toHaveBeenCalledOnce();
    expect(await provider!.embed(['hello'], 'passage')).toEqual(first);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
