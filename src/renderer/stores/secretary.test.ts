import type { SecretaryProfile, SecretaryProposal, SecretaryState } from '@shared/types/secretary';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const proposal: SecretaryProposal = {
  id: 'pr1',
  secretaryConversationId: 'sec1',
  createdAt: 1,
  updatedAt: 1,
  status: 'pending',
  kind: 'dispatch',
  draft: { projectId: 'p1', prompt: 'fix login', worktree: false },
};

const stateWith = (status: SecretaryProposal['status']): SecretaryState => ({
  enabled: true,
  projectId: 'sec-project',
  profile: null,
  persona: '',
  board: { needsYou: [], running: [], done: [], todos: [] },
  proposals: { pr1: { ...proposal, status } },
  takeovers: [],
});

let initialState: Promise<SecretaryState>;
let listener: ((state: SecretaryState) => void) | null = null;
let openListener: ((target: { conversationId: string; proposalId?: string }) => void) | null = null;
const off = vi.fn();
const offOpen = vi.fn();
const ensureOpen = vi.fn();
const resolveProposal = vi.fn(async (_proposalId: string, _action: 'confirm' | 'reject') => ({
  ok: true as const,
  proposal,
}));
const sessions = {
  selectConversation: vi.fn(),
  newConversation: vi.fn(async (_projectId: string) => 'conv-1' as string | null),
  setModel: vi.fn(),
  setThinking: vi.fn(),
  send: vi.fn(async (..._args: unknown[]) => null as string | null),
};
const settings = {
  language: 'en',
  defaultModel: null,
  projectGroups: [],
  virtualModels: [],
  projects: [{ id: 'sec-project', path: '/tmp/secretary', name: '秘书' }],
};

vi.mock('@/stores/sessions', () => ({ useSessionsStore: { getState: () => sessions } }));
vi.mock('@/stores/sidePanel', () => ({
  useSidePanelStore: { getState: () => ({ ensureOpen }) },
}));
vi.mock('@/stores/settings', () => ({ useSettingsStore: { getState: () => settings } }));
vi.mock('@/stores/modelDirectory/useProviders', () => ({ readMaterializedProviders: () => [] }));
/** 全局默认模型解析的结果：测试按需改，null 表示没有可用模型 */
const defaultModel = vi.hoisted(() => ({
  value: null as { providerId: string; modelId: string } | null,
}));
vi.mock('@shared/defaultModel', () => ({
  scopedDefaultModels: () => ({}),
  resolveChatModel: () =>
    defaultModel.value ? { ...defaultModel.value, source: 'default' } : { source: 'none' },
}));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/oauthCredentials', () => ({
  useOauthCredentialStore: { getState: () => ({ snapshot: {} }) },
  oauthCredentialContext: () => ({}),
}));

vi.stubGlobal('window', {
  electronAPI: {
    secretary: {
      getState: () => initialState,
      onStateChanged: (callback: (state: SecretaryState) => void) => {
        listener = callback;
        return off;
      },
      onOpenConversation: (
        callback: (target: { conversationId: string; proposalId?: string }) => void
      ) => {
        openListener = callback;
        return offOpen;
      },
      resolveProposal,
    },
  },
});

const { EMPTY_SECRETARY_STATE, useSecretaryStore } = await import('./secretary');
const { secretarySectionView } = await import('@/components/secretary/secretaryView');
const { isSecretaryOwned } = await import('@/stores/sessions/secretaryOwned');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('useSecretaryStore', () => {
  beforeEach(() => {
    listener = null;
    off.mockClear();
    offOpen.mockClear();
    resolveProposal.mockClear();
    useSecretaryStore.setState({ secretary: EMPTY_SECRETARY_STATE, resolving: {} });
  });

  it('bind 拉一次状态并订阅推送，推送覆盖初始快照', async () => {
    initialState = Promise.resolve(stateWith('pending'));
    const unbind = useSecretaryStore.getState().bind();
    await flush();
    expect(useSecretaryStore.getState().secretary.proposals.pr1?.status).toBe('pending');

    listener?.(stateWith('succeeded'));
    expect(useSecretaryStore.getState().secretary.proposals.pr1?.status).toBe('succeeded');

    unbind();
    expect(off).toHaveBeenCalledTimes(1);
    expect(offOpen).toHaveBeenCalledTimes(1);
  });

  it('推送先到时，晚回来的初始快照不把它盖回去', async () => {
    let settle: (state: SecretaryState) => void = () => {};
    initialState = new Promise<SecretaryState>((resolve) => {
      settle = resolve;
    });
    useSecretaryStore.getState().bind();
    listener?.(stateWith('executing'));
    settle(stateWith('pending'));
    await flush();
    expect(useSecretaryStore.getState().secretary.proposals.pr1?.status).toBe('executing');
  });

  it('resolveProposal 在途按提案 id 标记，结束后清除', async () => {
    let settle: () => void = () => {};
    resolveProposal.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = () => resolve({ ok: true, proposal });
        })
    );
    const pending = useSecretaryStore.getState().resolveProposal('pr1', 'confirm');
    expect(useSecretaryStore.getState().resolving.pr1).toBe(true);
    expect(resolveProposal).toHaveBeenCalledWith('pr1', 'confirm', undefined, undefined);

    settle();
    await pending;
    expect(useSecretaryStore.getState().resolving.pr1).toBeUndefined();
  });

  it('resolveProposal 抛错也清掉在途标记，按钮可以重试', async () => {
    resolveProposal.mockRejectedValueOnce(new Error('boom'));
    await useSecretaryStore.getState().resolveProposal('pr1', 'reject');
    expect(useSecretaryStore.getState().resolving.pr1).toBeUndefined();
  });

  it('深链带卡时选中会话、打开面板并定位那张卡', () => {
    useSecretaryStore.getState().bind();
    openListener?.({ conversationId: 'conv-9', proposalId: 'pr1' });
    expect(sessions.selectConversation).toHaveBeenCalledWith('conv-9');
    expect(ensureOpen).toHaveBeenCalledWith('conv-9');
    expect(useSecretaryStore.getState().focusProposal?.proposalId).toBe('pr1');
  });

  it('深链只带会话时不动工作台的定位', () => {
    useSecretaryStore.setState({ focusProposal: null });
    useSecretaryStore.getState().bind();
    openListener?.({ conversationId: 'conv-9' });
    expect(sessions.selectConversation).toHaveBeenCalledWith('conv-9');
    expect(useSecretaryStore.getState().focusProposal).toBeNull();
  });

  it('重来后（档案从有到无）主界面回到欢迎页，首次启动不会自己弹出来', () => {
    initialState = Promise.resolve(stateWith('pending'));
    useSecretaryStore.getState().bind();
    listener?.({ ...stateWith('pending'), profile: null });
    expect(useSecretaryStore.getState().welcomeOpen).toBe(false);

    listener?.({ ...stateWith('pending'), profile: { name: '秘书' } as never });
    expect(useSecretaryStore.getState().welcomeOpen).toBe(false);

    listener?.({ ...stateWith('pending'), profile: null });
    expect(useSecretaryStore.getState().welcomeOpen).toBe(true);
  });
});

describe('秘书开关关闭', () => {
  const sidebarEntry = () => secretarySectionView(useSecretaryStore.getState().secretary, String);
  const takenOver: SecretaryState = {
    ...stateWith('pending'),
    takeovers: [
      {
        conversationId: 'conv-t',
        projectId: 'p1',
        projectName: 'p',
        title: 't',
        grantedAt: 1,
        via: 'manual' as SecretaryState['takeovers'][number]['via'],
        secretaryConversationId: 'sec1',
      },
    ],
  };

  beforeEach(() => {
    useSecretaryStore.setState({ secretary: EMPTY_SECRETARY_STATE, welcomeOpen: false });
  });

  it('退订后入口消失、接管名单清空，开着时的快照不残留', async () => {
    initialState = Promise.resolve(takenOver);
    const unbind = useSecretaryStore.getState().bind();
    await flush();
    expect(sidebarEntry()).not.toBeNull();
    expect(isSecretaryOwned({ id: 'conv-t' })).toBe(true);

    unbind();
    expect(useSecretaryStore.getState().secretary.enabled).toBe(false);
    expect(sidebarEntry()).toBeNull();
    expect(isSecretaryOwned({ id: 'conv-t' })).toBe(false);
  });

  it('关掉时还在途的首帧回包不能把入口写回来', async () => {
    let settle: (state: SecretaryState) => void = () => {};
    initialState = new Promise<SecretaryState>((resolve) => {
      settle = resolve;
    });
    const unbind = useSecretaryStore.getState().bind();
    unbind();
    settle(stateWith('pending'));
    await flush();
    expect(sidebarEntry()).toBeNull();
  });

  it('重新打开后入口回来', async () => {
    initialState = Promise.resolve(stateWith('pending'));
    useSecretaryStore.getState().bind()();
    await flush();
    expect(sidebarEntry()).toBeNull();

    useSecretaryStore.getState().bind();
    await flush();
    expect(sidebarEntry()).not.toBeNull();
  });
});

describe('newSecretaryConversation', () => {
  const legacyProfile = (): SecretaryProfile =>
    ({
      version: 1,
      name: '秘书',
      avatar: { color: '#7c5cff' },
      takeoverScope: { mode: 'projects', projectIds: [] },
      visibleProjectIds: 'all',
      maxRunningDispatches: 3,
      patrolEnabled: true,
      replyLanguage: 'ui',
      style: 'concise',
      notify: 'needs-user',
      updatedAt: 1,
      // 旧档案里留下的秘书模型，provider 可能早就删了
      model: { providerId: 'gone', modelId: 'old' },
    }) as SecretaryProfile;
  const withProfile = (): SecretaryState => ({
    ...stateWith('pending'),
    profile: legacyProfile(),
  });

  beforeEach(() => {
    sessions.newConversation.mockClear();
    sessions.setModel.mockClear();
    sessions.setThinking.mockClear();
    sessions.send.mockClear();
    defaultModel.value = null;
    useSecretaryStore.setState({ secretary: EMPTY_SECRETARY_STATE, resolving: {} });
  });

  it('新建秘书会话用全局默认模型，不读档案里的旧模型；没有引导语时不发消息', async () => {
    defaultModel.value = { providerId: 'p', modelId: 'm' };
    useSecretaryStore.setState({ secretary: withProfile() });
    await expect(useSecretaryStore.getState().newSecretaryConversation()).resolves.toBe('conv-1');
    expect(sessions.newConversation).toHaveBeenCalledWith('sec-project');
    expect(sessions.setModel).not.toHaveBeenCalled();
    expect(sessions.setThinking).not.toHaveBeenCalled();
    expect(sessions.send).not.toHaveBeenCalled();
  });

  it('要引导语时用普通 send 按默认模型发一条固定的开场白', async () => {
    defaultModel.value = { providerId: 'p', modelId: 'm' };
    useSecretaryStore.setState({ secretary: withProfile() });
    await useSecretaryStore.getState().newSecretaryConversation({ greeting: true });
    expect(sessions.send).toHaveBeenCalledTimes(1);
    const [text, target, images, conversationId] = sessions.send.mock.calls[0] as unknown as [
      string,
      { providerId: string; modelId: string; cwd: string },
      unknown,
      string,
    ];
    expect(text).toContain('secretary_profile_propose');
    expect(target).toEqual({ providerId: 'p', modelId: 'm', cwd: '/tmp/secretary' });
    expect(images).toBeUndefined();
    expect(conversationId).toBe('conv-1');
  });

  it('没有可用模型时不建会话，也不发消息', async () => {
    useSecretaryStore.setState({ secretary: withProfile() });
    await expect(useSecretaryStore.getState().newSecretaryConversation()).resolves.toBeNull();
    expect(sessions.newConversation).not.toHaveBeenCalled();
    expect(sessions.send).not.toHaveBeenCalled();
  });

  it('开关没开、Main 还没登记秘书项目时直接返回', async () => {
    useSecretaryStore.setState({ secretary: { ...withProfile(), projectId: null } });
    await expect(useSecretaryStore.getState().newSecretaryConversation()).resolves.toBeNull();
    expect(sessions.newConversation).not.toHaveBeenCalled();
  });
});
