import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeTinyModel2Vec } from './memory/embedding/model2vec.fixture';
import { embeddingModelDirName, resolveEmbeddingModelSpec } from './memory/embedding/registry';
import {
  awaitMemoryEmbeddingClose,
  awaitMemoryReembed,
  closeMemoryDb,
  configureMemoryEmbedding,
  getMemoryEmbeddingError,
  getMemoryReembedProgress,
  invokeMemory,
} from './memoryHost';

const env = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => env.userData } }));
const spec = resolveEmbeddingModelSpec('local:potion-multilingual-128M')!;

function installTinyModel(): void {
  const dir = path.join(env.userData, 'memory', 'models', embeddingModelDirName(spec));
  const vector = Array(256).fill(0);
  vector[0] = 1;
  writeTinyModel2Vec(dir, { tokens: ['redis'], rows: [vector] });
  writeFileSync(path.join(dir, '.ready'), '{}');
}

/** 经由 host 建库写入无向量的行后关库，模拟「库文件存在但本进程尚未打开」 */
async function seedClosedDb(content: string): Promise<number> {
  configureMemoryEmbedding({ modelId: 'none' });
  await invokeMemory('capture', { content, importance: 0.6, spaceId: 'global' }, null);
  await awaitMemoryReembed();
  const before = getMemoryReembedProgress()?.id ?? 0;
  closeMemoryDb();
  return before;
}

beforeEach(() => {
  env.userData = mkdtempSync(path.join(tmpdir(), 'enso-host-lazy-'));
});
afterEach(async () => {
  await awaitMemoryReembed();
  closeMemoryDb();
  await awaitMemoryEmbeddingClose();
  rmSync(env.userData, { recursive: true, force: true });
});

describe('库未打开时的后台重嵌', () => {
  it('库文件不存在：配置 embedding 不报错，也不为此建库', async () => {
    installTinyModel();
    configureMemoryEmbedding({ modelId: spec.id, autoDownload: false });
    await awaitMemoryReembed();
    expect(getMemoryEmbeddingError()).toBeNull();
    expect(existsSync(path.join(env.userData, 'memory', 'memory.db'))).toBe(false);
  });

  it('库文件存在但未打开：配置 embedding 不报错，首次开库时补跑重嵌', async () => {
    const before = await seedClosedDb('redis');
    installTinyModel();
    configureMemoryEmbedding({ modelId: spec.id, autoDownload: false });
    await awaitMemoryReembed();
    expect(getMemoryEmbeddingError()).toBeNull();
    expect(getMemoryReembedProgress()?.id ?? 0).toBe(before);

    await invokeMemory('capture', { content: 'redis', importance: 0.6, spaceId: 'global' }, null);
    await awaitMemoryReembed();
    const job = getMemoryReembedProgress();
    expect(job?.status).toBe('done');
    expect(job!.id).toBeGreaterThan(before);
    expect(getMemoryEmbeddingError()).toBeNull();
  });
});
