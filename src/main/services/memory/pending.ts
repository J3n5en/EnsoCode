import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createCrystal } from './crystal';
import { type CreateMemoryOptions, createMemory } from './store';
import type { CreateMemoryInput, Memory } from './types';

/**
 * Bot 会话写 project / global 空间的待审批队列：批准前不进 memories（不参与检索、去重、KG），
 * 批准时按原请求真正写入；拒绝只删队列行。
 */
export type PendingWriteKind = 'capture' | 'crystallize';

export interface PendingWriteInput {
  kind: PendingWriteKind;
  spaceId: string;
  title: string | null;
  content: string;
  botId: string | null;
  chatId: string | null;
  /** 入队前已做过密钥脱敏 */
  redacted: boolean;
  /** capture：CreateMemoryInput 其余字段；crystallize：{ sourceIds, force? } */
  payload: Record<string, unknown>;
}

export interface PendingWrite extends PendingWriteInput {
  id: string;
  createdAt: string;
}

interface PendingRow {
  id: string;
  kind: string;
  space_id: string;
  title: string | null;
  content: string;
  payload: string;
  bot_id: string | null;
  chat_id: string | null;
  redacted: number;
  created_at: string;
}

function toPending(row: PendingRow): PendingWrite {
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.payload);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    /* 坏行按空载荷处理，批准时由创建校验拒绝 */
  }
  return {
    id: row.id,
    kind: row.kind === 'crystallize' ? 'crystallize' : 'capture',
    spaceId: row.space_id,
    title: row.title,
    content: row.content,
    botId: row.bot_id,
    chatId: row.chat_id,
    redacted: row.redacted === 1,
    payload,
    createdAt: row.created_at,
  };
}

export function queuePendingWrite(
  db: Database.Database,
  input: PendingWriteInput,
  now: Date = new Date()
): PendingWrite {
  const pending: PendingWrite = { ...input, id: randomUUID(), createdAt: now.toISOString() };
  db.prepare(
    `INSERT INTO pending_writes (id, kind, space_id, title, content, payload, bot_id, chat_id, redacted, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    pending.id,
    pending.kind,
    pending.spaceId,
    pending.title,
    pending.content,
    JSON.stringify(pending.payload),
    pending.botId,
    pending.chatId,
    pending.redacted ? 1 : 0,
    pending.createdAt
  );
  return pending;
}

export function listPendingWrites(db: Database.Database): PendingWrite[] {
  return (
    db.prepare('SELECT * FROM pending_writes ORDER BY created_at, id').all() as PendingRow[]
  ).map(toPending);
}

export function rejectPendingWrite(db: Database.Database, id: string): boolean {
  return db.prepare('DELETE FROM pending_writes WHERE id = ?').run(id).changes > 0;
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

function captureInput(pending: PendingWrite, force: boolean): CreateMemoryInput {
  const p = pending.payload;
  return {
    content: pending.content,
    title: pending.title,
    spaceId: pending.spaceId,
    source: 'agent',
    unitType: (str(p.unitType) as CreateMemoryInput['unitType']) ?? null,
    ...(str(p.unitTypeSource)
      ? { unitTypeSource: p.unitTypeSource as CreateMemoryInput['unitTypeSource'] }
      : {}),
    ...(typeof p.importance === 'number' ? { importance: p.importance } : {}),
    eventStart: str(p.eventStart) ?? null,
    eventEnd: str(p.eventEnd) ?? null,
    evolvesFromId: str(p.evolvesFromId) ?? null,
    evolvesRelation: (str(p.evolvesRelation) as CreateMemoryInput['evolvesRelation']) ?? null,
    force,
  };
}

/**
 * 批准即「看过内容仍要写入」：先按原请求写（保留精确去重），撞相似候选再 force 写入。
 * 创建失败（源记忆已失效等）保留队列行，交给用户拒绝。
 */
export async function approvePendingWrite(
  db: Database.Database,
  id: string,
  opts: CreateMemoryOptions
): Promise<{ ok: true; memory: Memory } | { ok: false; error: string }> {
  const row = db.prepare('SELECT * FROM pending_writes WHERE id = ?').get(id) as
    | PendingRow
    | undefined;
  if (!row) return { ok: false, error: 'Pending memory write not found.' };
  const pending = toPending(row);
  const create = (force: boolean) => {
    if (pending.kind === 'capture') return createMemory(db, captureInput(pending, force), opts);
    const sourceIds = Array.isArray(pending.payload.sourceIds)
      ? pending.payload.sourceIds.filter((item): item is string => typeof item === 'string')
      : [];
    return createCrystal(
      db,
      {
        content: pending.content,
        title: pending.title ?? '',
        sourceIds,
        spaceId: pending.spaceId,
        force,
      },
      opts
    );
  };
  try {
    let result = await create(pending.payload.force === true);
    if (result.status !== 'inserted') result = await create(true);
    if (result.status !== 'inserted') return { ok: false, error: 'Memory was not written.' };
    rejectPendingWrite(db, id);
    return { ok: true, memory: result.memory };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
