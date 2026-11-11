import type { Token } from 'node-llama-cpp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlamaEmbeddingContextLike, LlamaModelLike } from '../../llama/runtime';
import { createGgufEmbeddingProvider } from './gguf';
import type { EmbeddingModelSpec } from './types';

const spec: EmbeddingModelSpec = {
  id: 'local:qwen3-0.6b-gguf',
  runtime: 'gguf',
  dim: 512,
  prefix: { passage: '', query: 'Query: ' },
  approxBytes: 0,
  files: [{ name: 'model.gguf' }],
  gguf: { file: 'model.gguf', maxTokens: 512, truncateDim: 512 },
  sources: null,
};

/** 造一个可预测的假 embedding：第 i 维 = i+1，便于验证截断与归一化 */
function ramp(dim: number): number[] {
  return Array.from({ length: dim }, (_, i) => i + 1);
}

function fakeModel(opts: {
  vectorFor?: (input: string) => number[];
  seen?: string[];
  onDispose?: () => void;
}): LlamaModelLike {
  const ctx: LlamaEmbeddingContextLike = {
    getEmbeddingFor: vi.fn(async (input: string) => {
      opts.seen?.push(input);
      return { vector: opts.vectorFor?.(input) ?? ramp(1024) };
    }),
    dispose: vi.fn(async () => opts.onDispose?.()),
  };
  return {
    tokenizer: (input: string) => Array.from(input, (char) => char.codePointAt(0)),
    trainContextSize: 512,
    vocabularyType: 'bpe',
    tokens: { bos: null, eos: null, sep: null },
    createEmbeddingContext: vi.fn(async () => ctx),
    dispose: vi.fn(async () => {}),
  } as unknown as LlamaModelLike;
}

function provider(model: LlamaModelLike, override: Partial<EmbeddingModelSpec> = {}) {
  return createGgufEmbeddingProvider(
    { ...spec, ...override },
    { modelDir: '/models/qwen3', acquire: async () => model }
  );
}

function budgetModel(trainContextSize: number, vocabularyType = 'bpe') {
  const seen: (string | Token[])[] = [];
  const evaluated: number[][] = [];
  // 多字节文本按 byte token 编码，确保字符数不是 token 预算。
  const tokenizer = vi.fn((input: string) => Array.from(Buffer.from(input)) as Token[]);
  const model = {
    tokenizer,
    trainContextSize,
    vocabularyType,
    tokens: {
      bos: 1000,
      eos: 1001,
      sep: 1002,
      shouldPrependBosToken: false,
      shouldAppendEosToken: false,
    },
    createEmbeddingContext: vi.fn(async (options: { contextSize: number | { max: number } }) => {
      const size = Math.min(
        trainContextSize,
        typeof options.contextSize === 'number' ? options.contextSize : options.contextSize.max
      );
      return {
        getEmbeddingFor: vi.fn(async (input: string | Token[]) => {
          seen.push(input);
          const tokens: number[] = typeof input === 'string' ? tokenizer(input) : [...input];
          if (tokens.length > size) throw new Error('input exceeds context');
          if (vocabularyType === 'wpm') {
            if (tokens[0] !== 1000) tokens.unshift(1000);
            if (tokens.at(-1) !== 1002) tokens.push(1002);
          } else if (vocabularyType === 'ugm' && tokens.at(-1) !== 1001) {
            tokens.push(1001);
          } else if (vocabularyType === 'bpe') {
            if (model.tokens.shouldPrependBosToken && tokens[0] !== 1000) tokens.unshift(1000);
            if (model.tokens.shouldAppendEosToken && tokens.at(-1) !== 1001) tokens.push(1001);
          }
          if (tokens.length > size) throw new Error('special tokens exceed context');
          evaluated.push(tokens);
          return { vector: ramp(1024) };
        }),
        dispose: vi.fn(async () => {}),
      };
    }),
  };
  return {
    model: model as unknown as LlamaModelLike,
    tokenizer,
    seen,
    evaluated,
    tokens: model.tokens,
  };
}

describe('createGgufEmbeddingProvider token budget', () => {
  it.each(['passage', 'query'] as const)('按真实 token 截断长 %s，前缀也占预算', async (kind) => {
    const fixture = budgetModel(512);
    const p = await provider(fixture.model);
    const text = '记忆'.repeat(300);
    await expect(p.embed([text], kind)).resolves.toEqual([expect.any(Float32Array)]);
    const prefixed = kind === 'query' ? `Query: ${text}` : text;
    expect(fixture.evaluated).toEqual([Array.from(Buffer.from(prefixed)).slice(0, 512)]);
    expect(fixture.tokenizer).toHaveBeenCalledWith(prefixed, false);
  });

  it.each(['bpe', 'wpm', 'ugm'])(
    '%s 在训练长度边界为自动 special tokens 留位置',
    async (vocabulary) => {
      const fixture = budgetModel(10, vocabulary);
      if (vocabulary === 'bpe') {
        fixture.tokens.shouldPrependBosToken = true;
        fixture.tokens.shouldAppendEosToken = true;
      }
      const p = await provider(fixture.model);
      await expect(p.embed(['abcdefghij'], 'passage')).resolves.toEqual([expect.any(Float32Array)]);
      const begin = vocabulary === 'ugm' ? [] : [1000];
      const end = vocabulary === 'wpm' ? [1002] : [1001];
      expect(fixture.evaluated).toEqual([
        [
          ...begin,
          ...Array.from(Buffer.from('abcdefghij')).slice(0, 10 - begin.length - end.length),
          ...end,
        ],
      ]);
    }
  );

  it('恰好占满预算及短输入保持原字符串不变', async () => {
    const fixture = budgetModel(10, 'wpm');
    const p = await provider(fixture.model);
    await p.embed(['abcdefgh', '短'], 'passage');
    expect(fixture.seen).toEqual(['abcdefgh', '短']);
  });

  it('配置上限小于训练长度时仍遵守配置，边界输入不变', async () => {
    const fixture = budgetModel(8192);
    const p = await provider(fixture.model);
    await p.embed(['x'.repeat(512), 'x'.repeat(513)], 'passage');
    expect(fixture.seen[0]).toBe('x'.repeat(512));
    expect(fixture.evaluated.map((tokens) => tokens.length)).toEqual([512, 512]);
  });

  it('已包含首尾特殊 token 时不重复扣预算，截断仍保留结尾位置', async () => {
    const fixture = budgetModel(10, 'wpm');
    const exact = [1000, ...Array(8).fill(7), 1002] as Token[];
    const long = [1000, ...Array(9).fill(7), 1002] as Token[];
    fixture.tokenizer.mockImplementation((input) => (input === 'exact' ? exact : long));
    const p = await provider(fixture.model);
    await p.embed(['exact', 'long'], 'passage');
    expect(fixture.seen[0]).toBe('exact');
    expect(fixture.evaluated).toEqual([exact, exact]);
  });

  it('tokenizer 没有返回内容时不调用 embedding', async () => {
    const fixture = budgetModel(512);
    fixture.tokenizer.mockReturnValue([]);
    const p = await provider(fixture.model);
    await expect(p.embed(['ignored'], 'passage')).resolves.toEqual([null]);
    expect(fixture.seen).toEqual([]);
  });

  it('special token 耗尽上下文时不提交空内容向量', async () => {
    const fixture = budgetModel(2, 'wpm');
    const p = await provider(fixture.model);
    await expect(p.embed(['x'], 'passage')).resolves.toEqual([null]);
    expect(fixture.seen).toEqual([]);
  });
});

describe('createGgufEmbeddingProvider truncation warn', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('超长输入按预算截断，同一 provider 只 warn 一次，向量仍走 finalize', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fixture = budgetModel(10, 'wpm');
    const p = await provider(fixture.model);
    const long = 'x'.repeat(20);
    const [vec] = await p.embed([long, long], 'passage');

    const reservedEnd = 1;
    const sent = fixture.seen.filter((input): input is Token[] => Array.isArray(input));
    expect(sent).toHaveLength(2);
    for (const tokens of sent) {
      expect(tokens.length).toBeLessThanOrEqual(10 - reservedEnd);
    }
    expect(sent[0]).toEqual(Array.from(Buffer.from(long)).slice(0, 10 - 1 - reservedEnd));

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain(spec.id);
    expect(message).toContain(String(Buffer.from(long).length));
    expect(message).toContain(String(10 - 1 - reservedEnd));

    expect(vec).not.toBeNull();
    expect(vec?.length).toBe(512);
    let norm = 0;
    for (const x of vec as Float32Array) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  });

  it('正常长度不触发 warn，原文直接送给 getEmbeddingFor', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fixture = budgetModel(10, 'wpm');
    const p = await provider(fixture.model);
    await p.embed(['short'], 'passage');
    expect(fixture.seen).toEqual(['short']);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('createGgufEmbeddingProvider', () => {
  it('returns one L2-normalized vector per input', async () => {
    const p = await provider(fakeModel({}));
    const [vec] = await p.embed(['hello'], 'passage');
    expect(vec).not.toBeNull();
    let norm = 0;
    for (const x of vec as Float32Array) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  });

  it('normalizes vectors that arrive un-normalized from llama.cpp', async () => {
    // 实测 node-llama-cpp 返回原始模长（bge-small 约 9.0），不是单位向量。
    // 少了这步，余弦表会退化成点积，长文本天然得分更高。
    const p = await provider(fakeModel({ vectorFor: () => new Array(1024).fill(3) }));
    const [vec] = await p.embed(['hello'], 'passage');
    let norm = 0;
    for (const x of vec as Float32Array) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  });

  it('applies MRL truncation to the configured dim', async () => {
    const p = await provider(fakeModel({}));
    const [vec] = await p.embed(['hello'], 'passage');
    // 存库维度必须等于 spec.dim，否则写入时维度不匹配
    expect(vec?.length).toBe(512);
  });

  it('uses the full vector when truncateDim is null', async () => {
    const p = await provider(fakeModel({}), {
      gguf: { file: 'model.gguf', maxTokens: 512, truncateDim: null },
    });
    const [vec] = await p.embed(['hello'], 'passage');
    expect(vec?.length).toBe(1024);
  });

  it('adds the query prefix only for queries', async () => {
    const seen: string[] = [];
    const p = await provider(fakeModel({ seen }));
    await p.embed(['find me'], 'query');
    await p.embed(['store me'], 'passage');
    // Qwen3-Embedding 模型卡：只有查询侧加 instruction，写入侧不加
    expect(seen).toEqual(['Query: find me', 'store me']);
  });

  it('returns null for blank input without calling the model', async () => {
    const seen: string[] = [];
    const p = await provider(fakeModel({ seen }));
    const out = await p.embed(['', '   ', '\n'], 'passage');
    expect(out).toEqual([null, null, null]);
    expect(seen).toEqual([]);
  });

  it('keeps result positions aligned when some inputs are blank', async () => {
    const p = await provider(fakeModel({}));
    const out = await p.embed(['a', '', 'b'], 'passage');
    // 位置错位会把向量安到别的记忆上，且不会报错
    expect(out[0]).not.toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).not.toBeNull();
  });

  it('returns null for an all-zero vector instead of storing it', async () => {
    const p = await provider(fakeModel({ vectorFor: () => new Array(1024).fill(0) }));
    const [vec] = await p.embed(['hello'], 'passage');
    // 零向量归一化会产生 NaN，落库后污染检索
    expect(vec).toBeNull();
  });

  it('reuses one embedding context across calls', async () => {
    const model = fakeModel({});
    const p = await provider(model);
    await p.embed(['a'], 'passage');
    await p.embed(['b'], 'passage');
    expect(model.createEmbeddingContext).toHaveBeenCalledTimes(1);
  });

  it('disposes the context on close', async () => {
    const onDispose = vi.fn();
    const p = await provider(fakeModel({ onDispose }));
    await p.embed(['a'], 'passage');
    p.close?.();
    await vi.waitFor(() => expect(onDispose).toHaveBeenCalled());
  });

  it('rejects a spec without gguf settings', async () => {
    await expect(
      createGgufEmbeddingProvider(
        { ...spec, gguf: undefined },
        { modelDir: '/models/x', acquire: async () => fakeModel({}) }
      )
    ).rejects.toThrow(/gguf/i);
  });
});
