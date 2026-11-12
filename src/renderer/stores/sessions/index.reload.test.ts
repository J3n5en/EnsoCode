import type { ConversationReloadResult, SourceAuthorityProjection } from '@shared/types/agent';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentPrompt,
  agentRewind,
  agentWithdrawSteer,
  bindSessionProjection,
  installSessionGlobals,
  loadSessionModules,
  onAgentEvent,
  reloadConversation,
  seedParent,
  sessionsModule,
  settingsModule,
} from './index.testUtils';

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

describe('manual conversation reload', () => {
  beforeAll(async () => {
    await loadSessionModules();
  });

  beforeEach(async () => {
    reloadConversation.mockReset();
    if (!sessionsModule.useSessionsStore.getState().conversations.parent) {
      nextConversationId = 'parent';
      sourceProjection = {
        projects: [
          { projectId: 'project', canonicalPath: '/workspace', state: 'active', version: 1 },
        ],
        conversations: [],
      };
      sessionsModule.useSessionsStore.setState({
        conversations: {},
        order: [],
        activeId: null,
      });
      settingsModule.useSettingsStore.setState({
        projects: [{ id: 'project', name: 'Project', path: '/workspace' }],
      });
      await seedParent();
    }
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        live: {
          ...state.conversations.parent,
          id: 'live',
          parentId: undefined,
          activeTabId: undefined,
          started: true,
          spawning: false,
          status: 'running',
          generation: 'g1',
          lastSeq: 5,
          draftText: 'unsent draft',
          messages: [{ role: 'assistant', content: [{ type: 'text', text: 'stale' }] }],
        },
      },
      order: ['parent', 'live'],
      activeId: 'live',
    }));
  });

  const liveResult = (seq: number, text: string): ConversationReloadResult => ({
    ok: true,
    source: 'live',
    seq,
    snapshot: {
      identity: { sessionId: 'live', generation: 'g1' },
      status: 'running',
      messages: [{ role: 'assistant', content: [{ type: 'text', text }] }],
      commands: [],
    },
  });
  const textsOf = (id: string) =>
    sessionsModule.useSessionsStore
      .getState()
      .conversations[id].messages.map((message) => (message.content[0] as { text: string }).text);

  it('成功：权威正文替换，草稿与 started 保留，返回 null', async () => {
    reloadConversation.mockResolvedValue(liveResult(9, 'fresh'));
    const error = await sessionsModule.useSessionsStore.getState().reloadConversation('live');
    expect(error).toBeNull();
    expect(reloadConversation).toHaveBeenCalledWith('live');
    const live = sessionsModule.useSessionsStore.getState().conversations.live;
    expect(textsOf('live')).toEqual(['fresh']);
    expect(live.draftText).toBe('unsent draft');
    expect(live.started).toBe(true);
    expect(live.lastSeq).toBe(9);
    expect(live.reloading).toBeUndefined();
  });

  it('在途：reloading 标记，同会话并发合并为一次 IPC', async () => {
    let resolveReload: ((value: ConversationReloadResult) => void) | undefined;
    reloadConversation.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveReload = resolve;
        })
    );
    const first = sessionsModule.useSessionsStore.getState().reloadConversation('live');
    const second = sessionsModule.useSessionsStore.getState().reloadConversation('live');
    expect(sessionsModule.useSessionsStore.getState().conversations.live.reloading).toBe(true);
    expect(reloadConversation).toHaveBeenCalledTimes(1);
    resolveReload?.(liveResult(9, 'fresh'));
    expect(await Promise.all([first, second])).toEqual([null, null]);
    expect(sessionsModule.useSessionsStore.getState().conversations.live.reloading).toBeUndefined();
  });

  it('在途期间到达的实时事件既即时上屏，也在快照落地后按水位重放', async () => {
    let resolveReload: ((value: ConversationReloadResult) => void) | undefined;
    reloadConversation.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveReload = resolve;
        })
    );
    const pending = sessionsModule.useSessionsStore.getState().reloadConversation('live');
    onAgentEvent?.({
      type: 'message-upsert',
      identity: { sessionId: 'live', generation: 'g1' },
      seq: 10,
      index: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'after' }] },
    });
    expect(textsOf('live')).toEqual(['stale', 'after']);
    resolveReload?.(liveResult(9, 'fresh'));
    await pending;
    expect(textsOf('live')).toEqual(['fresh', 'after']);
    expect(sessionsModule.useSessionsStore.getState().conversations.live.lastSeq).toBe(10);
  });

  it('失败：正文不变，返回错误原因', async () => {
    reloadConversation.mockResolvedValue({ ok: false, error: 'History file is missing.' });
    const error = await sessionsModule.useSessionsStore.getState().reloadConversation('live');
    expect(error).toBe('History file is missing.');
    expect(textsOf('live')).toEqual(['stale']);
    expect(sessionsModule.useSessionsStore.getState().conversations.live.reloading).toBeUndefined();
  });

  it('会话在途中被删除：结果丢弃，不复活', async () => {
    let resolveReload: ((value: ConversationReloadResult) => void) | undefined;
    reloadConversation.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveReload = resolve;
        })
    );
    const pending = sessionsModule.useSessionsStore.getState().reloadConversation('live');
    sessionsModule.useSessionsStore.setState((state) => {
      const { live: _live, ...rest } = state.conversations;
      return { conversations: rest, order: ['parent'], activeId: 'parent' };
    });
    resolveReload?.(liveResult(9, 'fresh'));
    await pending;
    expect(sessionsModule.useSessionsStore.getState().conversations.live).toBeUndefined();
  });

  it('IPC 抛异常：当失败处理，不留 reloading', async () => {
    reloadConversation.mockRejectedValue(new Error('ipc down'));
    const error = await sessionsModule.useSessionsStore.getState().reloadConversation('live');
    expect(error).toBe('ipc down');
    expect(sessionsModule.useSessionsStore.getState().conversations.live.reloading).toBeUndefined();
  });
});

describe('withdraw undelivered messages', () => {
  beforeEach(async () => {
    await seedParent();
    agentRewind.mockClear();
    agentPrompt.mockClear();
  });

  it('等待中断期间撤回的队列项不能再被后台发送', async () => {
    const store = sessionsModule.useSessionsStore;
    store.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          status: 'running',
          queuedMessages: [{ id: 'q1', text: 'cancel me' }],
        },
      },
    }));
    const pending = store.getState().interruptAndSendQueued('parent', 'q1');
    store.getState().withdrawMessage('parent', { kind: 'queue', id: 'q1' });
    store.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          status: 'idle',
        },
      },
    }));
    await pending;
    expect(agentPrompt).not.toHaveBeenCalled();
    expect(store.getState().conversations.parent.messages).toEqual([]);
    expect(store.getState().conversations.parent.draftText).toBe('cancel me');
  });

  it('撤回本地队列并恢复附件，保留已有草稿、历史和计划', () => {
    const store = sessionsModule.useSessionsStore;
    const image = { data: 'aW1hZ2U=', mimeType: 'image/png' };
    store.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          draftText: 'existing',
          draftImages: [image],
          planState: {
            active: false,
            executing: { planId: 'plan', title: 'Plan', text: 'steps' },
            resolutions: { plan: 'approved' },
          },
          messages: [
            {
              role: 'toolResult',
              content: [],
              todos: [
                { content: 'done', status: 'completed' },
                { content: 'next', status: 'pending' },
              ],
            },
          ],
          queuedMessages: [
            { id: 'q1', text: 'continue', images: [image] },
            { id: 'q2', text: 'keep' },
          ],
        },
      },
    }));
    const before = store.getState().conversations.parent;
    store.getState().withdrawMessage('parent', { kind: 'queue', id: 'q1' });
    const after = store.getState().conversations.parent;
    expect(after.queuedMessages).toEqual([{ id: 'q2', text: 'keep' }]);
    expect(after).toMatchObject({
      draftText: 'existing\n\ncontinue',
      draftImages: [image, image],
      draftAppend: true,
    });
    expect(after.messages).toBe(before.messages);
    expect(after.planState).toBe(before.planState);
    expect(agentRewind).not.toHaveBeenCalled();
    expect(agentPrompt).not.toHaveBeenCalled();
    store.getState().withdrawMessage('parent', { kind: 'queue', id: 'q1' });
    expect(store.getState().conversations.parent).toBe(after);
    store.getState().clearDraft('parent');
    expect(store.getState().conversations.parent.draftAppend).toBeUndefined();
  });

  it.each(['rejected', 'pending', 'persisted'])(
    '只撤回明确拒收的精确投递，不靠失败状态推测（%s）',
    (delivery) => {
      const store = sessionsModule.useSessionsStore;
      const echo = {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'continue' }],
        optimistic: true,
        deliveryId: 'd1',
        deliveryRejected: delivery !== 'pending',
        ...(delivery === 'persisted' ? { entryId: 'entry' } : {}),
      };
      store.setState((state) => ({
        conversations: {
          ...state.conversations,
          parent: {
            ...state.conversations.parent,
            status: 'failed',
            messages: [echo, { ...echo, deliveryId: 'd2' }],
          },
        },
      }));
      const before = store.getState().conversations.parent;
      store.getState().withdrawMessage('parent', { kind: 'delivery', id: 'd1' });
      const after = store.getState().conversations.parent;
      if (delivery === 'rejected') {
        expect(after.messages).toEqual([before.messages[1]]);
        expect(after.draftText).toBe('continue');
        expect(after.draftAppend).toBe(true);
      } else expect(after).toBe(before);
      expect(agentRewind).not.toHaveBeenCalled();
    }
  );

  describe('运行中撤回模型未读的插话', () => {
    const pendingEcho = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'later' }],
      optimistic: true,
      deliveryId: 'd1',
    };
    const seedRunning = () =>
      sessionsModule.useSessionsStore.setState((state) => ({
        conversations: {
          ...state.conversations,
          parent: {
            ...state.conversations.parent,
            started: true,
            status: 'running',
            generation: 'g1',
            lastSeq: 0,
            draftText: 'existing',
            messages: [pendingEcho],
          },
        },
      }));

    beforeEach(() => {
      agentWithdrawSteer.mockClear();
      agentWithdrawSteer.mockResolvedValue({ ok: true });
    });

    it('请求 worker 撤回；回执后收回回显并把原文退回输入框', () => {
      const store = sessionsModule.useSessionsStore;
      seedRunning();
      store.getState().withdrawMessage('parent', { kind: 'delivery', id: 'd1' });
      store.getState().withdrawMessage('parent', { kind: 'delivery', id: 'd1' });
      expect(agentWithdrawSteer).toHaveBeenCalledTimes(1);
      expect(agentWithdrawSteer).toHaveBeenCalledWith('parent', 'd1');
      expect(store.getState().conversations.parent.messages).toEqual([
        { ...pendingEcho, withdrawRequested: true },
      ]);
      expect(store.getState().conversations.parent.draftText).toBe('existing');
      onAgentEvent?.({
        type: 'delivery-rejected',
        identity: { sessionId: 'parent', generation: 'g1' },
        seq: 1,
        deliveryId: 'd1',
      });
      const after = store.getState().conversations.parent;
      expect(after.messages).toEqual([]);
      expect(after.draftText).toBe('existing\n\nlater');
      expect(after.draftAppend).toBe(true);
    });

    it('撤回请求未送达 worker 时恢复为可再次撤回', async () => {
      const store = sessionsModule.useSessionsStore;
      seedRunning();
      agentWithdrawSteer.mockResolvedValueOnce({ ok: false, error: 'gone' });
      store.getState().withdrawMessage('parent', { kind: 'delivery', id: 'd1' });
      await vi.waitFor(() =>
        expect(store.getState().conversations.parent.messages).toEqual([pendingEcho])
      );
    });
  });
});
