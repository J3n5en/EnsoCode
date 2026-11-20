import { resolveChatModel, scopedDefaultModels } from '@shared/defaultModel';
import { normalizeLocale, translate } from '@shared/i18n';
import type { DispatchDraft, SecretaryProfileDraft, SecretaryState } from '@shared/types/secretary';
import { create } from 'zustand';
import { readMaterializedProviders } from '@/stores/modelDirectory/useProviders';
import { oauthCredentialContext, useOauthCredentialStore } from '@/stores/oauthCredentials';
import { useSessionsStore } from '@/stores/sessions';
import { setTakenOverSessions } from '@/stores/sessions/secretaryOwned';
import { useSettingsStore } from '@/stores/settings';
import { useSidePanelStore } from '@/stores/sidePanel';

/** 秘书会话的开场白：初次设置走「聊着设置」时由用户侧发一条固定引导语（D5） */
const SETUP_GREETING =
  "Let's set you up. Ask me a few questions about what to call me, which model you should use, and how much you may do on your own. Then submit the draft with secretary_profile_propose and wait for my confirmation.";

/**
 * 秘书状态 store：Main 是唯一真相，聊天卡片与之后的工作台读同一份推送。
 * renderer 只额外记「哪些提案正在提交」，按钮据此禁用。
 */
export const EMPTY_SECRETARY_STATE: SecretaryState = {
  enabled: false,
  projectId: null,
  profile: null,
  persona: '',
  board: { needsYou: [], running: [], done: [], todos: [] },
  proposals: {},
  takeovers: [],
};

interface SecretaryStoreState {
  secretary: SecretaryState;
  resolving: Record<string, true>;
  /** 未完成初次设置时主区域显示欢迎页（页面本身由设置流程提供） */
  welcomeOpen: boolean;
  /** 深链或手机按钮要求定位的那张确认卡：工作台滚过去并高亮 */
  focusProposal: { proposalId: string; at: number } | null;
  bind: () => () => void;
  openWelcome: () => void;
  closeWelcome: () => void;
  focusProposalCard: (proposalId: string) => void;
  clearFocusProposal: () => void;
  /**
   * 新建一个秘书会话，模型与思考档位和普通会话一样按默认走，之后在输入框里切。
   * greeting 只在初次设置走「聊着设置」时发。
   */
  newSecretaryConversation: (options?: { greeting?: boolean }) => Promise<string | null>;
  resolveProposal: (
    proposalId: string,
    action: 'confirm' | 'reject',
    edits?: Partial<DispatchDraft>,
    profileDraft?: SecretaryProfileDraft
  ) => Promise<void>;
}

export const useSecretaryStore = create<SecretaryStoreState>()((set, get) => ({
  secretary: EMPTY_SECRETARY_STATE,
  resolving: {},
  welcomeOpen: false,
  focusProposal: null,

  openWelcome: () => set({ welcomeOpen: true }),
  closeWelcome: () => set({ welcomeOpen: false }),
  focusProposalCard: (proposalId) => set({ focusProposal: { proposalId, at: Date.now() } }),
  clearFocusProposal: () => set({ focusProposal: null }),

  bind: () => {
    let pushed = false;
    let bound = true;
    const off = window.electronAPI.secretary.onStateChanged((secretary) => {
      pushed = true;
      setTakenOverSessions(secretary.takeovers.map((entry) => entry.conversationId));
      set((state) => ({
        secretary,
        // 设置完成后欢迎页让位给会话；档案被重来清掉时再回到欢迎页（首次启动没有档案不弹）
        welcomeOpen: secretary.profile
          ? false
          : state.secretary.profile !== null
            ? true
            : state.welcomeOpen,
      }));
    });
    void window.electronAPI.secretary
      .getState()
      // 推送比首帧快时以推送为准，否则旧快照会盖掉刚确认的提案
      .then((secretary) => {
        if (pushed || !bound) return;
        setTakenOverSessions(secretary.takeovers.map((entry) => entry.conversationId));
        set({ secretary });
      })
      .catch(() => undefined);
    // 手机上的消息带 enso://secretary?conversation=<id>[&proposal=<id>]：
    // 点开回到应用、选中那个会话；带卡时再让工作台定位到那张卡
    const offOpen = window.electronAPI.secretary.onOpenConversation((target) => {
      useSessionsStore.getState().selectConversation(target.conversationId);
      useSidePanelStore.getState().ensureOpen(target.conversationId);
      if (target.proposalId) get().focusProposalCard(target.proposalId);
    });
    return () => {
      bound = false;
      off();
      offOpen();
      // 开关关掉后 Main 不再推送：清掉最后一份快照，入口随之消失；会话本身不动
      setTakenOverSessions([]);
      set({ secretary: EMPTY_SECRETARY_STATE, welcomeOpen: false, focusProposal: null });
    };
  },

  newSecretaryConversation: async (options) => {
    const { secretary } = get();
    const projectId = secretary.projectId;
    if (!projectId) return null;
    const settings = useSettingsStore.getState();
    const project = settings.projects.find((entry) => entry.id === projectId);
    if (!project) return null;
    const model = resolveDefaultModel(projectId);
    if (!model) return null;
    const sessions = useSessionsStore.getState();
    const id = await sessions.newConversation(projectId);
    if (!id) return null;
    if (options?.greeting) {
      const locale = normalizeLocale(useSettingsStore.getState().language);
      await sessions.send(
        translate(locale, SETUP_GREETING),
        { ...model, cwd: project.path },
        undefined,
        id
      );
    }
    return id;
  },

  resolveProposal: async (proposalId, action, edits, profileDraft) => {
    set({ resolving: { ...get().resolving, [proposalId]: true } });
    try {
      // 结果不在这里落：Main 写完提案状态后推送，卡片跟着推送走
      await window.electronAPI.secretary.resolveProposal(proposalId, action, edits, profileDraft);
    } catch {
      // 抛错时 Main 没改状态，清掉在途标记让用户能重试
    } finally {
      const resolving = { ...get().resolving };
      delete resolving[proposalId];
      set({ resolving });
    }
  },
}));

/** 按「项目默认 → 分组默认 → 全局默认」只挑可用的模型，与普通会话同口径 */
function resolveDefaultModel(projectId: string): { providerId: string; modelId: string } | null {
  const settings = useSettingsStore.getState();
  const project = settings.projects.find((entry) => entry.id === projectId);
  if (!project) return null;
  const resolution = resolveChatModel({
    defaultModel: settings.defaultModel,
    ...scopedDefaultModels(project, settings.projectGroups),
    providers: readMaterializedProviders(),
    credentials: oauthCredentialContext(useOauthCredentialStore.getState().snapshot),
    virtualModels: settings.virtualModels,
  });
  return resolution.source === 'none'
    ? null
    : { providerId: resolution.providerId, modelId: resolution.modelId };
}
