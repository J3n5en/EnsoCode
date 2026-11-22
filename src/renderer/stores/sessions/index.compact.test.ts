import type { SourceAuthorityProjection } from '@shared/types/agent';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindSessionProjection,
  installSessionGlobals,
  loadSessionModules,
  resetSessionHarness,
  sessionsModule,
} from './index.testUtils';

const { addToast } = vi.hoisted(() => ({ addToast: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ addToast }));

let sourceProjection: SourceAuthorityProjection = { projects: [], conversations: [] };
let nextConversationId = 'parent';
bindSessionProjection({
  get sourceProjection() {
    return sourceProjection;
  },
  set sourceProjection(value) {
    sourceProjection = value;
  },
  get nextConversationId() {
    return nextConversationId;
  },
  set nextConversationId(value) {
    nextConversationId = value;
  },
});
installSessionGlobals();
const agentCompact = vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true }));
Object.assign(window.electronAPI.agent, { compact: agentCompact });

const setParent = (fields: Record<string, unknown>) =>
  sessionsModule.useSessionsStore.setState((state) => ({
    conversations: {
      ...state.conversations,
      parent: { ...state.conversations.parent, ...fields },
    },
  }));

const toastDescriptions = () =>
  addToast.mock.calls.map((call) => (call as unknown as [{ description: string }])[0].description);
const sendCompact = (text = '/compact') =>
  sessionsModule.useSessionsStore
    .getState()
    .send(text, { providerId: 'p', modelId: 'm', cwd: '/workspace' }, undefined, 'parent');

describe('手动压缩的反馈', () => {
  beforeAll(async () => {
    await loadSessionModules();
  });

  beforeEach(async () => {
    await resetSessionHarness();
    agentCompact.mockReset();
    agentCompact.mockResolvedValue({ ok: true });
    addToast.mockClear();
  });

  it('正常情况调用 compact 且不提示', async () => {
    setParent({ started: true });
    sessionsModule.useSessionsStore.getState().compact('parent', 'focus');
    expect(agentCompact).toHaveBeenCalledWith('parent', 'focus');
    await Promise.resolve();
    expect(addToast).not.toHaveBeenCalled();
  });

  it('正在压缩时不重复调用，并提示正在压缩', async () => {
    setParent({ started: true, compaction: 'running' });
    sessionsModule.useSessionsStore.getState().compact('parent');
    expect(agentCompact).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(toastDescriptions()).toEqual(['Compaction already in progress']));
  });

  it('已排队时提示本轮结束后压缩', async () => {
    setParent({ started: true, compaction: 'queued' });
    sessionsModule.useSessionsStore.getState().compact('parent');
    expect(agentCompact).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(toastDescriptions()).toEqual(['Compaction is queued and runs after this turn'])
    );
  });

  it('会话未启动时提示无可压缩上下文', async () => {
    setParent({ started: false });
    sessionsModule.useSessionsStore.getState().compact('parent');
    expect(agentCompact).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(toastDescriptions()).toEqual(['Session not started yet — nothing to compact'])
    );
  });

  it('工作区迁移中时提示稍后再压缩', async () => {
    setParent({ started: true, workspaceMigrating: true });
    sessionsModule.useSessionsStore.getState().compact('parent');
    expect(agentCompact).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(toastDescriptions()).toEqual([
        'Workspace operation in progress — compact again when it finishes',
      ])
    );
  });

  it('/compact 在会话未启动时也提示，而不是静默丢弃', async () => {
    setParent({ started: false });
    await expect(sendCompact()).resolves.toBeNull();
    expect(agentCompact).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(toastDescriptions()).toEqual(['Session not started yet — nothing to compact'])
    );
  });

  it('/compact 在工作区操作中也提示，而不是被通用拦截吞掉', async () => {
    setParent({ started: true, workspaceMigrating: true });
    await expect(sendCompact('/compact 保留分工')).resolves.toBeNull();
    expect(agentCompact).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(toastDescriptions()).toEqual([
        'Workspace operation in progress — compact again when it finishes',
      ])
    );
  });

  it('/compact 正常时带上摘要侧重转给 compact', async () => {
    setParent({ started: true });
    await expect(sendCompact('/compact 保留分工')).resolves.toBeNull();
    expect(agentCompact).toHaveBeenCalledWith('parent', '保留分工');
  });

  it('Main 拒绝时提示压缩失败', async () => {
    agentCompact.mockResolvedValue({ ok: false, error: 'Workspace operation in progress.' });
    setParent({ started: true });
    sessionsModule.useSessionsStore.getState().compact('parent');
    await vi.waitFor(() =>
      expect(addToast).toHaveBeenCalledWith({
        type: 'error',
        title: 'Compaction failed',
        description: 'Workspace operation in progress.',
      })
    );
  });

  it('手机代发（quiet）不在桌面弹提示', async () => {
    agentCompact.mockResolvedValue({ ok: false, error: 'stale' });
    setParent({ started: true, compaction: 'running' });
    sessionsModule.useSessionsStore.getState().compact('parent', undefined, { quiet: true });
    setParent({ compaction: undefined });
    sessionsModule.useSessionsStore.getState().compact('parent', undefined, { quiet: true });
    expect(agentCompact).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(addToast).not.toHaveBeenCalled();
  });
});
