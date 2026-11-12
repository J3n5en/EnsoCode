import type { SourceAuthorityProjection } from '@shared/types/agent';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentPrompt,
  agentSetApprovalMode,
  agentSetPlanMode,
  agentSpawn,
  bindSessionProjection,
  btwDispose,
  btwSpawn,
  installSessionGlobals,
  loadSessionModules,
  onAgentEvent,
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

describe('btw session send', () => {
  beforeAll(async () => {
    await loadSessionModules();
  });

  beforeEach(async () => {
    agentPrompt.mockClear();
    agentSpawn.mockClear();
    btwSpawn.mockReset().mockResolvedValue({ ok: true });
    btwDispose.mockReset().mockResolvedValue({ ok: true });
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
  });

  it('send(conversationId) 旁路会话走 btw.spawn 且不切走主会话', async () => {
    const parentId = sessionsModule.useSessionsStore.getState().activeId!;
    settingsModule.useSettingsStore.setState({ loadLocalSkills: false });
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        [parentId]: {
          ...state.conversations[parentId],
          presetId: 'coding',
          approvalMode: 'supervised',
        },
      },
    }));
    sessionsModule.useSessionsStore.getState().ensureBtwConversation({
      id: 'btw-1',
      projectId: 'project',
      btwParentId: parentId,
      rolePrompt: 'You are aside',
    });
    await sessionsModule.useSessionsStore
      .getState()
      .send(
        'hello aside',
        { providerId: 'provider-1', modelId: 'model-1', cwd: '/workspace' },
        undefined,
        'btw-1'
      );
    expect(btwSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'btw-1',
        parentConversationId: parentId,
        rolePrompt: 'You are aside',
        presetId: 'coding',
        approvalMode: 'supervised',
        loadLocalSkills: false,
      })
    );
    expect(agentSpawn).not.toHaveBeenCalled();
    expect(agentPrompt).toHaveBeenCalled();
    expect(sessionsModule.useSessionsStore.getState().activeId).toBe(parentId);
    expect(sessionsModule.useSessionsStore.getState().order).not.toContain('btw-1');
  });

  it('主会话前台时旁路仍应用 message-upsert，不因冷缓存丢正文', async () => {
    const parentId = sessionsModule.useSessionsStore.getState().activeId!;
    sessionsModule.useSessionsStore.getState().ensureBtwConversation({
      id: 'btw-1',
      projectId: 'project',
      btwParentId: parentId,
      rolePrompt: 'You are aside',
    });
    onAgentEvent?.({
      type: 'message-upsert',
      identity: { sessionId: 'btw-1', generation: 'g1' },
      seq: 1,
      index: 0,
      message: { role: 'assistant', content: [{ type: 'text', text: '旁路答完了' }] },
    });
    const messages = sessionsModule.useSessionsStore.getState().conversations['btw-1']?.messages;
    expect(messages?.some((message) => message.role === 'assistant')).toBe(true);
    expect(JSON.stringify(messages)).toContain('旁路答完了');
  });

  it('旁路首条 role 前缀 user upsert 消费乐观回显并上屏助手', async () => {
    const parentId = sessionsModule.useSessionsStore.getState().activeId!;
    sessionsModule.useSessionsStore.getState().ensureBtwConversation({
      id: 'btw-1',
      projectId: 'project',
      btwParentId: parentId,
      rolePrompt: 'You are aside',
    });
    await sessionsModule.useSessionsStore
      .getState()
      .send(
        '刚刚聊到什么工具',
        { providerId: 'provider-1', modelId: 'model-1', cwd: '/workspace' },
        undefined,
        'btw-1'
      );
    expect(
      sessionsModule.useSessionsStore
        .getState()
        .conversations['btw-1']?.messages.some((message) => message.optimistic)
    ).toBe(true);
    onAgentEvent?.({
      type: 'message-upsert',
      identity: { sessionId: 'btw-1', generation: 'g1' },
      seq: 1,
      index: 0,
      message: {
        role: 'user',
        content: [{ type: 'text', text: '<role>\nYou are aside\n</role>\n\n刚刚聊到什么工具' }],
      },
    });
    onAgentEvent?.({
      type: 'message-upsert',
      identity: { sessionId: 'btw-1', generation: 'g1' },
      seq: 2,
      index: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '用的是 bash' }] },
    });
    const messages = sessionsModule.useSessionsStore.getState().conversations['btw-1']?.messages;
    expect(messages?.some((message) => message.optimistic)).toBe(false);
    expect(messages?.some((message) => message.role === 'assistant')).toBe(true);
    expect(JSON.stringify(messages)).toContain('用的是 bash');
  });
});

describe('Plan 模式', () => {
  beforeAll(async () => {
    await loadSessionModules();
  });

  beforeEach(async () => {
    nextConversationId = 'plan-parent';
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
    agentSpawn.mockClear();
    agentPrompt.mockClear();
    agentSetPlanMode.mockClear();
  });

  const conv = () => sessionsModule.useSessionsStore.getState().conversations['plan-parent'];
  const target = { providerId: 'provider-1', modelId: 'model-1', cwd: '/workspace' };

  it('未启动时 /plan 正文：开启 Plan 随 spawn 下发，正文照常发送', async () => {
    await sessionsModule.useSessionsStore.getState().send('/plan 帮我重构登录', target);
    expect(conv()?.planState?.active).toBe(true);
    expect(agentSetPlanMode).not.toHaveBeenCalled();
    expect(agentSpawn).toHaveBeenCalledWith(expect.objectContaining({ planMode: true }));
    expect(agentPrompt).toHaveBeenCalledWith(
      'plan-parent',
      '帮我重构登录',
      undefined,
      expect.anything()
    );
  });

  it('已启动时 /plan off 即时下发且不发消息；下发失败回滚', async () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        'plan-parent': {
          ...state.conversations['plan-parent'],
          started: true,
          planState: { active: true, resolutions: {} },
        },
      },
    }));
    await sessionsModule.useSessionsStore.getState().send('/plan off', target);
    expect(agentSetPlanMode).toHaveBeenCalledWith('plan-parent', false);
    expect(agentPrompt).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(conv()?.planState?.active).toBe(false));

    agentSetPlanMode.mockResolvedValueOnce({ ok: false, error: 'stale' });
    sessionsModule.useSessionsStore.getState().setPlanMode('plan-parent', true);
    await vi.waitFor(() => expect(conv()?.planState?.active).toBe(false));
  });

  it('会话在异步回滚前已删除时不复活成半截会话', async () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        'plan-parent': { ...state.conversations['plan-parent'], started: true },
      },
    }));
    let settle!: (value: { ok: boolean; error?: string }) => void;
    agentSetPlanMode.mockImplementationOnce(() => new Promise((resolve) => (settle = resolve)));
    sessionsModule.useSessionsStore.getState().setPlanMode('plan-parent', false);
    sessionsModule.useSessionsStore.setState(({ conversations }) => {
      const { 'plan-parent': _removed, ...rest } = conversations;
      return { conversations: rest, order: [] };
    });
    settle({ ok: false, error: 'stale' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(conv()).toBeUndefined();
  });
});

describe('无人值守开关：已启动即时下发，未启动随 spawn', () => {
  beforeAll(async () => {
    await loadSessionModules();
  });

  beforeEach(async () => {
    await seedParent();
    agentSetApprovalMode.mockClear();
    agentSpawn.mockClear();
  });

  const conv = () => sessionsModule.useSessionsStore.getState().conversations['plan-parent'];

  it('已启动：随当前档位一起下发；失败回滚', async () => {
    sessionsModule.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        'plan-parent': {
          ...state.conversations['plan-parent'],
          started: true,
          approvalMode: 'auto-edits',
        },
      },
    }));
    sessionsModule.useSessionsStore.getState().setAutoRejectApprovals('plan-parent', true);
    expect(conv()?.autoRejectApprovals).toBe(true);
    expect(agentSetApprovalMode).toHaveBeenCalledWith('plan-parent', 'auto-edits', true);

    agentSetApprovalMode.mockResolvedValueOnce({ ok: false, error: 'stale' });
    sessionsModule.useSessionsStore.getState().setAutoRejectApprovals('plan-parent', false);
    await vi.waitFor(() => expect(conv()?.autoRejectApprovals).toBe(true));
  });

  it('未启动：只记在会话上，不下发，spawn 时带上', async () => {
    sessionsModule.useSessionsStore.getState().setAutoRejectApprovals('plan-parent', true);
    expect(agentSetApprovalMode).not.toHaveBeenCalled();
    expect(conv()?.autoRejectApprovals).toBe(true);
    await sessionsModule.useSessionsStore
      .getState()
      .send('继续', { providerId: 'provider-1', modelId: 'model-1', cwd: '/workspace' });
    expect(agentSpawn).toHaveBeenCalledWith(expect.objectContaining({ autoRejectApprovals: true }));
  });
});
