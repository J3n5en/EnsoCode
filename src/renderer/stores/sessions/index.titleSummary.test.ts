import type { SourceAuthorityProjection } from '@shared/types/agent';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bindSessionProjection,
  installSessionGlobals,
  loadSessionModules,
  onAgentEvent,
  resetSessionHarness,
  sessionsModule,
  settingsModule,
  summarizeTitle,
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

describe('typed Agent child projection', () => {
  beforeAll(async () => {
    await loadSessionModules();
  });

  beforeEach(async () => {
    await resetSessionHarness();
  });

  describe('回合结束滚动刷新标题', () => {
    const digest = {
      firstUserText: '会话首条请求',
      userText: '本轮用户请求',
      assistantText: '本轮 assistant 结论',
    };

    /** 构造一个已 started、带标题与模型记忆的 root 会话，返回其 id */
    function seedStartedRoot(id: string, overrides: Record<string, unknown> = {}) {
      sessionsModule.useSessionsStore.setState((state) => ({
        conversations: {
          ...state.conversations,
          [id]: {
            ...state.conversations.parent,
            id,
            title: '初始标题',
            started: true,
            spawning: false,
            status: 'running' as const,
            generation: 'g1',
            lastProviderId: 'provider-1',
            lastModelId: 'model-1',
            messages: [],
            ...overrides,
          },
        },
        order: [...state.order.filter((x) => x !== id), id],
      }));
    }

    function turnCompleted(id: string, d: typeof digest = digest) {
      onAgentEvent?.({
        type: 'turn-completed',
        identity: { sessionId: id, generation: 'g1' },
        seq: 2,
        turnId: 'turn-1',
        digest: d,
      });
    }

    // pendingTitleBaselines 是 store 闭包里的 Map，外层 beforeEach 的 setState 清不掉它。
    // 上一条用例若触发了滚动总结却没回流 title-generated，在飞基准会泄漏到下一条用例，
    // 让下一条的 turn-completed 被在飞去重误杀。这里对可能用到的会话 id 各回一个
    // title-generated：handler 会无条件 delete 该 id 的基准，从而隔离各用例。
    beforeEach(() => {
      for (const id of ['parent', 'cold', 'child-1']) {
        onAgentEvent?.({ type: 'title-generated', conversationId: id, title: '__reset__' });
      }
    });

    it('已 started 的 root 会话收到 turn-completed{digest} → summarizeTitle 以 rolling 输入调用', async () => {
      settingsModule.useSettingsStore.setState({ titleSummaryEnabled: true });
      summarizeTitle.mockClear();
      seedStartedRoot('parent');

      turnCompleted('parent');

      expect(summarizeTitle).toHaveBeenCalledWith(
        'parent',
        {
          kind: 'rolling',
          currentTitle: '初始标题',
          firstUserText: '会话首条请求',
          userText: '本轮用户请求',
          assistantText: '本轮 assistant 结论',
        },
        { providerId: 'provider-1', modelId: 'model-1' }
      );
    });

    it('本轮 user 是推进类短句（“开始实施”）→ 不发滚动总结，但 lastTurnDigest 照常写入', async () => {
      settingsModule.useSettingsStore.setState({ titleSummaryEnabled: true });
      summarizeTitle.mockClear();
      seedStartedRoot('parent');

      const continuation = { ...digest, userText: '开始实施' };
      turnCompleted('parent', continuation);

      expect(summarizeTitle).not.toHaveBeenCalled();
      const conversation = sessionsModule.useSessionsStore.getState().conversations.parent;
      expect(conversation.lastTurnDigest).toEqual(continuation);
      expect(conversation.titleSummaryPending).toBeUndefined();
      expect(conversation.title).toBe('初始标题');
    });

    it('推进类短句带实词（“继续排查节点转圈”）→ 照常发滚动总结', async () => {
      settingsModule.useSettingsStore.setState({ titleSummaryEnabled: true });
      summarizeTitle.mockClear();
      seedStartedRoot('parent');

      turnCompleted('parent', { ...digest, userText: '继续排查节点转圈' });

      expect(summarizeTitle).toHaveBeenCalledTimes(1);
    });

    it('在飞未回流时第二个 turn-completed 不再调用；收到 title-generated 后再触发', async () => {
      settingsModule.useSettingsStore.setState({ titleSummaryEnabled: true });
      summarizeTitle.mockClear();
      seedStartedRoot('parent');

      turnCompleted('parent');
      expect(summarizeTitle).toHaveBeenCalledTimes(1);

      // 第二次 turn-completed：上一轮总结在飞，应跳过
      turnCompleted('parent');
      expect(summarizeTitle).toHaveBeenCalledTimes(1);

      // title-generated 回流，清掉在飞基准
      onAgentEvent?.({
        type: 'title-generated',
        conversationId: 'parent',
        title: '新标题',
      });
      expect(sessionsModule.useSessionsStore.getState().conversations.parent.title).toBe('新标题');

      // 再来一次 turn-completed 应再次触发
      summarizeTitle.mockClear();
      // 更新 currentTitle 基准为新标题
      sessionsModule.useSessionsStore.setState((state) => ({
        conversations: {
          ...state.conversations,
          parent: { ...state.conversations.parent, title: '新标题' },
        },
      }));
      turnCompleted('parent');
      expect(summarizeTitle).toHaveBeenCalledTimes(1);
      expect(summarizeTitle).toHaveBeenCalledWith(
        'parent',
        expect.objectContaining({ kind: 'rolling', currentTitle: '新标题' }),
        { providerId: 'provider-1', modelId: 'model-1' }
      );
    });

    it('turn-failed 不触发滚动总结', async () => {
      settingsModule.useSettingsStore.setState({ titleSummaryEnabled: true });
      summarizeTitle.mockClear();
      seedStartedRoot('parent');

      onAgentEvent?.({
        type: 'turn-failed',
        identity: { sessionId: 'parent', generation: 'g1' },
        seq: 2,
        turnId: 'turn-1',
        error: 'boom',
      });
      expect(summarizeTitle).not.toHaveBeenCalled();
    });

    it('先设置 abortRequested=true 再 turn-completed 不触发', async () => {
      settingsModule.useSettingsStore.setState({ titleSummaryEnabled: true });
      summarizeTitle.mockClear();
      seedStartedRoot('parent', { abortRequested: true });

      turnCompleted('parent');
      expect(summarizeTitle).not.toHaveBeenCalled();
    });

    it('titleSummaryEnabled=false 不触发', async () => {
      settingsModule.useSettingsStore.setState({ titleSummaryEnabled: false });
      summarizeTitle.mockClear();
      seedStartedRoot('parent');

      turnCompleted('parent');
      expect(summarizeTitle).not.toHaveBeenCalled();
    });

    it('turn-completed 无 digest 不触发', async () => {
      settingsModule.useSettingsStore.setState({ titleSummaryEnabled: true });
      summarizeTitle.mockClear();
      seedStartedRoot('parent');

      onAgentEvent?.({
        type: 'turn-completed',
        identity: { sessionId: 'parent', generation: 'g1' },
        seq: 2,
        turnId: 'turn-1',
      });
      expect(summarizeTitle).not.toHaveBeenCalled();
    });

    it('有 parentId 的 child 会话不触发', async () => {
      settingsModule.useSettingsStore.setState({ titleSummaryEnabled: true });
      summarizeTitle.mockClear();
      seedStartedRoot('child-1', { parentId: 'parent' });

      turnCompleted('child-1');
      expect(summarizeTitle).not.toHaveBeenCalled();
    });

    it('冷会话（activeId 是别的会话、messages 为空）turn-completed{digest} 同样触发', async () => {
      settingsModule.useSettingsStore.setState({ titleSummaryEnabled: true });
      summarizeTitle.mockClear();
      seedStartedRoot('cold', { messages: [] });
      // 让冷会话不是当前查看的会话
      sessionsModule.useSessionsStore.setState({ activeId: 'parent' });

      turnCompleted('cold');
      expect(summarizeTitle).toHaveBeenCalledWith(
        'cold',
        expect.objectContaining({ kind: 'rolling', currentTitle: '初始标题' }),
        { providerId: 'provider-1', modelId: 'model-1' }
      );
    });

    it('renameConversation 后 conversation.titleLocked === true', async () => {
      seedStartedRoot('parent');
      sessionsModule.useSessionsStore.getState().renameConversation('parent', '手动改名');
      expect(sessionsModule.useSessionsStore.getState().conversations.parent.titleLocked).toBe(
        true
      );
      expect(sessionsModule.useSessionsStore.getState().conversations.parent.title).toBe(
        '手动改名'
      );
    });

    it('titleLocked 随 partialize 持久化', async () => {
      seedStartedRoot('parent');
      sessionsModule.useSessionsStore.getState().renameConversation('parent', '手动改名');
      const partialize = sessionsModule.useSessionsStore.persist.getOptions().partialize;
      const persisted = partialize?.(sessionsModule.useSessionsStore.getState()) as {
        conversations: Record<string, { title: string; titleLocked?: boolean }>;
      };
      expect(persisted.conversations.parent).toMatchObject({
        title: '手动改名',
        titleLocked: true,
      });
    });

    it('锁定后首条即时总结（spawn 路径）也不触发', async () => {
      settingsModule.useSettingsStore.setState({ titleSummaryEnabled: true });
      summarizeTitle.mockClear();
      const id = await sessionsModule.useSessionsStore.getState().newConversation('project');
      // 用户在发首条消息前就手动命名了这个会话
      sessionsModule.useSessionsStore.getState().renameConversation(id!, '预先命名');
      await sessionsModule.useSessionsStore
        .getState()
        .send('首条消息', { providerId: 'provider-1', modelId: 'model-1', cwd: '/project' });
      expect(summarizeTitle).not.toHaveBeenCalled();
      expect(sessionsModule.useSessionsStore.getState().conversations[id!].title).toBe('预先命名');
    });

    it('锁定后 turn-completed{digest} 不触发', async () => {
      settingsModule.useSettingsStore.setState({ titleSummaryEnabled: true });
      summarizeTitle.mockClear();
      seedStartedRoot('parent');
      sessionsModule.useSessionsStore.getState().renameConversation('parent', '手动改名');

      turnCompleted('parent');
      expect(summarizeTitle).not.toHaveBeenCalled();
    });

    it('锁定后 title-generated 迟到不覆盖标题', async () => {
      settingsModule.useSettingsStore.setState({ titleSummaryEnabled: true });
      seedStartedRoot('parent');
      // 先制造一个在飞基准（模拟锁定前刚发起的总结）
      summarizeTitle.mockClear();
      turnCompleted('parent');
      expect(summarizeTitle).toHaveBeenCalledTimes(1);

      // 用户手动改名（锁定）
      sessionsModule.useSessionsStore.getState().renameConversation('parent', '手动改名');
      expect(sessionsModule.useSessionsStore.getState().conversations.parent.title).toBe(
        '手动改名'
      );

      // 迟到的 title-generated 不应覆盖手动改的标题
      onAgentEvent?.({
        type: 'title-generated',
        conversationId: 'parent',
        title: 'AI 想改的标题',
      });
      expect(sessionsModule.useSessionsStore.getState().conversations.parent.title).toBe(
        '手动改名'
      );
    });

    it('title-generated 的 title 与当前相同 → 标题不变，但在飞态清除', async () => {
      settingsModule.useSettingsStore.setState({ titleSummaryEnabled: true });
      seedStartedRoot('parent');
      // 制造在飞基准
      turnCompleted('parent');
      expect(
        sessionsModule.useSessionsStore.getState().conversations.parent.titleSummaryPending
      ).toBe(true);

      onAgentEvent?.({
        type: 'title-generated',
        conversationId: 'parent',
        title: '初始标题',
      });
      const after = sessionsModule.useSessionsStore.getState().conversations.parent;
      // 模型选择不改 → 标题保持；但“标题已准确”也是成功，转圈必须消失
      expect(after.title).toBe('初始标题');
      expect(after.titleSummaryPending).toBeUndefined();
    });
  });

  describe('标题总结在飞态、失败态与手动重试', () => {
    const digest = {
      firstUserText: '会话首条请求',
      userText: '本轮用户请求',
      assistantText: '本轮 assistant 结论',
    };
    const conv = () => sessionsModule.useSessionsStore.getState().conversations.parent;

    function seed(overrides: Record<string, unknown> = {}) {
      sessionsModule.useSessionsStore.setState((state) => ({
        conversations: {
          ...state.conversations,
          parent: {
            ...state.conversations.parent,
            title: '初始标题',
            started: true,
            spawning: false,
            status: 'idle' as const,
            generation: 'g1',
            lastProviderId: 'provider-1',
            lastModelId: 'model-1',
            messages: [],
            titleLocked: undefined,
            titleSummaryError: undefined,
            titleSummaryPending: undefined,
            lastTurnDigest: undefined,
            ...overrides,
          },
        },
      }));
    }

    function turnCompleted(seq = 2) {
      onAgentEvent?.({
        type: 'turn-completed',
        identity: { sessionId: 'parent', generation: 'g1' },
        seq,
        turnId: `turn-${seq}`,
        digest,
      });
    }

    beforeEach(() => {
      settingsModule.useSettingsStore.setState({ titleSummaryEnabled: true });
      summarizeTitle.mockClear();
      summarizeTitle.mockResolvedValue({ ok: true });
      // 清掉上一用例可能泄漏的在飞基准
      onAgentEvent?.({ type: 'title-generated', conversationId: 'parent', title: '__reset__' });
      seed();
    });

    it('发起总结后 titleSummaryPending=true；title-generated 到达后清除', async () => {
      turnCompleted();
      expect(conv().titleSummaryPending).toBe(true);
      onAgentEvent?.({ type: 'title-generated', conversationId: 'parent', title: '新标题' });
      expect(conv().titleSummaryPending).toBeUndefined();
      expect(conv().title).toBe('新标题');
    });

    it('title-failed 在飞 → 写 titleSummaryError、清 pending；标题不变', async () => {
      turnCompleted();
      onAgentEvent?.({
        type: 'title-failed',
        conversationId: 'parent',
        error: 'cursor/composer-2.5-fast: timed out after 60s',
      });
      expect(conv().titleSummaryError).toBe('cursor/composer-2.5-fast: timed out after 60s');
      expect(conv().titleSummaryPending).toBeUndefined();
      expect(conv().title).toBe('初始标题');
    });

    it('title-failed 不在飞（迟到） → state 引用不变', async () => {
      const before = sessionsModule.useSessionsStore.getState();
      onAgentEvent?.({ type: 'title-failed', conversationId: 'parent', error: 'late' });
      expect(sessionsModule.useSessionsStore.getState()).toBe(before);
    });

    it('title-failed 对 titleLocked 会话不写错误', async () => {
      turnCompleted();
      sessionsModule.useSessionsStore.getState().renameConversation('parent', '手动改名');
      // 改名已清在飞；即使再来一个在飞态（模拟竞态）也不该写错误
      onAgentEvent?.({ type: 'title-failed', conversationId: 'parent', error: 'x' });
      expect(conv().titleSummaryError).toBeUndefined();
      expect(conv().title).toBe('手动改名');
    });

    it('title-generated 成功清除之前的 titleSummaryError', async () => {
      seed({ titleSummaryError: '旧错误' });
      turnCompleted();
      // 发起时就已清错误
      expect(conv().titleSummaryError).toBeUndefined();
      seed({ titleSummaryError: '又出错', titleSummaryPending: true });
      onAgentEvent?.({ type: 'title-generated', conversationId: 'parent', title: '初始标题' });
      expect(conv().titleSummaryError).toBeUndefined();
    });

    it('renameConversation 清 titleSummaryError 与 titleSummaryPending', async () => {
      turnCompleted();
      seed({ titleSummaryError: '错', titleSummaryPending: true });
      sessionsModule.useSessionsStore.getState().renameConversation('parent', '手动');
      expect(conv().titleSummaryError).toBeUndefined();
      expect(conv().titleSummaryPending).toBeUndefined();
    });

    it('turn-completed 带 digest → lastTurnDigest 写入', async () => {
      turnCompleted();
      expect(conv().lastTurnDigest).toEqual(digest);
    });

    it('summarizeTitle IPC 同步拒绝 → 与 title-failed 同效', async () => {
      summarizeTitle.mockResolvedValueOnce({ ok: false, error: 'no usable title model' });
      turnCompleted();
      await Promise.resolve();
      await Promise.resolve();
      expect(conv().titleSummaryError).toBe('no usable title model');
      expect(conv().titleSummaryPending).toBeUndefined();
    });

    it('retryTitleSummary：有 lastTurnDigest → rolling，清 error，pending=true', async () => {
      seed({ lastTurnDigest: digest, titleSummaryError: '错' });
      sessionsModule.useSessionsStore.getState().retryTitleSummary('parent');
      expect(summarizeTitle).toHaveBeenCalledWith(
        'parent',
        { kind: 'rolling', currentTitle: '初始标题', ...digest },
        { providerId: 'provider-1', modelId: 'model-1' }
      );
      expect(conv().titleSummaryError).toBeUndefined();
      expect(conv().titleSummaryPending).toBe(true);
    });

    it('retryTitleSummary：无 digest 有正文 → initial(首条用户文本)', async () => {
      seed({
        messages: [
          { role: 'user', content: [{ type: 'text', text: '首条用户消息原文\n第二行' }] },
          { role: 'assistant', content: [{ type: 'text', text: '回复' }] },
        ],
      });
      sessionsModule.useSessionsStore.getState().retryTitleSummary('parent');
      expect(summarizeTitle).toHaveBeenCalledWith(
        'parent',
        { kind: 'initial', text: '首条用户消息原文\n第二行' },
        { providerId: 'provider-1', modelId: 'model-1' }
      );
    });

    it('retryTitleSummary：无 digest 无正文 → initial(当前标题)', async () => {
      sessionsModule.useSessionsStore.getState().retryTitleSummary('parent');
      expect(summarizeTitle).toHaveBeenCalledWith(
        'parent',
        { kind: 'initial', text: '初始标题' },
        { providerId: 'provider-1', modelId: 'model-1' }
      );
    });

    it('retryTitleSummary：titleLocked / 开关关 / 在飞 → 不调用', async () => {
      seed({ lastTurnDigest: digest, titleLocked: true });
      sessionsModule.useSessionsStore.getState().retryTitleSummary('parent');
      expect(summarizeTitle).not.toHaveBeenCalled();

      seed({ lastTurnDigest: digest });
      settingsModule.useSettingsStore.setState({ titleSummaryEnabled: false });
      sessionsModule.useSessionsStore.getState().retryTitleSummary('parent');
      expect(summarizeTitle).not.toHaveBeenCalled();

      settingsModule.useSettingsStore.setState({ titleSummaryEnabled: true });
      turnCompleted(); // 制造在飞
      summarizeTitle.mockClear();
      sessionsModule.useSessionsStore.getState().retryTitleSummary('parent');
      expect(summarizeTitle).not.toHaveBeenCalled();
    });

    it('开关切 false → 全部 titleSummaryError / titleSummaryPending 清空', async () => {
      turnCompleted();
      seed({ titleSummaryError: '错', titleSummaryPending: true });
      settingsModule.useSettingsStore.getState().setTitleSummaryEnabled(false);
      expect(conv().titleSummaryError).toBeUndefined();
      expect(conv().titleSummaryPending).toBeUndefined();
      // 在飞基准也已清：迟到的 title-generated 不再写回
      onAgentEvent?.({ type: 'title-generated', conversationId: 'parent', title: '迟到' });
      expect(conv().title).toBe('初始标题');
    });

    it('partialize 不含 titleSummaryError / titleSummaryPending / lastTurnDigest', async () => {
      seed({ titleSummaryError: '错', titleSummaryPending: true, lastTurnDigest: digest });
      const partialize = sessionsModule.useSessionsStore.persist.getOptions().partialize;
      const persisted = partialize?.(sessionsModule.useSessionsStore.getState()) as {
        conversations: Record<string, Record<string, unknown>>;
      };
      // partialize 用 `key: undefined` 剔除（与周围字段同款），JSON 落盘时不写该键
      expect(persisted.conversations.parent.titleSummaryError).toBeUndefined();
      expect(persisted.conversations.parent.titleSummaryPending).toBeUndefined();
      expect(persisted.conversations.parent.lastTurnDigest).toBeUndefined();
      expect(JSON.stringify(persisted.conversations.parent)).not.toMatch(
        /titleSummaryError|titleSummaryPending|lastTurnDigest/
      );
    });
  });
});
