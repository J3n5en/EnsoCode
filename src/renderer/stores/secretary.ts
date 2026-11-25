import { resolveChatModel, scopedDefaultModels } from '@shared/defaultModel';
import { normalizeLocale, translate } from '@shared/i18n';
import type {
  DispatchDraft,
  SecretaryProfileDraft,
  SecretaryState,
  SecretarySummary,
} from '@shared/types/secretary';
import { create } from 'zustand';
import { pruneRemoteSecretaryAvatars } from '@/lib/remoteImage';
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
  /** 当前看着的秘书（所在会话、面板、欢迎页都按它）的状态；只有一个秘书时就是它 */
  secretary: SecretaryState;
  /** 全部秘书：侧栏、新建、删除与总看板用 */
  secretaries: SecretarySummary[];
  /** 每个秘书各自的一份 Main 状态 */
  states: Record<string, SecretaryState>;
  /** 当前看着的秘书 id */
  focusedId: string | null;
  /** 切到某个秘书：面板、欢迎页与 IPC 默认都按它 */
  focus: (secretaryId: string) => void;
  /** 向 Main 重读某个秘书的状态，覆盖手上这份 */
  reload: (secretaryId?: string) => Promise<void>;
  /** 新建秘书：建好后切过去并打开它的欢迎页 */
  createSecretary: () => Promise<string | null>;
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
  newSecretaryConversation: (options?: {
    greeting?: boolean;
    secretaryId?: string;
  }) => Promise<string | null>;
  resolveProposal: (
    proposalId: string,
    action: 'confirm' | 'reject',
    edits?: Partial<DispatchDraft>,
    profileDraft?: SecretaryProfileDraft
  ) => Promise<void>;
  /**
   * 聊天卡片发现 store 里没有这张提案时调用：按需重拉所有秘书状态。
   * 远程桌面丢过一次推送时提案卡会一直停在占位行（没有确认按钮），靠它自愈。
   * 并发调用合并成一次扫描；提案已在 store 里时不重拉。
   */
  ensureProposal: (proposalId: string) => Promise<void>;
}

/** 当前看着的那个秘书：没有选中时取清单里的第一个 */
function pickFocused(
  secretaries: readonly SecretarySummary[],
  focusedId: string | null
): string | null {
  if (focusedId && secretaries.some((entry) => entry.id === focusedId)) return focusedId;
  return secretaries[0]?.id ?? null;
}

/** 全部秘书的接管会话合起来：侧栏徽标只问「有没有秘书在管」 */
function syncTakenOver(states: Record<string, SecretaryState>): void {
  setTakenOverSessions(
    Object.values(states).flatMap((state) => state.takeovers.map((entry) => entry.conversationId))
  );
}

/** IPC 调用默认带上当前看着的秘书；只有一个秘书时 Main 也接受省略 */
export function focusedSecretaryId(): string | undefined {
  return useSecretaryStore.getState().focusedId ?? undefined;
}

/** 某个会话属于哪个秘书（按秘书的隐藏项目认） */
export function secretaryIdOfProject(projectId: string | undefined): string | null {
  if (!projectId) return null;
  return (
    useSecretaryStore.getState().secretaries.find((entry) => entry.projectId === projectId)?.id ??
    null
  );
}

export const useSecretaryStore = create<SecretaryStoreState>()((set, get) => ({
  secretary: EMPTY_SECRETARY_STATE,
  secretaries: [],
  states: {},
  focusedId: null,
  resolving: {},
  welcomeOpen: false,
  focusProposal: null,

  focus: (secretaryId) => {
    const { states, focusedId } = get();
    if (focusedId === secretaryId && states[secretaryId]) return;
    set({
      focusedId: secretaryId,
      secretary: states[secretaryId] ?? EMPTY_SECRETARY_STATE,
      welcomeOpen: false,
    });
    if (!states[secretaryId]) void get().reload(secretaryId);
  },

  reload: async (secretaryId) => {
    const id = secretaryId ?? get().focusedId;
    if (!id) return;
    const state = await window.electronAPI.secretary.getState(id).catch(() => null);
    if (!state) return;
    set((current) => ({
      states: { ...current.states, [id]: state },
      ...(current.focusedId === id ? { secretary: state } : {}),
    }));
  },

  createSecretary: async () => {
    const created = await window.electronAPI.secretary.create();
    if (!created.ok) return null;
    const list = await window.electronAPI.secretary.list();
    set({ secretaries: list });
    get().focus(created.secretaryId);
    set({ welcomeOpen: true });
    return created.secretaryId;
  },

  openWelcome: () => set({ welcomeOpen: true }),
  closeWelcome: () => set({ welcomeOpen: false }),
  focusProposalCard: (proposalId) => set({ focusProposal: { proposalId, at: Date.now() } }),
  clearFocusProposal: () => set({ focusProposal: null }),

  bind: () => {
    const pushed = new Set<string>();
    let bound = true;
    const apply = (secretary: SecretaryState) => {
      applySecretaryStateMerge(secretary, set, get);
    };
    const off = window.electronAPI.secretary.onStateChanged((secretary) => {
      if (secretary.secretaryId) pushed.add(secretary.secretaryId);
      apply(secretary);
    });
    const offList = window.electronAPI.secretary.onListChanged((secretaries) => {
      pruneRemoteSecretaryAvatars(secretaries.map((entry) => entry.id));
      set((state) => {
        const ids = new Set(secretaries.map((entry) => entry.id));
        const states = Object.fromEntries(
          Object.entries(state.states).filter(([id]) => ids.has(id))
        );
        const focusedId = pickFocused(secretaries, state.focusedId);
        syncTakenOver(states);
        return {
          secretaries,
          states,
          focusedId,
          // 清单推送常比各秘书的状态快：states 里还没有时保留手上那份，不把侧栏闪空。
          // 清单可能先到并把 focusedId 设好，所以按「聚焦没变」判断，而不是只看 states
          secretary:
            (focusedId && states[focusedId]) ||
            (focusedId === state.focusedId ? state.secretary : EMPTY_SECRETARY_STATE),
        };
      });
    });
    void window.electronAPI.secretary
      .list()
      .then(async (secretaries) => {
        if (!bound) return;
        pruneRemoteSecretaryAvatars(secretaries.map((entry) => entry.id));
        set((state) => ({
          secretaries,
          focusedId: pickFocused(secretaries, state.focusedId),
        }));
        for (const entry of secretaries) {
          // 推送比首帧快时以推送为准，否则旧快照会盖掉刚确认的提案
          const secretary = await window.electronAPI.secretary.getState(entry.id);
          if (!bound || pushed.has(entry.id)) continue;
          apply({ ...secretary, secretaryId: secretary.secretaryId ?? entry.id });
        }
      })
      .catch(() => undefined);
    // 手机上的消息带 enso://secretary?conversation=<id>[&proposal=<id>]：
    // 点开回到应用、选中那个会话；带卡时再让工作台定位到那张卡
    const offOpen = window.electronAPI.secretary.onOpenConversation((target) => {
      useSessionsStore.getState().selectConversation(target.conversationId);
      useSidePanelStore.getState().ensureOpen(target.conversationId);
      if (target.proposalId) get().focusProposalCard(target.proposalId);
    });
    // 打开某个秘书的会话：面板、欢迎页与 IPC 都切到这个秘书
    const offActive = useSessionsStore.subscribe((state, previous) => {
      if (state.activeId === previous.activeId) return;
      const projectId = state.activeId ? state.conversations[state.activeId]?.projectId : undefined;
      const id = secretaryIdOfProject(projectId);
      if (id) get().focus(id);
    });
    return () => {
      bound = false;
      off();
      offList();
      offOpen();
      offActive();
      // 开关关掉后 Main 不再推送：清掉最后一份快照，入口随之消失；会话本身不动
      setTakenOverSessions([]);
      set({
        secretary: EMPTY_SECRETARY_STATE,
        secretaries: [],
        states: {},
        focusedId: null,
        welcomeOpen: false,
        focusProposal: null,
      });
    };
  },

  newSecretaryConversation: async (options) => {
    const { states, secretary, secretaries } = get();
    const target = options?.secretaryId ? states[options.secretaryId] : secretary;
    if (options?.secretaryId) get().focus(options.secretaryId);
    // 刚建好的秘书状态是异步拉的：没到时按清单里登记的隐藏项目建，不让首次设置落空
    const projectId =
      target?.projectId ??
      (options?.secretaryId
        ? secretaries.find((entry) => entry.id === options.secretaryId)?.projectId
        : null);
    if (!projectId) return null;
    const settings = useSettingsStore.getState();
    const project = settings.projects.find((entry) => entry.id === projectId);
    if (!project) return null;
    // 只有引导语要用模型发出去；普通新建和普通新对话一样，没有默认模型就到输入框里选
    const model = options?.greeting ? resolveDefaultModel(projectId) : null;
    if (options?.greeting && !model) return null;
    const sessions = useSessionsStore.getState();
    const id = await sessions.newConversation(projectId);
    if (!id) return null;
    if (model) {
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

  ensureProposal: async (proposalId) => {
    if (Object.values(get().states).some((state) => state.proposals[proposalId])) return;
    await scanSecretaryStates();
  },
}));

/** 一次性重拉所有秘书状态：调用方负责先判断值得扫；在途合并 */
let scanningStates: Promise<void> | null = null;
async function scanSecretaryStates(): Promise<void> {
  scanningStates ??= (async () => {
    try {
      const list = await window.electronAPI.secretary.list().catch(() => []);
      for (const entry of list) {
        const state = await window.electronAPI.secretary.getState(entry.id).catch(() => null);
        if (!state) continue;
        applySecretaryStateMerge(
          { ...state, secretaryId: state.secretaryId ?? entry.id },
          useSecretaryStore.setState,
          useSecretaryStore.getState
        );
      }
    } finally {
      scanningStates = null;
    }
  })();
  return scanningStates;
}

/** 推送与按需重拉共用的归并逻辑：states 里按秘书落位，聚焦的那份同时进 secretary */
function applySecretaryStateMerge(
  secretary: SecretaryState,
  set: (fn: (state: SecretaryStoreState) => Partial<SecretaryStoreState>) => void,
  get: () => SecretaryStoreState
): void {
  const id = secretary.secretaryId ?? get().focusedId;
  if (!id) return;
  set((state) => {
    const states = { ...state.states, [id]: secretary };
    syncTakenOver(states);
    const focusedId = pickFocused(state.secretaries, state.focusedId) ?? id;
    if (focusedId !== id) return { states, focusedId };
    const before = state.states[id] ?? state.secretary;
    return {
      states,
      focusedId,
      secretary,
      // 设置完成后欢迎页让位给会话；档案被重来清掉时再回到欢迎页（首次启动没有档案不弹）
      welcomeOpen: secretary.profile
        ? false
        : before.profile !== null && before.enabled
          ? true
          : state.welcomeOpen,
    };
  });
}

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
