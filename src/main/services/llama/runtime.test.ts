import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __installLlamaForTest,
  __resetLlamaForTest,
  acquireModel,
  disposeLlamaRuntime,
  type LlamaLike,
  type LlamaModelLike,
  llamaRuntimeActive,
  releaseAllModels,
  releaseModel,
} from './runtime';

function fakeModel(): LlamaModelLike & { disposed: boolean } {
  const model = {
    disposed: false,
    createEmbeddingContext: vi.fn(),
    createContext: vi.fn(),
    dispose: vi.fn(async () => {
      model.disposed = true;
    }),
  };
  return model as unknown as LlamaModelLike & { disposed: boolean };
}

function fakeLlama(): {
  llama: LlamaLike;
  loaded: string[];
  models: ReturnType<typeof fakeModel>[];
} {
  const loaded: string[] = [];
  const models: ReturnType<typeof fakeModel>[] = [];
  const llama: LlamaLike = {
    loadModel: vi.fn(async ({ modelPath }) => {
      loaded.push(modelPath);
      const m = fakeModel();
      models.push(m);
      return m;
    }),
  };
  return { llama, loaded, models };
}

afterEach(async () => {
  await releaseAllModels();
  __resetLlamaForTest();
});

describe('acquireModel', () => {
  it('loads a model once and reuses it for the same path', async () => {
    const { llama, loaded } = fakeLlama();
    const impl = async () => llama;
    const a = await acquireModel('embedding', '/m/a.gguf', { loadLlamaImpl: impl });
    const b = await acquireModel('embedding', '/m/a.gguf', { loadLlamaImpl: impl });
    // 加载一份 0.6B 权重要数百毫秒，重复加载既慢又多占一份显存
    expect(a).toBe(b);
    expect(loaded).toEqual(['/m/a.gguf']);
  });

  it('disposes the old model when the path changes', async () => {
    const { llama, models } = fakeLlama();
    const impl = async () => llama;
    await acquireModel('embedding', '/m/a.gguf', { loadLlamaImpl: impl });
    await acquireModel('embedding', '/m/b.gguf', { loadLlamaImpl: impl });
    // 换模型不释放旧的会让两份权重同时驻留显存
    expect(models[0].disposed).toBe(true);
    expect(models[1].disposed).toBe(false);
  });

  it('keeps embedding and chat in separate slots', async () => {
    const { llama, models } = fakeLlama();
    const impl = async () => llama;
    await acquireModel('embedding', '/m/embed.gguf', { loadLlamaImpl: impl });
    await acquireModel('chat', '/m/chat.gguf', { loadLlamaImpl: impl });
    // 两种用途各占一个槽，互不驱逐
    expect(models[0].disposed).toBe(false);
    expect(models[1].disposed).toBe(false);
  });

  it('reloads after the slot was released', async () => {
    const { llama, loaded } = fakeLlama();
    const impl = async () => llama;
    await acquireModel('chat', '/m/a.gguf', { loadLlamaImpl: impl });
    await releaseModel('chat');
    await acquireModel('chat', '/m/a.gguf', { loadLlamaImpl: impl });
    expect(loaded).toEqual(['/m/a.gguf', '/m/a.gguf']);
  });

  it('survives a model that throws while disposing', async () => {
    const llama: LlamaLike = {
      loadModel: vi.fn(async () => ({
        createEmbeddingContext: vi.fn(),
        createContext: vi.fn(),
        dispose: vi.fn(async () => {
          throw new Error('gpu busy');
        }),
      })),
    };
    const impl = async () => llama;
    await acquireModel('chat', '/m/a.gguf', { loadLlamaImpl: impl });
    // 释放失败不能卡住切换：用户改模型时不该因为旧模型没退干净而卡死
    await expect(acquireModel('chat', '/m/b.gguf', { loadLlamaImpl: impl })).resolves.toBeDefined();
  });

  it('does not cache a failed load', async () => {
    let attempt = 0;
    const llama: LlamaLike = {
      loadModel: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('corrupt gguf');
        return {
          createEmbeddingContext: vi.fn(),
          createContext: vi.fn(),
          dispose: vi.fn(async () => {}),
        };
      }),
    };
    const impl = async () => llama;
    await expect(acquireModel('chat', '/m/a.gguf', { loadLlamaImpl: impl })).rejects.toThrow(
      'corrupt gguf'
    );
    // 第一次失败后槽位必须是空的，否则重试会拿到半个状态
    await expect(acquireModel('chat', '/m/a.gguf', { loadLlamaImpl: impl })).resolves.toBeDefined();
  });
});

describe('disposeLlamaRuntime', () => {
  it('is inactive until a model or llama instance exists', () => {
    expect(llamaRuntimeActive()).toBe(false);
  });

  it('disposes slotted models and the llama instance before going idle', async () => {
    const { llama, models } = fakeLlama();
    llama.dispose = vi.fn(async () => {});
    __installLlamaForTest(llama);
    await acquireModel('embedding', '/m/a.gguf', { loadLlamaImpl: async () => llama });
    expect(llamaRuntimeActive()).toBe(true);

    await disposeLlamaRuntime();

    expect(models[0].disposed).toBe(true);
    expect(llama.dispose).toHaveBeenCalledOnce();
    expect(llamaRuntimeActive()).toBe(false);
  });

  it('still finishes quit teardown if llama.dispose throws', async () => {
    const llama: LlamaLike = {
      loadModel: vi.fn(),
      dispose: vi.fn(async () => {
        throw new Error('metal teardown');
      }),
    };
    __installLlamaForTest(llama);
    await expect(disposeLlamaRuntime()).resolves.toBeUndefined();
    expect(llamaRuntimeActive()).toBe(false);
  });
});
