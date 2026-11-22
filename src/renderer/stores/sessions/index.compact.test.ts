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
const agentCompact = vi.fn(async () => ({ ok: true }));
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

describe('手动压缩的反馈', () => {
  beforeAll(async () => {
    await loadSessionModules();
  });

  beforeEach(async () => {
    await resetSessionHarness();
    agentCompact.mockClear();
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
});
