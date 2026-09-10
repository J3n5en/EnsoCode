import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetLocalChatForTest, createLocalComplete, releaseLocalChatSlot } from './llama/chat';
import { __installLlamaForTest, __resetLlamaForTest } from './llama/runtime';
import * as downloads from './memory/embedding/downloader';
import { Model2VecModel } from './memory/embedding/model2vec';
import { writeTinyModel2Vec } from './memory/embedding/model2vec.fixture';
import * as providers from './memory/embedding/provider';
import { embeddingModelDirName, resolveEmbeddingModelSpec } from './memory/embedding/registry';
import {
  awaitMemoryEmbeddingClose,
  awaitMemoryReembed,
  closeMemoryDb,
  configureMemoryEmbedding,
  getMemoryEmbedder,
  memoryDatabase,
  syncMemoryEmbeddingFromSettings,
} from './memoryHost';

const env = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => env.userData } }));
const minute = 60_000;
const spec = resolveEmbeddingModelSpec('local:potion-multilingual-128M')!;
const settings = { memoryEmbeddingModel: spec.id, memoryEmbeddingAutoDownload: true };
beforeEach(() => {
  vi.useFakeTimers();
  env.userData = mkdtempSync(path.join(tmpdir(), 'enso-host-idle-'));
  const dir = path.join(env.userData, 'memory', 'models', embeddingModelDirName(spec));
  mkdirSync(dir, { recursive: true });
  const vector = Array(256).fill(0);
  vector[0] = 1;
  writeTinyModel2Vec(dir, { tokens: ['hello'], rows: [vector] });
  writeFileSync(path.join(dir, '.ready'), '{}');
});
afterEach(async () => {
  await awaitMemoryReembed();
  closeMemoryDb();
  await awaitMemoryEmbeddingClose();
  await releaseLocalChatSlot();
  __resetLocalChatForTest();
  __resetLlamaForTest();
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(env.userData, { recursive: true, force: true });
});

describe('空闲设置 Main 接线', () => {
  it('当前关闭失败仍等待此前未完成的资源关闭屏障', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const first = { spec, embed: vi.fn(), close: () => pending };
    const second = {
      spec,
      embed: vi.fn(),
      close: async () => {
        throw new Error('close failed');
      },
    };
    vi.spyOn(providers, 'createEmbeddingProvider')
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    vi.spyOn(downloads, 'isModelReady').mockReturnValue(true);
    configureMemoryEmbedding({ modelId: spec.id });
    await getMemoryEmbedder();
    configureMemoryEmbedding({ modelId: 'local:qwen3-0.6b-gguf' });
    await getMemoryEmbedder();
    closeMemoryDb();
    let closed = false;
    const closing = awaitMemoryEmbeddingClose().then(() => {
      closed = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(closed).toBe(false);
    } finally {
      finish();
      await closing;
    }
    expect(closed).toBe(true);
  });
  it.each([5, 10, 30, 0, undefined, -1, 3, '5', NaN, Infinity])(
    '时限 %s 同步本地嵌入与生成，非法值默认十分钟',
    async (value) => {
      const close = vi.spyOn(Model2VecModel.prototype, 'close');
      const chatModel = {
        createContext: vi.fn(),
        createEmbeddingContext: vi.fn(),
        dispose: vi.fn(async () => {}),
      };
      __installLlamaForTest({ loadModel: async () => chatModel });
      syncMemoryEmbeddingFromSettings({ ...settings, memoryModelIdleMinutes: value });
      const e = await getMemoryEmbedder();
      await e!.embed('hello', 'passage');
      const complete = createLocalComplete('/chat.gguf', {
        createSession: async () => ({ prompt: async () => 'ok', dispose: () => {} }),
      });
      await complete('s', 'u');
      const minutes = value === 0 ? 60 : value === 5 || value === 30 ? value : 10;
      await vi.advanceTimersByTimeAsync(minutes * minute - 1);
      expect(close).not.toHaveBeenCalled();
      expect(chatModel.dispose).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(close).toHaveBeenCalledTimes(value === 0 ? 0 : 1);
      expect(chatModel.dispose).toHaveBeenCalledTimes(value === 0 ? 0 : 1);
    }
  );

  it('永不卸载时切到远程生成仍释放旧本地权重，无关设置不触发释放', async () => {
    const chatModel = {
      createContext: vi.fn(),
      createEmbeddingContext: vi.fn(),
      dispose: vi.fn(async () => {}),
    };
    __installLlamaForTest({ loadModel: async () => chatModel });
    const local = { ...settings, memoryChatModel: 'local:gemma-4-e2b', memoryModelIdleMinutes: 0 };
    syncMemoryEmbeddingFromSettings(local);
    const complete = createLocalComplete('/chat.gguf', {
      createSession: async () => ({ prompt: async () => 'ok', dispose: () => {} }),
    });
    await complete('s', 'u');
    syncMemoryEmbeddingFromSettings({ ...local, theme: 'dark' });
    await vi.advanceTimersByTimeAsync(0);
    expect(chatModel.dispose).not.toHaveBeenCalled();
    syncMemoryEmbeddingFromSettings({ ...local, memoryChatModel: 'remote' });
    await vi.advanceTimersByTimeAsync(0);
    expect(chatModel.dispose).toHaveBeenCalledOnce();
  });

  it('只改时限保留缓存和重嵌记录，卸载及再次使用不重下载或重嵌', async () => {
    const load = vi.spyOn(Model2VecModel, 'load');
    const close = vi.spyOn(Model2VecModel.prototype, 'close');
    const download = vi.spyOn(downloads, 'downloadModel');
    syncMemoryEmbeddingFromSettings({ ...settings, memoryModelIdleMinutes: 30 });
    const db = memoryDatabase();
    const e = await getMemoryEmbedder();
    await e!.embed('hello', 'passage');
    await awaitMemoryReembed();
    const jobs = db.prepare('SELECT * FROM memory_jobs').all();
    await vi.advanceTimersByTimeAsync(6 * minute);
    syncMemoryEmbeddingFromSettings({ ...settings, memoryModelIdleMinutes: 0 });
    await vi.advanceTimersByTimeAsync(30 * minute);
    expect(close).not.toHaveBeenCalled();
    expect(await getMemoryEmbedder()).toBe(e);
    syncMemoryEmbeddingFromSettings({ ...settings, memoryModelIdleMinutes: 5 });
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
    expect(await getMemoryEmbedder()).toBe(e);
    await e!.embed('hello', 'passage');
    expect(load).toHaveBeenCalledTimes(2);
    expect(download).not.toHaveBeenCalled();
    expect(db.prepare('SELECT * FROM memory_jobs').all()).toEqual(jobs);
  });
});
