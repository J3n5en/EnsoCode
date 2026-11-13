import type Database from 'better-sqlite3';
import { dropOrphanVecTables } from './db';
import { encodeEmbedding, vecDelete, vecInsert } from './store';
import type { Embedder } from './types';

export type ReembedStatus = 'pending' | 'running' | 'done' | 'cancelled';

export interface ReembedJob {
  id: number;
  /** 目标 embedding_model（注册表 id） */
  target: string;
  status: ReembedStatus;
  /** 已处理到的 memories.rowid（含）；重启后从这里续 */
  cursor: number;
  total: number;
  done: number;
  failed: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

const KIND = 'reembed';
const DEFAULT_BATCH = 32;
// 需要重嵌的行：最新版本、active、且向量不是目标模型的（含没向量的）。
// 与 applyRow 写回条件一致：已归档行算完也会被丢弃，选进来只会每次白算（远程嵌入重复计费）并计入失败
const PENDING_ROWS_WHERE = `is_latest = 1 AND lifecycle_state = 'active'
  AND (embedding_model IS NULL OR embedding_model != @target)`;

interface JobRow {
  id: number;
  target: string;
  status: ReembedStatus;
  cursor: number;
  total: number;
  done: number;
  failed: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const toJob = (r: JobRow): ReembedJob => ({
  id: r.id,
  target: r.target,
  status: r.status,
  cursor: r.cursor,
  total: r.total,
  done: r.done,
  failed: r.failed,
  error: r.error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** 当前活动（pending/running）的重嵌任务；没有则返回最近一条，供进度查询 */
export function getReembedJob(db: Database.Database): ReembedJob | null {
  const row = db
    .prepare(
      `SELECT * FROM memory_jobs WHERE kind = ?
       ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, id DESC LIMIT 1`
    )
    .get(KIND) as JobRow | undefined;
  return row ? toJob(row) : null;
}

/**
 * 幂等地为目标模型建任务：同目标的活动任务直接复用；其他目标的活动任务标 cancelled
 * （模型又切走了，继续跑只会产出很快又要重嵌的向量）。没有待处理行时不建任务。
 */
export function ensureReembedJob(db: Database.Database, target: string): ReembedJob | null {
  return db
    .transaction((): ReembedJob | null => {
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE memory_jobs SET status = 'cancelled', updated_at = ?
         WHERE kind = ? AND status IN ('pending','running') AND target != ?`
      ).run(now, KIND, target);
      const active = db
        .prepare(
          `SELECT * FROM memory_jobs WHERE kind = ? AND target = ? AND status IN ('pending','running')
           ORDER BY id DESC LIMIT 1`
        )
        .get(KIND, target) as JobRow | undefined;
      if (active) return toJob(active);
      const { n } = db
        .prepare(`SELECT count(*) AS n FROM memories WHERE ${PENDING_ROWS_WHERE}`)
        .get({ target }) as { n: number };
      if (n === 0) return null;
      const info = db
        .prepare(
          `INSERT INTO memory_jobs (kind, target, status, cursor, total, done, failed, created_at, updated_at)
           VALUES (?, ?, 'pending', 0, ?, 0, 0, ?, ?)`
        )
        .run(KIND, target, n, now, now);
      return toJob(
        db.prepare('SELECT * FROM memory_jobs WHERE id = ?').get(info.lastInsertRowid) as JobRow
      );
    })
    .immediate();
}

export interface RunReembedOptions {
  batchSize?: number;
  signal?: AbortSignal;
  onProgress?: (job: ReembedJob) => void;
}

/**
 * 跑当前 embedder 对应的重嵌任务直到完成或被 signal 打断。每行一个事务：重读正文确认没被改过再写，
 * 所以并发编辑 / 重复执行都不会写脏向量；被打断时状态回到 pending、cursor 保留，下次续跑。
 * 失败行推进 cursor（单行反复失败不能卡死整轮），但一轮结束后若仍有待处理行且本轮有进展，
 * 自动开下一轮（cursor=0）补齐；零进展则停下避免死循环，失败行留给下次触发（3b Major 2）。
 * 完成后清掉不再被任何最新行使用的旧维度 vec 表。
 */
export async function runReembedJob(
  db: Database.Database,
  embedder: Embedder,
  opts: RunReembedOptions = {}
): Promise<ReembedJob | null> {
  let job = ensureReembedJob(db, embedder.model);
  if (!job) {
    dropOrphanVecTables(db);
    return null;
  }
  for (;;) {
    const outcome = await runPass(db, embedder, job, opts);
    if (outcome.status !== 'done') return outcome;
    if (outcome.done === 0) return outcome;
    const next = ensureReembedJob(db, embedder.model);
    if (!next) return outcome;
    job = next;
  }
}

async function runPass(
  db: Database.Database,
  embedder: Embedder,
  job: ReembedJob,
  opts: RunReembedOptions
): Promise<ReembedJob> {
  const target = embedder.model;
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH);
  const setStatus = db.prepare(
    'UPDATE memory_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?'
  );
  const bump = db.prepare(
    `UPDATE memory_jobs SET cursor = ?, done = done + ?, failed = failed + ?, updated_at = ? WHERE id = ?`
  );
  const selectBatch = db.prepare(
    `SELECT rowid, semantic_field, space_id, embedding_dim FROM memories
     WHERE ${PENDING_ROWS_WHERE} AND rowid > @cursor ORDER BY rowid LIMIT @limit`
  );
  const reread = db.prepare(
    `SELECT semantic_field FROM memories
     WHERE rowid = ? AND is_latest = 1 AND lifecycle_state = 'active'`
  );
  const write = db.prepare(
    `UPDATE memories SET embedding = ?, embedding_model = ?, embedding_dim = ?, embedding_version = 1
     WHERE rowid = ?`
  );
  const applyRow = db.transaction(
    (
      rowid: number,
      field: string,
      spaceId: string,
      oldDim: number | null,
      vec: Float32Array
    ): boolean => {
      const cur = reread.get(rowid) as { semantic_field: string } | undefined;
      // 行在我们计算期间被删除 / 改写 / 退出最新版本 / 归档：放弃本次结果，改写后的行会在下一轮里被重新选中
      if (!cur || cur.semantic_field !== field) return false;
      vecDelete(db, rowid, oldDim);
      const blob = encodeEmbedding(vec);
      write.run(blob, target, vec.length, rowid);
      vecInsert(db, rowid, { blob, model: target, dim: vec.length }, spaceId);
      return true;
    }
  );

  const refresh = () =>
    toJob(db.prepare('SELECT * FROM memory_jobs WHERE id = ?').get(job.id) as JobRow);
  setStatus.run('running', null, new Date().toISOString(), job.id);
  try {
    for (;;) {
      if (opts.signal?.aborted) {
        setStatus.run('pending', null, new Date().toISOString(), job.id);
        return refresh();
      }
      // 任务可能被 ensureReembedJob（模型再次切换）标为 cancelled
      const current = refresh();
      if (current.status !== 'running') return current;
      const rows = selectBatch.all({ target, cursor: current.cursor, limit: batchSize }) as {
        rowid: number;
        semantic_field: string;
        space_id: string;
        embedding_dim: number | null;
      }[];
      if (rows.length === 0) break;
      for (const r of rows) {
        if (opts.signal?.aborted) break;
        let ok = false;
        try {
          const vec = await embedder.embed(r.semantic_field, 'passage');
          if (vec && vec.length > 0)
            ok = applyRow.immediate(r.rowid, r.semantic_field, r.space_id, r.embedding_dim, vec);
        } catch {
          ok = false;
        }
        bump.run(r.rowid, ok ? 1 : 0, ok ? 0 : 1, new Date().toISOString(), job.id);
      }
      opts.onProgress?.(refresh());
    }
    const finished = refresh();
    // 零进展的轮次把失败数记到 error，设置页能看到为什么停了
    const error =
      finished.failed > 0 && finished.done === 0 ? `${finished.failed} rows failed` : null;
    setStatus.run('done', error, new Date().toISOString(), job.id);
    dropOrphanVecTables(db);
    const done = refresh();
    opts.onProgress?.(done);
    return done;
  } catch (error) {
    setStatus.run(
      'pending',
      error instanceof Error ? error.message : String(error),
      new Date().toISOString(),
      job.id
    );
    return refresh();
  }
}
