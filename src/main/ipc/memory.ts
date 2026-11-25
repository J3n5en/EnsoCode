import { statSync } from 'node:fs';
import path, { basename } from 'node:path';
import { app, ipcMain } from '@platform';
import { CRYSTAL_MIN_SOURCES } from '@shared/memory/constants';
import {
  type DistillableSessionDto,
  isEvolvesReviewState,
  isMemoryEditPatch,
  isMemoryListQuery,
  isPendingMemoryWriteDecision,
  type MemoryArchiveCandidatesResult,
  type MemoryArchiveConfirmResult,
  type MemoryDecayRunDto,
  type MemoryDetail,
  type MemoryJobsSnapshot,
  type MemoryListResult,
  type MemoryMutationResult,
  type MemoryReconcileRunDto,
  type MemorySpaceKind,
  type MemoryStats,
  type PendingEvolvesReviewDto,
  type PendingMemoryWriteDto,
} from '@shared/memory/dto';
import {
  type CrystallizeResult,
  type InsightResult,
  isCrystallizeRequest,
  isGraphQuery,
  isInsightRequest,
  isTreeQuery,
  type MemoryGraphDto,
} from '@shared/memory/graphDto';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { BotStore } from '../services/bots/botStore';
import { BotChatStore } from '../services/bots/chatStore';
import {
  cancelChatModelDownload,
  deleteChatModel,
  listChatModels,
  setChatModelProgressSink,
  startChatModelDownload,
} from '../services/chatModels';
import { editAuditEntry } from '../services/memory/audit';
import {
  approvePendingMemoryWrite,
  distillSessionNow,
  editMemory,
  getMemoryDistillJobs,
  getMemoryEmbeddingError,
  getMemoryKgFailedCount,
  isMissingDb,
  memoryServiceOp,
  refreshMemoryEmbedding,
  releaseMemoryChatSlot,
  retryFailedMemoryKg,
  runMemoryForgettingNow,
  runMemoryReconcileNow,
  setMemoryChangeListener,
} from '../services/memoryHost';
import {
  cancelEmbeddingModelDownload,
  deleteEmbeddingModel,
  listEmbeddingModels,
  setEmbeddingProgressSink,
  startEmbeddingModelDownload,
} from '../services/memoryModels';
import { broadcastToRenderers, isMainRenderer } from '../services/renderers';
import { readSettings, readSettingsState } from './settings';

const EMPTY_LIST: MemoryListResult = { items: [], total: 0 };
const EMPTY_STATS: MemoryStats = {
  total: 0,
  bySpace: {},
  spaceLabels: {},
  crystals: 0,
  entities: 0,
  embedded: 0,
  databaseBytes: 0,
  neverHit: 0,
  addedLast7Days: 0,
  forgetting: { lastRunAt: null, lastRun: null, candidates: 0 },
};
const EMPTY_JOBS: MemoryJobsSnapshot = { distill: [], kg: [], reembed: null, kgFailed: 0 };
const EMPTY_GRAPH: MemoryGraphDto = { nodes: [], edges: [], totalEntities: 0 };

function isTrustedWindow(webContentsId: number): boolean {
  return isMainRenderer(webContentsId);
}

/** 服务侧库不存在（未建库）时按旧 withExistingDb 语义回落 fallback */
async function existingOp<T>(op: string, fallback: T, args?: unknown): Promise<T> {
  try {
    const result = await memoryServiceOp<T | { missing: true }>(op, args);
    return isMissingDb(result) ? fallback : result;
  } catch {
    return fallback;
  }
}

function invalidRequest(): MemoryMutationResult {
  return { ok: false, error: 'Invalid request.' };
}

function broadcast(channel: string, payload?: unknown): void {
  // 主窗口渲染层在 WebContentsView 里，必须经 broadcastToRenderers 投递，直发 shell webContents 收不到
  broadcastToRenderers(channel, payload);
}

/** 写入路径统一走这里：记忆库变了就让所有窗口的记忆视图重拉 */
function memoryChanged(): void {
  broadcast(IPC_CHANNELS.MEMORY_CHANGED);
}

export function registerMemoryHandlers(): void {
  // 下载进度广播给所有窗口（设置窗可能尚未打开或已重开）；已销毁的窗跳过
  setEmbeddingProgressSink((progress) => {
    broadcast(IPC_CHANNELS.MEMORY_MODEL_PROGRESS, progress);
  });
  setChatModelProgressSink((progress) => {
    broadcast(IPC_CHANNELS.MEMORY_CHAT_MODEL_PROGRESS, progress);
  });
  // agent 通过工具写记忆 / 后台蒸馏写入时也要刷新，不只是设置页里的操作
  setMemoryChangeListener(memoryChanged);

  ipcMain.handle(IPC_CHANNELS.MEMORY_LIST, async (event, request: unknown) => {
    if (!isTrustedWindow(event.sender.id) || !isMemoryListQuery(request)) return EMPTY_LIST;
    // 检索与 embedding 全在记忆服务进程；库不存在时按旧语义返回空
    const result = await existingOp<MemoryListResult>('list', EMPTY_LIST, request);
    const label = await spaceLabeler();
    return {
      ...result,
      items: result.items.map((item) => ({ ...item, spaceLabel: label(item.spaceId) })),
    };
  });

  ipcMain.handle(IPC_CHANNELS.MEMORY_DETAIL, async (event, id: unknown) => {
    if (!isTrustedWindow(event.sender.id) || typeof id !== 'string' || !id) return null;
    const detail = await existingOp<MemoryDetail | null>('detail', null, { id });
    if (!detail) return null;
    const label = await spaceLabeler();
    return {
      ...detail,
      spaceLabel: label(detail.spaceId),
      crystalSources: detail.crystalSources.map((s) => ({
        ...s,
        spaceLabel: label(s.spaceId),
      })),
    };
  });

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_ARCHIVE,
    async (event, id: unknown): Promise<MemoryMutationResult> => {
      if (!isTrustedWindow(event.sender.id) || typeof id !== 'string' || !id)
        return invalidRequest();
      return existingOp<MemoryMutationResult>(
        'archive',
        { ok: false, error: 'Memory database is not available.' },
        { id }
      );
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_RESTORE,
    async (event, id: unknown): Promise<MemoryMutationResult> => {
      if (!isTrustedWindow(event.sender.id) || typeof id !== 'string' || !id)
        return invalidRequest();
      return existingOp<MemoryMutationResult>(
        'restore',
        { ok: false, error: 'Memory database is not available.' },
        { id }
      );
    }
  );

  // 立即运行：走 memoryHost 的共享连接（与蒸馏 / 重嵌同一条写通道），跑完广播让列表刷新
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_FORGETTING_RUN,
    async (event): Promise<MemoryDecayRunDto | null> => {
      if (!isTrustedWindow(event.sender.id)) return null;
      return runMemoryForgettingNow();
    }
  );

  // 立即复核：绕过 memoryReconcileEnabled，排进与蒸馏 / KG 同一条 LLM 串行链；没有可用模型返回 null
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_RECONCILE_RUN,
    async (event): Promise<MemoryReconcileRunDto | null> => {
      if (!isTrustedWindow(event.sender.id)) return null;
      const summary = await runMemoryReconcileNow();
      if (summary) memoryChanged();
      return summary;
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_ARCHIVE_CANDIDATES,
    async (event, request: unknown): Promise<MemoryArchiveCandidatesResult> => {
      if (!isTrustedWindow(event.sender.id)) return { items: [], total: 0 };
      // 与 list / delete-preview 同口径：入参不合法就返回空，不猜用户想要哪一页
      if (!isCandidateQuery(request)) return { items: [], total: 0 };
      const query = request ?? { limit: 50, offset: 0 };
      const result = await existingOp<{ items: MemoryListResult['items']; total: number }>(
        'archive-candidates',
        { items: [], total: 0 },
        { query }
      );
      const label = await spaceLabeler();
      return {
        total: result.total,
        items: result.items.map((item) => ({ ...item, spaceLabel: label(item.spaceId) })),
      };
    }
  );

  // 批量确认归档：只改 lifecycle_state（可还原），不删除；条件在 Main 侧重算，不信任回传的列表
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_ARCHIVE_CANDIDATES_CONFIRM,
    async (event, ids: unknown): Promise<MemoryArchiveConfirmResult> => {
      if (!isTrustedWindow(event.sender.id) || !isIdList(ids)) return { archived: 0, skipped: 0 };
      // 审计与通知都在服务侧（审计文件也在 memory 目录）
      return existingOp<MemoryArchiveConfirmResult>(
        'archive-confirm',
        { archived: 0, skipped: 0 },
        { ids }
      );
    }
  );

  // 确认框先拿影响说明；真正删除时在事务里按同一规则重算，不信任渲染层回传的计划
  ipcMain.handle(IPC_CHANNELS.MEMORY_DELETE_PREVIEW, async (event, ids: unknown) => {
    if (!isTrustedWindow(event.sender.id) || !isIdList(ids)) return null;
    return existingOp('delete-preview', null, { ids });
  });

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_DELETE,
    async (event, id: unknown): Promise<MemoryMutationResult> => {
      if (!isTrustedWindow(event.sender.id) || typeof id !== 'string' || !id)
        return invalidRequest();
      // 审计在服务侧写入（memory/audit.jsonl 归记忆服务管）
      return existingOp<MemoryMutationResult>(
        'delete',
        { ok: false, error: 'Memory database is not available.' },
        { id }
      );
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_UPDATE,
    async (event, id: unknown, patch: unknown): Promise<MemoryMutationResult> => {
      if (!isTrustedWindow(event.sender.id) || typeof id !== 'string' || !id) {
        return invalidRequest();
      }
      if (!isMemoryEditPatch(patch)) return invalidRequest();
      try {
        const result = await editMemory(id, patch);
        if (!result) return { ok: false, error: 'Memory not found.' };
        await memoryServiceOp('audit-append', { entry: editAuditEntry(result) });
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      memoryChanged();
      return { ok: true };
    }
  );

  ipcMain.handle(IPC_CHANNELS.MEMORY_STATS, async (event) => {
    if (!isTrustedWindow(event.sender.id)) return EMPTY_STATS;
    // 遗忘状态并进 stats：同一次开库算完，不再为它多开一条连接
    const stats = await existingOp<MemoryStats>('stats', EMPTY_STATS);
    const label = await spaceLabeler();
    const kind = await spaceKinder();
    return {
      ...stats,
      embeddingError: await getMemoryEmbeddingError(),
      spaceLabels: Object.fromEntries(
        Object.keys(stats.bySpace).map((spaceId) => [spaceId, label(spaceId)])
      ),
      spaceKinds: Object.fromEntries(
        Object.keys(stats.bySpace).map((spaceId) => [spaceId, kind(spaceId)])
      ),
    };
  });

  ipcMain.handle(IPC_CHANNELS.MEMORY_JOBS_CLEAR, async (event) => {
    if (!isTrustedWindow(event.sender.id)) return 0;
    return existingOp<number>('jobs-clear', 0);
  });

  ipcMain.handle(IPC_CHANNELS.MEMORY_KG_RETRY_FAILED, async (event, raw: unknown) => {
    if (!isTrustedWindow(event.sender.id) || raw !== undefined) return 0;
    return retryFailedMemoryKg();
  });

  ipcMain.handle(IPC_CHANNELS.MEMORY_JOBS, async (event) => {
    if (!isTrustedWindow(event.sender.id)) return EMPTY_JOBS;
    const jobs = await memoryServiceOp<{
      snapshot: MemoryJobsSnapshot;
      memoryTitles: Record<string, string>;
    }>('jobs');
    const snapshot = jobs.snapshot;
    // 任务本身只存 id；界面要显示「哪个会话 / 哪条记忆」才有意义
    const titles = readConversationTitles();
    const label = await spaceLabeler();
    const projects = await projectNames();
    const memoryTitles = new Map(Object.entries(jobs.memoryTitles));
    return {
      ...snapshot,
      distill: snapshot.distill.map((job) => ({
        ...job,
        // 聚合任务没有自己的会话，列出成员会话的标题
        sessionTitle: job.sessionIds?.length
          ? job.sessionIds.map((id) => titles.get(id) ?? id.slice(0, 8)).join(' + ')
          : (titles.get(job.sessionId) ?? null),
        projectName: job.projectId ? (projects.get(job.projectId) ?? null) : null,
      })),
      kg: snapshot.kg.map((job) => ({
        ...job,
        memoryTitle: memoryTitles.get(job.memoryId) ?? null,
      })),
      reembed: snapshot.reembed
        ? { ...snapshot.reembed, target: label(snapshot.reembed.target) }
        : null,
      kgFailed: await getMemoryKgFailedCount(),
    };
  });

  ipcMain.handle(IPC_CHANNELS.MEMORY_EVOLVES_PENDING, async (event) => {
    if (!isTrustedWindow(event.sender.id)) return [];
    const items = await existingOp<PendingEvolvesReviewDto[]>('evolves-pending', []);
    if (items.length === 0) return [];
    // 空间名要项目注册表，服务层只知道 space id
    const label = await spaceLabeler();
    return items.map((item) => ({
      ...item,
      older: { ...item.older, spaceLabel: label(item.older.spaceId) },
      newer: { ...item.newer, spaceLabel: label(item.newer.spaceId) },
    }));
  });

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_EVOLVES_REVIEW,
    async (event, id: unknown, state: unknown): Promise<MemoryMutationResult> => {
      if (
        !isTrustedWindow(event.sender.id) ||
        typeof id !== 'string' ||
        !id ||
        !isEvolvesReviewState(state)
      ) {
        return invalidRequest();
      }
      return existingOp<MemoryMutationResult>(
        'evolves-review',
        { ok: false, error: 'Memory database is not available.' },
        { id, state }
      );
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_PENDING_WRITES,
    async (event): Promise<PendingMemoryWriteDto[]> => {
      if (!isTrustedWindow(event.sender.id)) return [];
      const rows = await existingOp<
        (PendingMemoryWriteDto & { payload?: Record<string, unknown> })[]
      >('pending-writes', []);
      if (rows.length === 0) return [];
      const label = await spaceLabeler();
      return rows.map(({ payload: _payload, ...row }) => ({
        ...row,
        spaceLabel: label(row.spaceId),
        originLabel: row.botId ? label(`bot:${row.botId}`) : '',
      }));
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_PENDING_WRITE_REVIEW,
    async (event, id: unknown, decision: unknown): Promise<MemoryMutationResult> => {
      if (
        !isTrustedWindow(event.sender.id) ||
        typeof id !== 'string' ||
        !id ||
        !isPendingMemoryWriteDecision(decision)
      ) {
        return invalidRequest();
      }
      if (decision === 'approve') return approvePendingMemoryWrite(id);
      return existingOp<MemoryMutationResult>(
        'pending-write-reject',
        { ok: false, error: 'Memory database is not available.' },
        { id }
      );
    }
  );

  ipcMain.handle(IPC_CHANNELS.MEMORY_MODELS, (event) => {
    if (!isTrustedWindow(event.sender.id)) return [];
    return listEmbeddingModels();
  });

  // 下载是长任务：这里只启动，进度走 MEMORY_MODEL_PROGRESS 事件，不阻塞渲染层
  ipcMain.handle(IPC_CHANNELS.MEMORY_MODEL_DOWNLOAD, (event, modelId: unknown) => {
    if (!isTrustedWindow(event.sender.id) || typeof modelId !== 'string' || !modelId) return false;
    // 下载完成后必须让 memoryHost 重新探测：它缓存了 provider，且自己的 db 是懒开的
    void startEmbeddingModelDownload(modelId).then((ok) => {
      if (ok) refreshMemoryEmbedding();
    });
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.MEMORY_MODEL_CANCEL, (event, modelId: unknown) => {
    if (!isTrustedWindow(event.sender.id) || typeof modelId !== 'string' || !modelId) return false;
    return cancelEmbeddingModelDownload(modelId);
  });

  ipcMain.handle(IPC_CHANNELS.MEMORY_MODEL_DELETE, (event, modelId: unknown) => {
    if (!isTrustedWindow(event.sender.id) || typeof modelId !== 'string' || !modelId) return false;
    const removed = deleteEmbeddingModel(modelId);
    if (removed) refreshMemoryEmbedding({ reembed: false });
    return removed;
  });

  ipcMain.handle(IPC_CHANNELS.MEMORY_CHAT_MODELS, (event) => {
    if (!isTrustedWindow(event.sender.id)) return [];
    return listChatModels();
  });

  ipcMain.handle(IPC_CHANNELS.MEMORY_CHAT_MODEL_DOWNLOAD, (event, modelId: unknown) => {
    if (!isTrustedWindow(event.sender.id) || typeof modelId !== 'string' || !modelId) return false;
    void startChatModelDownload(modelId);
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.MEMORY_CHAT_MODEL_CANCEL, (event, modelId: unknown) => {
    if (!isTrustedWindow(event.sender.id) || typeof modelId !== 'string' || !modelId) return false;
    return cancelChatModelDownload(modelId);
  });

  ipcMain.handle(IPC_CHANNELS.MEMORY_CHAT_MODEL_DELETE, async (event, modelId: unknown) => {
    if (!isTrustedWindow(event.sender.id) || typeof modelId !== 'string' || !modelId) return false;
    // 服务侧可能正持有该模型（蒸馏补全槽），先 RPC 释放再删文件；Windows 上 mmap 会拦 rm
    await releaseMemoryChatSlot().catch(() => false);
    return deleteChatModel(modelId);
  });

  // 手动补齐向量：自动触发点（下载完成、开库、切模型）都可能因为库懒开而错过，
  // 给用户一个能直接点的入口比继续加隐式触发更可靠
  ipcMain.handle(IPC_CHANNELS.MEMORY_REEMBED, (event) => {
    if (!isTrustedWindow(event.sender.id)) return false;
    refreshMemoryEmbedding();
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.MEMORY_GRAPH, async (event, request: unknown) => {
    if (!isTrustedWindow(event.sender.id) || !isGraphQuery(request)) return EMPTY_GRAPH;
    const graph = await existingOp<MemoryGraphDto>('graph', EMPTY_GRAPH, request);
    const label = await spaceLabeler();
    return {
      ...graph,
      nodes: graph.nodes.map((n) => ({ ...n, spaceLabel: label(n.spaceId) })),
    };
  });

  ipcMain.handle(IPC_CHANNELS.MEMORY_GRAPH_ENTITY, (event, entityId: unknown) => {
    if (!isTrustedWindow(event.sender.id) || typeof entityId !== 'string' || !entityId) return [];
    return existingOp('graph-entity', [], { entityId });
  });

  ipcMain.handle(IPC_CHANNELS.MEMORY_TREE, (event, request: unknown) => {
    if (!isTrustedWindow(event.sender.id) || !isTreeQuery(request)) return [];
    return existingOp('tree', [], request);
  });

  // 解读：模型只读不写，失败原样回报（静默失败会让用户以为按钮坏了）
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_INSIGHT,
    async (event, request: unknown): Promise<InsightResult> => {
      if (!isTrustedWindow(event.sender.id) || !isInsightRequest(request)) {
        return { ok: false, error: 'Invalid request.' };
      }
      // 补全与库都在服务侧：解读整条搬到服务，Main 只校验转发
      return memoryServiceOp<InsightResult>('insight', request);
    }
  );

  // 结晶：模型合成内容 → 走 createCrystal 的完整写入链路（含候选网）
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_CRYSTALLIZE,
    async (event, request: unknown): Promise<CrystallizeResult> => {
      if (!isTrustedWindow(event.sender.id) || !isCrystallizeRequest(request)) {
        return { ok: false, error: 'Invalid request.' };
      }
      if (request.memoryIds.length < CRYSTAL_MIN_SOURCES) {
        return { ok: false, error: `Pick at least ${CRYSTAL_MIN_SOURCES} memories.` };
      }
      return memoryServiceOp<CrystallizeResult>('crystallize', request);
    }
  );

  ipcMain.handle(IPC_CHANNELS.MEMORY_DISTILLABLE_SESSIONS, async (event) => {
    if (!isTrustedWindow(event.sender.id)) return [];
    return listDistillableSessions();
  });

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_DISTILL_SESSION,
    async (event, sessionId: unknown, force: unknown) => {
      if (!isTrustedWindow(event.sender.id) || typeof sessionId !== 'string' || !sessionId) {
        return false;
      }
      const target = (await listDistillableSessionRecords()).find((s) => s.sessionId === sessionId);
      if (!target) return false;
      return distillSessionNow(
        {
          sessionId: target.sessionId,
          sessionFile: target.sessionFile,
          projectId: target.projectId,
        },
        { force: force === true }
      );
    }
  );
}

interface DistillableRecord extends DistillableSessionDto {
  sessionFile: string;
}

async function projectNames(): Promise<Map<string, string>> {
  const { getSourceAuthorityRegistry } = await import('./agent');
  const registry = getSourceAuthorityRegistry();
  const names = new Map<string, string>();
  for (const project of registry?.projection().projects ?? []) {
    if (project.kind === 'bot-home') continue;
    if (project.kind === 'scratch') {
      names.set(project.projectId, '临时会话');
      continue;
    }
    if (project.kind === 'secretary') {
      names.set(project.projectId, '秘书');
      continue;
    }
    names.set(project.projectId, basename(project.canonicalPath));
  }
  return names;
}

const GLOBAL_SPACE_LABEL = 'Global';
const PROJECT_SPACE_PREFIX = 'proj:';

function isIdList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 500 &&
    value.every((id) => typeof id === 'string' && id.length > 0)
  );
}

/** 候选列表分页参数；缺省按第一页，脏值直接回落而不是报错 */
function isCandidateQuery(value: unknown): value is { limit?: number; offset?: number } {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (
    row.limit !== undefined &&
    (!Number.isSafeInteger(row.limit) || (row.limit as number) < 1 || (row.limit as number) > 200)
  ) {
    return false;
  }
  if (
    row.offset !== undefined &&
    (!Number.isSafeInteger(row.offset) || (row.offset as number) < 0)
  ) {
    return false;
  }
  return true;
}

/** 秘书私有空间也是 proj: 前缀，只有项目注册表知道哪个项目是秘书 */
async function spaceKinder(): Promise<(spaceId: string) => MemorySpaceKind> {
  const { getSourceAuthorityRegistry } = await import('./agent');
  const secretary = new Set(
    (getSourceAuthorityRegistry()?.projection().projects ?? [])
      .filter((project) => project.kind === 'secretary')
      .map((project) => project.projectId)
  );
  return (spaceId) => {
    if (spaceId.startsWith('bot:')) return 'bot';
    if (spaceId.startsWith('chat:')) return 'chat';
    if (!spaceId.startsWith(PROJECT_SPACE_PREFIX)) return 'global';
    return secretary.has(spaceId.slice(PROJECT_SPACE_PREFIX.length)) ? 'secretary' : 'project';
  };
}

/**
 * 设置里的项目名。注册表只含本次运行打开过的项目，未打开过的项目在这里还有名字，
 * 否则待审阅 / 列表里会退化成 `proj:` 的短 id，用户看不出这是哪个空间。
 */
function settingsProjectNames(): Map<string, string> {
  const names = new Map<string, string>();
  const projects = readSettingsState().projects;
  if (!Array.isArray(projects)) return names;
  for (const entry of projects) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, name } = entry as { id?: unknown; name?: unknown };
    if (typeof id === 'string' && typeof name === 'string' && name.trim()) {
      names.set(id, name.trim());
    }
  }
  return names;
}

/** space id → 项目名。项目已删或拿不到注册表时回退到短 id，不把 `proj:<uuid>` 原样给用户 */
async function spaceLabeler(): Promise<(spaceId: string) => string> {
  const { getSourceAuthorityRegistry } = await import('./agent');
  const registry = getSourceAuthorityRegistry();
  const names = settingsProjectNames();
  for (const project of registry?.projection().projects ?? []) {
    if (project.kind === 'bot-home') continue;
    if (project.kind === 'scratch') {
      names.set(project.projectId, '临时会话');
      continue;
    }
    if (project.kind === 'secretary') {
      names.set(project.projectId, '秘书');
      continue;
    }
    names.set(project.projectId, basename(project.canonicalPath));
  }
  const bots = new BotStore(path.join(app.getPath('userData'), 'bots'));
  const chats = new BotChatStore(path.join(app.getPath('userData'), 'bot-chats'));
  return (spaceId) => {
    if (spaceId.startsWith('bot:'))
      return `成员：${bots.get(spaceId.slice(4))?.name ?? '已删除成员'}`;
    if (spaceId.startsWith('chat:'))
      return `群：${chats.get(spaceId.slice(5))?.title ?? '已删除群'}`;
    if (!spaceId.startsWith(PROJECT_SPACE_PREFIX)) return GLOBAL_SPACE_LABEL;
    const projectId = spaceId.slice(PROJECT_SPACE_PREFIX.length);
    return names.get(projectId) ?? projectId.slice(0, 8);
  };
}

/**
 * 会话标题的权威在渲染层 zustand persist（`enso-conversations`），它通过 settings.writeKey 落盘，
 * 所以 Main 可以直读。拿不到时回退到 id 前缀，不编假标题。
 */
function readConversationTitles(): Map<string, string> {
  const titles = new Map<string, string>();
  const settings = readSettings();
  const store = settings?.['enso-conversations'];
  if (!store || typeof store !== 'object') return titles;
  const state = (store as Record<string, unknown>).state;
  if (!state || typeof state !== 'object') return titles;
  const conversations = (state as Record<string, unknown>).conversations;
  if (!conversations || typeof conversations !== 'object') return titles;
  // zustand 里是 Record<id, Conversation>，不是数组；早期按数组解析导致一条标题都读不到
  const entries = Array.isArray(conversations)
    ? conversations
    : Object.values(conversations as Record<string, unknown>);
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, title } = entry as { id?: unknown; title?: unknown };
    if (typeof id === 'string' && typeof title === 'string' && title.trim()) {
      titles.set(id, title.trim());
    }
  }
  return titles;
}

/** 权威会话记录（source-registry.json）里有 jsonl 的 root 会话；与记忆库对账出已提炼状态 */
async function listDistillableSessionRecords(): Promise<DistillableRecord[]> {
  const { getSourceAuthorityRegistry } = await import('./agent');
  const registry = getSourceAuthorityRegistry();
  if (!registry) return [];
  const snapshot = registry.projection();
  const projects = new Map(snapshot.projects.map((p) => [p.projectId, p]));
  const distilled = new Set(
    (await getMemoryDistillJobs(200)).flatMap((job) =>
      job.payload.sessions?.length
        ? job.payload.sessions.map((s) => s.sessionId)
        : [job.payload.sessionId]
    )
  );
  const titles = readConversationTitles();
  const sessionRoot = path.join(app.getPath('userData'), 'agent', 'sessions');
  const records: DistillableRecord[] = [];
  for (const conversation of snapshot.conversations) {
    const sessionFile = conversation.sessionFile;
    if (!sessionFile) continue;
    const project = projects.get(conversation.projectId);
    let updatedAt: string | null = null;
    try {
      updatedAt = statSync(path.resolve(sessionRoot, sessionFile)).mtime.toISOString();
    } catch {
      // jsonl 已被清理：仍列出来，触发时会因读不到内容自然失败
    }
    records.push({
      sessionId: conversation.conversationId,
      sessionFile,
      title: titles.get(conversation.conversationId) ?? conversation.conversationId.slice(0, 8),
      projectId: conversation.projectId || null,
      projectName: project ? basename(project.canonicalPath) : null,
      distilled: distilled.has(conversation.conversationId),
      updatedAt,
    });
  }
  // 新会话在前；没有 mtime 的排最后
  return records.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

async function listDistillableSessions(): Promise<DistillableSessionDto[]> {
  return (await listDistillableSessionRecords()).map(({ sessionFile: _file, ...dto }) => dto);
}
