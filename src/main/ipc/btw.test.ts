import { IPC_CHANNELS } from '@shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  completeText: vi.fn(),
  abortCompleteText: vi.fn(() => ({ ok: true })),
  spawnSession: vi.fn(() => ({ ok: true })),
  abortSession: vi.fn(() => ({ ok: true })),
  releaseParentSession: vi.fn(async () => ({ ok: true })),
  isAgentWorkerReady: vi.fn(() => true),
  resolveModelSelection: vi.fn(),
  readSettings: vi.fn((): unknown => ({
    'enso-settings': { state: { defaultModel: { providerId: 'p', modelId: 'm' } } },
  })),
  credentials: vi.fn(async () => new Set<string>()),
  isMainWebContents: vi.fn(() => true),
  authorityConversation: vi.fn(),
  workspace: vi.fn(),
  prepareParent: vi.fn(),
  currentIdentity: vi.fn(),
  sessionFile: vi.fn(),
  cleanup: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
  },
  app: { getPath: () => '/tmp' },
}));

vi.mock('../windows/MainWindow', () => ({ isMainWebContents: mocks.isMainWebContents }));
vi.mock('./settings', () => ({ readSettings: mocks.readSettings }));
vi.mock('../services/oauthProviders', () => ({
  readStoredOauthCredentialKeys: mocks.credentials,
}));
vi.mock('../services/agentHost', () => ({
  abortCompleteText: mocks.abortCompleteText,
  abortSession: mocks.abortSession,
  completeText: mocks.completeText,
  isAgentWorkerReady: mocks.isAgentWorkerReady,
  releaseParentSession: mocks.releaseParentSession,
  resolveModelSelection: mocks.resolveModelSelection,
  spawnSession: mocks.spawnSession,
}));
vi.mock('../services/sessionFileCleanup', () => ({
  removeConversationSessionFiles: mocks.cleanup,
}));
vi.mock('./agent', () => ({
  getSourceAuthorityRegistry: () => ({ conversation: mocks.authorityConversation }),
  resolveConversationWorkspace: mocks.workspace,
}));
vi.mock('./capabilities', () => ({
  agentSessionIndex: {
    prepareParent: mocks.prepareParent,
    currentIdentity: mocks.currentIdentity,
    sessionFile: mocks.sessionFile,
  },
}));

import { registerBtwHandlers } from './btw';

const event = { sender: { id: 1 } };

function handle(channel: string): (...args: unknown[]) => unknown {
  const fn = mocks.handlers.get(channel);
  if (!fn) throw new Error(`missing ${channel}`);
  return fn;
}

describe('btw IPC', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.completeText.mockReset();
    mocks.abortCompleteText.mockReset().mockReturnValue({ ok: true });
    mocks.isAgentWorkerReady.mockReturnValue(true);
    mocks.isMainWebContents.mockReturnValue(true);
    mocks.credentials.mockResolvedValue(new Set());
    mocks.resolveModelSelection.mockReturnValue({
      ok: true,
      selection: { config: { modelId: 'm' } },
    });
    mocks.spawnSession.mockReset().mockReturnValue({ ok: true });
    mocks.abortSession.mockReset().mockReturnValue({ ok: true });
    mocks.releaseParentSession.mockReset().mockResolvedValue({ ok: true });
    mocks.authorityConversation.mockReset().mockReturnValue(undefined);
    mocks.workspace.mockReset().mockReturnValue({ cwd: '/repo', projectId: 'p' });
    mocks.prepareParent.mockReset();
    mocks.currentIdentity.mockReset().mockReturnValue(undefined);
    mocks.sessionFile.mockReset();
    mocks.cleanup.mockReset();
    registerBtwHandlers();
  });

  it('拒绝脏请求和非主窗口', async () => {
    await expect(handle(IPC_CHANNELS.BTW_PROMPT)(event, { requestId: '' })).resolves.toEqual({
      ok: false,
      error: 'invalid request',
    });
    mocks.isMainWebContents.mockReturnValue(false);
    await expect(
      handle(IPC_CHANNELS.BTW_PROMPT)(event, {
        requestId: 'r1',
        conversationId: 'c1',
        systemPrompt: 's',
        userText: 'hi',
      })
    ).resolves.toEqual({ ok: false, error: 'not authorized' });
  });

  it('worker 未就绪时不发补全', async () => {
    mocks.isAgentWorkerReady.mockReturnValue(false);
    await expect(
      handle(IPC_CHANNELS.BTW_PROMPT)(event, {
        requestId: 'r1',
        conversationId: 'c1',
        systemPrompt: 's',
        userText: 'hi',
      })
    ).resolves.toEqual({ ok: false, error: 'Agent worker is not running.' });
    expect(mocks.completeText).not.toHaveBeenCalled();
  });

  it('把会话模型交给 completeText，中止走 abortCompleteText', async () => {
    mocks.completeText.mockResolvedValueOnce('aside answer');
    await expect(
      handle(IPC_CHANNELS.BTW_PROMPT)(event, {
        requestId: 'r1',
        conversationId: 'c1',
        systemPrompt: 's',
        userText: 'hi',
        sessionModel: { providerId: 'p', modelId: 'm' },
        reasoningEnabled: true,
        thinkingLevel: 'high',
      })
    ).resolves.toEqual({ ok: true, text: 'aside answer' });
    expect(mocks.completeText).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'r1',
        userText: 'hi',
        stream: true,
        reasoning: 'high',
      })
    );

    mocks.completeText.mockRejectedValueOnce(new Error('aborted'));
    await expect(
      handle(IPC_CHANNELS.BTW_PROMPT)(event, {
        requestId: 'r2',
        conversationId: 'c1',
        systemPrompt: 's',
        userText: 'hi',
      })
    ).resolves.toEqual({ ok: false, error: 'aborted', aborted: true });

    expect(handle(IPC_CHANNELS.BTW_ABORT)(event, { requestId: 'r1' })).toEqual({ ok: true });
    expect(mocks.abortCompleteText).toHaveBeenCalledWith('r1');
  });

  it('spawn 继承父工作区并关掉 subagent/coworker', async () => {
    await expect(
      handle(IPC_CHANNELS.BTW_SPAWN)(event, {
        sessionId: 'btw-1',
        parentConversationId: 'parent-1',
        providerId: 'p',
        modelId: 'm',
        rolePrompt: 'You are aside',
        reasoningEnabled: true,
        thinkingLevel: 'low',
        presetId: 'coding',
        loadLocalSkills: false,
      })
    ).resolves.toEqual({ ok: true });
    expect(mocks.prepareParent).toHaveBeenCalled();
    expect(mocks.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'btw-1' }),
      expect.objectContaining({
        sessionId: 'btw-1',
        providerId: 'p',
        modelId: 'm',
        cwd: '/repo',
        reasoningEnabled: true,
        thinkingLevel: 'low',
        approvalMode: 'full',
        presetId: 'coding',
        loadLocalSkills: false,
      }),
      expect.any(Set),
      undefined,
      'p',
      expect.objectContaining({
        rolePrompt: 'You are aside',
        extraDisabledTools: ['subagent', 'coworker', 'workflow'],
        omitDispatchTools: true,
      })
    );
  });

  it('spawn 拒绝占用中的会话 id 和缺失父会话', async () => {
    mocks.authorityConversation.mockReturnValue({ kind: 'root' });
    await expect(
      handle(IPC_CHANNELS.BTW_SPAWN)(event, {
        sessionId: 'btw-1',
        parentConversationId: 'parent-1',
        providerId: 'p',
        modelId: 'm',
        rolePrompt: 'You are aside',
      })
    ).resolves.toEqual({ ok: false, error: 'session id in use' });
    mocks.authorityConversation.mockReturnValue(undefined);
    mocks.workspace.mockReturnValue(null);
    await expect(
      handle(IPC_CHANNELS.BTW_SPAWN)(event, {
        sessionId: 'btw-1',
        parentConversationId: 'parent-1',
        providerId: 'p',
        modelId: 'm',
        rolePrompt: 'You are aside',
      })
    ).resolves.toEqual({ ok: false, error: 'parent conversation unavailable' });
    expect(mocks.spawnSession).not.toHaveBeenCalled();
  });

  it('dispose 释放 worker 并删 jsonl', async () => {
    mocks.currentIdentity.mockReturnValue({ sessionId: 'btw-1', generation: 'g1' });
    mocks.sessionFile.mockReturnValue('/tmp/agent/sessions/enso-btw-1.jsonl');
    await expect(handle(IPC_CHANNELS.BTW_DISPOSE)(event, { sessionId: 'btw-1' })).resolves.toEqual({
      ok: true,
    });
    expect(mocks.abortSession).toHaveBeenCalledWith({ sessionId: 'btw-1', generation: 'g1' });
    expect(mocks.releaseParentSession).toHaveBeenCalledWith({
      sessionId: 'btw-1',
      generation: 'g1',
    });
    expect(mocks.cleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'btw-1',
        sessionFile: '/tmp/agent/sessions/enso-btw-1.jsonl',
      })
    );
  });
});
