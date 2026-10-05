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
  deleteMemoryPermanently: vi.fn(() => false),
  clearFinishedMemoryJobs: vi.fn(() => 0),
  getMemoryStats: vi.fn(),
  listPendingEvolves: vi.fn(() => []),
  reviewEvolvesEdge: vi.fn(() => null),
  toMemoryJobsSnapshot: vi.fn(() => ({ distill: [], kg: [], reembed: null })),
  getMemoryDistillJobs: vi.fn(() => []),
  getMemoryKgJobs: vi.fn(() => []),
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
vi.mock('./settings', () => ({ readSettings: () => mocks.settings }));
vi.mock('../windows/MainWindow', () => ({ isMainWebContents: (id: number) => id === 1 }));
vi.mock('../windows/SettingsWindow', () => ({ isSettingsWebContents: () => false }));
vi.mock('../windows/createAppWindow', () => ({
  sendToAllWindows: (channel: string, ...args: unknown[]) => mocks.send(channel, ...args),
}));
vi.mock('../services/memoryAdmin', () => ({
  openExistingMemoryDb: mocks.openExistingMemoryDb,
  listMemoriesForAdmin: mocks.listMemoriesForAdmin,
  getMemoryDetail: mocks.getMemoryDetail,
  archiveMemory: mocks.archiveMemory,
  restoreMemory: mocks.restoreMemory,
  deleteMemoryPermanently: mocks.deleteMemoryPermanently,
  clearFinishedMemoryJobs: mocks.clearFinishedMemoryJobs,
  getMemoryStats: mocks.getMemoryStats,
  listPendingEvolves: mocks.listPendingEvolves,
  reviewEvolvesEdge: mocks.reviewEvolvesEdge,
  toMemoryJobsSnapshot: mocks.toMemoryJobsSnapshot,
}));
vi.mock('../services/memoryHost', () => ({
  getMemoryDistillJobs: mocks.getMemoryDistillJobs,
  getMemoryKgJobs: mocks.getMemoryKgJobs,
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
}));
vi.mock('../services/memory/pending', () => ({
  listPendingWrites: mocks.listPendingWrites,
  rejectPendingWrite: mocks.rejectPendingWrite,
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
    mocks.deleteMemoryPermanently.mockReturnValue(true);
    await handler(IPC_CHANNELS.MEMORY_DELETE)(event, 'm1');
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.MEMORY_CHANGED, undefined);

    // 找不到目标时不该广播
    mocks.send.mockClear();
    mocks.deleteMemoryPermanently.mockReturnValue(false);
    await handler(IPC_CHANNELS.MEMORY_DELETE)(event, 'ghost');
    expect(mocks.send).not.toHaveBeenCalled();
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

  it('gets job snapshots from memoryHost without opening the database', async () => {
    const result = await handler(IPC_CHANNELS.MEMORY_JOBS)(event);
    expect(mocks.getMemoryDistillJobs).toHaveBeenCalled();
    expect(mocks.getMemoryKgJobs).toHaveBeenCalled();
    expect(mocks.getMemoryReembedProgress).toHaveBeenCalled();
    expect(mocks.toMemoryJobsSnapshot).toHaveBeenCalled();
    expect(mocks.openExistingMemoryDb).not.toHaveBeenCalled();
    expect(result).toMatchObject({ distill: [], kg: [], reembed: null });
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
});
