import { randomUUID } from 'node:crypto';
import {
  KG_DEFAULT_ENTITY_TYPE,
  KG_DEFAULT_RELATION_TYPE,
  KG_EXTRACT_MAX_TOKENS,
  KG_MAX_ATTEMPTS,
  KG_MAX_DESCRIPTION_CHARS,
  KG_MAX_ENTITIES,
  KG_MAX_ENTITY_NAME_CHARS,
  KG_MAX_RELATIONS,
} from '@shared/memory/constants';
import { normalizeEntityName, normalizeKgLabel } from '@shared/memory/entityNormalize';
import { KG_EXTRACT_SYSTEM, kgExtractLevel1Prompt } from '@shared/memory/prompts';
import type Database from 'better-sqlite3';
import { contentHash } from './contentHash';
import { type Complete, looseParse, redactSecrets } from './distill';
import { getMemory, MEMORY_COLUMNS, type MemoryRow, rowToMemory } from './store';
import type { Memory } from './types';

/**
 * 实体层与异步 KG 抽取。
 * 纯逻辑层：不碰 electron；LLM 以 `Complete` 注入。抽取只在 memory_jobs（kind='kg'）里异步跑，
 * 绝不进 createMemory 热路径。
 */

export interface KgEntity {
  name: string;
  /** UPPER_SNAKE，建议表见 constants.KG_ENTITY_TYPES */
  type: string;
  description: string | null;
  confidence: number;
  /** 同一次抽取里归一到同一键的其它写法 */
  aliases: string[];
}

export interface KgRelation {
  source: string;
  target: string;
  relation: string;
  strength: number;
}

export interface KgExtraction {
  entities: KgEntity[];
  relations: KgRelation[];
}

/** 抽取策略接口：Level 1 一枪；Level 2（三步法）留此接口后续接入，失败时 fallback Level 1 */
export type KgExtractor = (text: string, complete: Complete) => Promise<KgExtraction>;

// ---------------------------------------------------------------------------
// 解析与归一
// ---------------------------------------------------------------------------

const DEFAULT_CONFIDENCE = 0.5;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
// 调用方（含测试 / Level 2）可能传非数值；NaN 会被 SQLite 绑成 NULL 撞 NOT NULL
const conf = (v: unknown) => clamp01(num(v) ?? DEFAULT_CONFIDENCE);
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const arr = (o: Record<string, unknown>, ...keys: string[]): unknown[] => {
  for (const k of keys) if (Array.isArray(o[k])) return o[k] as unknown[];
  return [];
};

const ENTITY_LIST_KEYS = ['entities', 'entity_list', '实体'];
const ENTITY_NAME_KEYS = ['name', 'entity', 'entity_name', 'text', '名称', '名字'];

function firstArray(o: Record<string, unknown>, keys: readonly string[]): unknown[] | null {
  for (const k of keys) if (Array.isArray(o[k])) return o[k] as unknown[];
  return null;
}

function entityName(item: unknown): string | null {
  if (typeof item === 'string') return str(item);
  if (!item || typeof item !== 'object') return null;
  const e = item as Record<string, unknown>;
  for (const k of ENTITY_NAME_KEYS) {
    const name = str(e[k]);
    if (name) return name;
  }
  return null;
}

function toEntity(item: unknown): Omit<KgEntity, 'aliases'> | null {
  const name = entityName(item);
  if (!name) return null;
  if (typeof item === 'string') {
    return { name, type: '', description: null, confidence: DEFAULT_CONFIDENCE };
  }
  const e = item as Record<string, unknown>;
  return {
    name,
    type: str(e.type) ?? str(e.entity_type) ?? str(e.类型) ?? '',
    description: str(e.description),
    confidence: num(e.confidence) ?? DEFAULT_CONFIDENCE,
  };
}

/**
 * 兼容形状 `{"entities":[{name,type,description,confidence}],"relationships":[{source,target,relation,confidence}]}`。
 * 容错：字符串实体、中文键、顶层数组、think 残片；蒸馏形状（memories）返回 null，不当作抽空成功。
 * 输出已经过 normalizeExtraction（去重、截断、关系校验）。
 */
export function parseKgResponse(raw: string): KgExtraction | null {
  const parsed = looseParse(raw);
  if (parsed === null || typeof parsed !== 'object') return null;
  if (Array.isArray(parsed)) {
    const entities = parsed.map(toEntity).filter((e): e is NonNullable<typeof e> => e !== null);
    return entities.length === 0 ? null : normalizeExtraction({ entities, relations: [] });
  }
  const o = parsed as Record<string, unknown>;
  const entityItems = firstArray(o, ENTITY_LIST_KEYS);
  const entities: KgEntity[] = [];
  for (const item of entityItems ?? []) {
    const entity = toEntity(item);
    if (!entity) continue;
    const extra =
      item && typeof item === 'object'
        ? arr(item as Record<string, unknown>, 'aliases')
            .map(str)
            .filter((a): a is string => a !== null)
        : [];
    entities.push({ ...entity, aliases: extra });
  }
  if (!entityItems) {
    const single = toEntity(o);
    if (!single) return null;
    return normalizeExtraction({ entities: [single], relations: [] });
  }
  const relations: KgRelation[] = [];
  for (const item of arr(o, 'relationships', 'relations', '关系')) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const source = str(r.source);
    const target = str(r.target);
    if (!source || !target) continue;
    relations.push({
      source,
      target,
      relation: str(r.relation) ?? str(r.relation_type) ?? str(r.type) ?? '',
      strength: num(r.strength) ?? num(r.confidence) ?? DEFAULT_CONFIDENCE,
    });
  }
  return normalizeExtraction({ entities, relations });
}

/**
 * 归一 + 防线：实体名 / 描述截长，type / relation 转 UPPER_SNAKE（非英文回退缺省），
 * 同归一键的实体合并（首次出现的写法为正名，其余进 aliases，confidence 取大），
 * 关系两端必须是已抽取实体且不成自环，最后硬截 10 / 20。
 */
export function normalizeExtraction(x: {
  entities: Omit<KgEntity, 'aliases'>[] | KgEntity[];
  relations: KgRelation[];
}): KgExtraction {
  const byKey = new Map<string, KgEntity>();
  for (const raw of x.entities) {
    const name = raw.name.trim().slice(0, KG_MAX_ENTITY_NAME_CHARS);
    const key = normalizeEntityName(name);
    if (!key) continue;
    const incomingAliases = ('aliases' in raw ? raw.aliases : []).map((a) =>
      a.trim().slice(0, KG_MAX_ENTITY_NAME_CHARS)
    );
    const existing = byKey.get(key);
    if (existing) {
      if (name !== existing.name) existing.aliases.push(name);
      existing.aliases.push(...incomingAliases);
      existing.confidence = Math.max(existing.confidence, conf(raw.confidence));
      existing.description ??= raw.description?.slice(0, KG_MAX_DESCRIPTION_CHARS) ?? null;
      continue;
    }
    if (byKey.size >= KG_MAX_ENTITIES) continue;
    byKey.set(key, {
      name,
      type: normalizeKgLabel(raw.type, KG_DEFAULT_ENTITY_TYPE),
      description: raw.description?.slice(0, KG_MAX_DESCRIPTION_CHARS) ?? null,
      confidence: conf(raw.confidence),
      aliases: incomingAliases,
    });
  }
  for (const e of byKey.values()) {
    e.aliases = [...new Set(e.aliases.filter((a) => a && a !== e.name))];
  }
  const relations: KgRelation[] = [];
  const seen = new Set<string>();
  for (const r of x.relations) {
    if (relations.length >= KG_MAX_RELATIONS) break;
    const s = normalizeEntityName(r.source);
    const t = normalizeEntityName(r.target);
    if (!s || !t || s === t || !byKey.has(s) || !byKey.has(t)) continue;
    const relation = normalizeKgLabel(r.relation, KG_DEFAULT_RELATION_TYPE);
    const dedupKey = `${s}\u0000${t}\u0000${relation}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    relations.push({
      source: byKey.get(s)?.name ?? r.source,
      target: byKey.get(t)?.name ?? r.target,
      relation,
      strength: conf(r.strength),
    });
  }
  return { entities: [...byKey.values()], relations };
}

/** Level 1：schema 在 system、正文在 user；模型输出不可解析即抛，由任务层按暂时性失败处理 */
export const extractLevel1: KgExtractor = async (text, complete) => {
  const call = (nudge: boolean) =>
    complete(
      KG_EXTRACT_SYSTEM,
      nudge ? `${kgExtractLevel1Prompt(text)}\n\nOutput JSON only` : kgExtractLevel1Prompt(text),
      { maxTokens: KG_EXTRACT_MAX_TOKENS }
    );
  const parsed = parseKgResponse(await call(false));
  if (parsed) return parsed;
  const retried = parseKgResponse(await call(true));
  if (!retried) throw new Error('model output is not parseable JSON');
  return retried;
};

// ---------------------------------------------------------------------------
// 写入：实体去重（space_id, normalized_name）、别名、mentions、关系
// ---------------------------------------------------------------------------

interface EntityRef {
  id: string;
  name: string;
}

/**
 * 一个事务：先清该记忆旧 mentions（重抽幂等），再逐实体按 (space_id, normalized_name) upsert，
 * 不同写法进 entity_aliases；关系按 (source, target, type) 去重取最大 strength。
 * 返回写入的实体 / 关系数。
 */
export function applyExtraction(
  db: Database.Database,
  memory: Pick<Memory, 'id' | 'spaceId'>,
  x: KgExtraction,
  now: Date = new Date()
): { entities: number; relations: number } {
  const ts = now.toISOString();
  const findEntity = db.prepare(
    'SELECT id, name FROM entities WHERE space_id = ? AND normalized_name = ?'
  );
  const insertEntity = db.prepare(
    `INSERT INTO entities (id, name, normalized_name, entity_type, description, confidence, space_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const touchEntity = db.prepare(
    `UPDATE entities SET confidence = max(confidence, ?), description = COALESCE(description, ?), updated_at = ?
     WHERE id = ?`
  );
  const insertAlias = db.prepare(
    'INSERT OR IGNORE INTO entity_aliases (entity_id, alias, normalized_alias) VALUES (?, ?, ?)'
  );
  const insertMention = db.prepare(
    `INSERT INTO mentions (memory_id, entity_id, confidence, mention_count, created_at) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(memory_id, entity_id) DO UPDATE SET
       mention_count = mention_count + 1, confidence = max(confidence, excluded.confidence)`
  );
  const insertRelation = db.prepare(
    `INSERT INTO entity_relations (id, source_id, target_id, relation_type, strength, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_id, target_id, relation_type) DO UPDATE SET strength = max(strength, excluded.strength)`
  );
  return db
    .transaction(() => {
      db.prepare('DELETE FROM mentions WHERE memory_id = ?').run(memory.id);
      const refs = new Map<string, EntityRef>();
      for (const e of x.entities) {
        const key = normalizeEntityName(e.name);
        let ref = findEntity.get(memory.spaceId, key) as EntityRef | undefined;
        if (ref) {
          touchEntity.run(e.confidence, e.description, ts, ref.id);
        } else {
          ref = { id: randomUUID(), name: e.name };
          insertEntity.run(
            ref.id,
            e.name,
            key,
            e.type,
            e.description,
            e.confidence,
            memory.spaceId,
            ts,
            ts
          );
        }
        for (const alias of [e.name, ...e.aliases]) {
          if (alias !== ref.name) insertAlias.run(ref.id, alias, normalizeEntityName(alias));
        }
        insertMention.run(memory.id, ref.id, e.confidence, ts);
        refs.set(key, ref);
      }
      let relations = 0;
      for (const r of x.relations) {
        const s = refs.get(normalizeEntityName(r.source));
        const t = refs.get(normalizeEntityName(r.target));
        if (!s || !t || s.id === t.id) continue;
        insertRelation.run(randomUUID(), s.id, t.id, r.relation, r.strength, ts);
        relations++;
      }
      return { entities: refs.size, relations };
    })
    .immediate();
}

/** 某条记忆提及的实体正名（测试 / 展示用） */
export function listEntityNames(db: Database.Database, memoryId: string): string[] {
  return (
    db
      .prepare(
        `SELECT e.name FROM mentions m JOIN entities e ON e.id = m.entity_id
         WHERE m.memory_id = ? ORDER BY e.name`
      )
      .all(memoryId) as { name: string }[]
  ).map((r) => r.name);
}

/**
 * 按归一键匹配实体正名或别名，返回提及它的最新活动记忆。
 * 正文里没出现该词、但 MENTIONS 同一实体的记忆也能召回——这是实体层区别于全文检索的价值。
 */
export function findMemoriesByEntity(
  db: Database.Database,
  name: string,
  spaceIds: readonly string[]
): Memory[] {
  const key = normalizeEntityName(name);
  if (!key || spaceIds.length === 0) return [];
  const spaces = spaceIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT DISTINCT ${MEMORY_COLUMNS.split(', ')
        .map((c) => `m.${c}`)
        .join(', ')}
       FROM memories m
       JOIN mentions mn ON mn.memory_id = m.id
       JOIN entities e ON e.id = mn.entity_id
       WHERE e.space_id IN (${spaces}) AND m.is_latest = 1 AND m.lifecycle_state = 'active'
         AND (e.normalized_name = ? OR e.id IN (SELECT entity_id FROM entity_aliases WHERE normalized_alias = ?))
       ORDER BY m.updated_at DESC, m.id`
    )
    .all(...spaceIds, key, key) as MemoryRow[];
  return rows.map(rowToMemory);
}

// ---------------------------------------------------------------------------
// 任务表（复用 memory_jobs，kind='kg'；target = `${memoryId}#${contentHash}`）
// ---------------------------------------------------------------------------

const KIND = 'kg';
export type KgStatus = 'pending' | 'running' | 'done' | 'cancelled';

export interface KgJob {
  id: number;
  memoryId: string;
  /** `${memoryId}#${contentHash(content)}`：同内容不重复抽 */
  fingerprint: string;
  status: KgStatus;
  attempts: number;
  /** 写入的实体数 */
  total: number;
  /** 写入的关系数 */
  done: number;
  /** 1 = 用尽重试或写入失败；成功与尚未终态的 pending 为 0 */
  failed: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface JobRow {
  id: number;
  target: string;
  status: KgStatus;
  cursor: number;
  total: number;
  done: number;
  failed: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const toJob = (r: JobRow): KgJob => ({
  id: r.id,
  memoryId: r.target.slice(0, r.target.indexOf('#')),
  fingerprint: r.target,
  status: r.status,
  attempts: r.cursor,
  total: r.total,
  done: r.done,
  failed: r.failed,
  error: r.error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function kgFingerprint(memoryId: string, content: string): string {
  // r2：解析器能吃小模型脏 JSON 之后，旧的「抽空成功」任务不能再挡住补抽
  return `${memoryId}#${contentHash(content)}#r2`;
}

/**
 * 幂等建任务（记忆创建后的持久化落点）：记忆不存在 / 已删除返回 null；
 * 同指纹已收尾（done / cancelled）返回 null；未跑完的返回原任务；内容已变则把该记忆的旧活动任务标 cancelled 再建新的。
 */
export function ensureKgJob(db: Database.Database, memoryId: string): KgJob | null {
  const memory = getMemory(db, memoryId);
  if (!memory || memory.lifecycleState === 'deleted') return null;
  const fingerprint = kgFingerprint(memory.id, memory.content);
  return db
    .transaction((): KgJob | null => {
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE memory_jobs SET status = 'cancelled', updated_at = ?
         WHERE kind = ? AND target LIKE ? AND target != ? AND status IN ('pending','running')`
      ).run(now, KIND, `${memory.id}#%`, fingerprint);
      const exists = db
        .prepare('SELECT * FROM memory_jobs WHERE kind = ? AND target = ? ORDER BY id DESC LIMIT 1')
        .get(KIND, fingerprint) as JobRow | undefined;
      if (exists) {
        return exists.status === 'pending' || exists.status === 'running' ? toJob(exists) : null;
      }
      const info = db
        .prepare(
          `INSERT INTO memory_jobs (kind, target, status, cursor, total, done, failed, created_at, updated_at)
           VALUES (?, ?, 'pending', 0, 0, 0, 0, ?, ?)`
        )
        .run(KIND, fingerprint, now, now);
      return toJob(
        db.prepare('SELECT * FROM memory_jobs WHERE id = ?').get(info.lastInsertRowid) as JobRow
      );
    })
    .immediate();
}

/** 重启后要续跑的任务：pending 与上次进程死在半路的 running */
export function listResumableKgJobs(db: Database.Database): KgJob[] {
  return (
    db
      .prepare(
        `SELECT * FROM memory_jobs WHERE kind = ? AND status IN ('pending','running') ORDER BY id ASC`
      )
      .all(KIND) as JobRow[]
  ).map(toJob);
}

export function listKgJobs(db: Database.Database, limit = 50): KgJob[] {
  return (
    db
      .prepare('SELECT * FROM memory_jobs WHERE kind = ? ORDER BY id DESC LIMIT ?')
      .all(KIND, Math.max(1, Math.floor(limit))) as JobRow[]
  ).map(toJob);
}

const FAILED_KG_SQL = `kind = ? AND status = 'done' AND (failed != 0 OR (error IS NOT NULL AND error != ''))`;

export function countFailedKgJobs(db: Database.Database): number {
  return (
    db.prepare(`SELECT count(*) AS n FROM memory_jobs WHERE ${FAILED_KG_SQL}`).get(KIND) as {
      n: number;
    }
  ).n;
}

export function retryFailedKgJobs(db: Database.Database): KgJob[] {
  const now = new Date().toISOString();
  const ids = db
    .prepare(`SELECT id FROM memory_jobs WHERE ${FAILED_KG_SQL} ORDER BY id ASC`)
    .all(KIND) as { id: number }[];
  if (ids.length === 0) return [];
  const update = db.prepare(
    `UPDATE memory_jobs SET status = 'pending', cursor = 0, failed = 0, error = NULL, updated_at = ?
     WHERE id = ?`
  );
  const read = db.prepare('SELECT * FROM memory_jobs WHERE id = ?');
  return db
    .transaction(() => {
      const jobs: KgJob[] = [];
      for (const { id } of ids) {
        update.run(now, id);
        jobs.push(toJob(read.get(id) as JobRow));
      }
      return jobs;
    })
    .immediate();
}

/** 最新活动记忆若还没有当前指纹的任务，就建 pending。开库 / 打开开关时补抽用。 */
export function ensurePendingKgJobs(db: Database.Database): number {
  const ids = db
    .prepare(`SELECT id FROM memories WHERE is_latest = 1 AND lifecycle_state = 'active'`)
    .all() as { id: string }[];
  let n = 0;
  for (const { id } of ids) if (ensureKgJob(db, id)) n++;
  return n;
}

export interface RunKgOptions {
  complete: Complete;
  /** 缺省 Level 1 */
  extract?: KgExtractor;
  now?: Date;
}

/**
 * 跑一个抽取任务：重读记忆核对指纹（内容已变 / 已删除 → cancelled）→ 密钥打码 → LLM → 归一 → applyExtraction。
 * LLM 阶段失败是暂时性的：attempts+1 保留 pending 记 error，超过 KG_MAX_ATTEMPTS 标 done 且 failed=1。绝不抛出。
 */
export async function runKgJob(
  db: Database.Database,
  job: KgJob,
  opts: RunKgOptions
): Promise<KgJob> {
  const set = db.prepare(
    `UPDATE memory_jobs SET status = ?, cursor = ?, total = ?, done = ?, failed = ?, error = ?, updated_at = ? WHERE id = ?`
  );
  const reread = () =>
    toJob(db.prepare('SELECT * FROM memory_jobs WHERE id = ?').get(job.id) as JobRow);
  const finish = (
    status: KgStatus,
    attempts: number,
    counts: { total: number; done: number },
    error: string | null,
    failed: number
  ) => {
    set.run(
      status,
      attempts,
      counts.total,
      counts.done,
      failed,
      error,
      new Date().toISOString(),
      job.id
    );
    return reread();
  };
  const zero = { total: 0, done: 0 };

  const memory = getMemory(db, job.memoryId);
  if (
    !memory ||
    memory.lifecycleState === 'deleted' ||
    kgFingerprint(memory.id, memory.content) !== job.fingerprint
  ) {
    return finish(
      'cancelled',
      job.attempts,
      zero,
      'memory changed or deleted since the job was created',
      job.failed ?? 0
    );
  }
  const attempts = job.attempts + 1;
  finish('running', attempts, zero, null, 0);

  let extraction: KgExtraction;
  try {
    const text = redactSecrets(`${memory.title}\n${memory.content}`);
    extraction = await (opts.extract ?? extractLevel1)(text, opts.complete);
  } catch (error) {
    const message = `kg extraction failed: ${error instanceof Error ? error.message : String(error)}`;
    const terminal = attempts >= KG_MAX_ATTEMPTS;
    return finish(terminal ? 'done' : 'pending', attempts, zero, message, terminal ? 1 : 0);
  }
  // 打码后模型仍可能把 `[REDACTED]` 当实体，或凭记忆吐出密钥形态的字串；正名 / 别名带打码标记或自身命中密钥模式的一律丢
  const tainted = (s: string) => s.includes('[REDACTED]') || redactSecrets(s) !== s;
  extraction.entities = extraction.entities.filter(
    (e) => !tainted(e.name) && !e.aliases.some(tainted)
  );
  extraction = normalizeExtraction(extraction);
  try {
    const counts = applyExtraction(db, memory, extraction, opts.now);
    return finish('done', attempts, { total: counts.entities, done: counts.relations }, null, 0);
  } catch (error) {
    return finish(
      'done',
      attempts,
      zero,
      `kg write failed: ${error instanceof Error ? error.message : String(error)}`,
      1
    );
  }
}
