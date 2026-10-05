import { CRYSTAL_MIN_SOURCES } from '@shared/memory/constants';
import {
  parseMemoryCaptureRequest,
  parseMemoryCrystallizeRequest,
  parseMemoryDeleteRequest,
  parseMemorySearchRequest,
} from '@shared/memory/toolParams';
import type { MemoryOp } from '@shared/types/agent';
import type Database from 'better-sqlite3';
import { deleteMemoryPermanently } from '../memoryAdmin';
import { createCrystal } from './crystal';
import type { Complete } from './distill';
import { type PendingWriteInput, queuePendingWrite } from './pending';
import { sanitizeMemoryWrite } from './safety';
import { searchMemories } from './search';
import { createSearchAssist } from './searchLlm';
import { defaultCaptureSpace, type MemorySpaceContext, resolveSpaceIds } from './space';
import { createMemory, getMemory } from './store';
import { type Embedder, GLOBAL_SPACE, type Memory, MemoryValidationError } from './types';

/** projectId：Main 权威 Project.id，会话不属于任何项目（或项目已失效）时为 null；botId/chatId 仅 Bot 模式 */
export interface MemoryBridgeContext extends MemorySpaceContext {
  embedder?: Embedder | null;
  now?: Date;
  /** 真正新插一行后的 best-effort hook（KG 抽取排队） */
  onCreated?: (memory: Memory) => void;
  /** 删除成功后的通知（刷新记忆视图） */
  onDeleted?: (id: string) => void;
  /** Bot 会话写 project / global 进入待审批后的通知（刷新收件箱 / 记忆审批入口） */
  onPending?: (id: string) => void;
  /** deep 检索的 instruct LLM；不可用时检索退回本地意图 */
  complete?: (() => Complete | null | Promise<Complete | null>) | null;
}

/** Bot 会话写共享空间（项目 / 全局）需用户审批；自己的 bot / chat 空间直接写 */
function needsReview(ctx: MemoryBridgeContext, spaceId: string): boolean {
  return Boolean(ctx.botId) && (spaceId === GLOBAL_SPACE || spaceId.startsWith('proj:'));
}

function queueForReview(
  db: Database.Database,
  ctx: MemoryBridgeContext,
  input: Omit<PendingWriteInput, 'botId' | 'chatId'>
): unknown {
  const pending = queuePendingWrite(
    db,
    { ...input, botId: ctx.botId ?? null, chatId: ctx.chatId ?? null },
    ctx.now
  );
  ctx.onPending?.(pending.id);
  return {
    status: 'pending_review',
    written: false,
    ...(input.redacted ? { redacted: true } : {}),
    pendingId: pending.id,
    message:
      `Not written yet: writes from Bot members to the ${input.spaceId === GLOBAL_SPACE ? 'global' : 'project'} ` +
      'memory space need user approval. It is queued in the inbox and will be saved once the user approves; do not resubmit it.',
  };
}

const REDACTED_NOTE = 'Secrets in the content were replaced with [REDACTED] before saving.';

/**
 * worker `memory-invoke` 的 Main 侧执行入口。载荷按 unknown 收窄（桥两端都归一/校验，不信任 worker），
 * 返回给模型的是精简投影，不是整行。
 */
export async function executeMemoryOp(
  db: Database.Database,
  op: MemoryOp,
  params: unknown,
  ctx: MemoryBridgeContext
): Promise<unknown> {
  if (op === 'search') {
    const request = parseMemorySearchRequest(params);
    if (!request)
      throw new MemoryValidationError('invalid_request', 'invalid memory_search params');
    const spaceIds = resolveSpaceIds(request.spaceId, ctx);
    const assist =
      request.mode === 'deep' ? createSearchAssist((await ctx.complete?.()) ?? null) : undefined;
    const hits = await searchMemories(db, {
      q: request.query,
      spaceIds,
      limit: request.limit,
      embedder: ctx.embedder,
      now: ctx.now,
      mode: request.mode,
      assist,
      // agent 检索启用 MMR 去冗余；显式写出来，默认值变化不会静默关掉它
      mmr: true,
      eventDateFrom: request.eventDateFrom ?? null,
      eventDateTo: request.eventDateTo ?? null,
      recordedDateFrom: request.recordedDateFrom ?? null,
      recordedDateTo: request.recordedDateTo ?? null,
    });
    return {
      results: hits.map((hit) => ({
        id: hit.memory.id,
        title: hit.memory.title,
        content: hit.memory.content,
        unitType: hit.memory.unitType,
        spaceId: hit.memory.spaceId,
        score: Number(hit.score.toFixed(4)),
        isLatest: hit.memory.isLatest,
      })),
    };
  }
  if (op === 'capture') {
    const request = parseMemoryCaptureRequest(params);
    if (!request) {
      throw new MemoryValidationError('invalid_request', 'invalid memory_capture params');
    }
    const [spaceId] = resolveSpaceIds(request.spaceId ?? defaultCaptureSpace(ctx), ctx);
    if (!spaceId) {
      throw new MemoryValidationError(
        'no_project',
        "this session has no project; use spaceId 'global' instead"
      );
    }
    const safe = sanitizeMemoryWrite({ title: request.title ?? null, content: request.content });
    if (needsReview(ctx, spaceId)) {
      return queueForReview(db, ctx, {
        kind: 'capture',
        spaceId,
        title: safe.title,
        content: safe.content,
        redacted: safe.redacted,
        payload: {
          unitType: request.unitType,
          unitTypeSource: request.unitTypeSource,
          importance: request.importance,
          ...(request.eventStart ? { eventStart: request.eventStart } : {}),
          ...(request.eventEnd ? { eventEnd: request.eventEnd } : {}),
          ...(request.force ? { force: true } : {}),
          ...(request.evolvesFromId ? { evolvesFromId: request.evolvesFromId } : {}),
          ...(request.evolvesRelation ? { evolvesRelation: request.evolvesRelation } : {}),
        },
      });
    }
    const result = await createMemory(
      db,
      {
        content: safe.content,
        title: safe.title,
        unitType: request.unitType,
        unitTypeSource: request.unitTypeSource,
        importance: request.importance,
        spaceId,
        source: 'agent',
        eventStart: request.eventStart ?? null,
        eventEnd: request.eventEnd ?? null,
        force: request.force,
        evolvesFromId: request.evolvesFromId ?? null,
        evolvesRelation: request.evolvesRelation ?? null,
      },
      { embedder: ctx.embedder, now: ctx.now, onCreated: ctx.onCreated }
    );
    if (result.status !== 'inserted') {
      // 只返回候选（含全文，调用方才能判断关系 / 决定 force），明确告知未写入
      return {
        status: 'candidates_found',
        written: false,
        message:
          'Nothing was written: similar memories already exist. Drop it, resubmit with ' +
          'evolvesFromId + evolvesRelation, or resubmit with force=true.',
        candidates: result.candidates.map((c) => ({
          id: c.memory.id,
          title: c.memory.title,
          content: c.memory.content,
          unitType: c.memory.unitType,
          similarity: Number(c.similarity.toFixed(4)),
          bm25Top1: c.bm25Top1,
        })),
      };
    }
    const { memory } = result;
    return {
      status: 'inserted',
      ...(result.deduplicated ? { deduplicated: true } : {}),
      ...(safe.redacted ? { redacted: true, note: REDACTED_NOTE } : {}),
      ...(result.evolves
        ? { evolves: { relation: result.evolves.relation, olderId: result.evolves.olderId } }
        : {}),
      memory: {
        id: memory.id,
        title: memory.title,
        unitType: memory.unitType,
        spaceId: memory.spaceId,
        importance: memory.importance,
      },
    };
  }
  if (op === 'crystallize') {
    const request = parseMemoryCrystallizeRequest(params);
    if (!request) {
      throw new MemoryValidationError(
        'invalid_request',
        `invalid memory_crystallize params: content, title and sourceIds (>= ${CRYSTAL_MIN_SOURCES} distinct memory ids) are required`
      );
    }
    // 模型不指定 space：源只能来自本会话可见的 space（all 解析结果），结晶落在源所在 space；
    // 不可见的源与“不存在”同样拒绝，不泄露其它项目的 space
    const visible = new Set(resolveSpaceIds('all', ctx));
    const spaceIds = new Set<string>();
    for (const id of request.sourceIds) {
      const source = getMemory(db, id);
      if (!source || !visible.has(source.spaceId)) {
        throw new MemoryValidationError(
          'crystal_sources',
          `source memory not found or not visible in this session: ${id}`
        );
      }
      spaceIds.add(source.spaceId);
    }
    if (spaceIds.size !== 1) {
      throw new MemoryValidationError(
        'crystal_sources',
        'all source memories must belong to the same space (all global, or all current project)'
      );
    }
    const [spaceId] = spaceIds;
    const safe = sanitizeMemoryWrite({ title: request.title, content: request.content });
    if (needsReview(ctx, spaceId)) {
      return queueForReview(db, ctx, {
        kind: 'crystallize',
        spaceId,
        title: safe.title,
        content: safe.content,
        redacted: safe.redacted,
        payload: { sourceIds: request.sourceIds, ...(request.force ? { force: true } : {}) },
      });
    }
    const result = await createCrystal(
      db,
      {
        content: safe.content,
        title: safe.title ?? request.title,
        sourceIds: request.sourceIds,
        spaceId,
        force: request.force,
      },
      { embedder: ctx.embedder, now: ctx.now, onCreated: ctx.onCreated }
    );
    if (result.status !== 'inserted') {
      return {
        status: 'candidates_found',
        written: false,
        message:
          'Nothing was written: similar memories already exist. Drop it, or resubmit with ' +
          'force=true if the crystal genuinely adds information.',
        candidates: result.candidates.map((c) => ({
          id: c.memory.id,
          title: c.memory.title,
          content: c.memory.content,
          unitType: c.memory.unitType,
          similarity: Number(c.similarity.toFixed(4)),
          bm25Top1: c.bm25Top1,
        })),
      };
    }
    const { memory } = result;
    return {
      status: 'inserted',
      memory: {
        id: memory.id,
        title: memory.title,
        spaceId: memory.spaceId,
        isCrystal: memory.isCrystal,
        sourceUnitCount: memory.sourceUnitCount,
      },
    };
  }
  if (op === 'delete') {
    const request = parseMemoryDeleteRequest(params);
    if (!request) {
      throw new MemoryValidationError(
        'invalid_request',
        'invalid memory_delete params: id is required'
      );
    }
    // 只能删本会话可见 space 的记忆；不可见与不存在同样拒绝，不泄露其它项目
    const memory = getMemory(db, request.id);
    const visible = new Set(resolveSpaceIds('all', ctx));
    if (
      !memory ||
      memory.lifecycleState === 'deleted' ||
      !visible.has(memory.spaceId) ||
      !deleteMemoryPermanently(db, request.id)
    ) {
      throw new MemoryValidationError(
        'not_found',
        `memory not found or not visible in this session: ${request.id}`
      );
    }
    ctx.onDeleted?.(request.id);
    return { status: 'deleted', id: request.id };
  }
  throw new MemoryValidationError('unknown_op', `unknown memory op: ${String(op)}`);
}
