import { CRYSTAL_MIN_SOURCES } from '@shared/memory/constants';
import type {
  MemoryJobsSnapshot,
  MemoryListResult,
  MemoryMutationResult,
} from '@shared/memory/dto';
import type {
  CrystallizeRequest,
  CrystallizeResult,
  GraphQuery,
  InsightRequest,
  InsightResult,
  TreeQuery,
} from '@shared/memory/graphDto';
import { CRYSTALLIZE_PROMPT, INSIGHT_PROMPT, withMemoryLanguage } from '@shared/memory/prompts';
import type { MemoryOp } from '@shared/types/agent';
import { appendMemoryAudit } from '../main/services/memory/audit';
import { createCrystal } from '../main/services/memory/crystal';
import { looseParse } from '../main/services/memory/distill';
import {
  archiveCandidatesConfirmed,
  getForgettingState,
  listArchiveCandidates,
} from '../main/services/memory/forgetting';
import {
  buildMemoryGraph,
  buildMemoryTree,
  entityMemoryIds,
  memoriesForEntity,
  memoriesForPrompt,
} from '../main/services/memory/graph';
import { deleteMemoriesManually, planMemoryDeletion } from '../main/services/memory/manual';
import { listPendingWrites, rejectPendingWrite } from '../main/services/memory/pending';
import { createSearchAssist } from '../main/services/memory/searchLlm';
import { getMemory, listMemories } from '../main/services/memory/store';
import type { SearchAssist } from '../main/services/memory/types';
import {
  archiveMemory,
  clearFinishedMemoryJobs,
  deleteMemorySpace,
  getMemoryDetail,
  getMemoryStats,
  listMemoriesForAdmin,
  listPendingEvolves,
  restoreMemory,
  reviewEvolvesEdge,
  searchMemoriesForAdmin,
  toMemoryJobsSnapshot,
  toMemoryListItem,
} from '../main/services/memoryAdmin';
import * as core from '../main/services/memoryServiceCore';

export const MISSING_DB = { missing: true } as const;

/** 库不存在就返回 MISSING_DB；存在则开/复用服务共享连接（不再每次新建连接） */
function existingDb() {
  return core.memoryDbIfExists();
}

async function withDb<T>(run: (db: ReturnType<typeof core.memoryDatabase>) => T | Promise<T>) {
  const db = existingDb();
  if (!db) return MISSING_DB;
  return run(db);
}

async function withDbRequired<T>(
  run: (db: ReturnType<typeof core.memoryDatabase>) => T | Promise<T>
) {
  return run(core.memoryDatabase());
}

export async function dispatchMemoryOp(op: string, args: unknown): Promise<unknown> {
  switch (op) {
    case 'config': {
      const { key, value } = args as { key: string; value: unknown };
      applyMemoryServiceConfig(key, value);
      return true;
    }
    case 'invoke': {
      const {
        op: memoryOp,
        params,
        scope,
      } = args as {
        op: MemoryOp;
        params: unknown;
        scope: Parameters<typeof core.invokeMemory>[2];
      };
      return core.invokeMemory(memoryOp, params, scope);
    }
    case 'approve-write':
      return core.approvePendingMemoryWrite((args as { id: string }).id);
    case 'edit-memory':
      return core.editMemory(
        (args as { id: string }).id,
        (args as { patch: Parameters<typeof core.editMemory>[1] }).patch
      );
    case 'audit-append':
      appendMemoryAudit(
        core.memoryDirPath(),
        (args as { entry: Parameters<typeof appendMemoryAudit>[1] }).entry
      );
      return { ok: true };
    case 'distill':
      return core.distillSessionNow(
        (args as { payload: Parameters<typeof core.distillSessionNow>[0] }).payload,
        (args as { options?: Parameters<typeof core.distillSessionNow>[1] }).options
      );
    case 'schedule-distill':
      return core.scheduleMemoryDistill(
        (args as { payload: Parameters<typeof core.scheduleMemoryDistill>[0] }).payload,
        (args as { options?: Parameters<typeof core.scheduleMemoryDistill>[1] }).options
      );
    case 'distill-jobs':
      return core.getMemoryDistillJobs((args as { limit?: number } | undefined)?.limit);
    case 'kg-jobs':
      return core.getMemoryKgJobs((args as { limit?: number } | undefined)?.limit);
    case 'kg-failed':
      return core.getMemoryKgFailedCount();
    case 'kg-retry-failed': {
      const reset = core.retryFailedMemoryKg();
      if (reset > 0) core.notifyMemoryChanged();
      return reset;
    }
    case 'reembed-progress':
      return core.getMemoryReembedProgress();
    case 'jobs': {
      const db = existingDb();
      const snapshot = toMemoryJobsSnapshot(
        core.getMemoryDistillJobs(),
        core.getMemoryKgJobs(),
        core.getMemoryReembedProgress()
      ) as MemoryJobsSnapshot;
      // kg 任务只存 memoryId；界面要标题，服务侧一并带出
      const memoryTitles = new Map<string, string>();
      if (db && snapshot.kg.length > 0) {
        const unique = [...new Set(snapshot.kg.map((job) => job.memoryId))];
        const rows = db
          .prepare(
            `SELECT id, title FROM memories WHERE id IN (${unique.map(() => '?').join(',')})`
          )
          .all(...unique) as { id: string; title: string }[];
        for (const row of rows) memoryTitles.set(row.id, row.title);
      }
      return { snapshot, memoryTitles: Object.fromEntries(memoryTitles) };
    }
    case 'await-distill':
      await core.awaitMemoryDistill();
      return true;
    case 'await-kg':
      await core.awaitMemoryKg();
      return true;
    case 'await-reconcile':
      await core.awaitMemoryReconcile();
      return true;
    case 'await-reembed':
      await core.awaitMemoryReembed();
      return true;
    case 'await-embedding-close':
      await core.awaitMemoryEmbeddingClose();
      return true;
    case 'warmup':
      return core.warmMemoryService();
    case 'forgetting-run': {
      const summary = core.runMemoryForgettingNow();
      core.notifyMemoryChanged();
      return summary;
    }
    case 'reconcile-run': {
      const summary = await core.runMemoryReconcileNow();
      if (summary) core.notifyMemoryChanged();
      return summary;
    }
    case 'forgetting-settings':
      return core.forgettingSettings();
    case 'stats':
      return withDb((db) => ({
        ...getMemoryStats(db),
        forgetting: getForgettingState(db, core.forgettingSettings()),
      }));
    case 'embedding-error':
      return core.getMemoryEmbeddingError();
    case 'reembed': {
      const force = (args as { force?: boolean } | undefined)?.force === true;
      core.refreshMemoryEmbedding({ reembed: force });
      return true;
    }
    case 'release-chat':
      await core.releaseMemoryChatSlot();
      return true;
    case 'remove-space': {
      const { spaceId } = args as { spaceId: string };
      const db = existingDb();
      if (!db) return { removed: false };
      await core.awaitMemoryDistill();
      await core.awaitMemoryKg();
      deleteMemorySpace(db, spaceId);
      core.notifyMemoryChanged();
      return { removed: true };
    }
    case 'list': {
      const query = args as Parameters<typeof listMemoriesForAdmin>[1] & {
        mode?: 'exact' | 'fast' | 'deep';
      };
      return withDb(async (db) => {
        const retrieval = query.mode === 'fast' || query.mode === 'deep';
        const embedder = retrieval ? await core.getMemoryEmbedder() : null;
        const assist: SearchAssist | null =
          query.mode === 'deep' ? createSearchAssist(await core.getMemoryCompletion()) : null;
        const result: MemoryListResult = retrieval
          ? await searchMemoriesForAdmin(db, query, embedder, assist)
          : listMemoriesForAdmin(db, query);
        return result;
      });
    }
    case 'detail':
      return withDb((db) => getMemoryDetail(db, (args as { id: string }).id));
    case 'archive': {
      return withDb((db) => {
        const id = (args as { id: string }).id;
        if (!archiveMemory(db, id)) return { ok: false, error: 'Memory not found.' };
        const memory = getMemoryDetail(db, id);
        core.notifyMemoryChanged();
        return memory
          ? ({ ok: true, memory } satisfies MemoryMutationResult)
          : { ok: false, error: 'Memory not found.' };
      });
    }
    case 'restore': {
      return withDb((db) => {
        const id = (args as { id: string }).id;
        if (!restoreMemory(db, id)) return { ok: false, error: 'Memory not found.' };
        const memory = getMemoryDetail(db, id);
        core.notifyMemoryChanged();
        return memory
          ? ({ ok: true, memory } satisfies MemoryMutationResult)
          : { ok: false, error: 'Memory not found.' };
      });
    }
    case 'archive-candidates': {
      const query = (args as { query?: { limit?: number; offset?: number } }).query ?? {
        limit: 50,
        offset: 0,
      };
      return withDb((db) => {
        const result = listArchiveCandidates(db, core.forgettingSettings(), query);
        return {
          total: result.total,
          items: result.items.map((memory) => toMemoryListItem(memory)),
        };
      });
    }
    case 'archive-confirm': {
      const ids = (args as { ids: string[] }).ids;
      return withDb((db) => {
        const outcome = archiveCandidatesConfirmed(db, core.forgettingSettings(), ids, {
          audit: (entry) => appendMemoryAudit(core.memoryDirPath(), entry),
        });
        if (outcome.archived > 0) core.notifyMemoryChanged();
        return { archived: outcome.archived, skipped: outcome.skipped };
      });
    }
    case 'delete-preview':
      return withDb((db) => planMemoryDeletion(db, (args as { ids: string[] }).ids));
    case 'delete': {
      const id = (args as { id: string }).id;
      return withDb((db) => {
        const impact = deleteMemoriesManually(db, [id]);
        if (!impact) return { ok: false, error: 'Memory not found.' };
        appendMemoryAudit(core.memoryDirPath(), {
          ts: new Date().toISOString(),
          action: 'memory.delete',
          actor: 'user',
          requested: [id],
          impact,
        });
        core.notifyMemoryChanged();
        return { ok: true, impact };
      });
    }
    case 'jobs-clear': {
      return withDb((db) => {
        const deleted = clearFinishedMemoryJobs(db);
        if (deleted > 0) core.notifyMemoryChanged();
        return deleted;
      });
    }
    case 'evolves-pending':
      return withDb((db) => listPendingEvolves(db));
    case 'evolves-review': {
      const { id, state } = args as { id: string; state: 'accepted' | 'rejected' };
      return withDb((db) => {
        const edge = reviewEvolvesEdge(db, id, state);
        return edge ? { ok: true, edge } : { ok: false, error: 'Evolves edge not found.' };
      });
    }
    case 'pending-writes':
      return withDb((db) => listPendingWrites(db));
    case 'pending-write-reject': {
      const id = (args as { id: string }).id;
      return withDb((db) => {
        if (!rejectPendingWrite(db, id)) {
          return { ok: false, error: 'Pending memory write not found.' };
        }
        core.notifyMemoryChanged();
        return { ok: true };
      });
    }
    case 'list-memories': {
      const query = args as { spaceIds?: string[]; limit?: number };
      return withDb((db) => ({
        items: (
          listMemories(db, {
            spaceIds: query.spaceIds ?? [],
            limit: query.limit ?? 50,
          }) as unknown[]
        ).map((m) => {
          const row = m as {
            id: string;
            title: string;
            content: string;
            createdAt: string;
            source: string;
            spaceId: string;
          };
          return {
            id: row.id,
            title: row.title,
            content: row.content,
            createdAt: row.createdAt,
            source: row.source,
            spaceId: row.spaceId,
          };
        }),
      }));
    }
    case 'graph':
      return withDb((db) => buildMemoryGraph(db, args as GraphQuery));
    case 'graph-entity':
      return withDb((db) => memoriesForEntity(db, (args as { entityId: string }).entityId));
    case 'tree':
      return withDb((db) => buildMemoryTree(db, args as TreeQuery));
    case 'insight': {
      const request = args as InsightRequest;
      const complete = await core.getMemoryCompletion();
      if (!complete) return { ok: false, error: 'No model available for interpretation.' };
      return withDbRequired(async (db) => {
        const ids = request.entityId
          ? entityMemoryIds(db, request.entityId)
          : (request.memoryIds ?? []);
        const { text, count } = memoriesForPrompt(db, ids);
        if (count === 0) return { ok: false, error: 'Nothing to interpret yet.' };
        try {
          const output = await complete(
            withMemoryLanguage(INSIGHT_PROMPT, core.memoryLanguage()),
            text
          );
          return { ok: true, text: output.trim(), sourceCount: count } satisfies InsightResult;
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      });
    }
    case 'crystallize': {
      const request = args as CrystallizeRequest;
      const complete = await core.getMemoryCompletion();
      if (!complete) return { ok: false, error: 'No model available for synthesis.' };
      return withDbRequired(async (db) => {
        const { text, count } = memoriesForPrompt(db, request.memoryIds);
        if (count < CRYSTAL_MIN_SOURCES) {
          return { ok: false, error: 'Some of those memories no longer exist.' };
        }
        let synthesis: { title: string; content: string; worthwhile: boolean };
        try {
          const raw = await complete(
            withMemoryLanguage(CRYSTALLIZE_PROMPT, core.memoryLanguage()),
            text
          );
          const parsed = looseParse(raw) as Record<string, unknown> | null;
          const title = typeof parsed?.title === 'string' ? parsed.title.trim() : '';
          const content = typeof parsed?.content === 'string' ? parsed.content.trim() : '';
          if (!content) return { ok: false, error: 'Model did not return a usable synthesis.' };
          synthesis = { title, content, worthwhile: parsed?.worthwhile !== false };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        if (!synthesis.worthwhile) {
          return {
            ok: false,
            error: 'These memories do not add up to something new — nothing was written.',
          };
        }
        const first = getMemory(db, request.memoryIds[0]);
        if (!first) return { ok: false, error: 'Source memory not found.' };
        try {
          const result = await createCrystal(
            db,
            {
              content: synthesis.content,
              title: request.title?.trim() || synthesis.title || synthesis.content.slice(0, 60),
              sourceIds: request.memoryIds,
              spaceId: first.spaceId,
            },
            { embedder: await core.getMemoryEmbedder() }
          );
          if (result.status !== 'inserted') {
            return {
              ok: false,
              title: synthesis.title,
              content: synthesis.content,
              candidates: result.candidates.map((c) => ({
                id: c.memory.id,
                title: c.memory.title,
                similarity: Number(c.similarity.toFixed(4)),
              })),
              error: 'A similar memory already exists.',
            };
          }
          core.notifyMemoryChanged();
          return {
            ok: true,
            memoryId: result.memory.id,
            title: result.memory.title,
            content: result.memory.content,
          } satisfies CrystallizeResult;
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      });
    }
    case 'shutdown':
      await core.shutdownMemoryService();
      return true;
    default:
      throw new Error(`unknown memory op: ${op}`);
  }
}

/** Main 推送的配置快照（settings 已收窄为可序列化数据） */
function applyMemoryServiceConfig(key: string, value: unknown): void {
  switch (key) {
    case 'embedding': {
      const v = value as {
        modelId: string;
        autoDownload: boolean;
        remoteIssue?: string | null;
        remoteCredentials?: { apiKey: string; baseUrl: string; organization?: string };
        idleMinutes?: number;
      };
      core.configureMemoryEmbedding({
        modelId: v.modelId,
        autoDownload: v.autoDownload === true,
        remoteIssue: v.remoteIssue ?? null,
        remoteCredentials: v.remoteCredentials ? () => v.remoteCredentials ?? null : undefined,
      });
      break;
    }
    case 'embedding-options': {
      const v = value as { modelId?: string; autoDownload?: boolean };
      core.configureMemoryEmbedding({
        ...(v.modelId !== undefined ? { modelId: v.modelId } : {}),
        ...(v.autoDownload !== undefined ? { autoDownload: v.autoDownload } : {}),
      });
      break;
    }
    case 'chat':
      core.syncMemoryChatFromSettings(value as Record<string, unknown>);
      break;
    case 'distill':
      core.syncMemoryDistillFromSettings(value as Record<string, unknown>);
      break;
    case 'distill-options':
      core.configureMemoryDistill(value as Parameters<typeof core.configureMemoryDistill>[0]);
      break;
    case 'kg':
      core.syncMemoryKgFromSettings(value as Record<string, unknown>);
      break;
    case 'kg-enabled':
      core.configureMemoryKg({ enabled: value === true });
      break;
    case 'reconcile':
      core.syncMemoryReconcileFromSettings(value as Record<string, unknown>);
      break;
    case 'forgetting':
      core.syncMemoryForgettingFromSettings(value as Record<string, unknown>);
      break;
  }
}
