import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  dataDir: '',
  completeText: vi.fn(async () => 'feat: x'),
  resolveModelSelection: vi.fn(() => ({ ok: true, selection: { config: { modelId: 'm' } } })),
  readSettings: vi.fn((): unknown => ({ 'enso-settings': { state: {} } })),
  withSessionGitWorkspace: vi.fn(),
  isMainRenderer: vi.fn(() => true),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
  },
  app: { getPath: () => mocks.dataDir },
}));
vi.mock('../services/renderers', () => ({ isMainRenderer: mocks.isMainRenderer }));
vi.mock('./settings', () => ({ readSettings: mocks.readSettings }));
vi.mock('./worktree', () => ({ withSessionGitWorkspace: mocks.withSessionGitWorkspace }));
vi.mock('../services/oauthProviders', () => ({
  readStoredOauthCredentialKeys: async () => new Set<string>(),
}));
vi.mock('../services/agentHost', () => ({
  completeText: mocks.completeText,
  isAgentWorkerReady: () => true,
  resolveModelSelection: mocks.resolveModelSelection,
}));

import { registerGitCommitMessageHandlers } from './gitCommitMessage';

const sender = { sender: { id: 1 } };
const invoke = (channel: string, ...args: unknown[]) =>
  mocks.handlers.get(channel)?.(sender, ...args) as Promise<Record<string, unknown>>;
const request = { conversationId: 'c', projectId: 'p', requestId: 'r' };

beforeEach(() => {
  mocks.dataDir = mkdtempSync(path.join(tmpdir(), 'git-commit-ipc-'));
  mocks.handlers.clear();
  vi.clearAllMocks();
  registerGitCommitMessageHandlers();
});
afterEach(() => {
  rmSync(mocks.dataDir, { recursive: true, force: true });
});

describe('git commit message IPC', () => {
  it('非主窗口拒绝', async () => {
    mocks.isMainRenderer.mockReturnValueOnce(false);
    expect(await invoke(IPC_CHANNELS.GIT_GENERATE_COMMIT_MESSAGE, request)).toMatchObject({
      ok: false,
    });
    expect(mocks.completeText).not.toHaveBeenCalled();
  });

  it('坏入参拒绝，不碰 git 与模型', async () => {
    for (const bad of [undefined, 'x', { ...request, requestId: '' }, { conversationId: 'c' }]) {
      expect(await invoke(IPC_CHANNELS.GIT_GENERATE_COMMIT_MESSAGE, bad)).toMatchObject({
        ok: false,
        code: 'invalid-request',
      });
    }
    expect(await invoke(IPC_CHANNELS.GIT_GENERATE_COMMIT_MESSAGE_ABORT, { requestId: 1 })).toEqual({
      ok: false,
      error: 'invalid request',
    });
    expect(mocks.withSessionGitWorkspace).not.toHaveBeenCalled();
    expect(mocks.completeText).not.toHaveBeenCalled();
  });

  it('未配置时不发起模型调用', async () => {
    expect(await invoke(IPC_CHANNELS.GIT_GENERATE_COMMIT_MESSAGE, request)).toMatchObject({
      ok: false,
      code: 'not-configured',
      missing: 'provider',
    });
    expect(mocks.resolveModelSelection).not.toHaveBeenCalled();
    expect(mocks.withSessionGitWorkspace).not.toHaveBeenCalled();
    expect(mocks.completeText).not.toHaveBeenCalled();
  });

  it('已配置：读 diff 后经 completeText 调模型，自定义标记决定提示词', async () => {
    mocks.readSettings.mockReturnValue({
      'enso-settings': {
        state: {
          gitCommitModel: { providerId: 'p', modelId: 'm' },
          gitCommitPromptCustomized: true,
        },
      },
    });
    mocks.withSessionGitWorkspace.mockResolvedValue({ staged: 'S', unstaged: '' });
    await invoke(IPC_CHANNELS.GIT_COMMIT_PROMPT_WRITE, { text: 'MY RULES' });
    expect(await invoke(IPC_CHANNELS.GIT_GENERATE_COMMIT_MESSAGE, request)).toEqual({
      ok: true,
      message: 'feat: x',
      source: 'staged',
      truncated: false,
    });
    expect(mocks.completeText).toHaveBeenCalledWith(
      expect.objectContaining({ systemPrompt: 'MY RULES', userText: 'S', reasoning: 'off' })
    );
  });

  it('提示词：只写 userData 下固定文件；坏输入不落盘；恢复默认即删除', async () => {
    const file = path.join(mocks.dataDir, 'git-commit-prompt.txt');
    expect(await invoke(IPC_CHANNELS.GIT_COMMIT_PROMPT_WRITE, { text: '' })).toMatchObject({
      ok: false,
    });
    expect(await invoke(IPC_CHANNELS.GIT_COMMIT_PROMPT_WRITE, 'rules')).toMatchObject({
      ok: false,
    });
    expect(existsSync(file)).toBe(false);
    expect(
      await invoke(IPC_CHANNELS.GIT_COMMIT_PROMPT_WRITE, { text: 'rules', path: '/etc/passwd' })
    ).toEqual({ ok: true });
    expect(readFileSync(file, 'utf8')).toBe('rules');
    expect(await invoke(IPC_CHANNELS.GIT_COMMIT_PROMPT_READ)).toEqual({
      ok: true,
      text: 'rules',
      custom: true,
    });
    expect(await invoke(IPC_CHANNELS.GIT_COMMIT_PROMPT_RESET)).toEqual({ ok: true });
    expect(existsSync(file)).toBe(false);
    expect(await invoke(IPC_CHANNELS.GIT_COMMIT_PROMPT_READ)).toMatchObject({ custom: false });
  });
});
