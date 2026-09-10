import { CRYSTAL_MIN_SOURCES } from '@shared/memory/constants';
import {
  type MemorySearchSpace,
  parseMemoryCaptureRequest,
  parseMemoryCrystallizeRequest,
  parseMemorySearchRequest,
} from '@shared/memory/toolParams';
import type { MemoryOp } from '@shared/types/agent';
import type Database from 'better-sqlite3';
import { createCrystal } from './crystal';
import type { Complete } from './distill';
import { searchMemories } from './search';
import { createSearchAssist } from './searchLlm';
import { createMemory, getMemory } from './store';
import {
  type Embedder,
  GLOBAL_SPACE,
  type Memory,
  MemoryValidationError,
  projectSpaceId,
} from './types';

export interface MemoryBridgeContext {
  /** Main 权威 Project.id；会话不属于任何项目（或项目已失效）时为 null */
  projectId: string | null;
  embedder?: Embedder | null;
  now?: Date;
  /** 真正新插一行后的 best-effort hook（KG 抽取排队） */
  onCreated?: (memory: Memory) => void;
  /** deep 检索的 instruct LLM；不可用时检索退回本地意图 */
  complete?: (() => Complete | null | Promise<Complete | null>) | null;
}

/** 模型只说 space 语义，这里换成真实 space_id；`project` 无项目时返回空集合让调用方决定拒绝还是空结果。 */
export function resolveSpaceIds(space: MemorySearchSpace, projectId: string | null): string[] {
  const project = projectId ? [projectSpaceId(projectId)] : [];
  if (space === 'global') return [GLOBAL_SPACE];
  if (space === 'project') return project;
  return [GLOBAL_SPACE, ...project];
}

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
    const spaceIds = resolveSpaceIds(request.spaceId, ctx.projectId);
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
    const [spaceId] = resolveSpaceIds(request.spaceId, ctx.projectId);
    if (!spaceId) {
      throw new MemoryValidationError(
        'no_project',
        "this session has no project; use spaceId 'global' instead"
      );
    }
    const result = await createMemory(
      db,
      {
        content: request.content,
        title: request.title ?? null,
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
    // 模型不指定 space：源只能来自本会话可见的 space（global + 当前项目），结晶落在源所在 space；
    // 不可见的源与“不存在”同样拒绝，不泄露其它项目的 space
    const visible = new Set(resolveSpaceIds('all', ctx.projectId));
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
    const result = await createCrystal(
      db,
      {
        content: request.content,
        title: request.title,
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
  throw new MemoryValidationError('unknown_op', `unknown memory op: ${String(op)}`);
}
