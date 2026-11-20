import { IPC_CHANNELS } from '@shared/types';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  db: { close: vi.fn() },
  openExistingMemoryDb: vi.fn(),
  listMemoriesForAdmin: vi.fn(() => ({ items: [], total: 0 })),
  getMemoryDetail: vi.fn(() => null),
  archiveMemory: vi.fn(() => null),
  restoreMemory: vi.fn(() => null),
  deleteMemoriesManually: vi.fn((): unknown => null),
  planMemoryDeletion: vi.fn((): unknown => null),
  appendMemoryAudit: vi.fn(),
  clearFinishedMemoryJobs: vi.fn(() => 0),
  getMemoryStats: vi.fn(),
  listPendingEvolves: vi.fn((): unknown[] => []),
  reviewEvolvesEdge: vi.fn(() => null),
  toMemoryJobsSnapshot: vi.fn(() => ({ distill: [], kg: [], reembed: null })),
  getMemoryDistillJobs: vi.fn(() => []),
  getMemoryKgJobs: vi.fn(() => []),
  getMemoryKgFailedCount: vi.fn(() => 2),
  getMemoryReembedProgress: vi.fn(() => null),
  distillSessionNow: vi.fn(async () => true),
  getMemoryCompletion: vi.fn(
    async () => null as null | ((s: string, u: string) => Promise<string>)
  ),
  listPendingWrites: vi.fn((): unknown[] => []),
  rejectPendingWrite: vi.fn(() => false),
  approvePendingMemoryWrite: vi.fn(
    async (): Promise<{ ok: boolean; error?: string }> => ({ ok: false, error: 'x' })
  ),
  editMemory: vi.fn((): unknown => null),
  retryFailedMemoryKg: vi.fn(() => 0),
  runMemoryForgettingNow: vi.fn(() => ({
    ranAt: '2026-06-01T00:00:00.000Z',
    scored: 1,
    candidates: 0,
    archived: 0,
    staleDays: 90,
    maxImportance: 0.5,
    autoArchive: false,
    durationMs: 1,
  })),
  runMemoryReconcileNow: vi.fn(
    async (): Promise<{ challenges: number } | null> => ({ challenges: 1 })
  ),
  getForgettingState: vi.fn(() => ({
    lastRunAt: '2026-06-01T00:00:00.000Z',
    lastRun: null,
    candidates: 3,
  })),
  listArchiveCandidates: vi.fn(() => ({ items: [], total: 0 })),
  archiveCandidatesConfirmed: vi.fn(() => ({ archived: 0, skipped: 0, ids: [] as string[] })),
  registry: null as { projection: () => unknown } | null,
  settings: null as Record<string, unknown> | null,
  send: vi.fn(),
  shellSend: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/user-data') },
  BrowserWindow: {
    // 主窗口是 shell + WebContentsView：直接发给 shell webContents 渲染层收不到
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.shellSend } }],
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
  },
}));
// memory.ts 动态 import('./agent') 取项目/会话权威；真模块会拉进 utilityProcess 与 vite 专属的 ?modulePath
vi.mock('./agent', () => ({
  getSourceAuthorityRegistry: () => mocks.registry,
}));
vi.mock('./settings', () => ({
  readSettings: () => mocks.settings,
  readSettingsState: () =>
    (mocks.settings?.['enso-settings'] as { state?: Record<string, unknown> } | undefined)?.state ??
    {},
}));
vi.mock('../services/renderers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/renderers')>()),
  isMainRenderer: (id: number) => id === 1,
  isSettingsRenderer: () => false,
  broadcastToRenderers: (channel: string, ...args: unknown[]) => mocks.send(channel, ...args),
}));
vi.mock('../services/memoryAdmin', () => ({
  openExistingMemoryDb: mocks.openExistingMemoryDb,
  listMemoriesForAdmin: mocks.listMemoriesForAdmin,
  getMemoryDetail: mocks.getMemoryDetail,
  archiveMemory: mocks.archiveMemory,
  restoreMemory: mocks.restoreMemory,
  clearFinishedMemoryJobs: mocks.clearFinishedMemoryJobs,
  getMemoryStats: mocks.getMemoryStats,
  listPendingEvolves: mocks.listPendingEvolves,
  reviewEvolvesEdge: mocks.reviewEvolvesEdge,
  toMemoryJobsSnapshot: mocks.toMemoryJobsSnapshot,
  toMemoryListItem: (memory: Record<string, unknown>) => ({
    id: memory.id,
    title: memory.title,
    contentSummary: '',
    unitType: 'fact',
    spaceId: memory.spaceId,
    spaceLabel: memory.spaceId,
    importance: memory.importance,
    isCrystal: false,
    isLatest: true,
    lifecycleState: 'active',
    createdAt: '',
    updatedAt: '',
    appearances: 0,
    lastHitAt: null,
    hitCount: 0,
    archiveCandidateAt: null,
  }),
}));
vi.mock('../services/memoryHost', () => ({
  getMemoryDistillJobs: mocks.getMemoryDistillJobs,
  getMemoryKgJobs: mocks.getMemoryKgJobs,
  getMemoryKgFailedCount: mocks.getMemoryKgFailedCount,
  getMemoryReembedProgress: mocks.getMemoryReembedProgress,
  distillSessionNow: mocks.distillSessionNow,
  getMemoryCompletion: mocks.getMemoryCompletion,
  getMemoryEmbedder: vi.fn(async () => null),
  memoryDatabase: vi.fn(() => mocks.db),
  memoryLanguage: vi.fn(() => 'en'),
  refreshMemoryEmbedding: vi.fn(),
  getMemoryEmbeddingError: vi.fn(() => null),
  setMemoryChangeListener: vi.fn(),
  approvePendingMemoryWrite: mocks.approvePendingMemoryWrite,
  editMemory: mocks.editMemory,
  retryFailedMemoryKg: mocks.retryFailedMemoryKg,
  forgettingSettings: () => ({
    enabled: true,
    archiveCandidates: true,
    autoArchive: false,
    staleDays: 90,
    maxImportance: 0.5,
    intervalDays: 7,
  }),
  runMemoryForgettingNow: mocks.runMemoryForgettingNow,
  runMemoryReconcileNow: mocks.runMemoryReconcileNow,
}));
vi.mock('../services/memory/pending', () => ({
  listPendingWrites: mocks.listPendingWrites,
  rejectPendingWrite: mocks.rejectPendingWrite,
}));
vi.mock('../services/memory/forgetting', () => ({
  getForgettingState: mocks.getForgettingState,
  listArchiveCandidates: mocks.listArchiveCandidates,
  archiveCandidatesConfirmed: mocks.archiveCandidatesConfirmed,
}));
vi.mock('../services/memory/manual', () => ({
  deleteMemoriesManually: mocks.deleteMemoriesManually,
  planMemoryDeletion: mocks.planMemoryDeletion,
}));
vi.mock('../services/memory/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/memory/audit')>()),
  appendMemoryAudit: mocks.appendMemoryAudit,
}));
vi.mock('../services/memory/graph', () => ({
  buildMemoryGraph: vi.fn(() => ({ nodes: [], edges: [], totalEntities: 0 })),
  buildMemoryTree: vi.fn(() => []),
  entityMemoryIds: vi.fn(() => []),
  memoriesForEntity: vi.fn(() => []),
  memoriesForPrompt: vi.fn(() => ({ text: '', count: 0 })),
}));
vi.mock('../services/memory/crystal', () => ({ createCrystal: vi.fn() }));
vi.mock('../services/memory/distill', () => ({ looseParse: vi.fn(() => null) }));
vi.mock('../services/memory/store', () => ({ getMemory: vi.fn(() => null) }));
vi.mock('../services/memoryModels', () => ({
  listEmbeddingModels: vi.fn(() => []),
  startEmbeddingModelDownload: vi.fn(async () => true),
  cancelEmbeddingModelDownload: vi.fn(() => true),
  deleteEmbeddingModel: vi.fn(() => true),
  setEmbeddingProgressSink: vi.fn(),
}));
vi.mock('../services/chatModels', () => ({
  listChatModels: vi.fn(() => []),
  startChatModelDownload: vi.fn(async () => true),
  cancelChatModelDownload: vi.fn(() => true),
  deleteChatModel: vi.fn(() => true),
  setChatModelProgressSink: vi.fn(),
}));

import { registerMemoryHandlers } from './memory';

const event = { sender: { id: 1 } };
const handler = (channel: string) => {
  const value = mocks.handlers.get(channel);
  if (!value) throw new Error(`handler not registered: ${channel}`);
  return value;
};

beforeAll(registerMemoryHandlers);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.openExistingMemoryDb.mockReturnValue(mocks.db);
  mocks.registry = null;
  mocks.settings = null;
});

describe('memory IPC', () => {
  it('labels project spaces with the project name, never the raw proj:<uuid>', async () => {
    const projectId = '6db81646-1111-4111-8111-111111111111';
    mocks.registry = {
      projection: () => ({
        projects: [{ projectId, canonicalPath: '/Users/me/work/enso-code' }],
        conversations: [],
      }),
    };
    mocks.listMemoriesForAdmin.mockReturnValue({
      items: [{ id: 'm1', spaceId: `proj:${projectId}`, spaceLabel: `proj:${projectId}` }],
      total: 1,
    } as never);
    const result = (await handler(IPC_CHANNELS.MEMORY_LIST)(event, {
      limit: 20,
      offset: 0,
    })) as { items: { spaceLabel: string }[] };
    expect(result.items[0].spaceLabel).toBe('enso-code');

    mocks.listMemoriesForAdmin.mockReturnValue({
      items: [{ id: 'm2', spaceId: 'global', spaceLabel: 'global' }],
      total: 1,
    } as never);
    const globalResult = (await handler(IPC_CHANNELS.MEMORY_LIST)(event, {
      limit: 20,
      offset: 0,
    })) as { items: { spaceLabel: string }[] };
    expect(globalResult.items[0].spaceLabel).toBe('Global');
  });

  it('uses the stored conversation title for distillable sessions', async () => {
    mocks.registry = {
      projection: () => ({
        projects: [{ projectId: 'p1', canonicalPath: '/Users/me/work/enso-code' }],
        conversations: [
          { conversationId: 'c1', projectId: 'p1', sessionFile: 'a.jsonl' },
          { conversationId: 'c2', projectId: 'p1', sessionFile: 'b.jsonl' },
        ],
      }),
    };
    // 真实结构是 Record<id, Conversation>；早期按数组解析，标题一条都读不到
    mocks.settings = {
      'enso-conversations': {
        state: { conversations: { c1: { id: 'c1', title: 'Fix retry loop' } } },
      },
    };
    const sessions = (await handler(IPC_CHANNELS.MEMORY_DISTILLABLE_SESSIONS)(event)) as {
      sessionId: string;
      title: string;
      projectName: string | null;
    }[];
    expect(sessions.find((s) => s.sessionId === 'c1')?.title).toBe('Fix retry loop');
    expect(sessions.find((s) => s.sessionId === 'c1')?.projectName).toBe('enso-code');
    // 没有存标题的회话回退到短 id，不编造
    expect(sessions.find((s) => s.sessionId === 'c2')?.title).toBe('c2');
  });

  it('聚合任务：标题列出各成员会话，成员会话都算已提炼', async () => {
    mocks.registry = {
      projection: () => ({
        projects: [{ projectId: 'p1', canonicalPath: '/Users/me/work/enso-code' }],
        conversations: [
          { conversationId: 'c1', projectId: 'p1', sessionFile: 'a.jsonl' },
          { conversationId: 'c2', projectId: 'p1', sessionFile: 'b.jsonl' },
        ],
      }),
    };
    mocks.settings = {
      'enso-conversations': {
        state: { conversations: { c1: { id: 'c1', title: 'Fix retry loop' } } },
      },
    };
    const batch = {
      id: 7,
      sessionId: 'batch:0123456789abcdef',
      sessionIds: ['c1', 'c2'],
      projectId: 'p1',
    };
    mocks.toMemoryJobsSnapshot.mockReturnValueOnce({
      distill: [batch],
      kg: [],
      reembed: null,
    } as never);
    mocks.getMemoryDistillJobs.mockReturnValueOnce([
      {
        payload: {
          sessionId: batch.sessionId,
          sessions: [{ sessionId: 'c1' }, { sessionId: 'c2' }],
        },
      },
    ] as never);
    const jobs = (await handler(IPC_CHANNELS.MEMORY_JOBS)(event)) as {
      distill: { sessionTitle: string | null }[];
    };
    expect(jobs.distill[0].sessionTitle).toBe('Fix retry loop + c2');
    mocks.getMemoryDistillJobs.mockReturnValueOnce([
      { payload: { sessionId: batch.sessionId, sessions: [{ sessionId: 'c2' }] } },
    ] as never);
    const sessions = (await handler(IPC_CHANNELS.MEMORY_DISTILLABLE_SESSIONS)(event)) as {
      sessionId: string;
      distilled: boolean;
    }[];
    expect(sessions.find((s) => s.sessionId === 'c2')?.distilled).toBe(true);
    expect(sessions.find((s) => s.sessionId === 'c1')?.distilled).toBe(false);
  });

  it('knowledge handlers reject malformed input and never touch the db', async () => {
    // 图谱 / 树 / 解读 / 结晶都按 unknown 收窄；非法载荷不能落到查询层
    expect(await handler(IPC_CHANNELS.MEMORY_GRAPH)(event, { limit: 0 })).toEqual({
      nodes: [],
      edges: [],
      totalEntities: 0,
    });
    expect(await handler(IPC_CHANNELS.MEMORY_TREE)(event, { groupBy: 'nope' })).toEqual([]);
    expect(await handler(IPC_CHANNELS.MEMORY_INSIGHT)(event, {})).toMatchObject({ ok: false });
    expect(await handler(IPC_CHANNELS.MEMORY_CRYSTALLIZE)(event, { memoryIds: 'x' })).toMatchObject(
      { ok: false }
    );
    expect(mocks.openExistingMemoryDb).not.toHaveBeenCalled();
  });

  it('crystallize refuses fewer than the minimum sources before calling any model', async () => {
    const result = (await handler(IPC_CHANNELS.MEMORY_CRYSTALLIZE)(event, {
      memoryIds: ['a', 'b'],
    })) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/at least/i);
    expect(mocks.getMemoryCompletion).not.toHaveBeenCalled();
  });

  it('interpretation reports the missing model instead of failing silently', async () => {
    mocks.getMemoryCompletion.mockResolvedValueOnce(null);
    const result = (await handler(IPC_CHANNELS.MEMORY_INSIGHT)(event, {
      entityId: 'e1',
    })) as { ok: boolean; error?: string };
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/model/i);
  });

  it('broadcasts a change after every write so other views reload', async () => {
    // 组件树传 revision 只覆盖「在设置页点的操作」；agent 通过工具写记忆时界面不会动
    mocks.archiveMemory.mockReturnValue({ id: 'm1' } as never);
    mocks.getMemoryDetail.mockReturnValue({ id: 'm1', spaceId: 'global' } as never);
    await handler(IPC_CHANNELS.MEMORY_ARCHIVE)(event, 'm1');
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.MEMORY_CHANGED, undefined);

    mocks.send.mockClear();
    mocks.deleteMemoriesManually.mockReturnValue({ deleted: [{ id: 'm1' }] });
    await handler(IPC_CHANNELS.MEMORY_DELETE)(event, 'm1');
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.MEMORY_CHANGED, undefined);
    expect(mocks.appendMemoryAudit).toHaveBeenCalledWith(
      '/user-data/memory',
      expect.objectContaining({ action: 'memory.delete', actor: 'user', requested: ['m1'] })
    );

    // 找不到目标时不该广播
    mocks.send.mockClear();
    mocks.appendMemoryAudit.mockClear();
    mocks.deleteMemoriesManually.mockReturnValue(null);
    await handler(IPC_CHANNELS.MEMORY_DELETE)(event, 'ghost');
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.appendMemoryAudit).not.toHaveBeenCalled();
  });

  it('previews deletion impact only for a trusted window and a non-empty id list', async () => {
    const preview = handler(IPC_CHANNELS.MEMORY_DELETE_PREVIEW);
    for (const ids of [null, 'm1', [], [1], ['']]) {
      expect(await preview(event, ids)).toBeNull();
    }
    expect(await preview({ sender: { id: 99 } }, ['m1'])).toBeNull();
    expect(mocks.planMemoryDeletion).not.toHaveBeenCalled();
    mocks.planMemoryDeletion.mockReturnValueOnce({ deleted: [] });
    expect(await preview(event, ['m1', 'm2'])).toEqual({ deleted: [] });
    expect(mocks.planMemoryDeletion).toHaveBeenLastCalledWith(mocks.db, ['m1', 'm2']);
  });

  it('edits a memory only with a trusted window and a well-formed patch', async () => {
    const update = handler(IPC_CHANNELS.MEMORY_UPDATE);
    for (const patch of [
      null,
      { title: 'x' },
      { title: 'x', content: '   ' },
      { title: 1, content: 'x' },
      { title: 'x', content: 'y', importance: 2 },
      { title: 'x', content: 'y', unitType: 'nope' },
      { title: 'x', content: 'y', extra: 1 },
    ]) {
      expect(await update(event, 'm1', patch)).toMatchObject({ ok: false });
    }
    expect(await update(event, '', { title: '', content: 'y' })).toMatchObject({ ok: false });
    expect(await update({ sender: { id: 99 } }, 'm1', { title: '', content: 'y' })).toMatchObject({
      ok: false,
    });
    expect(mocks.editMemory).not.toHaveBeenCalled();

    mocks.editMemory.mockReturnValueOnce(null);
    expect(await update(event, 'ghost', { title: '', content: 'y' })).toMatchObject({ ok: false });
    expect(mocks.send).not.toHaveBeenCalled();

    mocks.editMemory.mockImplementationOnce(() => {
      throw new Error('Refused to write memory: prompt-injection');
    });
    expect(await update(event, 'm1', { title: '', content: 'bad' })).toEqual({
      ok: false,
      error: 'Refused to write memory: prompt-injection',
    });

    const memory = { id: 'm1', title: 'T', content: 'y', unitType: 'fact', importance: 0.6 };
    mocks.editMemory.mockReturnValueOnce({
      before: { ...memory, title: 'Old', importance: 0.5 },
      memory: { ...memory, unitType: 'decision', importance: 0.8 },
      semanticChanged: true,
      embedded: true,
    });
    const patch = { title: 'T', content: 'y', unitType: 'decision', importance: 0.8 };
    expect(await update(event, 'm1', patch)).toEqual({ ok: true });
    expect(mocks.editMemory).toHaveBeenLastCalledWith('m1', patch);
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.MEMORY_CHANGED, undefined);
    expect(mocks.appendMemoryAudit).toHaveBeenCalledWith(
      '/user-data/memory',
      expect.objectContaining({
        action: 'memory.edit',
        memoryId: 'm1',
        changes: {
          title: { from: 'Old', to: 'T' },
          unitType: { from: 'fact', to: 'decision' },
          importance: { from: 0.5, to: 0.8 },
        },
      })
    );
  });

  it('rejects invalid list input before reaching the service', async () => {
    const result = await handler(IPC_CHANNELS.MEMORY_LIST)(event, { limit: 0, offset: 0 });
    expect(result).toEqual({ items: [], total: 0 });
    expect(mocks.openExistingMemoryDb).not.toHaveBeenCalled();
    expect(mocks.listMemoriesForAdmin).not.toHaveBeenCalled();
  });

  it('returns empty data when the database is absent', async () => {
    mocks.openExistingMemoryDb.mockReturnValue(null);
    expect(await handler(IPC_CHANNELS.MEMORY_LIST)(event, { limit: 20, offset: 0 })).toEqual({
      items: [],
      total: 0,
    });
    expect(mocks.listMemoriesForAdmin).not.toHaveBeenCalled();
  });

  it('rejects chat-model IPC that is untrusted or not a model id', async () => {
    expect(await handler(IPC_CHANNELS.MEMORY_CHAT_MODELS)({ sender: { id: 99 } })).toEqual([]);
    expect(await handler(IPC_CHANNELS.MEMORY_CHAT_MODEL_DOWNLOAD)(event, 1)).toBe(false);
    expect(await handler(IPC_CHANNELS.MEMORY_CHAT_MODEL_DOWNLOAD)(event, '')).toBe(false);
    expect(await handler(IPC_CHANNELS.MEMORY_CHAT_MODEL_CANCEL)(event, null)).toBe(false);
    expect(await handler(IPC_CHANNELS.MEMORY_CHAT_MODEL_DELETE)(event, { id: 'x' })).toBe(false);
  });

  it('rejects invalid and untrusted writes without reaching the service', async () => {
    expect(await handler(IPC_CHANNELS.MEMORY_ARCHIVE)(event, 42)).toMatchObject({ ok: false });
    expect(
      await handler(IPC_CHANNELS.MEMORY_ARCHIVE)({ sender: { id: 99 } }, 'memory-id')
    ).toMatchObject({ ok: false });
    expect(mocks.archiveMemory).not.toHaveBeenCalled();
  });

  it('validates evolves review state', async () => {
    expect(
      await handler(IPC_CHANNELS.MEMORY_EVOLVES_REVIEW)(event, 'edge-id', 'pending')
    ).toMatchObject({ ok: false });
    expect(mocks.reviewEvolvesEdge).not.toHaveBeenCalled();
  });

  it('待审阅带上两端记忆，并用设置里的项目名标注空间（注册表没有该项目时）', async () => {
    const older = { id: 'o1', title: 'Workflow removed', spaceId: 'proj:p1', importance: 0.9 };
    const newer = { id: 'n1', title: 'Wants a workflow', spaceId: 'proj:p1', importance: 0.8 };
    mocks.listPendingEvolves.mockReturnValueOnce([
      {
        edge: { id: 'e1', olderId: 'o1', newerId: 'n1', relation: 'challenges' },
        older,
        newer,
      },
    ]);
    mocks.settings = {
      'enso-settings': { state: { projects: [{ id: 'p1', name: 'enso-code' }] } },
    };
    mocks.registry = null;
    const [item] = (await handler(IPC_CHANNELS.MEMORY_EVOLVES_PENDING)(event)) as {
      older: { spaceLabel: string };
      newer: { spaceLabel: string };
    }[];
    expect(item.older.spaceLabel).toBe('enso-code');
    expect(item.newer.spaceLabel).toBe('enso-code');
  });

  it('gets job snapshots from memoryHost without opening the database', async () => {
    const result = await handler(IPC_CHANNELS.MEMORY_JOBS)(event);
    expect(mocks.getMemoryDistillJobs).toHaveBeenCalled();
    expect(mocks.getMemoryKgJobs).toHaveBeenCalled();
    expect(mocks.getMemoryReembedProgress).toHaveBeenCalled();
    expect(mocks.toMemoryJobsSnapshot).toHaveBeenCalled();
    expect(mocks.openExistingMemoryDb).not.toHaveBeenCalled();
    expect(mocks.getMemoryKgFailedCount).toHaveBeenCalled();
    expect(result).toMatchObject({ distill: [], kg: [], reembed: null, kgFailed: 2 });
  });

  it('rejects untrusted or unexpected kg retry payloads', async () => {
    expect(await handler(IPC_CHANNELS.MEMORY_KG_RETRY_FAILED)({ sender: { id: 99 } })).toBe(0);
    expect(await handler(IPC_CHANNELS.MEMORY_KG_RETRY_FAILED)(event, { force: true })).toBe(0);
    expect(await handler(IPC_CHANNELS.MEMORY_KG_RETRY_FAILED)(event, null)).toBe(0);
    expect(await handler(IPC_CHANNELS.MEMORY_KG_RETRY_FAILED)(event, 0)).toBe(0);
    expect(mocks.retryFailedMemoryKg).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('retries failed kg jobs when the window is trusted and there is no payload', async () => {
    mocks.retryFailedMemoryKg.mockReturnValueOnce(3);
    expect(await handler(IPC_CHANNELS.MEMORY_KG_RETRY_FAILED)(event)).toBe(3);
    expect(mocks.retryFailedMemoryKg).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.MEMORY_CHANGED, undefined);
  });

  it('does not broadcast when no kg jobs were reset', async () => {
    mocks.retryFailedMemoryKg.mockReturnValueOnce(0);
    expect(await handler(IPC_CHANNELS.MEMORY_KG_RETRY_FAILED)(event)).toBe(0);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('rejects untrusted job history clears without opening the database', async () => {
    expect(await handler(IPC_CHANNELS.MEMORY_JOBS_CLEAR)({ sender: { id: 99 } })).toBe(0);
    expect(mocks.openExistingMemoryDb).not.toHaveBeenCalled();
    expect(mocks.clearFinishedMemoryJobs).not.toHaveBeenCalled();
  });

  it('clears finished jobs and broadcasts when any rows were deleted', async () => {
    mocks.clearFinishedMemoryJobs.mockReturnValue(4);
    expect(await handler(IPC_CHANNELS.MEMORY_JOBS_CLEAR)(event)).toBe(4);
    expect(mocks.clearFinishedMemoryJobs).toHaveBeenCalledWith(mocks.db);
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.MEMORY_CHANGED, undefined);
  });

  it('does not broadcast when there was nothing to clear', async () => {
    mocks.clearFinishedMemoryJobs.mockReturnValue(0);
    expect(await handler(IPC_CHANNELS.MEMORY_JOBS_CLEAR)(event)).toBe(0);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('pending writes: list labels spaces and hides internal payload', async () => {
    mocks.listPendingWrites.mockReturnValue([
      {
        id: 'p1',
        kind: 'capture',
        spaceId: 'global',
        title: 't',
        content: 'c',
        botId: 'b1',
        chatId: null,
        redacted: true,
        createdAt: '2026-10-05T00:00:00.000Z',
        payload: { importance: 0.7 },
      },
    ]);
    expect(await handler(IPC_CHANNELS.MEMORY_PENDING_WRITES)({ sender: { id: 99 } })).toEqual([]);
    expect(await handler(IPC_CHANNELS.MEMORY_PENDING_WRITES)(event)).toEqual([
      {
        id: 'p1',
        kind: 'capture',
        spaceId: 'global',
        spaceLabel: 'Global',
        originLabel: '成员：已删除成员',
        title: 't',
        content: 'c',
        botId: 'b1',
        chatId: null,
        redacted: true,
        createdAt: '2026-10-05T00:00:00.000Z',
      },
    ]);
  });

  it('pending write review: narrows input, rejects / approves and broadcasts', async () => {
    const review = handler(IPC_CHANNELS.MEMORY_PENDING_WRITE_REVIEW);
    expect(await review(event, 'p1', 'maybe')).toMatchObject({ ok: false });
    expect(await review(event, 42, 'reject')).toMatchObject({ ok: false });
    expect(await review({ sender: { id: 99 } }, 'p1', 'approve')).toMatchObject({ ok: false });
    expect(mocks.rejectPendingWrite).not.toHaveBeenCalled();
    expect(mocks.approvePendingMemoryWrite).not.toHaveBeenCalled();

    mocks.rejectPendingWrite.mockReturnValue(true);
    expect(await review(event, 'p1', 'reject')).toEqual({ ok: true });
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.MEMORY_CHANGED, undefined);

    mocks.approvePendingMemoryWrite.mockResolvedValue({ ok: true });
    expect(await review(event, 'p2', 'approve')).toEqual({ ok: true });
    expect(mocks.approvePendingMemoryWrite).toHaveBeenCalledWith('p2');
  });

  it('forgetting: stats 带上巡检状态，不额外开库', async () => {
    mocks.getMemoryStats.mockReturnValue({
      total: 1,
      bySpace: { global: 1 },
      spaceLabels: {},
      crystals: 0,
      entities: 0,
      embedded: 0,
      databaseBytes: 0,
      neverHit: 1,
      addedLast7Days: 1,
    });
    const stats = (await handler(IPC_CHANNELS.MEMORY_STATS)(event)) as {
      forgetting?: { candidates: number };
    };
    expect(stats.forgetting).toEqual({
      lastRunAt: '2026-06-01T00:00:00.000Z',
      lastRun: null,
      candidates: 3,
    });
    expect(mocks.openExistingMemoryDb).toHaveBeenCalledTimes(1);
  });

  it('forgetting: 立即运行走 memoryHost 并广播', async () => {
    const run = handler(IPC_CHANNELS.MEMORY_FORGETTING_RUN);
    expect(run({ sender: { id: 99 } })).toBeNull();
    expect(mocks.runMemoryForgettingNow).not.toHaveBeenCalled();

    const summary = run(event) as { scored: number };
    expect(summary.scored).toBe(1);
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.MEMORY_CHANGED, undefined);
  });

  it('reconcile: 立即复核只认可信窗口，跑完广播；没有模型返回 null 且不广播', async () => {
    const run = handler(IPC_CHANNELS.MEMORY_RECONCILE_RUN);
    expect(await run({ sender: { id: 99 } })).toBeNull();
    expect(mocks.runMemoryReconcileNow).not.toHaveBeenCalled();

    mocks.send.mockClear();
    expect(await run(event)).toEqual({ challenges: 1 });
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.MEMORY_CHANGED, undefined);

    mocks.send.mockClear();
    mocks.runMemoryReconcileNow.mockResolvedValueOnce(null);
    expect(await run(event)).toBeNull();
    expect(mocks.send).not.toHaveBeenCalledWith(IPC_CHANNELS.MEMORY_CHANGED, undefined);
  });

  it('forgetting: 候选列表与确认归档都收窄入参', async () => {
    const list = handler(IPC_CHANNELS.MEMORY_ARCHIVE_CANDIDATES);
    expect(await list({ sender: { id: 99 } })).toEqual({ items: [], total: 0 });
    expect(await list(event, { limit: 0 })).toEqual({ items: [], total: 0 });
    expect(await list(event, { limit: 10, offset: 0 })).toEqual({ items: [], total: 0 });
    expect(mocks.listArchiveCandidates).toHaveBeenCalledTimes(1);

    const confirm = handler(IPC_CHANNELS.MEMORY_ARCHIVE_CANDIDATES_CONFIRM);
    for (const ids of [null, 'm1', [], [1], ['']]) {
      expect(confirm(event, ids)).toEqual({ archived: 0, skipped: 0 });
    }
    expect(confirm({ sender: { id: 99 } }, ['m1'])).toEqual({ archived: 0, skipped: 0 });
    expect(mocks.archiveCandidatesConfirmed).not.toHaveBeenCalled();

    mocks.archiveCandidatesConfirmed.mockReturnValue({ archived: 1, skipped: 0, ids: ['m1'] });
    expect(confirm(event, ['m1'])).toEqual({ archived: 1, skipped: 0 });
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.MEMORY_CHANGED, undefined);
    expect(mocks.appendMemoryAudit).not.toHaveBeenCalled();
  });
});
