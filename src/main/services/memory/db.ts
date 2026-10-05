import fs from 'node:fs';
import path from 'node:path';
import { UNIT_TYPES } from '@shared/memory/constants';
import Database from 'better-sqlite3';
import { getLoadablePath } from 'sqlite-vec';
import { contentHash } from './contentHash';

export const MEMORY_SCHEMA_VERSION = 9;

/** 已知最大的 embedding 维度是 qwen3-8b 的 4096；留 4 倍余量，再大视为脏数据 */
export const MAX_EMBEDDING_DIM = 16_384;

export interface OpenMemoryDbOptions {
  /** sqlite-vec 扩展路径；`null` 明确不加载（测试降级路径）。缺省取 sqlite-vec 自带的平台二进制。 */
  vecExtensionPath?: string | null;
}

// 扩展是否加载成功按连接记录：失败只降级向量通道，不影响 FTS 与落库
const vecReady = new WeakMap<Database.Database, boolean>();

export function hasVec(db: Database.Database): boolean {
  return vecReady.get(db) === true;
}

/** 表名拼接前必须校验维度，禁止外部值直接进 SQL */
export function vecTableName(dim: number): string {
  if (!Number.isSafeInteger(dim) || dim <= 0 || dim > MAX_EMBEDDING_DIM) {
    throw new Error(`invalid vector dimension: ${dim}`);
  }
  return `memory_vec_${dim}`;
}

/**
 * 一个维度一张 vec0 表，多模型共存。`model` / `space_id` 做 partition key：KNN 在 vec 层就按
 * 模型与 space 分区，避免 global 记忆占满 top-k 后 JOIN 过滤把项目内命中挤光（3a 评审 Major 4）。
 * 表内只索引 is_latest = 1 的行，历史版本不进 KNN 名额。
 */
export function ensureVecTable(db: Database.Database, dim: number): string {
  const table = vecTableName(dim);
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${table}
     USING vec0(embedding float[${dim}] distance_metric=cosine,
                model text partition key, space_id text partition key)`
  );
  return table;
}

export function listVecTables(db: Database.Database): { name: string; dim: number }[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'memory_vec_%'")
    .all() as { name: string }[];
  return rows
    .map((r) => ({ name: r.name, dim: Number(r.name.slice('memory_vec_'.length)) }))
    .filter((r) => Number.isSafeInteger(r.dim) && r.dim > 0);
}

/** 没有任何 is_latest 行仍使用该维度时整表删除（滚动重嵌完成后清理旧模型的索引） */
export function dropOrphanVecTables(db: Database.Database): string[] {
  const dropped: string[] = [];
  for (const t of listVecTables(db)) {
    const used = db
      .prepare(
        'SELECT 1 FROM memories WHERE embedding IS NOT NULL AND embedding_dim = ? AND is_latest = 1 LIMIT 1'
      )
      .get(t.dim);
    if (used) continue;
    db.exec(`DROP TABLE IF EXISTS ${vecTableName(t.dim)}`);
    dropped.push(t.name);
  }
  return dropped;
}

export function vecTableExists(db: Database.Database, dim: number): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(vecTableName(dim))
  );
}

/**
 * memories.embedding（BLOB）是权威副本，vec 表只是可重建索引：把尚未入索引的行补进对应维度表。
 * 可重入，每次打开都跑，扩展首次不可用、后来可用时自动补齐。
 */
export function syncVecTables(db: Database.Database): void {
  if (!hasVec(db)) return;
  const dims = db
    .prepare(
      'SELECT DISTINCT embedding_dim AS dim FROM memories WHERE embedding IS NOT NULL AND embedding_dim IS NOT NULL'
    )
    .all() as { dim: number }[];
  for (const { dim } of dims) {
    const table = ensureVecTable(db, dim);
    const rows = db
      .prepare(
        `SELECT m.rowid AS rowid, m.embedding AS embedding, m.embedding_model AS model,
                m.space_id AS space_id
         FROM memories m
         WHERE m.embedding IS NOT NULL AND m.embedding_dim = ? AND m.is_latest = 1
           AND m.rowid NOT IN (SELECT rowid FROM ${table})`
      )
      .all(dim) as { rowid: number; embedding: Buffer; model: string | null; space_id: string }[];
    const insert = db.prepare(
      `INSERT INTO ${table}(rowid, embedding, model, space_id) VALUES (?, ?, ?, ?)`
    );
    for (const r of rows) insert.run(BigInt(r.rowid), r.embedding, r.model ?? '', r.space_id);
  }
  // 孤儿：基表行已删除 / 换了模型维度 / 不再是最新版本；留着会白占 KNN 名额
  for (const t of listVecTables(db)) {
    db.exec(
      `DELETE FROM ${vecTableName(t.dim)} WHERE rowid NOT IN (
         SELECT rowid FROM memories
         WHERE embedding IS NOT NULL AND embedding_dim = ${t.dim} AND is_latest = 1)`
    );
  }
}

const UNIT_TYPE_CHECK = UNIT_TYPES.map((t) => `'${t}'`).join(',');

// Schema 含 unit_type_source、embedding_* 元数据、
// idempotency_key（幂等）、decay_score_cached（缺省 1.0）。
// FTS5 用 trigram：unicode61 不切中文（实测「主库」「读写分离」零命中），trigram 对 ≥3 字子串直接命中，
// <3 字查询由 search.ts 回退 LIKE。external-content 表必须配三只触发器，否则搜索空/脏。
const MIGRATIONS: (string | ((db: Database.Database) => void))[] = [
  `
  CREATE TABLE memories (
    id                 TEXT PRIMARY KEY,
    title              TEXT NOT NULL,
    content            TEXT NOT NULL,
    semantic_field     TEXT NOT NULL,
    unit_type          TEXT NOT NULL DEFAULT 'fact' CHECK (unit_type IN (${UNIT_TYPE_CHECK})),
    unit_type_source   TEXT NOT NULL DEFAULT 'default',
    importance         REAL NOT NULL DEFAULT 0.5,
    confidence         REAL NOT NULL DEFAULT 0.6,
    space_id           TEXT NOT NULL DEFAULT 'global',
    source             TEXT NOT NULL DEFAULT 'manual',
    is_latest          INTEGER NOT NULL DEFAULT 1,
    version            INTEGER NOT NULL DEFAULT 1,
    is_crystal         INTEGER NOT NULL DEFAULT 0,
    lifecycle_state    TEXT NOT NULL DEFAULT 'active',
    temporal_context   TEXT NOT NULL DEFAULT 'timeless',
    temporal_type      TEXT,
    event_start        TEXT,
    event_end          TEXT,
    temporal_precision TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    last_accessed_at   TEXT,
    access_count       INTEGER NOT NULL DEFAULT 0,
    appearances        INTEGER NOT NULL DEFAULT 0,
    clicks             INTEGER NOT NULL DEFAULT 0,
    decay_score_cached REAL NOT NULL DEFAULT 1.0,
    embedding          BLOB,
    embedding_model    TEXT,
    embedding_dim      INTEGER,
    embedding_version  INTEGER,
    idempotency_key    TEXT UNIQUE
  );
  CREATE INDEX memories_space_latest ON memories (space_id, is_latest, lifecycle_state);
  CREATE INDEX memories_embedding_model ON memories (embedding_model) WHERE embedding IS NOT NULL;

  CREATE VIRTUAL TABLE memories_fts USING fts5(
    title, content, semantic_field,
    content='memories', content_rowid='rowid',
    tokenize='trigram'
  );
  CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, title, content, semantic_field)
    VALUES (new.rowid, new.title, new.content, new.semantic_field);
  END;
  CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, content, semantic_field)
    VALUES ('delete', old.rowid, old.title, old.content, old.semantic_field);
  END;
  CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, content, semantic_field)
    VALUES ('delete', old.rowid, old.title, old.content, old.semantic_field);
    INSERT INTO memories_fts(rowid, title, content, semantic_field)
    VALUES (new.rowid, new.title, new.content, new.semantic_field);
  END;
  `,
  // v2：向量索引迁入 sqlite-vec。基表不变，历史 BLOB 由 syncVecTables 搬入按维度分的虚拟表
  syncVecTables,
  // v3：vec 表加 space_id partition key（vec0 不能 ALTER，整表重建，BLOB 是权威副本所以无损）；
  // 后台任务用持久化 jobs 表，进程重启后可续跑
  (db) => {
    for (const t of listVecTables(db)) db.exec(`DROP TABLE IF EXISTS ${vecTableName(t.dim)}`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_jobs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        kind       TEXT NOT NULL,
        target     TEXT NOT NULL,
        status     TEXT NOT NULL CHECK (status IN ('pending','running','done','cancelled')),
        cursor     INTEGER NOT NULL DEFAULT 0,
        total      INTEGER NOT NULL DEFAULT 0,
        done       INTEGER NOT NULL DEFAULT 0,
        failed     INTEGER NOT NULL DEFAULT 0,
        error      TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_jobs_kind_status ON memory_jobs (kind, status);
    `);
    syncVecTables(db);
  },
  // v4：content_hash 精确去重 + evolves 版本关系
  (db) => {
    // 测试会把 user_version 回拨到旧版重跑迁移，列与表都按幂等建
    const cols = db.prepare('PRAGMA table_info(memories)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'content_hash')) {
      db.exec('ALTER TABLE memories ADD COLUMN content_hash TEXT');
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS memories_content_hash ON memories (space_id, content_hash);
      CREATE TABLE IF NOT EXISTS evolves (
        id               TEXT PRIMARY KEY,
        older_id         TEXT NOT NULL REFERENCES memories(id),
        newer_id         TEXT NOT NULL REFERENCES memories(id),
        content_relation TEXT NOT NULL CHECK (content_relation IN ('replaces','enriches','confirms','challenges')),
        confidence       REAL NOT NULL,
        reason           TEXT,
        review_state     TEXT NOT NULL DEFAULT 'pending' CHECK (review_state IN ('pending','accepted','rejected')),
        reviewed_at      TEXT,
        created_at       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS evolves_older ON evolves (older_id);
      CREATE INDEX IF NOT EXISTS evolves_newer ON evolves (newer_id);
    `);
    // 旧行的 content_hash 回填不在这里做：大表逐行 UPDATE 会把迁移的 BEGIN IMMEDIATE 拉很长，
    // 改由 openMemoryDb 在迁移之后分批小事务补齐（backfillContentHash）
  },
  // v5：蒸馏任务要在重启后续跑，需要记会话文件 / 项目等上下文；jobs 表加 payload JSON 列
  (db) => {
    const cols = db.prepare('PRAGMA table_info(memory_jobs)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'payload')) {
      db.exec('ALTER TABLE memory_jobs ADD COLUMN payload TEXT');
    }
  },
  // v6：蒸馏丢弃原因（candidates_found / importance 不足）要能被设置页结构化查询，不能只埋在 error 文本里
  (db) => {
    const cols = db.prepare('PRAGMA table_info(memory_jobs)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'notes')) {
      db.exec('ALTER TABLE memory_jobs ADD COLUMN notes TEXT');
    }
  },
  // v7：实体层。字段语义对应 Entity 节点 + MENTIONS / RELATES_TO 边，
  // 用 SQLite 关系表表达（不引入图数据库）。aliases 拆表便于索引。
  // 去重键 normalized_name（entityNormalize.ts），按 space 唯一
  `
  CREATE TABLE IF NOT EXISTS entities (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    entity_type     TEXT NOT NULL,
    description     TEXT,
    confidence      REAL NOT NULL DEFAULT 0.5,
    space_id        TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE (space_id, normalized_name)
  );
  CREATE TABLE IF NOT EXISTS entity_aliases (
    entity_id        TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    alias            TEXT NOT NULL,
    normalized_alias TEXT NOT NULL,
    PRIMARY KEY (entity_id, alias)
  );
  CREATE INDEX IF NOT EXISTS entity_aliases_normalized ON entity_aliases (normalized_alias);
  CREATE TABLE IF NOT EXISTS mentions (
    memory_id     TEXT NOT NULL REFERENCES memories(id),
    entity_id     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    confidence    REAL NOT NULL DEFAULT 0.5,
    mention_count INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL,
    PRIMARY KEY (memory_id, entity_id)
  );
  CREATE INDEX IF NOT EXISTS mentions_entity ON mentions (entity_id);
  CREATE TABLE IF NOT EXISTS entity_relations (
    id            TEXT PRIMARY KEY,
    source_id     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    target_id     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL,
    strength      REAL NOT NULL DEFAULT 0.5,
    created_at    TEXT NOT NULL,
    UNIQUE (source_id, target_id, relation_type)
  );
  CREATE INDEX IF NOT EXISTS entity_relations_source ON entity_relations (source_id);
  CREATE INDEX IF NOT EXISTS entity_relations_target ON entity_relations (target_id);
  `,
  // v8：Crystal 不是独立节点，是 is_crystal 标位 + CRYSTALLIZED_FROM 边。
  (db) => {
    const cols = db.prepare('PRAGMA table_info(memories)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'crystal_title')) {
      db.exec('ALTER TABLE memories ADD COLUMN crystal_title TEXT');
    }
    if (!cols.some((c) => c.name === 'source_unit_count')) {
      db.exec('ALTER TABLE memories ADD COLUMN source_unit_count INTEGER NOT NULL DEFAULT 0');
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS crystallized_from (
        crystal_id          TEXT NOT NULL REFERENCES memories(id),
        source_id           TEXT NOT NULL REFERENCES memories(id),
        contribution_weight REAL NOT NULL DEFAULT 1.0,
        created_at          TEXT NOT NULL,
        PRIMARY KEY (crystal_id, source_id)
      );
      CREATE INDEX IF NOT EXISTS crystallized_from_source ON crystallized_from (source_id);
    `);
  },
  // v9：Bot 会话写 project / global 的待审批队列；批准前不进 memories
  `
  CREATE TABLE IF NOT EXISTS pending_writes (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    space_id   TEXT NOT NULL,
    title      TEXT,
    content    TEXT NOT NULL,
    payload    TEXT NOT NULL,
    bot_id     TEXT,
    chat_id    TEXT,
    redacted   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  `,
];

/**
 * 可重入的孤儿清理：mentions 指向已删除 / 不存在的记忆 → 删；没有任何 mention 的实体只可能来自失效抽取 → 删
 * 及其别名 / 关系。连接未开 foreign_keys（不想让既有表的行为随之改变），级联在这里显式做。
 * 抽取写入在同一事务里先建实体再写 mention，不会误删进行中的数据。
 */
export function cleanupOrphanMentions(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      DELETE FROM mentions WHERE memory_id NOT IN (
        SELECT id FROM memories WHERE lifecycle_state != 'deleted');
      DELETE FROM entities WHERE id NOT IN (SELECT entity_id FROM mentions);
      DELETE FROM entity_aliases WHERE entity_id NOT IN (SELECT id FROM entities);
      DELETE FROM entity_relations
        WHERE source_id NOT IN (SELECT id FROM entities) OR target_id NOT IN (SELECT id FROM entities);
    `);
  }).immediate();
}

export const CONTENT_HASH_BACKFILL_BATCH = 500;

/** 可重入：只处理 content_hash IS NULL 的行，每批一个短事务，中途退出下次开库续跑 */
export function backfillContentHash(db: Database.Database): void {
  const pick = db.prepare('SELECT rowid, content FROM memories WHERE content_hash IS NULL LIMIT ?');
  const set = db.prepare('UPDATE memories SET content_hash = ? WHERE rowid = ?');
  const batch = db.transaction((rows: { rowid: number; content: string }[]) => {
    for (const r of rows) set.run(contentHash(r.content), r.rowid);
  });
  for (;;) {
    const rows = pick.all(CONTENT_HASH_BACKFILL_BATCH) as { rowid: number; content: string }[];
    if (rows.length === 0) return;
    batch.immediate(rows);
  }
}

/** 路径由调用方注入（生产：userData/memory/memory.db；测试：临时目录），本模块不 import electron。 */
export function openMemoryDb(dbPath: string, opts: OpenMemoryDbOptions = {}): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  vecReady.set(db, loadVec(db, opts.vecExtensionPath));
  migrate(db);
  backfillContentHash(db);
  syncVecTables(db);
  cleanupOrphanMentions(db);
  return db;
}

// 扩展不兼容的平台（或路径错误）只丢向量通道，记忆功能整体仍可用
function loadVec(db: Database.Database, extensionPath: string | null | undefined): boolean {
  if (extensionPath === null) return false;
  try {
    const p = extensionPath ?? getLoadablePath();
    // asar 内的动态库无法 dlopen，打包后要走 unpacked 副本
    const unpacked = p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    db.loadExtension(fs.existsSync(unpacked) ? unpacked : p);
    db.prepare('SELECT vec_version()').get();
    return true;
  } catch {
    return false;
  }
}

function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current >= MEMORY_SCHEMA_VERSION) return;
  db.transaction(() => {
    for (let v = current; v < MEMORY_SCHEMA_VERSION; v++) {
      const step = MIGRATIONS[v];
      if (typeof step === 'string') db.exec(step);
      else step(db);
      db.pragma(`user_version = ${v + 1}`);
    }
  }).immediate();
}
