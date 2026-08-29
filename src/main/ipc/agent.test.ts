import { IPC_CHANNELS } from '@shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  spawnSession: vi.fn(),
  setAgentEventListener: vi.fn(),
  restoreJournal: vi.fn(() => ({ records: [], partial: false })),
  existsSync: vi.fn(() => true),
  persistedConversation: vi.fn(),
  currentIdentity: vi.fn(),
  coworkerOf: vi.fn(),
  dismissChildSession: vi.fn(() => ({ ok: true })),
  dismissCoworkerSession: vi.fn(() => ({ ok: true })),
  promptSession: vi.fn(),
  steerSession: vi.fn(),
  abortSession: vi.fn(),
  setPairAgentBridge: vi.fn(),
  setSessionModel: vi.fn(() => ({ ok: true })),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../windows/MainWindow', () => ({ isMainWebContents: vi.fn(() => true) }));
vi.mock('../services/oauthProviders', () => ({
  readStoredOauthCredentialKeys: vi.fn(async () => new Set<string>()),
}));
vi.mock('../services/agentHost', () => ({
  abortSession: mocks.abortSession,
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
  resolveModelSelection: vi.fn(),
  respondApproval: vi.fn(),
  respondAsk: vi.fn(),
  rewindSession: vi.fn(),
  setAgentEventListener: mocks.setAgentEventListener,
  setSessionApprovalMode: vi.fn(),
  setSessionModel: mocks.setSessionModel,
  setSessionReasoning: vi.fn(),
  setSessionThinking: vi.fn(),
  spawnChildSession: vi.fn(),
  spawnSession: mocks.spawnSession,
  steerSession: mocks.steerSession,
  stopBackgroundTask: vi.fn(),
}));
vi.mock('../services/notifications', () => ({ maybeNotify: vi.fn() }));
vi.mock('../services/pairHost', () => ({
  forwardAgentEvent: vi.fn(),
  setPairAgentBridge: mocks.setPairAgentBridge,
}));
vi.mock('./capabilities', () => ({
  agentSessionIndex: {
    currentIdentity: mocks.currentIdentity,
    prepareParent: vi.fn(),
    observe: vi.fn(),
    reserveChild: vi.fn(),
    releaseChild: vi.fn(),
    resolveTeamTarget: vi.fn(),
    persistedConversation: mocks.persistedConversation,
    coworkerOf: mocks.coworkerOf,
  },
  capabilityGateway: {
    registerInvocation: vi.fn(() => true),
    terminateGeneration: vi.fn(),
  },
  handleCapabilityInvoke: vi.fn(),
}));
vi.mock('./settings', () => ({ readSettings: vi.fn(() => null) }));
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

import { registerAgentHandlers } from './agent';

const sender = {
  id: 1,
  once: vi.fn(),
};
const event = { sender };

describe('agent IPC Main identity boundary', () => {
  beforeEach(() => {
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
    mocks.setSessionModel.mockClear();
    mocks.coworkerOf.mockReset();
    mocks.dismissChildSession.mockClear();
    mocks.dismissCoworkerSession.mockClear();
    registerAgentHandlers();
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
    const bridge = () =>
      mocks.setPairAgentBridge.mock.calls.at(-1)?.[0] as {
        prompt(sessionId: string, text: string): void;
        abort(sessionId: string): void;
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

    it('child 身份不能冒充父会话接收手机命令', () => {
      mocks.currentIdentity.mockReturnValue({
        sessionId: 'conv-1::cw-1',
        generation: 'g',
        parent,
        instanceId: 'i',
        instanceName: 'Enso-1',
        typeKey: 'agent:enso',
      });
      bridge().prompt('conv-1::cw-1', 'hello');
      expect(mocks.promptSession).not.toHaveBeenCalled();
    });
  });

  describe('已结束 child 的只读历史读取', () => {
    const read = (request: unknown) =>
      mocks.handlers.get(IPC_CHANNELS.AGENT_CHILD_HISTORY_READ)?.(event, request);

    it('正常路径返回投影', () => {
      mocks.persistedConversation.mockReturnValue({
        sessionFile: '/tmp/agent/sessions/enso-parent__cw-1-gen.jsonl',
      });
      expect(read({ conversationId: 'parent::cw-1' })).toEqual({
        ok: true,
        projection: { records: [], partial: false },
      });
    });

    it('不是持久化会话时不读任何文件', () => {
      mocks.persistedConversation.mockReturnValue(null);
      expect(read({ conversationId: 'unknown' })).toMatchObject({ ok: false, code: 'not-found' });
      expect(mocks.restoreJournal).not.toHaveBeenCalled();
    });

    it('路径逃出 sessions 目录一律拒绝（防穿越）', () => {
      mocks.persistedConversation.mockReturnValue({
        sessionFile: '/tmp/agent/sessions/../../../etc/passwd',
      });
      expect(read({ conversationId: 'parent::cw-1' })).toMatchObject({
        ok: false,
        code: 'unavailable',
      });
      expect(mocks.restoreJournal).not.toHaveBeenCalled();
    });

    it('非 enso- 前缀的文件不读（pi 普通 session 未经脱敏）', () => {
      mocks.persistedConversation.mockReturnValue({
        sessionFile: '/tmp/agent/sessions/2026-08-29T00-00-00-000Z_abc.jsonl',
      });
      expect(read({ conversationId: 'parent::cw-1' })).toMatchObject({
        ok: false,
        code: 'unavailable',
      });
      expect(mocks.restoreJournal).not.toHaveBeenCalled();
    });

    it('文件不存在时给 not-found，不抛错', () => {
      mocks.persistedConversation.mockReturnValue({
        sessionFile: '/tmp/agent/sessions/enso-gone.jsonl',
      });
      mocks.existsSync.mockReturnValue(false);
      expect(read({ conversationId: 'parent::cw-1' })).toMatchObject({
        ok: false,
        code: 'not-found',
      });
    });

    it('渲染层传路径不会被采信', () => {
      // 只认 conversationId；带上 sessionFile 也得走 Main 自己的持久化查询。
      mocks.persistedConversation.mockReturnValue(null);
      expect(read({ conversationId: 'parent::cw-1', sessionFile: '/etc/passwd' })).toMatchObject({
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
