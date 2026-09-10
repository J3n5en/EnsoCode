import { statSync } from 'node:fs';
import path, { basename } from 'node:path';
import { CRYSTAL_MIN_SOURCES } from '@shared/memory/constants';
import {
  type DistillableSessionDto,
  isEvolvesReviewState,
  isMemoryListQuery,
  isMemoryRetrievalMode,
  type MemoryJobsSnapshot,
  type MemoryListResult,
  type MemoryMutationResult,
  type MemoryStats,
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
import { CRYSTALLIZE_PROMPT, INSIGHT_PROMPT, withMemoryLanguage } from '@shared/memory/prompts';
import { IPC_CHANNELS } from '@shared/types';
import type Database from 'better-sqlite3';
import { app, BrowserWindow, ipcMain } from 'electron';
import {
  cancelChatModelDownload,
  deleteChatModel,
  listChatModels,
  setChatModelProgressSink,
  startChatModelDownload,
} from '../services/chatModels';
import { createCrystal } from '../services/memory/crystal';
import { looseParse } from '../services/memory/distill';
import {
  buildMemoryGraph,
  buildMemoryTree,
  entityMemoryIds,
  memoriesForEntity,
  memoriesForPrompt,
} from '../services/memory/graph';
import { createSearchAssist } from '../services/memory/searchLlm';
import { getMemory } from '../services/memory/store';
import {
  archiveMemory,
  clearFinishedMemoryJobs,
  deleteMemoryPermanently,
  getMemoryDetail,
  getMemoryStats,
  listMemoriesForAdmin,
  listPendingEvolves,
  openExistingMemoryDb,
  restoreMemory,
  reviewEvolvesEdge,
  searchMemoriesForAdmin,
  toMemoryJobsSnapshot,
} from '../services/memoryAdmin';
import {
  distillSessionNow,
  getMemoryCompletion,
  getMemoryDistillJobs,
  getMemoryEmbedder,
  getMemoryEmbeddingError,
  getMemoryKgJobs,
  getMemoryReembedProgress,
  memoryDatabase,
  memoryLanguage,
  refreshMemoryEmbedding,
  setMemoryChangeListener,
} from '../services/memoryHost';
import {
  cancelEmbeddingModelDownload,
  deleteEmbeddingModel,
  listEmbeddingModels,
  setEmbeddingProgressSink,
  startEmbeddingModelDownload,
} from '../services/memoryModels';
import { isMainWebContents } from '../windows/MainWindow';
import { isSettingsWebContents } from '../windows/SettingsWindow';
import { readSettings } from './settings';

const EMPTY_LIST: MemoryListResult = { items: [], total: 0 };
const EMPTY_STATS: MemoryStats = {
  total: 0,
  bySpace: {},
  spaceLabels: {},
  crystals: 0,
  entities: 0,
  embedded: 0,
  databaseBytes: 0,
};
const EMPTY_JOBS: MemoryJobsSnapshot = { distill: [], kg: [], reembed: null };
const EMPTY_GRAPH: MemoryGraphDto = { nodes: [], edges: [], totalEntities: 0 };

function isTrustedWindow(webContentsId: number): boolean {
  return isMainWebContents(webContentsId) || isSettingsWebContents(webContentsId);
}

function memoryDbPath(): string {
  return path.join(app.getPath('userData'), 'memory', 'memory.db');
}

function withExistingDb<T>(fallback: T, run: (db: Database.Database) => T): T {
  const db = openExistingMemoryDb(memoryDbPath());
  if (!db) return fallback;
  try {
    return run(db);
  } catch {
    return fallback;
  } finally {
    db.close();
  }
}

async function withExistingDbAsync<T>(
  fallback: T,
  run: (db: Database.Database) => Promise<T>
): Promise<T> {
  const db = openExistingMemoryDb(memoryDbPath());
  if (!db) return fallback;
  try {
    return await run(db);
  } catch {
    return fallback;
  } finally {
    db.close();
  }
}

function invalidRequest(): MemoryMutationResult {
  return { ok: false, error: 'Invalid request.' };
}

function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
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
    // 语义模式要拿 embedder，且 searchMemories 是异步的；库不存在时两条路径都返回空
    const retrieval = isMemoryRetrievalMode(request.mode);
    const embedder = retrieval ? await getMemoryEmbedder() : null;
    const assist = request.mode === 'deep' ? createSearchAssist(await getMemoryCompletion()) : null;
    const result = await withExistingDbAsync(EMPTY_LIST, (db) =>
      retrieval
        ? searchMemoriesForAdmin(db, request, embedder, assist)
        : Promise.resolve(listMemoriesForAdmin(db, request))
    );
    const label = await spaceLabeler();
    return {
      ...result,
      items: result.items.map((item) => ({ ...item, spaceLabel: label(item.spaceId) })),
    };
  });

  ipcMain.handle(IPC_CHANNELS.MEMORY_DETAIL, async (event, id: unknown) => {
    if (!isTrustedWindow(event.sender.id) || typeof id !== 'string' || !id) return null;
    const detail = withExistingDb(null, (db) => getMemoryDetail(db, id));
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

  ipcMain.handle(IPC_CHANNELS.MEMORY_ARCHIVE, (event, id: unknown): MemoryMutationResult => {
    if (!isTrustedWindow(event.sender.id) || typeof id !== 'string' || !id) return invalidRequest();
    return withExistingDb<MemoryMutationResult>(
      { ok: false, error: 'Memory database is not available.' },
      (db) => {
        if (!archiveMemory(db, id)) return { ok: false, error: 'Memory not found.' };
        const memory = getMemoryDetail(db, id);
        memoryChanged();
        return memory ? { ok: true, memory } : { ok: false, error: 'Memory not found.' };
      }
    );
  });

  ipcMain.handle(IPC_CHANNELS.MEMORY_RESTORE, (event, id: unknown): MemoryMutationResult => {
    if (!isTrustedWindow(event.sender.id) || typeof id !== 'string' || !id) return invalidRequest();
    return withExistingDb<MemoryMutationResult>(
      { ok: false, error: 'Memory database is not available.' },
      (db) => {
        if (!restoreMemory(db, id)) return { ok: false, error: 'Memory not found.' };
        const memory = getMemoryDetail(db, id);
        memoryChanged();
        return memory ? { ok: true, memory } : { ok: false, error: 'Memory not found.' };
      }
    );
  });

  ipcMain.handle(IPC_CHANNELS.MEMORY_DELETE, (event, id: unknown): MemoryMutationResult => {
    if (!isTrustedWindow(event.sender.id) || typeof id !== 'string' || !id) return invalidRequest();
    return withExistingDb<MemoryMutationResult>(
      { ok: false, error: 'Memory database is not available.' },
      (db) => {
        if (!deleteMemoryPermanently(db, id)) return { ok: false, error: 'Memory not found.' };
        memoryChanged();
        return { ok: true };
      }
    );
  });

  ipcMain.handle(IPC_CHANNELS.MEMORY_STATS, async (event) => {
    if (!isTrustedWindow(event.sender.id)) return EMPTY_STATS;
    const stats = withExistingDb(EMPTY_STATS, getMemoryStats);
    const label = await spaceLabeler();
    return {
      ...stats,
      embeddingError: getMemoryEmbeddingError(),
      spaceLabels: Object.fromEntries(
        Object.keys(stats.bySpace).map((spaceId) => [spaceId, label(spaceId)])
      ),
    };
  });

  ipcMain.handle(IPC_CHANNELS.MEMORY_JOBS_CLEAR, (event) => {
    if (!isTrustedWindow(event.sender.id)) return 0;
    return withExistingDb(0, (db) => {
      const deleted = clearFinishedMemoryJobs(db);
      if (deleted > 0) memoryChanged();
      return deleted;
    });
  });

  ipcMain.handle(IPC_CHANNELS.MEMORY_JOBS, async (event) => {
    if (!isTrustedWindow(event.sender.id)) return EMPTY_JOBS;
    const snapshot = toMemoryJobsSnapshot(
      getMemoryDistillJobs(),
      getMemoryKgJobs(),
      getMemoryReembedProgress()
    );
    // 任务本身只存 id；界面要显示「哪个会话 / 哪条记忆」才有意义
    const titles = readConversationTitles();
    const label = await spaceLabeler();
    const projects = await projectNames();
    // 没有 kg 任务就不必为查标题开库（保持「不需要就不碰库」）
    const memoryTitles =
      snapshot.kg.length === 0
        ? new Map<string, string>()
        : withExistingDb(new Map<string, string>(), (db) =>
            memoryTitlesFor(
              db,
              snapshot.kg.map((job) => job.memoryId)
            )
          );
    return {
      ...snapshot,
      distill: snapshot.distill.map((job) => ({
        ...job,
        sessionTitle: titles.get(job.sessionId) ?? null,
        projectName: job.projectId ? (projects.get(job.projectId) ?? null) : null,
      })),
      kg: snapshot.kg.map((job) => ({
        ...job,
        memoryTitle: memoryTitles.get(job.memoryId) ?? null,
      })),
      reembed: snapshot.reembed
        ? { ...snapshot.reembed, target: label(snapshot.reembed.target) }
        : null,
    };
  });

  ipcMain.handle(IPC_CHANNELS.MEMORY_EVOLVES_PENDING, (event) => {
    if (!isTrustedWindow(event.sender.id)) return [];
    return withExistingDb([], listPendingEvolves);
  });

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_EVOLVES_REVIEW,
    (event, id: unknown, state: unknown): MemoryMutationResult => {
      if (
        !isTrustedWindow(event.sender.id) ||
        typeof id !== 'string' ||
        !id ||
        !isEvolvesReviewState(state)
      ) {
        return invalidRequest();
      }
      return withExistingDb<MemoryMutationResult>(
        { ok: false, error: 'Memory database is not available.' },
        (db) => {
          const edge = reviewEvolvesEdge(db, id, state);
          return edge ? { ok: true, edge } : { ok: false, error: 'Evolves edge not found.' };
        }
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

  ipcMain.handle(IPC_CHANNELS.MEMORY_CHAT_MODEL_DELETE, (event, modelId: unknown) => {
    if (!isTrustedWindow(event.sender.id) || typeof modelId !== 'string' || !modelId) return false;
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
    const graph = withExistingDb(EMPTY_GRAPH, (db) => buildMemoryGraph(db, request));
    const label = await spaceLabeler();
    return {
      ...graph,
      nodes: graph.nodes.map((n) => ({ ...n, spaceLabel: label(n.spaceId) })),
    };
  });

  ipcMain.handle(IPC_CHANNELS.MEMORY_GRAPH_ENTITY, (event, entityId: unknown) => {
    if (!isTrustedWindow(event.sender.id) || typeof entityId !== 'string' || !entityId) return [];
    return withExistingDb([], (db) => memoriesForEntity(db, entityId));
  });

  ipcMain.handle(IPC_CHANNELS.MEMORY_TREE, (event, request: unknown) => {
    if (!isTrustedWindow(event.sender.id) || !isTreeQuery(request)) return [];
    return withExistingDb([], (db) => buildMemoryTree(db, request));
  });

  // 解读：模型只读不写，失败原样回报（静默失败会让用户以为按钮坏了）
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_INSIGHT,
    async (event, request: unknown): Promise<InsightResult> => {
      if (!isTrustedWindow(event.sender.id) || !isInsightRequest(request)) {
        return { ok: false, error: 'Invalid request.' };
      }
      const complete = await getMemoryCompletion();
      if (!complete) return { ok: false, error: 'No model available for interpretation.' };
      const db = memoryDatabase();
      const ids = request.entityId
        ? entityMemoryIds(db, request.entityId)
        : (request.memoryIds ?? []);
      const { text, count } = memoriesForPrompt(db, ids);
      if (count === 0) return { ok: false, error: 'Nothing to interpret yet.' };
      try {
        const output = await complete(withMemoryLanguage(INSIGHT_PROMPT, memoryLanguage()), text);
        return { ok: true, text: output.trim(), sourceCount: count };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
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
      const complete = await getMemoryCompletion();
      if (!complete) return { ok: false, error: 'No model available for synthesis.' };
      const db = memoryDatabase();
      const { text, count } = memoriesForPrompt(db, request.memoryIds);
      if (count < CRYSTAL_MIN_SOURCES) {
        return { ok: false, error: 'Some of those memories no longer exist.' };
      }
      let synthesis: { title: string; content: string; worthwhile: boolean };
      try {
        const raw = await complete(withMemoryLanguage(CRYSTALLIZE_PROMPT, memoryLanguage()), text);
        const parsed = looseParse(raw) as Record<string, unknown> | null;
        const title = typeof parsed?.title === 'string' ? parsed.title.trim() : '';
        const content = typeof parsed?.content === 'string' ? parsed.content.trim() : '';
        if (!content) return { ok: false, error: 'Model did not return a usable synthesis.' };
        synthesis = { title, content, worthwhile: parsed?.worthwhile !== false };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
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
          { embedder: await getMemoryEmbedder() }
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
        return {
          ok: true,
          memoryId: result.memory.id,
          title: result.memory.title,
          content: result.memory.content,
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
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

/** kg 任务只存 memoryId，列表里要显示标题 */
function memoryTitlesFor(db: Database.Database, ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const unique = [...new Set(ids)];
  const rows = db
    .prepare(`SELECT id, title FROM memories WHERE id IN (${unique.map(() => '?').join(',')})`)
    .all(...unique) as { id: string; title: string }[];
  for (const row of rows) out.set(row.id, row.title);
  return out;
}

async function projectNames(): Promise<Map<string, string>> {
  const { getSourceAuthorityRegistry } = await import('./agent');
  const registry = getSourceAuthorityRegistry();
  const names = new Map<string, string>();
  for (const project of registry?.projection().projects ?? []) {
    names.set(project.projectId, basename(project.canonicalPath));
  }
  return names;
}

const GLOBAL_SPACE_LABEL = 'Global';
const PROJECT_SPACE_PREFIX = 'proj:';

/** space id → 项目名。项目已删或拿不到注册表时回退到短 id，不把 `proj:<uuid>` 原样给用户 */
async function spaceLabeler(): Promise<(spaceId: string) => string> {
  const { getSourceAuthorityRegistry } = await import('./agent');
  const registry = getSourceAuthorityRegistry();
  const names = new Map<string, string>();
  for (const project of registry?.projection().projects ?? []) {
    names.set(project.projectId, basename(project.canonicalPath));
  }
  return (spaceId) => {
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
  const distilled = new Set(getMemoryDistillJobs(200).map((job) => job.payload.sessionId));
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
