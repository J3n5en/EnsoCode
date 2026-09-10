import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetLocalChatForTest, createLocalComplete, releaseLocalChatSlot } from './chat';
import {
  __installLlamaForTest,
  __resetLlamaForTest,
  acquireModel,
  disposeLlamaRuntime,
  type LlamaModelLike,
  releaseAllModels,
  releaseModel,
} from './runtime';

vi.mock('node-llama-cpp', () => ({
  resolveChatWrapper: () => ({}),
  LlamaChatSession: class {
    async prompt() {
      return 'ok';
    }
    dispose() {}
  },
}));

const minute = 60_000;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function model(): LlamaModelLike {
  return {
    createContext: vi.fn(),
    createEmbeddingContext: vi.fn(),
    dispose: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(async () => {
  await releaseLocalChatSlot();
  await releaseAllModels();
  __resetLocalChatForTest();
  __resetLlamaForTest();
  vi.useRealTimers();
});

describe('本地生成空闲生命周期', () => {
  it('默认十分钟后释放权重，下次调用按同一路径懒加载', async () => {
    const first = model();
    const second = model();
    const loadModel = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    __installLlamaForTest({ loadModel });
    const complete = createLocalComplete('/chat.gguf', {
      createSession: async () => ({ prompt: async () => 'ok', dispose: () => {} }),
    });
    expect(await complete('s', 'a')).toBe('ok');
    await vi.advanceTimersByTimeAsync(10 * minute - 1);
    expect(first.dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(await complete('s', 'b')).toBe('ok');
    expect(loadModel).toHaveBeenCalledTimes(2);
  });

  it('生成先释放 KV context 再释放权重，再次加载使用全新 context', async () => {
    const events: string[] = [];
    const first = model();
    const second = model();
    const context = () => ({
      getSequence: () => ({ clearHistory: async () => {} }),
      dispose: vi.fn(async () => {
        events.push('context');
      }),
    });
    first.createContext = vi.fn(async () => context());
    second.createContext = vi.fn(async () => context());
    first.dispose = vi.fn(async () => {
      events.push('model');
    });
    __installLlamaForTest({
      loadModel: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
    });
    const complete = createLocalComplete('/chat.gguf');
    await complete('s', 'a');
    await vi.advanceTimersByTimeAsync(10 * minute);
    expect(events).toEqual(['context', 'model']);
    await complete('s', 'b');
    expect(second.createContext).toHaveBeenCalledOnce();
  });

  it('调用者超时不释放仍在推理的 session，不让排队任务重叠', async () => {
    const held = deferred<string>();
    const first = model();
    __installLlamaForTest({ loadModel: async () => first });
    const dispose = vi.fn();
    const prompt = vi.fn().mockReturnValueOnce(held.promise).mockResolvedValue('second');
    const complete = createLocalComplete('/chat.gguf', {
      timeoutMs: 10,
      createSession: async () => ({ prompt, dispose }),
    });
    const result = complete('s', 'a').catch(() => 'timeout');
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toBe('timeout');
    const next = complete('s', 'b');
    await vi.advanceTimersByTimeAsync(30 * minute);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
    expect(first.dispose).not.toHaveBeenCalled();
    held.resolve('late');
    expect(await next).toBe('second');
    await vi.advanceTimersByTimeAsync(10 * minute);
    expect(first.dispose).toHaveBeenCalledOnce();
  });

  it('显式关闭等待底层推理结束', async () => {
    const held = deferred<string>();
    const first = model();
    __installLlamaForTest({ loadModel: async () => first });
    const complete = createLocalComplete('/chat.gguf', {
      createSession: async () => ({ prompt: () => held.promise, dispose: () => {} }),
    });
    const run = complete('s', 'a');
    await vi.advanceTimersByTimeAsync(0);
    const closing = releaseLocalChatSlot();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.dispose).not.toHaveBeenCalled();
    held.resolve('done');
    await Promise.all([run, closing]);
    expect(first.dispose).toHaveBeenCalledOnce();
  });
});

describe('模型槽并发', () => {
  it('关闭覆盖排队中才启动的 Llama 初始化，关闭后不再接新加载', async () => {
    const m = model();
    const llama = { loadModel: async () => m, dispose: vi.fn(async () => {}) };
    const loading = acquireModel('chat', '/chat.gguf', {
      loadLlamaImpl: async () => {
        __installLlamaForTest(llama);
        return llama;
      },
    });
    const closing = disposeLlamaRuntime();
    await Promise.all([loading, closing]);
    expect(m.dispose).toHaveBeenCalledOnce();
    expect(llama.dispose).toHaveBeenCalledOnce();
    await expect(
      acquireModel('chat', '/later.gguf', { loadLlamaImpl: async () => llama })
    ).rejects.toThrow();
  });

  it('关闭运行时等待仍持有 context 的模型 owner 释放', async () => {
    const m = model();
    const llama = { loadModel: async () => m, dispose: vi.fn(async () => {}) };
    __installLlamaForTest(llama);
    await acquireModel('embedding', '/embed.gguf', { retain: true });
    const closing = disposeLlamaRuntime();
    await vi.advanceTimersByTimeAsync(0);
    expect(llama.dispose).not.toHaveBeenCalled();
    await releaseModel('embedding', m);
    await closing;
    expect(m.dispose).toHaveBeenCalledOnce();
    expect(llama.dispose).toHaveBeenCalledOnce();
  });
  it('同槽同时加载只加载一份权重', async () => {
    const held = deferred<LlamaModelLike>();
    const loadModel = vi.fn(() => held.promise);
    __installLlamaForTest({ loadModel });
    const a = acquireModel('embedding', '/embed.gguf');
    const b = acquireModel('embedding', '/embed.gguf');
    await vi.advanceTimersByTimeAsync(0);
    held.resolve(model());
    expect(await a).toBe(await b);
    expect(loadModel).toHaveBeenCalledOnce();
  });

  it('加载中释放会等待权重到达并释放它', async () => {
    const held = deferred<LlamaModelLike>();
    const first = model();
    __installLlamaForTest({ loadModel: () => held.promise });
    const loading = acquireModel('embedding', '/embed.gguf');
    await vi.advanceTimersByTimeAsync(0);
    const closing = releaseModel('embedding');
    held.resolve(first);
    await Promise.all([loading, closing]);
    expect(first.dispose).toHaveBeenCalledOnce();
  });
});
