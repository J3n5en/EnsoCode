import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeTinyModel2Vec } from './model2vec.fixture';
import { createEmbeddingProvider, toEmbedder, withPrefix } from './provider';
import {
  DEFAULT_EMBEDDING_MODEL_ID,
  embeddingModelDirName,
  listEmbeddingModelSpecs,
  resolveEmbeddingModelSpec,
} from './registry';
import type { EmbeddingModelSpec, EmbeddingProvider } from './types';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'enso-embed-provider-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const tinySpec = (over: Partial<EmbeddingModelSpec> = {}): EmbeddingModelSpec => ({
  id: 'local:tiny',
  runtime: 'model2vec',
  dim: 2,
  prefix: { passage: '', query: '' },
  approxBytes: 0,
  files: [],
  sources: null,
  ...over,
});

describe('registry', () => {
  it('default model is a known local gguf spec with sources on both mirrors', () => {
    const spec = resolveEmbeddingModelSpec(DEFAULT_EMBEDDING_MODEL_ID);
    // 默认值必须是能理解同义改写的上下文模型；model2vec 是词袋平均，semantic 召回等同于字面匹配
    expect(spec?.runtime).toBe('gguf');
    expect(spec?.sources?.huggingface).toBeTruthy();
    expect(spec?.sources?.modelscope).toBeTruthy();
    expect(listEmbeddingModelSpecs().map((s) => s.id)).toContain(DEFAULT_EMBEDDING_MODEL_ID);
  });

  it('every gguf model declares the file it loads and lists it as downloadable', () => {
    // gguf.file 与 files[] 不一致时，下载能成功但加载会找不到文件——只在真机报错
    for (const spec of listEmbeddingModelSpecs()) {
      if (spec.runtime !== 'gguf') continue;
      expect(spec.gguf, spec.id).toBeDefined();
      expect(
        spec.files.map((f) => f.name),
        spec.id
      ).toContain(spec.gguf?.file);
    }
  });

  it('gguf models store vectors at the dim they advertise', () => {
    // dim 与实际截断维度不符会让向量进错表，检索静默失效
    for (const spec of listEmbeddingModelSpecs()) {
      if (spec.runtime !== 'gguf' || !spec.gguf) continue;
      if (spec.gguf.truncateDim !== null) {
        expect(spec.dim, spec.id).toBe(spec.gguf.truncateDim);
      }
    }
  });

  it('has no duplicate ids', () => {
    // 同 id 会让两个模型共用一个缓存目录，互相覆盖权重
    const ids = listEmbeddingModelSpecs().map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only ships runtimes that are actually implemented', () => {
    // onnx 运行时已随 onnxruntime-node 一起移除；注册表若还留着 onnx 条目，
    // 选中后会走到不存在的分支
    const runtimes = new Set(listEmbeddingModelSpecs().map((s) => s.runtime));
    expect(runtimes).not.toContain('onnx');
    expect([...runtimes].sort()).toEqual(['gguf', 'model2vec', 'none']);
  });

  it('every downloadable model has a ModelScope fallback, not just HuggingFace', () => {
    // HF 在部分网络下不可达；漏配国内源的模型在那里完全下不下来（实测仓库均存在）
    for (const spec of listEmbeddingModelSpecs()) {
      if (spec.files.length === 0) continue;
      expect(spec.sources?.huggingface, `${spec.id} huggingface`).toBeTruthy();
      expect(spec.sources?.modelscope, `${spec.id} modelscope`).toBeTruthy();
    }
  });

  it('unknown ids resolve to null; remote:* yields an openai-compatible spec', () => {
    expect(resolveEmbeddingModelSpec('nope')).toBeNull();
    expect(resolveEmbeddingModelSpec('remote:')).toBeNull();
    expect(resolveEmbeddingModelSpec('remote:text-embedding-3-small')).toMatchObject({
      runtime: 'openai-compatible',
      dim: null,
    });
  });

  it('instructs only the query side for qwen3, and neither side for bge-m3', () => {
    // Qwen3-Embedding 模型卡：instruction 只加在查询侧；BGE-M3 不需要前缀
    const qwen = resolveEmbeddingModelSpec('local:qwen3-0.6b-gguf') as EmbeddingModelSpec;
    expect(withPrefix(qwen, 'passage', 'x')).toBe('x');
    expect(withPrefix(qwen, 'query', 'x')).toMatch(/^Instruct: .*\nQuery: x$/);
    const bge = resolveEmbeddingModelSpec('local:bge-m3-gguf') as EmbeddingModelSpec;
    expect(withPrefix(bge, 'passage', 'x')).toBe('x');
    expect(withPrefix(bge, 'query', 'x')).toBe('x');
  });

  it('dir name is filesystem-safe on every platform', () => {
    for (const spec of listEmbeddingModelSpecs()) {
      expect(embeddingModelDirName(spec)).toMatch(/^[a-zA-Z0-9._-]+$/);
    }
    expect(
      embeddingModelDirName(resolveEmbeddingModelSpec('remote:a/b:c') as EmbeddingModelSpec)
    ).toBe('remote_a_b_c');
  });
});

describe('createEmbeddingProvider', () => {
  it('returns null for runtime none', async () => {
    await expect(
      createEmbeddingProvider(resolveEmbeddingModelSpec('none') as EmbeddingModelSpec, {
        modelDir: dir,
      })
    ).resolves.toBeNull();
  });

  it('loads model2vec from modelDir and embeds a batch (null for empty inputs)', async () => {
    writeTinyModel2Vec(dir, {
      tokens: ['a', 'b'],
      rows: [
        [1, 0],
        [0, 1],
      ],
    });
    const p = (await createEmbeddingProvider(tinySpec(), { modelDir: dir })) as EmbeddingProvider;
    const [a, empty, b] = await p.embed(['a', '', 'b'], 'passage');
    expect(Array.from(a as Float32Array)).toEqual([1, 0]);
    expect(empty).toBeNull();
    expect(Array.from(b as Float32Array)).toEqual([0, 1]);
    p.close?.();
  });

  it('applies the spec prefix before embedding', async () => {
    writeTinyModel2Vec(dir, {
      tokens: ['query', 'a'],
      rows: [
        [1, 0],
        [0, 1],
      ],
    });
    const p = (await createEmbeddingProvider(
      tinySpec({ prefix: { passage: '', query: 'query: ' } }),
      { modelDir: dir }
    )) as EmbeddingProvider;
    const [q] = await p.embed(['a'], 'query');
    const [d] = await p.embed(['a'], 'passage');
    expect((q as Float32Array)[0]).toBeCloseTo(Math.SQRT1_2, 5);
    expect((q as Float32Array)[1]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(Array.from(d as Float32Array)).toEqual([0, 1]);
    p.close?.();
  });

  it('rejects a model whose dim differs from the registry', async () => {
    writeTinyModel2Vec(dir, { tokens: ['a'], rows: [[1, 0, 0]] });
    await expect(createEmbeddingProvider(tinySpec({ dim: 2 }), { modelDir: dir })).rejects.toThrow(
      /dim/
    );
  });

  it('fills dim from the model when the spec leaves it null', async () => {
    writeTinyModel2Vec(dir, { tokens: ['a'], rows: [[1, 0, 0]] });
    const p = (await createEmbeddingProvider(tinySpec({ dim: null }), {
      modelDir: dir,
    })) as EmbeddingProvider;
    expect(p.spec.dim).toBe(3);
    p.close?.();
  });

  it('remote runtime requires injected credentials', async () => {
    await expect(
      createEmbeddingProvider(tinySpec({ runtime: 'openai-compatible' }), { modelDir: dir })
    ).rejects.toThrow(/remote credentials/);
  });
});

describe('toEmbedder', () => {
  function counting(): EmbeddingProvider & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      spec: tinySpec(),
      embed: async (texts, kind) => {
        for (const t of texts) calls.push(`${kind}:${t}`);
        return texts.map((t) => (t ? Float32Array.from([t.length, 0]) : null));
      },
    };
  }

  it('exposes model id and dim for store/search', () => {
    const e = toEmbedder(counting());
    expect(e.model).toBe('local:tiny');
    expect(e.dim).toBe(2);
  });

  it('caches query vectors within TTL but never passage vectors', async () => {
    let t = 0;
    const p = counting();
    const e = toEmbedder(p, { now: () => t });
    await e.embed('q', 'query');
    await e.embed('q', 'query');
    await e.embed('q', 'passage');
    await e.embed('q', 'passage');
    expect(p.calls).toEqual(['query:q', 'passage:q', 'passage:q']);
    t = 300_001;
    await e.embed('q', 'query');
    expect(p.calls.filter((c) => c === 'query:q')).toHaveLength(2);
  });

  it('evicts the oldest query entry beyond 64', async () => {
    const p = counting();
    const e = toEmbedder(p);
    for (let i = 0; i < 65; i++) await e.embed(`q${i}`, 'query');
    await e.embed('q0', 'query');
    expect(p.calls.filter((c) => c === 'query:q0')).toHaveLength(2);
    await e.embed('q64', 'query');
    expect(p.calls.filter((c) => c === 'query:q64')).toHaveLength(1);
  });

  it('tracks a lazily-resolved dim from the provider spec', async () => {
    let dim: number | null = null;
    const p = {
      get spec() {
        return tinySpec({ dim });
      },
      embed: async (texts: string[]) => {
        dim = 2;
        return texts.map(() => Float32Array.from([1, 0]));
      },
    };
    const e = toEmbedder(p);
    expect(e.dim).toBeNull();
    await e.embed('x', 'passage');
    expect(e.dim).toBe(2);
  });
});
