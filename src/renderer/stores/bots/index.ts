import { botBrowserChatId } from '@shared/bots/browser';
import { visibleInbox } from '@shared/bots/inbox';
import type { AttachedImage } from '@shared/types/agent';
import type {
  BotChat,
  BotProfile,
  BotRoutine,
  Delegation,
  GroupEntry,
  GroupTask,
} from '@shared/types/bot';
import type {
  BotActionResult,
  BotEvent,
  BotInboxItem,
  BotQueueItem,
  BotSearchHit,
  BotSendResult,
  BotSilence,
} from '@shared/types/botIpc';
import type { BrowserTabHolder } from '@shared/types/browser';
import { create } from 'zustand';
import { draftFromSentText, seedBotDraft } from '@/components/bots/botDraft';
import { usePendingMemoryWrites } from '@/stores/memoryReview';
import { applyHistoryPage, emptyProjection } from '@/stores/sessions/reducer';
import { resizeSidePanelWidth, SIDE_PANEL_DEFAULT_WIDTH } from '@/stores/sidePanel/width';
import { type ChatBrowserTabs, closeChatTab, parseChatTabs, revealChatTab } from './browserTabs';
import type { BotUsageSnapshot } from './budget';
import { createCoalescer } from './coalesce';
import { isActiveDelegation } from './delegations';
import { mergeLatest, mergeNewer, mergeOlder, TIMELINE_MAX, trimTimeline } from './groupTimeline';
import { applyBotAgentEvent, type BotSessions, seedHistory } from './projection';
import { chatSummary } from './selectors';
import { seedReadMarks, unreadMark } from './unread';

/**
 * Bot 模式 store：成员/聊天目录、群时间线、成员会话投影。
 * 成员会话不在 enso-conversations 里（sessions store 会丢它们的事件），
 * 这里只为 chat.sessions 里出现过的 conversationId 维护投影。
 */

export interface TimelineState {
  entries: GroupEntry[];
  lastSeq: number;
  hasOlder: boolean;
  loading: boolean;
  /**
   * 历史窗口：已加载条目没追上最新，实时新消息不并入列表。
   * sinceSeq = 进入时的 lastSeq（计新消息数），tail = 已知最新一条（预览用）
   */
  history?: { sinceSeq: number; tail?: GroupEntry };
  loadingNewer?: boolean;
}

export interface ChatRuntime {
  current: string | null;
  queue: string[];
  hops: number;
  turnsByBot: Record<string, number>;
  pendingHuman: boolean;
  routing: boolean;
}

export type BotView = { kind: 'chat'; chatId: string } | { kind: 'inbox' } | null;

/** 搜索结果跳转：目标聊天的时间线消费后清掉（按 nonce 防止清掉更新的一次） */
export interface BotFocus {
  chatId: string;
  locator: BotSearchHit['locator'];
  query: string;
  nonce: number;
}

const TIMELINE_PAGE = 50;
/** 跳转窗口：目标前后各取这么多条 */
const TIMELINE_AROUND = 40;
const READS_KEY = 'enso-bot-reads';
const PANEL_KEY = 'enso-bot-panel';
const PANEL_WIDTH_KEY = 'enso-bot-panel-width';
const PANEL_TAB_KEY = 'enso-bot-panel-tab';
/** 聊天 → 共享浏览器 tabId（agent 先开的 tab 是随机 id，重启后按它恢复） */
const BROWSER_TABS_KEY = 'enso-bot-browser-tabs';
const VIEW_KEY = 'enso-bot-view';
/** 旧版收件箱忽略记录（localStorage），首次连上 Main 收件箱时迁移后删除 */
const LEGACY_DISMISSED_KEY = 'enso-bot-dismissed-delegations';
const LEGACY_DISMISSED_BUDGETS_KEY = 'enso-bot-dismissed-budgets';

function loadReads(): Record<string, number> | null {
  try {
    const raw = localStorage.getItem(READS_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function loadView(): BotView {
  const raw = localStorage.getItem(VIEW_KEY);
  if (raw === 'inbox') return { kind: 'inbox' };
  return raw ? { kind: 'chat', chatId: raw } : null;
}

export type BotPanelTab = 'info' | 'browser';

function loadBrowserTabs(): Record<string, ChatBrowserTabs> {
  try {
    return parseChatTabs(JSON.parse(localStorage.getItem(BROWSER_TABS_KEY) ?? '{}'));
  } catch {
    return {};
  }
}

function loadDismissed(key: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

interface BotsState {
  enabled: boolean;
  loaded: boolean;
  bots: BotProfile[];
  chats: BotChat[];
  queue: BotQueueItem[];
  /** 运行中却超过静默阈值没有输出的成员会话（Main 看门狗） */
  silences: BotSilence[];
  delegations: Delegation[];
  /** Main 收件箱（未结束的条目，含已忽略） */
  inbox: BotInboxItem[];
  /** 成员用量概览（今日 / 7 天 / 30 天 + 今日是否超预算） */
  usage: BotUsageSnapshot | null;
  /** 全部例行任务：收件箱的待批准 / 阻塞提示、群时间线里的提议卡片 */
  routines: BotRoutine[];
  timelines: Record<string, TimelineState>;
  runtime: Record<string, ChatRuntime>;
  /** 群任务看板；只缓存打开过看板的群 */
  tasks: Record<string, GroupTask[]>;
  sessions: BotSessions;
  sessionHistoryLoading: Record<string, boolean>;
  reads: Record<string, number>;
  view: BotView;
  /** 聊天右侧的成员资料 / 群信息面板 */
  panelOpen: boolean;
  panelWidth: number;
  panelTab: BotPanelTab;
  browserTabs: Record<string, ChatBrowserTabs>;
  /** 聊天浏览器当前页标题（面板页签显示，不持久化） */
  browserTitles: Record<string, string>;
  /** 聊天浏览器各标签当前占用的成员会话（Main 推送，不持久化） */
  browserHolders: Record<string, BrowserTabHolder>;
  searchOpen: boolean;
  focus: BotFocus | null;

  /** 订阅 Bot 事件与 agent 事件流并拉一次全量；引用计数，重复 bind 共用一份订阅；返回清理函数 */
  bind: () => () => void;
  refreshCatalog: () => Promise<void>;
  refreshChats: () => Promise<void>;
  /** 拉委派列表，并跟踪进行中委派的子会话（审批/提问归属发起聊天） */
  refreshDelegations: () => Promise<void>;
  refreshInbox: () => Promise<void>;
  dismissInbox: (key: string) => Promise<void>;
  refreshUsage: () => Promise<void>;
  refreshRoutines: () => Promise<void>;
  refreshTasks: (chatId: string) => Promise<void>;
  loadLatest: (chatId: string) => Promise<void>;
  loadOlder: (chatId: string) => Promise<void>;
  /** 历史窗口向下翻页；追上最新后退出历史窗口 */
  loadNewer: (chatId: string) => Promise<void>;
  /** 跳转：直接加载目标 seq 附近一段替换当前条目，未到最新则进入历史窗口 */
  loadAround: (chatId: string, seq: number) => Promise<void>;
  /** 回到最新：替换为最新一页并退出历史窗口 */
  jumpLatest: (chatId: string) => Promise<void>;
  refreshRuntime: (chatId: string) => Promise<void>;
  /** 开始跟踪成员会话；返回首屏历史加载完成的 promise */
  trackSession: (conversationId: string) => Promise<void>;
  loadOlderSession: (conversationId: string) => Promise<void>;
  setView: (view: BotView) => void;
  togglePanel: () => void;
  setPanelTab: (tab: BotPanelTab) => void;
  /** 标题按 tabId 记 */
  setBrowserTitle: (tabId: string, title: string) => void;
  /** 用户新开一个标签并切到浏览器面板 */
  openBrowserTab: (chatId: string) => void;
  selectBrowserTab: (chatId: string, tabId: string) => void;
  /** 用户手动关标签；关完最后一个回到信息页 */
  closeBrowserTab: (chatId: string, tabId: string) => Promise<void>;
  nudgePanelWidth: (delta: number, workspaceWidth: number) => void;
  markRead: (key: string, marker: number) => void;
  /** 手动标为未读：已读记号退回一格 */
  markUnread: (chatId: string) => void;
  send: (
    chatId: string,
    text: string,
    images: AttachedImage[],
    refs?: { files?: string[]; chats?: string[]; skill?: string }
  ) => Promise<BotSendResult>;
  stop: (chatId: string) => Promise<void>;
  /** 私聊回退 / 重试（Main 校验并收尾委派与记忆水位）；回退草稿经 rewind-done 回填输入框 */
  rewind: (chatId: string, entryId: string, restoreFiles: boolean) => Promise<BotActionResult>;
  retry: (chatId: string) => Promise<BotActionResult>;
  /** 打开与成员的私聊；没有就建一个 */
  openDirect: (botId: string) => Promise<string | null>;
  upsertChat: (chat: BotChat) => void;
  upsertBot: (bot: BotProfile) => void;
  setSearchOpen: (open: boolean) => void;
  /** 打开命中所在聊天并请求滚动定位、短暂高亮 */
  focusHit: (hit: BotSearchHit, query: string) => void;
  clearFocus: (nonce: number) => void;
}

export const useBotsStore = create<BotsState>()((set, get) => {
  const historyInFlight = new Set<string>();
  /** Bot 事件常成串到达：同一刷新约 50ms 内合并为一次 */
  const coalesce = createCoalescer(50);
  const seeding = new Map<string, Promise<void>>();
  /** 本窗口发起、尚未收到 rewind-done 草稿的回退：conversationId → chatId */
  const rewinds = new Map<string, string>();
  /** 整体替换群时间线（跳转 / 回到最新 / 退出历史窗口）时递增，丢弃按旧列表发出的请求结果 */
  const timelineEpochs = new Map<string, number>();
  const epochOf = (chatId: string) => timelineEpochs.get(chatId) ?? 0;
  const bumpEpoch = (chatId: string) => timelineEpochs.set(chatId, epochOf(chatId) + 1);
  let storedReads = loadReads();
  let bindings = 0;
  let unbind: (() => void) | null = null;

  const saveReads = (reads: Record<string, number>) => {
    storedReads = reads;
    localStorage.setItem(READS_KEY, JSON.stringify(reads));
  };

  const patchSession = (
    id: string,
    update: (state: BotSessions[string]) => BotSessions[string]
  ) => {
    set((state) => {
      const current = state.sessions[id];
      if (!current) return state;
      const next = update(current);
      return next === current ? state : { sessions: { ...state.sessions, [id]: next } };
    });
  };

  const patchTimeline = (chatId: string, next: Partial<TimelineState>) =>
    set((state) => {
      const timeline = state.timelines[chatId];
      return timeline
        ? { timelines: { ...state.timelines, [chatId]: { ...timeline, ...next } } }
        : state;
    });

  const replaceTimeline = (chatId: string, timeline: TimelineState) =>
    set((state) => ({ timelines: { ...state.timelines, [chatId]: timeline } }));

  const trackChats = (chats: BotChat[]): Promise<unknown> => {
    const loads: Promise<void>[] = [];
    for (const chat of chats) {
      if (chat.archivedAt !== undefined) continue;
      for (const session of Object.values(chat.sessions)) {
        loads.push(get().trackSession(session.conversationId));
      }
    }
    return Promise.all(loads);
  };

  const names = () => Object.fromEntries(get().bots.map((bot) => [bot.id, bot.name]));

  /** 首次使用：把当前活动全部记为已读 */
  const seedReads = () => {
    const { chats, sessions, timelines, queue } = get();
    const markers: Record<string, number> = {};
    for (const chat of chats) {
      const summary = chatSummary(chat, {
        sessions,
        timeline: timelines[chat.id],
        queue,
        names: names(),
      });
      markers[summary.key] = summary.marker;
    }
    const reads = seedReadMarks(storedReads, markers);
    if (reads !== storedReads) saveReads(reads);
    set({ reads });
  };

  const onBotEvent = (event: BotEvent) => {
    switch (event.kind) {
      case 'catalog':
        void get().refreshCatalog();
        void get().refreshUsage();
        break;
      case 'chat':
      case 'queue':
      case 'silence':
        void get().refreshChats();
        if (event.chatId && event.kind !== 'silence') void get().refreshRuntime(event.chatId);
        break;
      case 'routine':
        void get().refreshChats();
        void get().refreshRoutines();
        break;
      case 'timeline':
        // 已拉到该 seq 的推送是过期提示，不再请求
        if (
          event.chatId &&
          !(event.seq !== undefined && event.seq <= (get().timelines[event.chatId]?.lastSeq ?? -1))
        )
          void get().loadLatest(event.chatId);
        break;
      case 'delegation':
        void get().refreshDelegations();
        if (event.chatId) void get().loadLatest(event.chatId);
        break;
      case 'tasks':
        if (event.chatId && get().tasks[event.chatId]) void get().refreshTasks(event.chatId);
        break;
      case 'reminder':
        // Main 已取消搁置；提醒到点的聊天标为未读
        void get()
          .refreshChats()
          .then(() => event.chatId && get().markUnread(event.chatId));
        break;
      case 'budget':
        void get().refreshUsage();
        break;
      case 'inbox':
        void get().refreshInbox();
        break;
    }
  };

  /** 旧版 localStorage 里的忽略记录交给 Main 收件箱，只做一次 */
  const migrateDismissed = async () => {
    const keys = [
      ...loadDismissed(LEGACY_DISMISSED_KEY).map((id) => `delegation-interrupted:${id}`),
      ...loadDismissed(LEGACY_DISMISSED_BUDGETS_KEY).map((key) => `budget:${key}`),
    ];
    if (localStorage.getItem(LEGACY_DISMISSED_KEY) === null && keys.length === 0) return;
    const active = new Set(get().inbox.map((item) => item.key));
    await Promise.all(
      keys
        .filter((key) => active.has(key))
        .map((key) => window.electronAPI.bots.inbox.update({ key, action: 'dismiss' }))
    ).catch(() => {});
    localStorage.removeItem(LEGACY_DISMISSED_KEY);
    localStorage.removeItem(LEGACY_DISMISSED_BUDGETS_KEY);
  };

  const putChatTabs = (chatId: string, next: ChatBrowserTabs | undefined) => {
    const { [chatId]: _old, ...rest } = get().browserTabs;
    const browserTabs = next ? { ...rest, [chatId]: next } : rest;
    localStorage.setItem(BROWSER_TABS_KEY, JSON.stringify(browserTabs));
    set({ browserTabs });
  };
  const dropChatTab = (chatId: string, current: ChatBrowserTabs, tabId: string) => {
    const next = closeChatTab(current, tabId);
    if (next === current) return;
    const { [tabId]: _title, ...browserTitles } = get().browserTitles;
    const { [tabId]: _holder, ...browserHolders } = get().browserHolders;
    set({ browserTitles, browserHolders });
    putChatTabs(chatId, next);
    const { view, panelTab } = get();
    if (!next && panelTab === 'browser' && view?.kind === 'chat' && view.chatId === chatId)
      get().setPanelTab('info');
  };

  const subscribe = () => {
    let active = true;
    const offBot = window.electronAPI.bots.onEvent(onBotEvent);
    // 成员用浏览器工具开/切标签时：记下并激活，正看着这个聊天就把右侧面板切到浏览器
    const offReveal = window.electronAPI.browser.onReveal((event) => {
      const chatId = botBrowserChatId(event.conversationId);
      if (!chatId || !event.tabId) return;
      putChatTabs(chatId, revealChatTab(get().browserTabs[chatId], event.tabId));
      const { view } = get();
      if (view?.kind !== 'chat' || view.chatId !== chatId) return;
      if (!get().panelOpen) get().togglePanel();
      get().setPanelTab('browser');
    });
    const offClosed = window.electronAPI.browser.onTabClosed((event) => {
      const chatId = botBrowserChatId(event.conversationId);
      const current = chatId ? get().browserTabs[chatId] : undefined;
      if (chatId && current) dropChatTab(chatId, current, event.tabId);
    });
    const offState = window.electronAPI.browser.onState(({ conversationId, tabId, state }) => {
      if (!tabId || state.tabId !== tabId || !botBrowserChatId(conversationId)) return;
      if (state.title.trim()) get().setBrowserTitle(tabId, state.title.trim());
      const { [tabId]: held, ...rest } = get().browserHolders;
      const next = state.holder;
      if (held?.conversationId === next?.conversationId && held?.name === next?.name) return;
      set({ browserHolders: next ? { ...rest, [tabId]: next } : rest });
    });
    const offAgent = window.electronAPI.agent.onEvent((event) => {
      const { sessions } = get();
      const result = applyBotAgentEvent(sessions, event);
      if (result.sessions !== sessions) set({ sessions: result.sessions });
      for (const id of result.resync) void window.electronAPI.agent.requestSnapshot(id);
      if (event.type === 'rewind-done' && event.filesRestored === undefined) {
        const chatId = rewinds.get(event.identity.sessionId);
        rewinds.delete(event.identity.sessionId);
        if (chatId && event.editorText) seedBotDraft(chatId, draftFromSentText(event.editorText));
      }
    });
    // 解绑期间（关闭 Bot 模式）seeding 保留已完成的加载；重绑时缓存必须重新向权威源补齐。
    for (const [id, cached] of Object.entries(get().sessions)) {
      void window.electronAPI.agent.requestSnapshot(id);
      void window.electronAPI.bots
        .sessionHistory({ conversationId: id })
        .then((result) => {
          if (!active || !result.ok) return;
          // 热会话的快照/事件优先；已冷回收的会话没有快照，用 jsonl 并清掉旧代运行状态。
          patchSession(id, (current) =>
            current === cached ? seedHistory(emptyProjection, result) : current
          );
        })
        .catch(() => {});
    }
    void (async () => {
      await Promise.all([
        get().refreshCatalog(),
        get().refreshChats(),
        get().refreshDelegations(),
        get().refreshUsage(),
        get().refreshRoutines(),
        get().refreshInbox(),
      ]);
      void migrateDismissed();
      const groups = get().chats.filter((chat) => chat.kind === 'group');
      await Promise.all([
        ...groups.map((chat) => get().loadLatest(chat.id)),
        trackChats(get().chats),
      ]);
      if (storedReads === null) seedReads();
      set({ loaded: true });
    })();
    return () => {
      active = false;
      offBot();
      offAgent();
      offReveal();
      offClosed();
      offState();
    };
  };

  return {
    enabled: false,
    loaded: false,
    bots: [],
    chats: [],
    queue: [],
    silences: [],
    delegations: [],
    inbox: [],
    usage: null,
    routines: [],
    timelines: {},
    runtime: {},
    tasks: {},
    sessions: {},
    sessionHistoryLoading: {},
    reads: storedReads ?? {},
    view: loadView(),
    panelOpen: localStorage.getItem(PANEL_KEY) !== '0',
    panelWidth: Number(localStorage.getItem(PANEL_WIDTH_KEY)) || SIDE_PANEL_DEFAULT_WIDTH,
    panelTab: localStorage.getItem(PANEL_TAB_KEY) === 'browser' ? 'browser' : 'info',
    browserTabs: loadBrowserTabs(),
    browserTitles: {},
    browserHolders: {},
    searchOpen: false,
    focus: null,

    bind: () => {
      bindings += 1;
      if (!unbind) unbind = subscribe();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        bindings -= 1;
        if (bindings === 0) {
          unbind?.();
          unbind = null;
        }
      };
    },

    refreshCatalog: async () => {
      const result = await window.electronAPI.bots.list();
      if (result.ok) set({ bots: result.bots, enabled: result.enabled });
    },

    refreshChats: () =>
      coalesce('chats', async () => {
        const result = await window.electronAPI.bots.chats();
        if (!result.ok) return;
        set({
          chats: result.chats,
          queue: result.queue,
          silences: result.silences ?? [],
          enabled: result.enabled,
        });
        void trackChats(result.chats);
        for (const chat of result.chats) {
          if (chat.kind === 'group' && !get().runtime[chat.id]) void get().refreshRuntime(chat.id);
        }
      }),

    refreshDelegations: () =>
      coalesce('delegations', async () => {
        const result = await window.electronAPI.bots.delegations();
        if (!result?.ok) return;
        set({ delegations: result.delegations });
        for (const item of result.delegations) {
          if (
            item.chatId &&
            isActiveDelegation(item.state) &&
            !get().sessions[item.childConversationId]
          )
            void get().trackSession(item.childConversationId);
        }
      }),

    refreshTasks: async (chatId) => {
      const result = await window.electronAPI.bots.tasks.list(chatId).catch(() => null);
      if (!result?.ok) return;
      set((state) => ({ tasks: { ...state.tasks, [chatId]: result.tasks } }));
    },

    refreshInbox: () =>
      coalesce('inbox', async () => {
        const result = await window.electronAPI.bots.inbox.list();
        if (result.ok) set({ inbox: result.items });
      }),

    dismissInbox: async (key) => {
      // 先本地隐藏，Main 的 inbox 事件随后以权威列表覆盖
      set((state) => ({
        inbox: state.inbox.map((item) =>
          item.key === key ? { ...item, dismissedAt: Date.now() } : item
        ),
      }));
      await window.electronAPI.bots.inbox.update({ key, action: 'dismiss' }).catch(() => null);
      await get().refreshInbox();
    },

    refreshUsage: () =>
      coalesce('usage', async () => {
        try {
          const result = await window.electronAPI.bots.usage();
          if (result.ok) set({ usage: { day: result.day, bots: result.bots } });
        } catch {
          // 用量概览只影响收件箱提示与资料面板，失败不阻断其余加载
        }
      }),

    refreshRoutines: () =>
      coalesce('routines', async () => {
        try {
          const result = await window.electronAPI.bots.routines.list();
          if (result.ok) set({ routines: result.routines });
        } catch {
          // 只影响收件箱提示与提议卡片
        }
      }),

    loadLatest: (chatId) =>
      coalesce(`timeline:${chatId}`, async () => {
        const known = get().timelines[chatId];
        const windowed = Boolean(known?.history);
        const epoch = epochOf(chatId);
        // 历史窗口只取最新一条（记 lastSeq 与预览）；否则只拉 lastSeq 之后的增量，
        // 缺口过大时 Main 退回最新一页，由 mergeLatest 按空洞替换
        const result = await window.electronAPI.bots.timeline(
          windowed
            ? { chatId, limit: 1 }
            : { chatId, ...(known ? { afterSeq: known.lastSeq } : {}), limit: TIMELINE_PAGE }
        );
        if (!result.ok) return;
        if (epochOf(chatId) !== epoch || Boolean(get().timelines[chatId]?.history) !== windowed) {
          // 请求期间列表被整体替换或切换了模式：结果按旧列表取的，重拉一次
          void get().loadLatest(chatId);
          return;
        }
        set((state) => {
          const current = state.timelines[chatId];
          if (current?.history) {
            const tail = result.entries.at(-1) ?? current.history.tail;
            return {
              timelines: {
                ...state.timelines,
                [chatId]: {
                  ...current,
                  lastSeq: result.lastSeq,
                  history: { ...current.history, tail },
                },
              },
            };
          }
          const merged = mergeLatest(current?.entries ?? [], result.entries);
          const hasOlder =
            current && !merged.gap ? current.hasOlder : result.entries.length >= TIMELINE_PAGE;
          return {
            timelines: {
              ...state.timelines,
              [chatId]: {
                entries: merged.entries,
                lastSeq: result.lastSeq,
                hasOlder,
                loading: current?.loading ?? false,
              },
            },
          };
        });
      }),

    loadOlder: async (chatId) => {
      const current = get().timelines[chatId];
      const first = current?.entries[0];
      if (!current || !first || !current.hasOlder || current.loading) return;
      patchTimeline(chatId, { loading: true });
      try {
        const result = await window.electronAPI.bots.timeline({
          chatId,
          beforeSeq: first.seq,
          limit: TIMELINE_PAGE,
        });
        if (!result.ok) return;
        const latest = get().timelines[chatId];
        if (latest?.entries[0]?.seq !== first.seq) return;
        // 超过渲染上限裁掉底部；最新视图被裁后进入历史窗口
        const merged = trimTimeline(
          mergeOlder(latest.entries, result.entries),
          TIMELINE_MAX,
          'end'
        );
        patchTimeline(chatId, {
          entries: merged.entries,
          hasOlder: result.entries.length >= TIMELINE_PAGE,
          ...(merged.trimmed && !latest.history
            ? { history: { sinceSeq: latest.lastSeq, tail: latest.entries.at(-1) } }
            : {}),
        });
      } finally {
        patchTimeline(chatId, { loading: false });
      }
    },

    loadNewer: async (chatId) => {
      const current = get().timelines[chatId];
      const last = current?.entries.at(-1);
      if (!current?.history || !last || current.loadingNewer) return;
      patchTimeline(chatId, { loadingNewer: true });
      try {
        // seq 连续：取 (last, last + PAGE] 这一页
        const result = await window.electronAPI.bots.timeline({
          chatId,
          beforeSeq: last.seq + TIMELINE_PAGE + 1,
          limit: TIMELINE_PAGE,
        });
        if (!result.ok) return;
        const latest = get().timelines[chatId];
        if (!latest?.history || latest.entries.at(-1)?.seq !== last.seq) return;
        const merged = mergeNewer(latest.entries, result.entries);
        const caughtUp = (merged.at(-1)?.seq ?? 0) >= result.lastSeq;
        if (!caughtUp && merged === latest.entries) {
          // 缺行导致这一页翻不过去：直接回到最新
          void get().jumpLatest(chatId);
          return;
        }
        const trimmed = trimTimeline(merged, TIMELINE_MAX, 'start');
        if (caughtUp) bumpEpoch(chatId);
        patchTimeline(chatId, {
          entries: trimmed.entries,
          lastSeq: result.lastSeq,
          hasOlder: latest.hasOlder || trimmed.trimmed,
          history: caughtUp ? undefined : latest.history,
        });
      } finally {
        patchTimeline(chatId, { loadingNewer: false });
      }
    },

    loadAround: async (chatId, seq) => {
      bumpEpoch(chatId);
      const epoch = epochOf(chatId);
      const limit = TIMELINE_AROUND * 2 + 1;
      const result = await window.electronAPI.bots.timeline({
        chatId,
        beforeSeq: seq + TIMELINE_AROUND + 1,
        limit,
      });
      if (!result.ok || epochOf(chatId) !== epoch) return;
      const current = get().timelines[chatId];
      const tail = current?.history ? current.history.tail : current?.entries.at(-1);
      const caughtUp = (result.entries.at(-1)?.seq ?? 0) >= result.lastSeq;
      replaceTimeline(chatId, {
        entries: result.entries,
        lastSeq: result.lastSeq,
        hasOlder: result.entries.length >= limit,
        loading: false,
        ...(caughtUp
          ? {}
          : { history: { sinceSeq: current?.history?.sinceSeq ?? result.lastSeq, tail } }),
      });
      if (!caughtUp && (tail?.seq ?? 0) < result.lastSeq) void get().loadLatest(chatId);
    },

    jumpLatest: async (chatId) => {
      bumpEpoch(chatId);
      const epoch = epochOf(chatId);
      const result = await window.electronAPI.bots.timeline({ chatId, limit: TIMELINE_PAGE });
      if (!result.ok || epochOf(chatId) !== epoch) return;
      replaceTimeline(chatId, {
        entries: result.entries,
        lastSeq: result.lastSeq,
        hasOlder: result.entries.length >= TIMELINE_PAGE,
        loading: false,
      });
    },

    refreshRuntime: (chatId) =>
      coalesce(`runtime:${chatId}`, async () => {
        const chat = get().chats.find((item) => item.id === chatId);
        if (chat && chat.kind !== 'group') return;
        const result = await window.electronAPI.bots.chatState?.(chatId);
        if (!result?.ok) return;
        const { ok: _ok, ...runtime } = result;
        set((state) => ({ runtime: { ...state.runtime, [chatId]: runtime } }));
      }),

    trackSession: (conversationId) => {
      const existing = seeding.get(conversationId);
      if (existing) return existing;
      set((state) => ({
        sessions: { ...state.sessions, [conversationId]: { ...emptyProjection } },
      }));
      void window.electronAPI.agent.requestSnapshot(conversationId);
      const load = window.electronAPI.bots
        .sessionHistory({ conversationId })
        .then((result) => {
          if (!result.ok) return;
          patchSession(conversationId, (state) => seedHistory(state, result));
        })
        .catch(() => {});
      seeding.set(conversationId, load);
      return load;
    },

    loadOlderSession: async (conversationId) => {
      const session = get().sessions[conversationId];
      const beforeIndex = session?.historyBaseIndex;
      if (!session || !beforeIndex || beforeIndex <= 0 || historyInFlight.has(conversationId))
        return;
      historyInFlight.add(conversationId);
      set((state) => ({
        sessionHistoryLoading: { ...state.sessionHistoryLoading, [conversationId]: true },
      }));
      try {
        const result = await window.electronAPI.bots.sessionHistory({
          conversationId,
          beforeIndex,
        });
        if (!result.ok) return;
        patchSession(conversationId, (state) =>
          state.historyBaseIndex === beforeIndex
            ? applyHistoryPage(state, { baseIndex: result.baseIndex, messages: result.messages })
            : state
        );
      } finally {
        historyInFlight.delete(conversationId);
        set((state) => ({
          sessionHistoryLoading: { ...state.sessionHistoryLoading, [conversationId]: false },
        }));
      }
    },

    setView: (view) => {
      if (view?.kind === 'chat') localStorage.setItem(VIEW_KEY, view.chatId);
      else if (view?.kind === 'inbox') localStorage.setItem(VIEW_KEY, 'inbox');
      else localStorage.removeItem(VIEW_KEY);
      set({ view });
    },

    togglePanel: () => {
      const panelOpen = !get().panelOpen;
      localStorage.setItem(PANEL_KEY, panelOpen ? '1' : '0');
      set({ panelOpen });
    },

    setPanelTab: (panelTab) => {
      localStorage.setItem(PANEL_TAB_KEY, panelTab);
      set({ panelTab });
    },

    setBrowserTitle: (tabId, title) => {
      if (get().browserTitles[tabId] === title) return;
      set({ browserTitles: { ...get().browserTitles, [tabId]: title } });
    },

    openBrowserTab: (chatId) => {
      putChatTabs(
        chatId,
        revealChatTab(get().browserTabs[chatId], `browser:${crypto.randomUUID()}`)
      );
      get().setPanelTab('browser');
    },

    selectBrowserTab: (chatId, tabId) => {
      const current = get().browserTabs[chatId];
      if (current?.tabs.includes(tabId)) putChatTabs(chatId, { ...current, active: tabId });
      get().setPanelTab('browser');
    },

    closeBrowserTab: async (chatId, tabId) => {
      const current = get().browserTabs[chatId];
      // 先卸掉视图再关，避免关闭途中视图按 tabId 又把页面建回来
      if (current) dropChatTab(chatId, current, tabId);
      await window.electronAPI.browser.closeTab(tabId);
    },

    nudgePanelWidth: (delta, workspaceWidth) => {
      const panelWidth = resizeSidePanelWidth(get().panelWidth, delta, workspaceWidth);
      localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth));
      set({ panelWidth });
    },

    markRead: (key, marker) => {
      const reads = get().reads;
      if (reads[key] === marker) return;
      const next = { ...reads, [key]: marker };
      saveReads(next);
      set({ reads: next });
    },

    markUnread: (chatId) => {
      const { chats, sessions, timelines, queue } = get();
      const chat = chats.find((item) => item.id === chatId);
      if (!chat) return;
      const summary = chatSummary(chat, {
        sessions,
        timeline: timelines[chat.id],
        queue,
        names: names(),
      });
      const mark = unreadMark(summary.marker);
      if (mark === undefined) return;
      const next = { ...get().reads, [summary.key]: mark };
      saveReads(next);
      set({ reads: next });
    },

    send: async (chatId, text, images, refs = {}) => {
      const result = await window.electronAPI.bots.send({
        chatId,
        text,
        ...(images.length > 0 ? { images } : {}),
        ...(refs.files?.length ? { files: refs.files } : {}),
        ...(refs.chats?.length ? { chats: refs.chats } : {}),
        ...(refs.skill ? { skill: refs.skill } : {}),
        deliveryId: crypto.randomUUID(),
      });
      if (result.ok && result.conversationId) {
        const id = result.conversationId;
        if (get().sessions[id]) void window.electronAPI.agent.requestSnapshot(id);
        else void get().trackSession(id);
      }
      return result;
    },

    stop: async (chatId) => {
      const chat = get().chats.find((item) => item.id === chatId);
      if (!chat) return;
      if (chat.kind === 'group') {
        await window.electronAPI.bots.stopChat?.(chatId);
        return;
      }
      const conversationId = chat.sessions[chat.members[0]]?.conversationId;
      if (conversationId) await window.electronAPI.agent.abort(conversationId);
    },

    rewind: async (chatId, entryId, restoreFiles) => {
      const chat = get().chats.find((item) => item.id === chatId);
      const conversationId = chat?.sessions[chat.members[0]]?.conversationId;
      if (conversationId) rewinds.set(conversationId, chatId);
      const result = await window.electronAPI.bots
        .rewind({ chatId, entryId, restoreFiles })
        .catch((error: unknown) => ({ ok: false as const, error: String(error) }));
      if (!result.ok && conversationId) rewinds.delete(conversationId);
      return result;
    },

    retry: (chatId) =>
      window.electronAPI.bots
        .retry(chatId)
        .catch((error: unknown) => ({ ok: false as const, error: String(error) })),

    openDirect: async (botId) => {
      const existing = get().chats.find(
        (chat) =>
          chat.kind === 'direct' && chat.members[0] === botId && chat.archivedAt === undefined
      );
      if (existing) {
        get().setView({ kind: 'chat', chatId: existing.id });
        return existing.id;
      }
      const result = await window.electronAPI.bots.createChat({
        kind: 'direct',
        members: [botId],
        workspace: { kind: 'member-home' },
      });
      if (!result.ok) return null;
      get().upsertChat(result.chat);
      if (result.chat.archivedAt !== undefined) {
        const restored = await window.electronAPI.bots.updateChat({
          chatId: result.chat.id,
          archived: false,
        });
        if (restored.ok) get().upsertChat(restored.chat);
      }
      get().setView({ kind: 'chat', chatId: result.chat.id });
      return result.chat.id;
    },

    upsertChat: (chat) => {
      set((state) => {
        const index = state.chats.findIndex((item) => item.id === chat.id);
        const chats = index === -1 ? [...state.chats, chat] : state.chats.toSpliced(index, 1, chat);
        return { chats };
      });
      void trackChats([chat]);
    },

    upsertBot: (bot) => {
      set((state) => {
        const index = state.bots.findIndex((item) => item.id === bot.id);
        return { bots: index === -1 ? [...state.bots, bot] : state.bots.toSpliced(index, 1, bot) };
      });
    },

    setSearchOpen: (searchOpen) => set({ searchOpen }),

    focusHit: (hit, query) => {
      get().setView({ kind: 'chat', chatId: hit.chatId });
      set({
        searchOpen: false,
        focus: { chatId: hit.chatId, locator: hit.locator, query, nonce: Date.now() },
      });
    },

    clearFocus: (nonce) => {
      if (get().focus?.nonce === nonce) set({ focus: null });
    },
  };
});

/** Bot 待处理数：收件箱入口与标题栏徽标共用 */
export const useBotPendingCount = (): number =>
  useBotsStore((s) => visibleInbox(s.inbox).length) + usePendingMemoryWrites().length;
