import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetLocalChatForTest,
  createLocalComplete,
  releaseLocalChatSlot,
} from '../../llama/chat';
import { __installLlamaForTest, __resetLlamaForTest, releaseAllModels } from '../../llama/runtime';
import { createEmbeddingProvider } from './provider';
import type { EmbeddingModelSpec, EmbeddingProvider } from './types';

const minute = 60_000;
const spec: EmbeddingModelSpec = {
  id: 'test:gguf',
  runtime: 'gguf',
  dim: 2,
  approxBytes: 0,
  sources: null,
  files: [],
  prefix: { query: '', passage: '' },
  gguf: { file: 'embed.gguf', maxTokens: 256, truncateDim: null },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fakeModel() {
  const context = {
    getEmbeddingFor: vi.fn(async () => ({ vector: [1, 0] })),
    dispose: vi.fn(async () => {}),
  };
  return {
    context,
    trainContextSize: 256,
    vocabularyType: 'bpe',
    tokens: {},
    tokenizer: () => [1],
    createEmbeddingContext: vi.fn(async () => context),
    createContext: vi.fn(),
    dispose: vi.fn(async () => {}),
  };
}
const providers: EmbeddingProvider[] = [];
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(async () => {
  await Promise.all(providers.splice(0).map((p) => p.close?.()));
  await releaseLocalChatSlot();
  await releaseAllModels();
  __resetLocalChatForTest();
  __resetLlamaForTest();
  vi.useRealTimers();
});
async function load(modelDir = '/models') {
  const p = (await createEmbeddingProvider(spec, { modelDir }))!;
  providers.push(p);
  return p;
}

describe('GGUF 空闲安全', () => {
  it('context 释放失败仍归还模型 owner，不把权重留在槽里', async () => {
    const m = fakeModel();
    m.context.dispose.mockRejectedValueOnce(new Error('dispose failed'));
    __installLlamaForTest({ loadModel: async () => m });
    const p = await load();
    providers.splice(providers.indexOf(p), 1);
    await expect(p.close?.()).rejects.toThrow('dispose failed');
    expect(m.dispose).toHaveBeenCalledOnce();
  });
  it('嵌入与生成独立计时，嵌入 context 和权重都释放且下次只重载一次', async () => {
    const embedding = fakeModel();
    const chat = fakeModel();
    const reloaded = fakeModel();
    const loadModel = vi
      .fn()
      .mockResolvedValueOnce(embedding)
      .mockResolvedValueOnce(chat)
      .mockResolvedValueOnce(reloaded);
    __installLlamaForTest({ loadModel });
    const p = await load();
    await p.embed(['first'], 'query');
    await vi.advanceTimersByTimeAsync(5 * minute);
    const complete = createLocalComplete('/chat.gguf', {
      createSession: async () => ({ prompt: async () => 'ok', dispose: () => {} }),
    });
    await complete('s', 'u');
    await vi.advanceTimersByTimeAsync(5 * minute);
    expect(embedding.context.dispose).toHaveBeenCalledOnce();
    expect(embedding.dispose).toHaveBeenCalledOnce();
    expect(chat.dispose).not.toHaveBeenCalled();
    await Promise.all([p.embed(['a'], 'passage'), p.embed(['b'], 'passage')]);
    expect(loadModel).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5 * minute);
    expect(chat.dispose).toHaveBeenCalledOnce();
    expect(reloaded.dispose).not.toHaveBeenCalled();
  });

  it('长推理和已排队请求期间不释放，关闭也等它们真正结束', async () => {
    const held = deferred<{ vector: number[] }>();
    const m = fakeModel();
    m.context.getEmbeddingFor.mockReturnValueOnce(held.promise);
    __installLlamaForTest({ loadModel: async () => m });
    const p = await load();
    const a = p.embed(['a'], 'passage');
    const b = p.embed(['b'], 'passage');
    await vi.advanceTimersByTimeAsync(30 * minute);
    expect(m.context.getEmbeddingFor).toHaveBeenCalledTimes(1);
    expect(m.dispose).not.toHaveBeenCalled();
    const close = p.close?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(m.context.dispose).not.toHaveBeenCalled();
    held.resolve({ vector: [1, 0] });
    await Promise.all([a, b, close]);
    expect(m.context.dispose).toHaveBeenCalledOnce();
    expect(m.dispose).toHaveBeenCalledOnce();
    await expect(p.embed(['stale'], 'passage')).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(30 * minute);
    expect(m.dispose).toHaveBeenCalledOnce();
  });

  it('换模型时旧请求不被新槽销毁，旧关闭不能释放新权重', async () => {
    const held = deferred<{ vector: number[] }>();
    const old = fakeModel();
    const next = fakeModel();
    old.context.getEmbeddingFor.mockReturnValueOnce(held.promise);
    __installLlamaForTest({
      loadModel: vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce(next),
    });
    const a = await load('/old');
    const pending = a.embed(['a'], 'passage');
    await vi.advanceTimersByTimeAsync(0);
    const close = a.close?.();
    const b = await load('/new');
    await b.embed(['b'], 'passage');
    expect(old.dispose).not.toHaveBeenCalled();
    held.resolve({ vector: [1, 0] });
    await Promise.all([pending, close]);
    expect(old.dispose).toHaveBeenCalledOnce();
    expect(next.dispose).not.toHaveBeenCalled();
  });

  it('释放未结束时的新请求等释放后再懒加载', async () => {
    const held = deferred<void>();
    const old = fakeModel();
    const next = fakeModel();
    old.context.dispose.mockReturnValueOnce(held.promise);
    const loadModel = vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce(next);
    __installLlamaForTest({ loadModel });
    const p = await load();
    await vi.advanceTimersByTimeAsync(10 * minute);
    const pending = p.embed(['next'], 'passage');
    await vi.advanceTimersByTimeAsync(0);
    expect(loadModel).toHaveBeenCalledTimes(1);
    held.resolve();
    expect(await pending).toEqual([new Float32Array([1, 0])]);
    expect(old.dispose).toHaveBeenCalledOnce();
    expect(loadModel).toHaveBeenCalledTimes(2);
  });
});
