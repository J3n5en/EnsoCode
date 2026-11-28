import { CRYSTAL_MIN_SOURCES } from '@shared/memory/constants';
import { searchAssistReport } from '@shared/memory/searchAssist';
import {
  parseMemoryCaptureRequest,
  parseMemoryCrystallizeRequest,
  parseMemoryDeleteRequest,
  parseMemorySearchRequest,
} from '@shared/memory/toolParams';
import { wrapUntrusted } from '@shared/secretary/transcript';
import type { MemoryOp } from '@shared/types/agent';
import type Database from 'better-sqlite3';
import type { MemoryAuditEntry } from './audit';
import { contentHash } from './contentHash';
import { createCrystal } from './crystal';
import { type Complete, redactSecrets } from './distill';
import { deleteMemoriesManually, planMemoryDeletion } from './manual';
import { type PendingWriteInput, queuePendingWrite } from './pending';
import { sanitizeMemoryWrite } from './safety';
import { searchMemories } from './search';
import { createSearchAssist } from './searchLlm';
import {
  defaultCaptureSpace,
  type MemorySpaceContext,
  requestSpaceIds,
  resolveSpaceIds,
  secretaryPrivateSpace,
} from './space';
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
  /** 检索时 embedding 模型还没加载好：本次无向量通道，结果要如实标注 */
  vectorWarming?: boolean;
  /** 检索等查询向量的剩余预算；超出即跳过向量通道并同样标注 */
  vectorBudgetMs?: number;
  /** 秘书写共享空间的审计落点 */
  audit?: (entry: MemoryAuditEntry) => void;
}

// 给模型看的说明：结果暂时不全，别把「没搜到」当成「没有」
const VECTOR_WARMING = {
  vector: 'warming',
  note:
    'Semantic (vector) search is still warming up, so these results come only from full-text and ' +
    'entity matching. Search again in a moment if semantic matches matter.',
} as const;

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

/** 秘书真正写入 / 删除了私有空间之外的记忆：留审计，正文只记 hash 与长度 */
function auditSecretaryWrite(
  ctx: MemoryBridgeContext,
  op: 'capture' | 'crystallize' | 'delete',
  memory: Pick<Memory, 'id' | 'spaceId' | 'title' | 'content'>,
  evolves?: Extract<MemoryAuditEntry, { action: 'memory.agent-write' }>['evolves']
): void {
  if (!ctx.secretary || !ctx.audit || memory.spaceId === secretaryPrivateSpace(ctx)) return;
  ctx.audit({
    ts: (ctx.now ?? new Date()).toISOString(),
    action: 'memory.agent-write',
    actor: 'secretary',
    sessionId: ctx.secretary.sessionId,
    op,
    memoryId: memory.id,
    spaceId: memory.spaceId,
    title: memory.title,
    contentHash: contentHash(memory.content),
    contentChars: Array.from(memory.content).length,
    ...(evolves ? { evolves } : {}),
  });
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
    const spaceIds = requestSpaceIds(request.spaceId, request.projectId, ctx);
    const assist =
      request.mode === 'deep' ? createSearchAssist((await ctx.complete?.()) ?? null) : undefined;
    let vectorSkipped = ctx.vectorWarming === true;
    const hits = await searchMemories(db, {
      q: request.query,
      spaceIds,
      limit: request.limit,
      embedder: ctx.embedder,
      now: ctx.now,
      mode: request.mode,
      assist,
      vectorBudgetMs: ctx.vectorBudgetMs,
      onVectorSkipped: () => {
        vectorSkipped = true;
      },
      // agent 检索启用 MMR 去冗余；显式写出来，默认值变化不会静默关掉它
      mmr: true,
      eventDateFrom: request.eventDateFrom ?? null,
      eventDateTo: request.eventDateTo ?? null,
      recordedDateFrom: request.recordedDateFrom ?? null,
      recordedDateTo: request.recordedDateTo ?? null,
    });
    // 秘书读到的其它空间是共享记忆：脱敏并包进不可信标签，提示词据此禁止照做
    const own = secretaryPrivateSpace(ctx);
    const shared = (spaceId: string) => own !== null && spaceId !== own;
    return {
      // 顺序即排名；relevance 是向量余弦，未走向量通道时省略，不填占位值（#168）
      results: hits.map((hit, index) => ({
        id: hit.memory.id,
        title: shared(hit.memory.spaceId) ? redactSecrets(hit.memory.title) : hit.memory.title,
        content: shared(hit.memory.spaceId)
          ? wrapUntrusted(`memory:${hit.memory.spaceId}`, redactSecrets(hit.memory.content))
          : hit.memory.content,
        unitType: hit.memory.unitType,
        spaceId: hit.memory.spaceId,
        rank: index + 1,
        ...(hit.relevance === null ? {} : { relevance: Number(hit.relevance.toFixed(4)) }),
        isLatest: hit.memory.isLatest,
        // 有矛盾证据（challenges 未被拒绝）：列出发起方 id，干净记忆不带此字段
        ...(hit.challengedBy ? { challengedBy: hit.challengedBy } : {}),
      })),
      ...searchAssistReport(request.mode, assist),
      ...(vectorSkipped ? VECTOR_WARMING : {}),
    };
  }
  if (op === 'capture') {
    const request = parseMemoryCaptureRequest(params);
    if (!request) {
      throw new MemoryValidationError('invalid_request', 'invalid memory_capture params');
    }
    const [spaceId] = requestSpaceIds(
      request.spaceId ?? defaultCaptureSpace(ctx),
      request.projectId,
      ctx
    );
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
          ...(request.evolvesReason ? { evolvesReason: request.evolvesReason } : {}),
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
        evolvesReason: request.evolvesReason ?? null,
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
    if (!result.deduplicated) {
      auditSecretaryWrite(
        ctx,
        'capture',
        memory,
        result.evolves
          ? { relation: result.evolves.relation, olderId: result.evolves.olderId }
          : undefined
      );
    }
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
    auditSecretaryWrite(ctx, 'crystallize', memory);
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
    if (!memory || memory.lifecycleState === 'deleted' || !visible.has(memory.spaceId)) {
      throw new MemoryValidationError(
        'not_found',
        `memory not found or not visible in this session: ${request.id}`
      );
    }
    // 与设置页删除同一条路径：一并删掉只通向它的历史版本、重连 replaces 链、修正引用它的结晶。
    // 演进边与结晶来源都限定在同一 space，所以连带影响不会越出上面的可见性检查。
    // 先按预览取出将被删的行，删完后逐条审计（正文只记 hash）
    const doomed = new Map(
      (planMemoryDeletion(db, [request.id])?.deleted ?? []).map((d) => [d.id, getMemory(db, d.id)])
    );
    const impact = deleteMemoriesManually(db, [request.id]);
    if (!impact) {
      throw new MemoryValidationError('not_found', `memory not found: ${request.id}`);
    }
    for (const entry of impact.deleted) {
      const row = entry.id === memory.id ? memory : doomed.get(entry.id);
      if (row) auditSecretaryWrite(ctx, 'delete', row);
    }
    ctx.onDeleted?.(request.id);
    const history = impact.deleted.filter((d) => d.role === 'history').map((d) => d.id);
    return {
      status: 'deleted',
      id: request.id,
      title: memory.title,
      content: memory.content.slice(0, 240),
      ...(history.length > 0 ? { alsoDeletedHistory: history } : {}),
      ...(impact.bridges.length > 0 ? { relinked: impact.bridges } : {}),
      ...(impact.crystalsUpdated.length > 0
        ? { crystalsUpdated: impact.crystalsUpdated.map((c) => c.id) }
        : {}),
      ...(impact.crystalsDemoted.length > 0
        ? { crystalsDemoted: impact.crystalsDemoted.map((c) => c.id) }
        : {}),
    };
  }
  throw new MemoryValidationError('unknown_op', `unknown memory op: ${String(op)}`);
}
