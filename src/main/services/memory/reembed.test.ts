import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listVecTables, openMemoryDb, vecTableExists } from './db';
import { ensureReembedJob, getReembedJob, runReembedJob } from './reembed';
import { searchMemories } from './search';
import { createMemory, getMemory, updateMemory } from './store';
import type { Embedder } from './types';

let dir: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'enso-memory-reembed-'));
  db = openMemoryDb(path.join(dir, 'memory.db'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 旧模型 1 维；新模型 2 维且记录每次调用，可注入失败/中断 */
const oldModel: Embedder = { model: 'old', dim: 1, embed: async () => Float32Array.from([1]) };
function newModel(hooks: { onEmbed?: (text: string, n: number) => void } = {}) {
  const calls: string[] = [];
  const e: Embedder = {
    model: 'new',
    dim: 2,
    embed: async (text) => {
      calls.push(text);
      hooks.onEmbed?.(text, calls.length);
      return text.includes('near') ? Float32Array.from([1, 0]) : Float32Array.from([0, 1]);
    },
  };
  return { e, calls };
}

async function seed(n: number, embedder: Embedder | null = oldModel) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = await createMemory(
      db,
      // 正文带上模型名：同文本会被 content_hash 去重
      { content: `near note ${i} ${embedder?.model ?? 'none'}`, spaceId: 'global' },
      { embedder: embedder ?? undefined }
    );
    if (r.status !== 'inserted') throw new Error();
    ids.push(r.memory.id);
  }
  return ids;
}

const jobRows = () =>
  db.prepare('SELECT status, target, cursor, done, failed FROM memory_jobs ORDER BY id').all();

describe('ensureReembedJob', () => {
  it('没有待重嵌行时不建任务；有则建 pending 任务，重复调用复用同一条', async () => {
    expect(ensureReembedJob(db, 'old')).toBeNull();
    await seed(3);
    expect(ensureReembedJob(db, 'old')).toBeNull();
    const job = ensureReembedJob(db, 'new');
    expect(job).toMatchObject({ status: 'pending', target: 'new', total: 3, cursor: 0 });
    expect(ensureReembedJob(db, 'new')?.id).toBe(job?.id);
    expect(jobRows()).toHaveLength(1);
  });

  it('切到另一个目标模型时旧任务标 cancelled', async () => {
    await seed(2);
    const a = ensureReembedJob(db, 'new');
    const b = ensureReembedJob(db, 'newer');
    expect(a?.id).not.toBe(b?.id);
    expect(jobRows()).toEqual([
      expect.objectContaining({ target: 'new', status: 'cancelled' }),
      expect.objectContaining({ target: 'newer', status: 'pending' }),
    ]);
  });
});

describe('runReembedJob', () => {
  it('把旧模型/无向量的行重嵌到新维度表，完成后旧维度表被清理，新模型可召回', async () => {
    const ids = await seed(3);
    const noVec = (await seed(1, null))[0];
    expect(vecTableExists(db, 1)).toBe(true);
    const { e, calls } = newModel();
    const progress: number[] = [];
    const job = await runReembedJob(db, e, {
      batchSize: 2,
      onProgress: (j) => progress.push(j.done),
    });
    expect(job).toMatchObject({ status: 'done', total: 4, done: 4, failed: 0 });
    expect(calls).toHaveLength(4);
    expect(progress).toEqual([2, 4, 4]);
    for (const id of [...ids, noVec]) {
      expect(getMemory(db, id)).toMatchObject({ embeddingModel: 'new', embeddingDim: 2 });
    }
    expect(listVecTables(db).map((t) => t.dim)).toEqual([2]);
    // 查询词不在正文中：命中只能来自新模型的向量通道
    const hits = await searchMemories(db, { q: 'zzz near', spaceIds: ['global'], embedder: e });
    expect(hits.map((h) => h.memory.id).sort()).toEqual([...ids, noVec].sort());
    // 幂等：再跑一次没有待处理行，不新建任务、不再调用 embedder（上面 search 自己占一次 query 调用）
    const before = calls.length;
    expect(await runReembedJob(db, e)).toBeNull();
    expect(calls).toHaveLength(before);
    expect(jobRows()).toHaveLength(1);
  });

  it('中途 abort：状态回 pending、cursor 保留；续跑只处理剩余行；再跑为空操作', async () => {
    await seed(5);
    const ac = new AbortController();
    const first = newModel({ onEmbed: (_t, n) => n === 2 && ac.abort() });
    const interrupted = await runReembedJob(db, first.e, { batchSize: 2, signal: ac.signal });
    expect(interrupted).toMatchObject({ status: 'pending', done: 2, total: 5 });
    expect(interrupted!.cursor).toBeGreaterThan(0);
    expect(first.calls).toHaveLength(2);
    // 中断期间旧向量仍在：旧模型照样能搜到还没重嵌的行
    const oldHits = await searchMemories(db, {
      q: 'zzz',
      spaceIds: ['global'],
      embedder: oldModel,
    });
    expect(oldHits).toHaveLength(3);

    // 模拟进程重启：重开库后从 jobs 表续跑
    db.close();
    db = openMemoryDb(path.join(dir, 'memory.db'));
    expect(getReembedJob(db)).toMatchObject({ status: 'pending', done: 2 });
    const second = newModel();
    const resumed = await runReembedJob(db, second.e, { batchSize: 2 });
    expect(resumed).toMatchObject({ status: 'done', done: 5, failed: 0 });
    expect(second.calls).toHaveLength(3);
    expect(jobRows()).toHaveLength(1);
    expect(vecTableExists(db, 1)).toBe(false);
    expect(await runReembedJob(db, second.e)).toBeNull();
    expect(second.calls).toHaveLength(3);
  });

  it('embedder 失败 / 返回 null 的行计入 failed 并跳过，不阻塞其余行', async () => {
    const ids = await seed(3);
    let n = 0;
    const flaky: Embedder = {
      model: 'new',
      dim: 2,
      embed: async () => {
        n++;
        if (n === 1) throw new Error('boom');
        if (n === 2) return null;
        return Float32Array.from([1, 0]);
      },
    };
    const job = await runReembedJob(db, flaky, { batchSize: 10 });
    // 第一轮 1 成 2 失；有进展且仍有待处理行 → 自动开第二轮（cursor=0）把失败行补上（3b Major 2）
    expect(job).toMatchObject({ status: 'done', done: 2, failed: 0 });
    expect(jobRows()).toEqual([
      expect.objectContaining({ status: 'done', done: 1, failed: 2 }),
      expect.objectContaining({ status: 'done', done: 2, failed: 0 }),
    ]);
    for (const id of ids) expect(getMemory(db, id)?.embeddingModel).toBe('new');
    expect(vecTableExists(db, 1)).toBe(false);
  });

  it('一轮内零进展（全部失败）不死循环：标 done 带 error，失败行保持待处理，下次触发重建任务', async () => {
    const ids = await seed(2);
    const dead: Embedder = {
      model: 'new',
      dim: 2,
      embed: async () => {
        throw new Error('runtime gone');
      },
    };
    const job = await runReembedJob(db, dead, { batchSize: 10 });
    expect(job).toMatchObject({ status: 'done', done: 0, failed: 2 });
    expect(job?.error).toMatch(/2/);
    expect(jobRows()).toHaveLength(1);
    // 失败行仍是旧模型；旧维度表仍有最新行在用，不能删
    for (const id of ids) expect(getMemory(db, id)?.embeddingModel).toBe('old');
    expect(vecTableExists(db, 1)).toBe(true);
    // embedder 恢复后再触发：新任务从头补齐
    const { e } = newModel();
    expect(await runReembedJob(db, e)).toMatchObject({ status: 'done', done: 2, failed: 0 });
    expect(jobRows()).toHaveLength(2);
  });

  it('计算期间正文被改写的行不落脏向量', async () => {
    const [id] = await seed(1);
    const e: Embedder = {
      model: 'new',
      dim: 2,
      embed: async () => {
        updateMemory(db, id, { content: 'rewritten meanwhile' });
        return Float32Array.from([1, 0]);
      },
    };
    const job = await runReembedJob(db, e);
    expect(job).toMatchObject({ status: 'done', done: 0, failed: 1 });
    expect(getMemory(db, id)).toMatchObject({ embeddingModel: null, embeddingDim: null });
  });

  it('计算期间行退出最新版本 / 被归档：不写向量（3b Minor 3）', async () => {
    const [a, b] = await seed(2);
    const e: Embedder = {
      model: 'new',
      dim: 2,
      embed: async (text) => {
        if (text.includes('0')) updateMemory(db, a, { isLatest: false });
        else updateMemory(db, b, { lifecycleState: 'archived' });
        return Float32Array.from([1, 0]);
      },
    };
    const job = await runReembedJob(db, e, { batchSize: 10 });
    expect(job).toMatchObject({ done: 0, failed: 2 });
    expect(getMemory(db, a)?.embeddingModel).toBe('old');
    expect(getMemory(db, b)?.embeddingModel).toBe('old');
    // 从未写过新维度向量，新维度表都不会建
    expect(vecTableExists(db, 2)).toBe(false);
  });

  // 写回只认 active 行；选择时若不排除已归档行，每次触发都会白算一遍（远程嵌入重复计费）并一直报 N rows failed
  it('已归档的行不参与重嵌：不调用 embedder、不计失败，再次触发也不重复计算', async () => {
    const [, archived] = await seed(2);
    updateMemory(db, archived, { lifecycleState: 'archived' });
    const { e, calls } = newModel();
    const job = await runReembedJob(db, e, { batchSize: 10 });
    expect(job).toMatchObject({ status: 'done', done: 1, failed: 0, error: null });
    expect(await runReembedJob(db, e, { batchSize: 10 })).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('运行中被切换到其他目标（任务 cancelled）会停止', async () => {
    await seed(4);
    const { e, calls } = newModel({
      onEmbed: (_t, n) => {
        if (n === 1) ensureReembedJob(db, 'newer');
      },
    });
    const job = await runReembedJob(db, e, { batchSize: 1 });
    expect(job?.status).toBe('cancelled');
    expect(calls).toHaveLength(1);
  });
});
