import type { SourceAuthorityProjection } from '@shared/types/agent';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentFork,
  agentRewind,
  agentSpawn,
  bindSessionProjection,
  installSessionGlobals,
  loadSessionModules,
  onAgentEvent,
  requestSnapshot,
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

const rewindMessages = () =>
  ['one', 'two'].map((text) => ({
    role: 'user' as const,
    entryId: `entry-${text}`,
    content: [{ type: 'text' as const, text }],
  }));

function emitRewindSnapshot(sessionId = 'parent') {
  onAgentEvent?.({
    type: 'snapshot',
    partial: true,
    sessions: [
      {
        identity: { sessionId, generation: 'g-ready' },
        status: 'idle',
        messages: rewindMessages(),
        commands: [],
      },
    ],
  });
}

function enableRewindResumeModel() {
  settingsModule.useSettingsStore.setState({
    projects: [{ id: 'project', name: 'Project', path: '/workspace' }],
    providers: [
      {
        id: 'p1',
        name: 'p1',
        api: 'openai-completions',
        apiKey: 'k',
        baseUrl: 'https://example.test/v1',
        enabled: true,
        models: [{ id: 'm1' }],
      },
    ],
    defaultModel: { providerId: 'p1', modelId: 'm1' },
  });
}

describe('rewind 在 failed 状态放行、running 仍拦截', () => {
  beforeAll(async () => {
    await loadSessionModules();
  });

  beforeEach(async () => {
    agentRewind.mockClear();
    agentSpawn.mockClear();
    agentSpawn.mockResolvedValue({ ok: true });
    nextConversationId = 'parent';
    sourceProjection = {
      projects: [
        {
          projectId: 'project',
          canonicalPath: '/workspace',
          state: 'active',
          version: 1,
        },
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
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: { ...state.conversations.parent, messages: rewindMessages() },
      },
    }));
  });

  it('status:failed 时调用 window.electronAPI.agent.rewind', () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          spawning: false,
          status: 'failed' as const,
          generation: 'g1',
        },
      },
    }));
    sessionsModule.useSessionsStore.getState().rewind('parent', 0, false);
    expect(agentRewind).toHaveBeenCalledWith('parent', 'entry-two', false);
  });

  it.each([false, true])(
    '未确认继续不裁剪进度、不唤醒或下发回退（restoreFiles=%s）',
    (restoreFiles) => {
      const messages = [
        { role: 'user', entryId: 'execute', content: [{ type: 'text' as const, text: 'execute' }] },
        {
          role: 'toolResult',
          toolName: 'todo',
          content: [],
          todos: [{ content: 'done', status: 'completed' as const }],
        },
        { role: 'user', optimistic: true, content: [{ type: 'text' as const, text: 'continue' }] },
      ];
      sessionsModule.useSessionsStore.setState((state) => ({
        conversations: {
          ...state.conversations,
          parent: {
            ...state.conversations.parent,
            started: true,
            spawning: false,
            status: 'failed',
            messages,
          },
        },
      }));
      sessionsModule.useSessionsStore.getState().rewind('parent', 0, restoreFiles);
      expect(agentRewind).not.toHaveBeenCalled();
      expect(agentSpawn).not.toHaveBeenCalled();
      const after = sessionsModule.useSessionsStore.getState().conversations.parent;
      expect(after.messages).toEqual(messages);
      expect(after.rewinding).toBeFalsy();
      expect(after.restoringFiles).toBeFalsy();
    }
  );

  it('回退已确认目标使用 ID，后面的未确认消息不使 worker 选错轮次', () => {
    const messages = [
      { role: 'user', entryId: 'execute', content: [] },
      { role: 'user', entryId: 'continue', content: [] },
      { role: 'user', optimistic: true, content: [] },
    ];
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          spawning: false,
          status: 'failed',
          messages,
        },
      },
    }));
    sessionsModule.useSessionsStore.getState().rewind('parent', 1, false);
    expect(agentRewind).toHaveBeenCalledWith('parent', 'continue', false);
    expect(sessionsModule.useSessionsStore.getState().conversations.parent.messages).toEqual([
      messages[0],
    ]);
  });

  it.each(['rejected', 'offline'])(
    '回退投递失败恢复原进度，不留下乐观截断（%s）',
    async (error) => {
      const store = sessionsModule.useSessionsStore;
      store.setState((state) => ({
        conversations: {
          ...state.conversations,
          parent: { ...state.conversations.parent, started: true, spawning: false, status: 'idle' },
        },
      }));
      const messages = store.getState().conversations.parent.messages;
      if (error === 'rejected') agentRewind.mockResolvedValueOnce({ ok: false, error });
      else agentRewind.mockRejectedValueOnce(new Error(error));
      store.getState().rewind('parent', 0, true);
      await vi.waitFor(() => {
        const after = store.getState().conversations.parent;
        expect(after.messages).toEqual(messages);
        expect(after.rewinding).toBeFalsy();
        expect(after.restoringFiles).toBeFalsy();
        expect(after.error).toBe(error);
      });
    }
  );

  it('热会话回退立刻截掉目标 user 及之后，不空等 worker', () => {
    const user = (text: string) => ({
      role: 'user' as const,
      entryId: `entry-${text}`,
      content: [{ type: 'text' as const, text }],
    });
    const assistant = (text: string) => ({
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text }],
    });
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          spawning: false,
          status: 'idle' as const,
          generation: 'g1',
          messages: [user('one'), assistant('a'), user('two'), assistant('b')],
        },
      },
    }));
    const revisionBefore =
      sessionsModule.useSessionsStore.getState().workspaceRevisionByConversation.parent ?? 0;
    sessionsModule.useSessionsStore.getState().rewind('parent', 0, false);
    expect(agentRewind).toHaveBeenCalledWith('parent', 'entry-two', false);
    expect(sessionsModule.useSessionsStore.getState().conversations.parent.messages).toEqual([
      user('one'),
      assistant('a'),
    ]);
    expect(sessionsModule.useSessionsStore.getState().conversations.parent).toMatchObject({
      draftText: 'two',
      rewinding: true,
      restoringFiles: undefined,
    });
    expect(sessionsModule.useSessionsStore.getState().workspaceRevisionByConversation.parent).toBe(
      revisionBefore + 1
    );
  });

  it('回退第一条：时间线空窗，不把空窗当缺正文去拉快照', () => {
    requestSnapshot.mockClear();
    const user = (text: string) => ({
      role: 'user' as const,
      entryId: `entry-${text}`,
      content: [{ type: 'text' as const, text }],
    });
    const assistant = (text: string) => ({
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text }],
    });
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          spawning: false,
          status: 'idle' as const,
          generation: 'g1',
          historyLoadAttempted: undefined,
          messages: [user('first'), assistant('a'), user('second'), assistant('b')],
        },
      },
    }));
    sessionsModule.useSessionsStore.getState().rewind('parent', 1, false);
    const conversation = sessionsModule.useSessionsStore.getState().conversations.parent;
    expect(conversation.messages).toEqual([]);
    expect(conversation.draftText).toBe('first');
    expect(conversation.historyLoadAttempted).toBe(true);
    onAgentEvent?.({
      type: 'messages-truncated',
      identity: { sessionId: 'parent', generation: 'g1' },
      seq: 1,
      length: 0,
    });
    expect(requestSnapshot).not.toHaveBeenCalled();
  });

  it('尾窗内回退第一条：补前缀快照，不把更长的旧会话写回', () => {
    requestSnapshot.mockClear();
    const user = (text: string) => ({
      role: 'user' as const,
      entryId: `entry-${text}`,
      content: [{ type: 'text' as const, text }],
    });
    const assistant = (text: string) => ({
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text }],
    });
    const prefix = [user('kept-a'), assistant('kept-b')];
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          spawning: false,
          status: 'idle' as const,
          generation: 'g1',
          historyBaseIndex: 40,
          messages: [user('first-in-window'), assistant('a'), user('second'), assistant('b')],
        },
      },
    }));
    sessionsModule.useSessionsStore.getState().rewind('parent', 1, false);
    expect(sessionsModule.useSessionsStore.getState().conversations.parent.messages).toEqual([]);
    expect(sessionsModule.useSessionsStore.getState().conversations.parent.historyBaseIndex).toBe(
      40
    );
    onAgentEvent?.({
      type: 'messages-truncated',
      identity: { sessionId: 'parent', generation: 'g1' },
      seq: 1,
      length: 40,
    });
    expect(requestSnapshot).toHaveBeenCalledWith('parent');
    onAgentEvent?.({
      type: 'snapshot',
      partial: true,
      sessions: [
        {
          identity: { sessionId: 'parent', generation: 'g1' },
          status: 'idle',
          messages: prefix,
          commands: [],
        },
      ],
    });
    expect(sessionsModule.useSessionsStore.getState().conversations.parent.messages).toEqual(
      prefix
    );
    onAgentEvent?.({
      type: 'snapshot',
      partial: true,
      sessions: [
        {
          identity: { sessionId: 'parent', generation: 'g1' },
          status: 'idle',
          messages: [...prefix, ...Array.from({ length: 40 }, (_, i) => user(`stale-${i}`))],
          commands: [],
        },
      ],
    });
    expect(sessionsModule.useSessionsStore.getState().conversations.parent.messages).toEqual(
      prefix
    );
  });

  it('尾窗内回退最后一条也要补前缀快照', () => {
    requestSnapshot.mockClear();
    vi.setSystemTime(Date.now() + 3_000);
    const user = (text: string) => ({
      role: 'user' as const,
      entryId: `entry-${text}`,
      content: [{ type: 'text' as const, text }],
    });
    const assistant = (text: string) => ({
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text }],
    });
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          spawning: false,
          status: 'idle' as const,
          generation: 'g1',
          historyBaseIndex: 40,
          messages: [user('first-in-window'), assistant('a'), user('second'), assistant('b')],
        },
      },
    }));
    sessionsModule.useSessionsStore.getState().rewind('parent', 0, false);
    expect(sessionsModule.useSessionsStore.getState().conversations.parent.messages).toEqual([
      user('first-in-window'),
      assistant('a'),
    ]);
    onAgentEvent?.({
      type: 'messages-truncated',
      identity: { sessionId: 'parent', generation: 'g1' },
      seq: 1,
      length: 42,
    });
    expect(requestSnapshot).toHaveBeenCalledWith('parent');
    vi.useRealTimers();
  });

  it('回退中的全量快照不能把刚裁掉的旧会话写回', () => {
    const user = (text: string) => ({
      role: 'user' as const,
      entryId: `entry-${text}`,
      content: [{ type: 'text' as const, text }],
    });
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          spawning: false,
          status: 'idle' as const,
          generation: 'g1',
          messages: [user('one'), user('two')],
        },
      },
    }));
    sessionsModule.useSessionsStore.getState().rewind('parent', 0, false);
    expect(sessionsModule.useSessionsStore.getState().conversations.parent.messages).toEqual([
      user('one'),
    ]);
    onAgentEvent?.({
      type: 'snapshot',
      partial: true,
      sessions: [
        {
          identity: { sessionId: 'parent', generation: 'g1' },
          status: 'idle',
          messages: [user('one'), user('two'), user('stale')],
          commands: [],
        },
      ],
    });
    expect(sessionsModule.useSessionsStore.getState().conversations.parent.messages).toEqual([
      user('one'),
    ]);
  });

  it('对话+文件立刻标 restoringFiles，草稿不等 worker', () => {
    const user = (text: string) => ({
      role: 'user' as const,
      entryId: `entry-${text}`,
      content: [{ type: 'text' as const, text }],
    });
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          spawning: false,
          status: 'idle' as const,
          generation: 'g1',
          messages: [user('keep'), user('back')],
        },
      },
    }));
    sessionsModule.useSessionsStore.getState().rewind('parent', 0, true);
    expect(sessionsModule.useSessionsStore.getState().conversations.parent).toMatchObject({
      draftText: 'back',
      rewinding: true,
      restoringFiles: true,
    });
  });

  it('rewind-done 清 rewinding；filesRestored 清 restoringFiles；不覆盖已改草稿', () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          spawning: false,
          status: 'idle' as const,
          generation: 'g1',
          messages: [
            { role: 'user', entryId: 'entry-keep', content: [{ type: 'text', text: 'keep' }] },
            { role: 'user', entryId: 'entry-back', content: [{ type: 'text', text: 'back' }] },
          ],
        },
      },
    }));
    sessionsModule.useSessionsStore.getState().rewind('parent', 0, true);
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: { ...state.conversations.parent, draftText: 'edited' },
      },
    }));
    onAgentEvent?.({
      type: 'rewind-done',
      identity: { sessionId: 'parent', generation: 'g1' },
      seq: 1,
      editorText: 'back',
    });
    expect(sessionsModule.useSessionsStore.getState().conversations.parent).toMatchObject({
      draftText: 'edited',
      rewinding: undefined,
      restoringFiles: true,
    });
    const revisionAfterRewind =
      sessionsModule.useSessionsStore.getState().workspaceRevisionByConversation.parent ?? 0;
    onAgentEvent?.({
      type: 'rewind-done',
      identity: { sessionId: 'parent', generation: 'g1' },
      seq: 2,
      filesRestored: true,
    });
    expect(sessionsModule.useSessionsStore.getState().conversations.parent).toMatchObject({
      draftText: 'edited',
      restoringFiles: undefined,
    });
    expect(sessionsModule.useSessionsStore.getState().workspaceRevisionByConversation.parent).toBe(
      revisionAfterRewind + 1
    );
  });

  it('status:running 时不调用 window.electronAPI.agent.rewind', () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          spawning: false,
          status: 'running' as const,
          generation: 'g1',
        },
      },
    }));
    sessionsModule.useSessionsStore.getState().rewind('parent', 0, false);
    expect(agentRewind).not.toHaveBeenCalled();
  });

  it('started 但仍 spawning（尚未 parent-ready）时不下发 rewind', () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          spawning: true,
          status: 'idle' as const,
          generation: 'g1',
        },
      },
    }));
    sessionsModule.useSessionsStore.getState().rewind('parent', 0, false);
    expect(agentRewind).not.toHaveBeenCalled();
  });

  it('热路径 spawning 时等待；空 snapshot 不发，含该会话 snapshot 后只发一次', async () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          spawning: true,
          status: 'idle' as const,
          sessionFile: '/tmp/cold.jsonl',
          generation: 'g-ready',
        },
      },
    }));
    sessionsModule.useSessionsStore.getState().rewind('parent', 0, false);
    sessionsModule.useSessionsStore.getState().rewind('parent', 0, false);
    expect(agentRewind).not.toHaveBeenCalled();
    onAgentEvent?.({ type: 'snapshot', partial: true, sessions: [] });
    await Promise.resolve();
    expect(agentRewind).not.toHaveBeenCalled();
    emitRewindSnapshot();
    await vi.waitFor(() => expect(agentRewind).toHaveBeenCalledTimes(1));
    expect(agentRewind).toHaveBeenCalledWith('parent', 'entry-two', false);
  });

  it.each([false, true])(
    '等待恢复时绑定原 entryId，目标消失不替换成同位置消息（removed=%s）',
    async (removed) => {
      const store = sessionsModule.useSessionsStore;
      store.setState((state) => ({
        conversations: {
          ...state.conversations,
          parent: {
            ...state.conversations.parent,
            started: true,
            spawning: true,
            status: 'idle',
            sessionFile: '/tmp/cold.jsonl',
          },
        },
      }));
      store.getState().rewind('parent', 0, true);
      const messages = [
        ...rewindMessages().filter((message) => !removed || message.entryId !== 'entry-two'),
        { role: 'user', entryId: 'new', content: [] },
      ];
      store.setState((state) => ({
        conversations: {
          ...state.conversations,
          parent: {
            ...state.conversations.parent,
            messages,
            historyBaseIndex: 40,
            spawning: false,
          },
        },
      }));
      await Promise.resolve();
      await Promise.resolve();
      if (removed) {
        expect(agentRewind).not.toHaveBeenCalled();
        expect(store.getState().conversations.parent.messages).toEqual(messages);
      } else {
        expect(agentRewind).toHaveBeenCalledWith('parent', 'entry-two', true);
        expect(store.getState().conversations.parent.messages).toEqual([messages[0]]);
      }
    }
  );

  it('同一 tick 状态变 ready 后再 rewind 仍走 inFlight 不双发', async () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: true,
          spawning: true,
          status: 'idle' as const,
          sessionFile: '/tmp/cold.jsonl',
        },
      },
    }));
    sessionsModule.useSessionsStore.getState().rewind('parent', 0, false);
    expect(agentRewind).not.toHaveBeenCalled();
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: { ...state.conversations.parent, spawning: false },
      },
    }));
    sessionsModule.useSessionsStore.getState().rewind('parent', 0, false);
    expect(agentRewind).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(agentRewind).toHaveBeenCalledTimes(1));
  });

  it.each(['workspaceMigrating', 'worktreeMissing'] as const)(
    'ready 到实际下发之间出现 %s 时取消回退',
    async (flag) => {
      const store = sessionsModule.useSessionsStore;
      store.setState((state) => ({
        conversations: {
          ...state.conversations,
          parent: {
            ...state.conversations.parent,
            started: true,
            spawning: true,
            status: 'idle' as const,
            sessionFile: '/tmp/cold.jsonl',
          },
        },
      }));
      store.getState().rewind('parent', 0, true);
      store.setState((state) => ({
        conversations: {
          ...state.conversations,
          parent: { ...state.conversations.parent, spawning: false },
        },
      }));
      store.setState((state) => ({
        conversations: {
          ...state.conversations,
          parent: { ...state.conversations.parent, [flag]: true },
        },
      }));
      await Promise.resolve();
      expect(agentRewind).not.toHaveBeenCalled();
    }
  );

  it('冷加载历史主会话 spawn ack 不下发，含该会话 snapshot 后才 rewind', async () => {
    enableRewindResumeModel();
    let finishSpawn: ((value: { ok: true }) => void) | undefined;
    agentSpawn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSpawn = resolve;
        })
    );
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: false,
          spawning: false,
          status: 'idle' as const,
          sessionFile: '/tmp/cold.jsonl',
          lastProviderId: 'p1',
          lastModelId: 'm1',
        },
        other: { ...state.conversations.parent, id: 'other', started: true },
      },
      activeId: 'other',
    }));
    sessionsModule.useSessionsStore.getState().rewind('parent', 1, false);
    await vi.waitFor(() => expect(agentSpawn).toHaveBeenCalled());
    expect(agentRewind).not.toHaveBeenCalled();
    finishSpawn?.({ ok: true });
    await vi.waitFor(() =>
      expect(sessionsModule.useSessionsStore.getState().conversations.parent.started).toBe(true)
    );
    expect(agentRewind).not.toHaveBeenCalled();
    emitRewindSnapshot();
    await vi.waitFor(() => expect(agentRewind).toHaveBeenCalledWith('parent', 'entry-one', false));
    expect(agentSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'parent', resumeFile: '/tmp/cold.jsonl' })
    );
    expect(agentRewind).not.toHaveBeenCalledWith('other', expect.anything(), expect.anything());
  });

  it('冷会话 resume 失败不下发 rewind', async () => {
    enableRewindResumeModel();
    agentSpawn.mockResolvedValueOnce({ ok: false });
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: false,
          spawning: false,
          status: 'idle' as const,
          sessionFile: '/tmp/cold.jsonl',
          lastProviderId: 'p1',
          lastModelId: 'm1',
        },
      },
    }));
    sessionsModule.useSessionsStore.getState().rewind('parent', 0, false);
    await vi.waitFor(() => expect(agentSpawn).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(sessionsModule.useSessionsStore.getState().conversations.parent.status).toBe('failed')
    );
    expect(agentRewind).not.toHaveBeenCalled();
  });

  it('resume 期间目标 jsonl 被换掉或变 running 后不下发 rewind', async () => {
    enableRewindResumeModel();
    let finishSpawn: ((value: { ok: true }) => void) | undefined;
    agentSpawn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSpawn = resolve;
        })
    );
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: false,
          spawning: false,
          status: 'idle' as const,
          sessionFile: '/tmp/cold.jsonl',
          lastProviderId: 'p1',
          lastModelId: 'm1',
        },
      },
    }));
    sessionsModule.useSessionsStore.getState().rewind('parent', 0, false);
    await vi.waitFor(() => expect(agentSpawn).toHaveBeenCalled());
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          sessionFile: '/tmp/other.jsonl',
          status: 'running' as const,
        },
      },
    }));
    finishSpawn?.({ ok: true });
    await vi.waitFor(() =>
      expect(sessionsModule.useSessionsStore.getState().conversations.parent.started).toBe(true)
    );
    expect(agentRewind).not.toHaveBeenCalled();
  });

  it('未恢复的 coworker / historyOnly 不唤醒也不 rewind', () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        child: {
          ...state.conversations.parent,
          id: 'child',
          parentId: 'parent',
          started: false,
          spawning: false,
          status: 'idle' as const,
          sessionFile: '/tmp/child.jsonl',
          historyOnly: true,
        },
        coworker: {
          ...state.conversations.parent,
          id: 'coworker',
          parentId: 'parent',
          started: false,
          spawning: false,
          status: 'idle' as const,
          sessionFile: '/tmp/coworker.jsonl',
        },
      },
    }));
    sessionsModule.useSessionsStore.getState().rewind('child', 0, false);
    sessionsModule.useSessionsStore.getState().rewind('coworker', 0, false);
    expect(agentSpawn).not.toHaveBeenCalled();
    expect(agentRewind).not.toHaveBeenCalled();
  });

  it('冷加载主会话分支：先 resume，含该会话 snapshot 后才 fork', async () => {
    enableRewindResumeModel();
    agentFork.mockClear();
    let finishSpawn: ((value: { ok: true }) => void) | undefined;
    agentSpawn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSpawn = resolve;
        })
    );
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: false,
          spawning: false,
          status: 'idle' as const,
          sessionFile: '/tmp/cold.jsonl',
          lastProviderId: 'p1',
          lastModelId: 'm1',
        },
      },
    }));
    nextConversationId = 'forked';
    const forked = sessionsModule.useSessionsStore.getState().forkFromMessage('parent', 1);
    await vi.waitFor(() =>
      expect(agentSpawn).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'parent', resumeFile: '/tmp/cold.jsonl' })
      )
    );
    finishSpawn?.({ ok: true });
    await vi.waitFor(() =>
      expect(sessionsModule.useSessionsStore.getState().conversations.parent.started).toBe(true)
    );
    expect(agentFork).not.toHaveBeenCalled();
    emitRewindSnapshot();
    await expect(forked).resolves.toBe('forked');
    expect(agentFork).toHaveBeenCalledWith('parent', 'forked', { userIndexFromEnd: 1 });
  });

  it('冷会话 resume 失败不 fork、不建分支会话', async () => {
    enableRewindResumeModel();
    agentFork.mockClear();
    agentSpawn.mockResolvedValueOnce({ ok: false });
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        parent: {
          ...state.conversations.parent,
          started: false,
          spawning: false,
          status: 'idle' as const,
          sessionFile: '/tmp/cold.jsonl',
          lastProviderId: 'p1',
          lastModelId: 'm1',
        },
      },
    }));
    nextConversationId = 'forked';
    await expect(
      sessionsModule.useSessionsStore.getState().forkFromMessage('parent', 0)
    ).resolves.toBe(null);
    expect(agentFork).not.toHaveBeenCalled();
    expect(sessionsModule.useSessionsStore.getState().conversations.forked).toBeUndefined();
  });
});
