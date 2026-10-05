import { IPC_CHANNELS } from '@shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatchHost: { resolveSubagentModel: undefined as unknown },
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  spawnSession: vi.fn(),
  summarizeConversationTitle: vi.fn(() => ({ ok: true })),
  resolveModelSelection: vi.fn(),
  readSettings: vi.fn((): unknown => null),
  setAgentEventListener: vi.fn(),
  restoreJournal: vi.fn(() => ({ records: [], partial: false })),
  existsSync: vi.fn(() => true),
  persistedConversation: vi.fn(),
  currentIdentity: vi.fn(),
  coworkerOf: vi.fn(),
  resolveTeamTarget: vi.fn(),
  isMainWebContents: vi.fn(() => true),
  dismissChildSession: vi.fn(() => ({ ok: true })),
  dismissCoworkerSession: vi.fn(() => ({ ok: true })),
  promptSession: vi.fn(),
  steerSession: vi.fn(),
  abortSession: vi.fn(),
  setPairAgentBridge: vi.fn(),
  configurePairSessionHost: vi.fn(),
  respondApproval: vi.fn(),
  respondAsk: vi.fn(),
  prepareParent: vi.fn(),
  setSessionModel: vi.fn(() => ({ ok: true })),
  forkSession: vi.fn(() => ({ ok: true })),
  sessionWorktree: vi.fn(),
  sessionWorktreeBusy: vi.fn(() => false),
  shareSessionWorktree: vi.fn(),
  removeRegisteredWorktree: vi.fn(async () => {}),
  cleanupSessionFiles: vi.fn(),
  credentials: vi.fn(async () => new Set<string>()),
  readSettingsState: vi.fn((): Record<string, unknown> | undefined => undefined),
  sendComputerResult: vi.fn(),
  computerInvoke: vi.fn(),
  computerCloseAll: vi.fn(),
  compactSession: vi.fn(() => ({ ok: true })),
  sessionFile: vi.fn((): string | undefined => undefined),
  scheduleMemoryDistill: vi.fn(async () => undefined),
  getBotServices: vi.fn((): unknown => null),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  powerMonitor: { on: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
}));

vi.mock('../services/sessionFileCleanup', () => ({
  removeConversationSessionFiles: mocks.cleanupSessionFiles,
}));
vi.mock('../windows/MainWindow', () => ({ isMainWebContents: mocks.isMainWebContents }));
vi.mock('../services/oauthProviders', () => ({
  readStoredOauthCredentialKeys: mocks.credentials,
}));
vi.mock('../services/agentHost', () => ({
  abortSession: mocks.abortSession,
  compactSession: mocks.compactSession,
  forgetParentToolProfile: vi.fn(),
  agentTypeRegistrySnapshot: vi.fn(() => ({
    revision: 1,
    candidates: [
      {
        typeKey: 'agent:enso',
        displayName: 'Enso',
        description: 'System Agent',
        source: 'system',
        locked: true,
        canDisable: false,
        canEdit: false,
      },
    ],
  })),
  appendSessionCustomEntry: vi.fn(),
  dismissChildSession: mocks.dismissChildSession,
  dismissCoworkerSession: mocks.dismissCoworkerSession,
  resumeCoworkerSession: vi.fn(() => ({ ok: true })),
  promptChildSession: vi.fn(),
  promptSession: mocks.promptSession,
  requestSnapshot: vi.fn(),
  resolveAgentTypeSpawnConfig: vi.fn(),
  resolveModelSelection: mocks.resolveModelSelection,
  resolveSubagentModelSelection: vi.fn(),
  respondApproval: mocks.respondApproval,
  respondAsk: mocks.respondAsk,
  rewindSession: vi.fn(),
  forkSession: mocks.forkSession,
  setAgentEventListener: mocks.setAgentEventListener,
  setSessionApprovalMode: vi.fn(),
  setSessionModel: mocks.setSessionModel,
  setSessionReasoning: vi.fn(),
  setSessionThinking: vi.fn(),
  spawnChildSession: vi.fn(),
  spawnSession: mocks.spawnSession,
  steerSession: mocks.steerSession,
  stopBackgroundTask: vi.fn(),
  backgroundForegroundTool: vi.fn(),
  summarizeConversationTitle: mocks.summarizeConversationTitle,
  readSettingsState: mocks.readSettingsState,
  sendComputerResultToSession: mocks.sendComputerResult,
}));
vi.mock('../services/computerHost', () => ({
  computerHost: {
    invoke: mocks.computerInvoke,
    close: vi.fn(),
    closeAll: mocks.computerCloseAll,
  },
}));
vi.mock('../services/agentDispatchService', async () => {
  const actual = await vi.importActual<typeof import('../services/agentDispatchService')>(
    '../services/agentDispatchService'
  );
  return {
    ...actual,
    AgentDispatchService: class extends actual.AgentDispatchService {
      constructor(options: ConstructorParameters<typeof actual.AgentDispatchService>[0]) {
        mocks.dispatchHost.resolveSubagentModel = options.host.resolveSubagentModel;
        super(options);
      }
    },
  };
});
vi.mock('../services/notifications', () => ({ maybeNotify: vi.fn() }));
vi.mock('../services/pairHost', () => ({
  forwardAgentEvent: vi.fn(),
  setPairAgentBridge: mocks.setPairAgentBridge,
  refreshPowerKeepAlive: vi.fn(),
}));
vi.mock('../services/pairSessionHost', () => ({
  configurePairSessionHost: mocks.configurePairSessionHost,
  handlePairHeadlessAgentEvent: vi.fn(),
}));
vi.mock('./capabilities', () => ({
  agentSessionIndex: {
    currentIdentity: mocks.currentIdentity,
    prepareParent: mocks.prepareParent,
    observe: vi.fn(),
    reserveChild: vi.fn(),
    releaseChild: vi.fn(),
    resolveTeamTarget: mocks.resolveTeamTarget,
    persistedConversation: mocks.persistedConversation,
    coworkerOf: mocks.coworkerOf,
    sessionFile: mocks.sessionFile,
  },
  capabilityGateway: {
    registerInvocation: vi.fn(() => true),
    terminateGeneration: vi.fn(),
  },
  handleCapabilityInvoke: vi.fn(),
}));
vi.mock('./settings', () => ({ readSettings: mocks.readSettings }));
vi.mock('../services/memoryHost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/memoryHost')>()),
  scheduleMemoryDistill: mocks.scheduleMemoryDistill,
}));
vi.mock('./bots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bots')>()),
  getBotServices: mocks.getBotServices,
}));
vi.mock('../../agent/ensoSafeJournal', () => ({
  EnsoSafeJournal: { restore: mocks.restoreJournal },
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: mocks.existsSync,
}));
vi.mock('../services/fileSearch', () => ({ searchFiles: vi.fn(() => []) }));
vi.mock('../services/sessionImport', () => ({
  importExternalSession: vi.fn(),
  listExternalSessions: vi.fn(() => []),
  readExternalSession: vi.fn(() => []),
}));

vi.mock('./worktree', () => ({
  sessionWorktree: mocks.sessionWorktree,
  sessionWorktreeBusy: mocks.sessionWorktreeBusy,
  shareSessionWorktree: mocks.shareSessionWorktree,
  removeRegisteredWorktree: mocks.removeRegisteredWorktree,
}));

import { resolveSubagentModelSelection, rewindSession } from '../services/agentHost';
import { getSourceAuthorityRegistry, registerAgentHandlers } from './agent';

const sender = {
  id: 1,
  once: vi.fn(),
};
const event = { sender };

describe('agent IPC Main identity boundary', () => {
  beforeEach(() => {
    mocks.dispatchHost.resolveSubagentModel = undefined;
    mocks.handlers.clear();
    mocks.spawnSession.mockReset();
    mocks.restoreJournal.mockClear();
    mocks.existsSync.mockReturnValue(true);
    mocks.persistedConversation.mockReset();
    mocks.currentIdentity.mockReset();
    mocks.promptSession.mockClear();
    mocks.steerSession.mockClear();
    mocks.abortSession.mockClear();
    mocks.setPairAgentBridge.mockClear();
    mocks.configurePairSessionHost.mockClear();
    mocks.respondApproval.mockClear();
    mocks.respondAsk.mockClear();
    mocks.prepareParent.mockClear();
    mocks.setSessionModel.mockClear();
    mocks.coworkerOf.mockReset();
    mocks.dismissChildSession.mockClear();
    mocks.dismissCoworkerSession.mockClear();
    mocks.credentials.mockReset().mockResolvedValue(new Set());
    mocks.sessionWorktree.mockReset();
    mocks.sessionWorktreeBusy.mockReset().mockReturnValue(false);
    registerAgentHandlers();
  });

  it('派发 host 接上子代理模型解析，模型覆盖才不会被当成档案禁止', () => {
    expect(mocks.dispatchHost.resolveSubagentModel).toBe(resolveSubagentModelSelection);
  });

  it('desktop rewind requires a persisted entry ID and a current generation', () => {
    const identity = { sessionId: 'parent', generation: '11111111-1111-4111-8111-111111111111' };
    mocks.currentIdentity.mockReturnValue(identity);
    vi.mocked(rewindSession).mockReset().mockReturnValue({ ok: true });
    const handler = mocks.handlers.get(IPC_CHANNELS.AGENT_REWIND)!;
    for (const anchor of [0, -1, null, undefined, '', ' ', {}, []]) {
      expect(handler(event, 'parent', anchor, true)).toMatchObject({ ok: false });
    }
    expect(handler(event, 'parent', 'entry', 'true')).toMatchObject({ ok: false });
    expect(rewindSession).not.toHaveBeenCalled();
    expect(handler(event, 'parent', 'entry', true)).toEqual({ ok: true });
    expect(rewindSession).toHaveBeenCalledExactlyOnceWith(identity, 'entry', true);
    mocks.currentIdentity.mockReturnValue(undefined);
    expect(handler(event, 'parent', 'entry', true)).toMatchObject({ ok: false });
    expect(rewindSession).toHaveBeenCalledTimes(1);
  });

  it.each(['busy', 'ended', 'rebound'])(
    'revalidates spawn after credentials: %s',
    async (change) => {
      const authority = getSourceAuthorityRegistry()!;
      const conversation = {
        conversationId: 'spawn-target',
        projectId: 'p',
        kind: 'root' as const,
        lifecycle: 'draft' as 'draft' | 'ended',
        version: 1,
      };
      vi.spyOn(authority, 'conversation').mockReturnValue(conversation);
      vi.spyOn(authority, 'project').mockReturnValue({
        projectId: 'p',
        canonicalPath: '/repo',
        state: 'active',
        version: 1,
      });
      mocks.credentials.mockImplementationOnce(async () => {
        if (change === 'busy') mocks.sessionWorktreeBusy.mockReturnValue(true);
        else if (change === 'ended') conversation.lifecycle = 'ended';
        else mocks.sessionWorktree.mockReturnValue({ path: '/worktree' });
        return new Set();
      });
      const result = await mocks.handlers.get(IPC_CHANNELS.AGENT_SPAWN)!(event, {
        sessionId: 'spawn-target',
        providerId: 'provider',
        modelId: 'model',
        cwd: '/repo',
      });
      if (change === 'rebound') expect(mocks.spawnSession.mock.calls[0][1].cwd).toBe('/worktree');
      else {
        expect(result).toMatchObject({ ok: false });
        expect(mocks.spawnSession).not.toHaveBeenCalled();
      }
    }
  );

  it('通用 AGENT_SPAWN 拒绝 bot 会话（人设与工作区只能由 BotSessionHost 组装）', async () => {
    const authority = getSourceAuthorityRegistry()!;
    vi.spyOn(authority, 'conversation').mockReturnValue({
      conversationId: 'bot-target',
      projectId: 'p',
      kind: 'root',
      lifecycle: 'draft',
      version: 1,
      bot: { botId: '11111111-1111-4111-8111-111111111111', chatId: null },
    });
    vi.spyOn(authority, 'project').mockReturnValue({
      projectId: 'p',
      canonicalPath: '/repo',
      state: 'active',
      version: 1,
    });
    const result = await mocks.handlers.get(IPC_CHANNELS.AGENT_SPAWN)!(event, {
      sessionId: 'bot-target',
      providerId: 'provider',
      modelId: 'model',
      cwd: '/repo',
    });
    expect(result).toMatchObject({ ok: false });
    expect(mocks.spawnSession).not.toHaveBeenCalled();
  });

  it('Bot authority rejects generic execution and policy changes but keeps abort available', async () => {
    vi.spyOn(getSourceAuthorityRegistry()!, 'conversation').mockReturnValue({
      conversationId: 'bot-target',
      projectId: 'p',
      kind: 'root',
      lifecycle: 'ready',
      version: 1,
      bot: { botId: '11111111-1111-4111-8111-111111111111', chatId: null },
    });
    mocks.currentIdentity.mockReturnValue({ sessionId: 'bot-target', generation: 'g' });
    for (const [channel, args] of [
      [IPC_CHANNELS.AGENT_PROMPT, ['hello']],
      [IPC_CHANNELS.AGENT_STEER, ['hello']],
      [IPC_CHANNELS.AGENT_SET_MODEL, ['provider', 'model']],
      [IPC_CHANNELS.AGENT_SET_THINKING, ['high']],
      [IPC_CHANNELS.AGENT_SET_REASONING, [true]],
      [IPC_CHANNELS.AGENT_SET_APPROVAL_MODE, ['full']],
    ] as const) {
      expect(await mocks.handlers.get(channel)!(event, 'bot-target', ...args)).toMatchObject({
        ok: false,
        error: expect.stringContaining('Bot'),
      });
    }
    const bridge = mocks.setPairAgentBridge.mock.calls.at(-1)![0];
    expect(bridge.prompt('bot-target', 'hello')).toMatchObject({ ok: false });
    const headless = mocks.configurePairSessionHost.mock.calls.at(-1)![0];
    expect(headless.compact('bot-target')).toMatchObject({ ok: false });
    mocks.compactSession.mockClear();
    expect(
      await mocks.handlers.get(IPC_CHANNELS.AGENT_COMPACT)!(event, 'bot-target', '保留分工')
    ).toEqual({ ok: true });
    expect(mocks.compactSession).toHaveBeenCalledWith(
      { sessionId: 'bot-target', generation: 'g' },
      '保留分工'
    );
    expect(bridge.steer('bot-target', 'hello')).toMatchObject({ ok: false });
    bridge.abort('bot-target');
    expect(mocks.abortSession).toHaveBeenCalled();
    expect(mocks.promptSession).not.toHaveBeenCalled();
    expect(mocks.steerSession).not.toHaveBeenCalled();
  });

  it('cleans a late fork file if the target was removed before completion', () => {
    const sourceId = '11111111-1111-4111-8111-111111111111';
    const targetId = '33333333-3333-4333-8333-333333333333';
    mocks.currentIdentity.mockReturnValue({ sessionId: sourceId, generation: 'g' });
    const authority = getSourceAuthorityRegistry()!;
    const lookup = vi.spyOn(authority, 'conversation').mockImplementation((id) => ({
      conversationId: id,
      projectId: 'p',
      kind: 'root',
      lifecycle: id === sourceId ? 'ready' : 'draft',
      version: 1,
      ...(id === targetId ? { forkedFrom: { conversationId: sourceId, entryId: 'entry' } } : {}),
    }));
    mocks.handlers.get(IPC_CHANNELS.AGENT_FORK)!(event, sourceId, targetId, { entryId: 'entry' });
    lookup.mockReturnValue(undefined);
    mocks.cleanupSessionFiles.mockClear();
    const listener = mocks.setAgentEventListener.mock.calls.at(-1)![0];
    listener({
      type: 'fork-done',
      identity: { sessionId: sourceId, generation: 'g' },
      seq: 1,
      targetConversationId: targetId,
      sessionFile: '/tmp/agent/sessions/fork.jsonl',
      entryId: 'entry',
    });
    expect(mocks.cleanupSessionFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: targetId,
        sessionFile: '/tmp/agent/sessions/fork.jsonl',
      })
    );
  });

  it('reserves a worktree reference before posting fork and releases failed reservations', async () => {
    const sourceId = '11111111-1111-4111-8111-111111111111';
    const targetId = '22222222-2222-4222-8222-222222222222';
    mocks.currentIdentity.mockReturnValue({ sessionId: sourceId, generation: 'g' });
    const worktree = { path: '/reserved' };
    mocks.sessionWorktree.mockReturnValue(worktree);
    const authority = getSourceAuthorityRegistry()!;
    vi.spyOn(authority, 'conversation').mockImplementation((id) => ({
      conversationId: id,
      projectId: 'p',
      kind: 'root',
      lifecycle: id === sourceId ? 'ready' : 'draft',
      version: 1,
      ...(id === targetId ? { forkedFrom: { conversationId: sourceId, entryId: 'entry' } } : {}),
    }));
    mocks.forkSession.mockImplementationOnce(() => {
      expect(mocks.shareSessionWorktree).toHaveBeenCalledWith(sourceId, targetId);
      return { ok: false };
    });
    const result = mocks.handlers.get(IPC_CHANNELS.AGENT_FORK)!(event, sourceId, targetId, {
      entryId: 'entry',
    });
    expect(result).toEqual({ ok: false });
    await vi.waitFor(() =>
      expect(mocks.removeRegisteredWorktree).toHaveBeenCalledWith(targetId, worktree)
    );
  });

  it('rejects fork when worktree reservation fails without posting to worker', () => {
    const sourceId = '11111111-1111-4111-8111-111111111111';
    const targetId = '22222222-2222-4222-8222-222222222222';
    mocks.currentIdentity.mockReturnValue({ sessionId: sourceId, generation: 'g' });
    vi.spyOn(getSourceAuthorityRegistry()!, 'conversation').mockImplementation((id) => ({
      conversationId: id,
      projectId: 'p',
      kind: 'root',
      lifecycle: id === sourceId ? 'ready' : 'draft',
      version: 1,
      ...(id === targetId ? { forkedFrom: { conversationId: sourceId, entryId: 'entry' } } : {}),
    }));
    mocks.forkSession.mockClear();
    mocks.shareSessionWorktree.mockImplementationOnce(() => {
      throw new Error('worktree busy');
    });
    const result = mocks.handlers.get(IPC_CHANNELS.AGENT_FORK)!(event, sourceId, targetId, {
      entryId: 'entry',
    });
    expect(result).toMatchObject({ ok: false });
    expect(mocks.forkSession).not.toHaveBeenCalled();
  });

  it('exposes the Main agent type registry snapshot on the three-point list channel', () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.AGENT_TYPES_REGISTRY_LIST);
    expect(handler).toBeDefined();
    expect(handler!(event)).toEqual({
      revision: 1,
      candidates: [
        {
          typeKey: 'agent:enso',
          displayName: 'Enso',
          description: 'System Agent',
          source: 'system',
          locked: true,
          canDisable: false,
          canEdit: false,
        },
      ],
    });
  });

  it('rejects plain spawn attempts for the removed global/reserved Enso identity', async () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.AGENT_SPAWN);
    expect(handler).toBeDefined();
    await expect(
      handler!(event, {
        sessionId: 'builtin-agent:enso',
        providerId: 'provider',
        modelId: 'model',
        cwd: '/workspace',
      })
    ).resolves.toEqual({ ok: false, error: 'invalid spawn request' });
    expect(mocks.spawnSession).not.toHaveBeenCalled();
  });

  describe('手动雇佣走 Main dispatch', () => {
    it('非主窗口 / 非法参数拒绝；合法请求委托 dispatchService.hireCoworker', async () => {
      const handler = mocks.handlers.get(IPC_CHANNELS.AGENT_HIRE_COWORKER);
      expect(handler).toBeDefined();
      await expect(handler!(event, 'conv-1', '', undefined)).resolves.toMatchObject({
        ok: false,
      });
      mocks.isMainWebContents.mockReturnValueOnce(false);
      await expect(handler!(event, 'conv-1', 'bob', undefined)).resolves.toMatchObject({
        ok: false,
      });
      // 合法请求到达 dispatchService：hireCoworker 首先查 resolveTeamTarget，
      // 这里用哨兵错误证明委托链路真实走通。
      mocks.resolveTeamTarget.mockReturnValue({
        ok: false,
        code: 'unavailable',
        error: 'sentinel: team target',
      });
      await expect(handler!(event, 'conv-1', 'bob', 'scout')).resolves.toMatchObject({
        ok: false,
        error: 'sentinel: team target',
      });
      expect(mocks.resolveTeamTarget).toHaveBeenCalledWith('conv-1');
    });
  });

  describe('dismiss 降级链：typed child → legacy coworker → not-found', () => {
    const parentIdentity = { sessionId: 'conv-1', generation: 'pg1' };
    const childIdentity = {
      sessionId: 'conv-1::cw-1',
      generation: 'cg1',
      parent: parentIdentity,
      instanceId: 'i1',
      instanceName: 'Scout · 1',
      typeKey: 'builtin:scout',
    };
    const dismiss = (coworkerId: string) =>
      mocks.handlers.get(IPC_CHANNELS.AGENT_DISMISS_COWORKER)?.(event, 'conv-1', coworkerId, true);

    it('typed child（在 sessions 索引）走 dismiss-child 现路径', () => {
      mocks.currentIdentity.mockImplementation((sessionId: string) =>
        sessionId === 'conv-1' ? parentIdentity : childIdentity
      );
      expect(dismiss('conv-1::cw-1')).toEqual({ ok: true });
      expect(mocks.dismissChildSession).toHaveBeenCalledWith(parentIdentity, childIdentity, true);
      expect(mocks.dismissCoworkerSession).not.toHaveBeenCalled();
    });

    it('工具直雇 coworker（不在索引、在 parent.coworkers 映射）走 dismiss-coworker 命令', () => {
      // 39f4d3a 起的回归：这类 coworker 永远解不雇（'parent' in child 必然 false）
      mocks.currentIdentity.mockImplementation((sessionId: string) =>
        sessionId === 'conv-1' ? parentIdentity : undefined
      );
      mocks.coworkerOf.mockReturnValue({ id: 'conv-1::cw-bob', name: 'bob' });
      expect(dismiss('conv-1::cw-bob')).toEqual({ ok: true });
      expect(mocks.coworkerOf).toHaveBeenCalledWith(parentIdentity, 'conv-1::cw-bob');
      expect(mocks.dismissCoworkerSession).toHaveBeenCalledWith(
        parentIdentity,
        'conv-1::cw-bob',
        true
      );
      expect(mocks.dismissChildSession).not.toHaveBeenCalled();
    });

    it('两处都查不到（重启后的死 tab）返回 not-found，渲染层据此本地移除', () => {
      mocks.currentIdentity.mockImplementation((sessionId: string) =>
        sessionId === 'conv-1' ? parentIdentity : undefined
      );
      mocks.coworkerOf.mockReturnValue(undefined);
      expect(dismiss('conv-1::cw-gone')).toMatchObject({ ok: false });
      expect(mocks.dismissChildSession).not.toHaveBeenCalled();
      expect(mocks.dismissCoworkerSession).not.toHaveBeenCalled();
    });

    it('父身份解析不出（旧代/已结束）一律拒绝，不碰任何命令', () => {
      mocks.currentIdentity.mockReturnValue(undefined);
      expect(dismiss('conv-1::cw-bob')).toMatchObject({ ok: false });
      expect(mocks.dismissChildSession).not.toHaveBeenCalled();
      expect(mocks.dismissCoworkerSession).not.toHaveBeenCalled();
    });
  });

  it('已启动会话换模型走 exact identity，旧 generation 与 child 身份被拒', async () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.AGENT_SET_MODEL);
    expect(handler).toBeDefined();

    mocks.currentIdentity.mockReturnValue({ sessionId: 'conv-1', generation: 'gen-1' });
    await expect(handler?.(event, 'conv-1', 'pv-B', 'model-1')).resolves.toMatchObject({
      ok: true,
    });
    expect(mocks.setSessionModel).toHaveBeenCalledWith(
      { sessionId: 'conv-1', generation: 'gen-1' },
      'pv-B',
      'model-1',
      expect.anything()
    );

    // child 不能走父会话的换模型路径
    mocks.setSessionModel.mockClear();
    mocks.currentIdentity.mockReturnValue({
      sessionId: 'conv-1::cw-1',
      generation: 'g',
      parent: { sessionId: 'conv-1', generation: 'gen-1' },
      instanceId: 'i',
      instanceName: 'Enso-1',
      typeKey: 'agent:enso',
    });
    await expect(handler?.(event, 'conv-1::cw-1', 'pv-B', 'model-1')).resolves.toMatchObject({
      ok: false,
    });

    // 解析不出身份（会话已结束 / generation 已轮替）同样拒绝
    mocks.currentIdentity.mockReturnValue(undefined);
    await expect(handler?.(event, 'gone', 'pv-B', 'model-1')).resolves.toMatchObject({ ok: false });
    expect(mocks.setSessionModel).not.toHaveBeenCalled();
  });

  describe('手机第二屏的会话命令桥', () => {
    const parent = { sessionId: 'conv-1', generation: 'gen-1' };
    const child = {
      sessionId: 'conv-1::cw-1',
      generation: 'g',
      parent,
      instanceId: 'i',
      instanceName: 'Enso-1',
      typeKey: 'agent:enso',
    };
    const bridge = () =>
      mocks.setPairAgentBridge.mock.calls.at(-1)?.[0] as {
        prompt(sessionId: string, text: string): void;
        abort(sessionId: string): void;
        respondApproval(sessionId: string, requestId: string, decision: string): void;
        respondAsk(sessionId: string, requestId: string, answer: unknown): void;
        spawn(request: { sessionId: string }): Promise<unknown>;
      };
    const headless = () =>
      mocks.configurePairSessionHost.mock.calls.at(-1)?.[0] as {
        prompt(sessionId: string, text: string): void;
        setModel(sessionId: string, providerId: string, modelId: string): void;
      };

    it('裸 sessionId 被解析成 exact identity 后才下发', () => {
      mocks.currentIdentity.mockReturnValue(parent);
      bridge().prompt('conv-1', 'hello');
      expect(mocks.promptSession).toHaveBeenCalledWith(parent, 'hello', undefined);
    });

    it('解析不出身份时丢弃命令，不降级成按 sessionId 盲发', () => {
      // 手机只持有裸 sessionId；会话已结束/generation 已轮替时必须 fail-closed。
      mocks.currentIdentity.mockReturnValue(undefined);
      bridge().prompt('conv-gone', 'hello');
      bridge().abort('conv-gone');
      expect(mocks.promptSession).not.toHaveBeenCalled();
      expect(mocks.abortSession).not.toHaveBeenCalled();
    });

    it('coworker 标签页的审批/回答/输入/停止与桌面同样按 child 身份下发', () => {
      mocks.currentIdentity.mockReturnValue(child);
      bridge().respondApproval('conv-1::cw-1', 'r-1', 'allow');
      bridge().respondAsk('conv-1::cw-1', 'r-2', 'yes');
      bridge().prompt('conv-1::cw-1', 'hello');
      bridge().abort('conv-1::cw-1');
      headless().prompt('conv-1::cw-1', 'tray');
      expect(mocks.respondApproval).toHaveBeenCalledWith(child, 'r-1', 'allow');
      expect(mocks.respondAsk).toHaveBeenCalledWith(child, 'r-2', 'yes');
      expect(mocks.promptSession).toHaveBeenCalledWith(child, 'hello', undefined);
      expect(mocks.promptSession).toHaveBeenCalledWith(child, 'tray', undefined);
      expect(mocks.abortSession).toHaveBeenCalledWith(child);
    });

    it('child 身份不能作为新建会话的父身份，也不能被切模型', async () => {
      mocks.currentIdentity.mockReturnValue(child);
      mocks.credentials.mockRejectedValue(new Error('stop here'));
      await bridge().spawn({ sessionId: 'conv-1::cw-1' });
      expect(mocks.prepareParent).not.toHaveBeenCalledWith(child);
      headless().setModel('conv-1::cw-1', 'pv', 'm');
      await Promise.resolve();
      expect(mocks.setSessionModel).not.toHaveBeenCalled();
    });
  });

  describe.each([
    [IPC_CHANNELS.AGENT_PROMPT, mocks.promptSession],
    [IPC_CHANNELS.AGENT_STEER, mocks.steerSession],
  ])('%s 透传乐观回显 deliveryId', (channel, send) => {
    const parent = { sessionId: 'conv-1', generation: 'gen-1' };
    const invoke = (...args: unknown[]) => mocks.handlers.get(channel)?.(event, ...args);

    it('合法 deliveryId 原样下发，缺省时不带', async () => {
      mocks.currentIdentity.mockReturnValue(parent);
      send.mockReturnValue({ ok: true });
      await invoke('conv-1', 'hi', undefined, 'd-1');
      expect(send).toHaveBeenLastCalledWith(parent, 'hi', undefined, 'd-1');
      await invoke('conv-1', 'hi');
      expect(send).toHaveBeenLastCalledWith(parent, 'hi', undefined, undefined);
    });

    it.each(['', 7, 'x'.repeat(129)])('非法 deliveryId %# 拒绝且不下发', async (deliveryId) => {
      mocks.currentIdentity.mockReturnValue(parent);
      expect(await invoke('conv-1', 'hi', undefined, deliveryId)).toMatchObject({ ok: false });
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('已结束 child 的只读历史读取', () => {
    const read = (request: unknown) =>
      mocks.handlers.get(IPC_CHANNELS.AGENT_CHILD_HISTORY_READ)?.(event, request);

    it('正常路径返回投影', async () => {
      mocks.persistedConversation.mockReturnValue({
        sessionFile: '/tmp/agent/sessions/enso-parent__cw-1-gen.jsonl',
      });
      await expect(read({ conversationId: 'parent::cw-1' })).resolves.toEqual({
        ok: true,
        projection: { records: [], partial: false },
      });
    });

    it('不是持久化会话时不读任何文件', async () => {
      mocks.persistedConversation.mockReturnValue(null);
      await expect(read({ conversationId: 'unknown' })).resolves.toMatchObject({
        ok: false,
        code: 'not-found',
      });
      expect(mocks.restoreJournal).not.toHaveBeenCalled();
    });

    it('路径逃出 sessions 目录一律拒绝（防穿越）', async () => {
      mocks.persistedConversation.mockReturnValue({
        sessionFile: '/tmp/agent/sessions/../../../etc/passwd',
      });
      await expect(read({ conversationId: 'parent::cw-1' })).resolves.toMatchObject({
        ok: false,
        code: 'unavailable',
      });
      expect(mocks.restoreJournal).not.toHaveBeenCalled();
    });

    it('非 enso- 前缀的文件不读（pi 普通 session 未经脱敏）', async () => {
      mocks.persistedConversation.mockReturnValue({
        sessionFile: '/tmp/agent/sessions/2026-08-29T00-00-00-000Z_abc.jsonl',
      });
      await expect(read({ conversationId: 'parent::cw-1' })).resolves.toMatchObject({
        ok: false,
        code: 'unavailable',
      });
      expect(mocks.restoreJournal).not.toHaveBeenCalled();
    });

    it('文件不存在时给 not-found，不抛错', async () => {
      mocks.persistedConversation.mockReturnValue({
        sessionFile: '/tmp/agent/sessions/enso-gone.jsonl',
      });
      mocks.existsSync.mockReturnValue(false);
      await expect(read({ conversationId: 'parent::cw-1' })).resolves.toMatchObject({
        ok: false,
        code: 'not-found',
      });
    });

    it('渲染层传路径不会被采信', async () => {
      // 只认 conversationId；带上 sessionFile 也得走 Main 自己的持久化查询。
      mocks.persistedConversation.mockReturnValue(null);
      await expect(
        read({ conversationId: 'parent::cw-1', sessionFile: '/etc/passwd' })
      ).resolves.toMatchObject({
        ok: false,
        code: 'not-found',
      });
      expect(mocks.restoreJournal).not.toHaveBeenCalled();
    });
  });

  it('rejects dispatch payloads that forge profile, target, or reserved identity fields', async () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.AGENT_DISPATCH);
    expect(handler).toBeDefined();
    const base = {
      requestId: 'request',
      bindingId: 'binding',
      typeKey: 'agent:enso',
      task: { text: 'task', images: [], fileMentions: [] },
    };
    for (const forged of [
      { profileId: 'enso-locked-v1' },
      { sessionId: 'builtin-agent:enso' },
      { conversationId: 'other' },
      { projectPath: '/other' },
    ]) {
      await expect(handler!(event, { ...base, ...forged })).resolves.toMatchObject({
        accepted: false,
        code: 'invalid-request',
      });
    }
  });
});

describe('agent IPC 标题总结：回退链全部可解析候选一次性下发', () => {
  const titleModel = { providerId: 'p-title', modelId: 'm-title' };
  const defaultModel = { providerId: 'p-default', modelId: 'm-default' };
  const sessionModel = { providerId: 'p-session', modelId: 'm-session' };
  const config = (ref: { providerId: string; modelId: string }) => ({
    api: 'openai-completions',
    baseUrl: '',
    apiKey: 'k',
    modelId: ref.modelId,
    settingsProviderId: ref.providerId,
  });
  const request = {
    conversationId: 'conversation-1',
    input: { kind: 'initial', text: '帮我修一下节点转圈' },
    sessionModel,
  };

  beforeEach(() => {
    mocks.handlers.clear();
    mocks.summarizeConversationTitle.mockClear();
    mocks.resolveModelSelection.mockReset();
    mocks.readSettings.mockReturnValue({
      'enso-settings': {
        state: { titleSummaryEnabled: true, titleSummaryModel: titleModel, defaultModel },
      },
    });
    registerAgentHandlers();
  });

  it('三个候选全部可解析 → 按优先级下发 3 个 config', async () => {
    mocks.resolveModelSelection.mockImplementation((providerId: string, modelId: string) => ({
      ok: true,
      selection: { config: config({ providerId, modelId }) },
    }));
    const handler = mocks.handlers.get(IPC_CHANNELS.AGENT_SUMMARIZE_TITLE);
    await expect(handler!(event, request)).resolves.toEqual({ ok: true });
    expect(mocks.summarizeConversationTitle).toHaveBeenCalledWith(
      'conversation-1',
      { kind: 'initial', text: '帮我修一下节点转圈' },
      [config(titleModel), config(defaultModel), config(sessionModel)]
    );
  });

  it('中间候选不可解析 → 跳过它，下发其余 2 个', async () => {
    mocks.resolveModelSelection.mockImplementation((providerId: string, modelId: string) =>
      providerId === 'p-default'
        ? { ok: false, error: 'Model is unavailable' }
        : { ok: true, selection: { config: config({ providerId, modelId }) } }
    );
    const handler = mocks.handlers.get(IPC_CHANNELS.AGENT_SUMMARIZE_TITLE);
    await handler!(event, request);
    expect(mocks.summarizeConversationTitle).toHaveBeenCalledWith(
      'conversation-1',
      expect.anything(),
      [config(titleModel), config(sessionModel)]
    );
  });

  it('全部不可解析 → 不下发，返回 no usable title model', async () => {
    mocks.resolveModelSelection.mockReturnValue({ ok: false, error: 'nope' });
    const handler = mocks.handlers.get(IPC_CHANNELS.AGENT_SUMMARIZE_TITLE);
    await expect(handler!(event, request)).resolves.toEqual({
      ok: false,
      error: 'no usable title model',
    });
    expect(mocks.summarizeConversationTitle).not.toHaveBeenCalled();
  });

  it('开关关闭 → 不解析模型、不下发', async () => {
    mocks.readSettings.mockReturnValue({
      'enso-settings': { state: { titleSummaryEnabled: false, titleSummaryModel: titleModel } },
    });
    const handler = mocks.handlers.get(IPC_CHANNELS.AGENT_SUMMARIZE_TITLE);
    await expect(handler!(event, request)).resolves.toEqual({
      ok: false,
      error: 'title summary disabled',
    });
    expect(mocks.resolveModelSelection).not.toHaveBeenCalled();
  });

  describe('computer bridge', () => {
    const parent = { sessionId: '11111111-1111-4111-8111-111111111111', generation: 'g' };
    const emit = (event: Record<string, unknown>) =>
      mocks.setAgentEventListener.mock.calls.at(-1)![0]({ seq: 1, ...event });

    beforeEach(() => {
      mocks.readSettingsState.mockReturnValue({ disabledBuiltinTools: [] });
      mocks.computerInvoke.mockReset();
      mocks.sendComputerResult.mockReset();
    });

    it('child / coworker 身份的 computer-invoke 在 Main 拒绝', () => {
      emit({
        type: 'computer-invoke',
        identity: { ...parent, sessionId: 'child', parent, instanceId: 'i', instanceName: 'n' },
        requestId: 'r1',
        op: 'run',
        params: { code: 'return 1' },
      });
      expect(mocks.computerInvoke).not.toHaveBeenCalled();
      expect(mocks.sendComputerResult).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'child' }),
        'r1',
        expect.objectContaining({ ok: false })
      );
    });

    it('computer-cancel 中止 Main 侧 run，worker 退出时停下全部', async () => {
      let signal: AbortSignal | undefined;
      mocks.computerInvoke.mockImplementation(
        (_id: string, _op: string, _params: unknown, s: AbortSignal) => {
          signal = s;
          return new Promise((_, reject) =>
            s.addEventListener('abort', () => reject(new Error('Computer action aborted')))
          );
        }
      );
      emit({
        type: 'computer-invoke',
        identity: parent,
        requestId: 'r2',
        op: 'run',
        params: { code: 'await wait(1000)' },
      });
      expect(signal?.aborted).toBe(false);
      emit({ type: 'computer-cancel', identity: parent, requestId: 'r2' });
      expect(signal?.aborted).toBe(true);
      await vi.waitFor(() =>
        expect(mocks.sendComputerResult).toHaveBeenCalledWith(
          parent,
          'r2',
          expect.objectContaining({ ok: false })
        )
      );
      emit({ type: 'worker-exited' });
      expect(mocks.computerCloseAll).toHaveBeenCalled();
    });

    it('默认关闭时不执行', () => {
      mocks.readSettingsState.mockReturnValue({});
      emit({
        type: 'computer-invoke',
        identity: parent,
        requestId: 'r3',
        op: 'run',
        params: { code: 'return 1' },
      });
      expect(mocks.computerInvoke).not.toHaveBeenCalled();
    });
  });
});

describe('压缩完成触发记忆整理', () => {
  const identity = { sessionId: 'conv-1', generation: 'g' };
  const emit = (event: Record<string, unknown>) =>
    mocks.setAgentEventListener.mock.calls.at(-1)![0]({ seq: 1, identity, ...event });
  const distill = vi.fn(async () => {});
  const markCompacted = vi.fn();

  beforeEach(() => {
    mocks.handlers.clear();
    registerAgentHandlers();
    mocks.scheduleMemoryDistill.mockClear();
    distill.mockClear();
    markCompacted.mockClear();
    mocks.sessionFile.mockReturnValue('/tmp/agent/sessions/conv-1.jsonl');
    mocks.getBotServices.mockReturnValue({ memory: { distill }, groups: { markCompacted } });
  });

  const conversation = (bot?: { botId: string; chatId: string | null }) =>
    vi.spyOn(getSourceAuthorityRegistry()!, 'conversation').mockReturnValue({
      conversationId: 'conv-1',
      projectId: 'p',
      kind: 'root',
      lifecycle: 'ready',
      version: 1,
      ...(bot ? { bot } : {}),
    });

  it('Code 会话：成功压缩后按增量水位蒸馏；失败 / 放弃 / 开始不触发', () => {
    conversation();
    emit({ type: 'compaction', state: 'start' });
    emit({ type: 'compaction', state: 'end', error: 'boom' });
    emit({ type: 'compaction', state: 'end', abandoned: true });
    expect(mocks.scheduleMemoryDistill).not.toHaveBeenCalled();
    emit({ type: 'compaction', state: 'end' });
    expect(mocks.scheduleMemoryDistill).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleMemoryDistill).toHaveBeenCalledWith(
      { sessionId: 'conv-1', sessionFile: '/tmp/agent/sessions/conv-1.jsonl', projectId: null },
      { continueFromLastJob: true }
    );
    expect(distill).not.toHaveBeenCalled();
  });

  it('Code 会话结束同样走增量水位', () => {
    conversation();
    emit({ type: 'parent-ended' });
    expect(mocks.scheduleMemoryDistill).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'conv-1' }),
      { continueFromLastJob: true }
    );
  });

  it('Bot 群聊会话：压缩后走 Bot 记忆整理并标记下次补群状态', () => {
    conversation({ botId: 'bot-a', chatId: 'chat-1' });
    emit({ type: 'compaction', state: 'end' });
    expect(distill).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        sessionFile: '/tmp/agent/sessions/conv-1.jsonl',
      })
    );
    expect(markCompacted).toHaveBeenCalledWith('chat-1', 'bot-a', 'conv-1');
    expect(mocks.scheduleMemoryDistill).not.toHaveBeenCalled();
  });

  it('Bot 私聊会话：只整理记忆，不标记群状态', () => {
    conversation({ botId: 'bot-a', chatId: null });
    emit({ type: 'compaction', state: 'end' });
    expect(distill).toHaveBeenCalledTimes(1);
    expect(markCompacted).not.toHaveBeenCalled();
  });
});
