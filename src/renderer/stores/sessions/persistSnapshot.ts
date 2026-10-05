import type { Conversation } from './index';

type PersistableConversation = {
  messages: { timestamp?: number }[];
  lastActiveAt?: number;
  createdAt: number;
  started: boolean;
  sessionFile?: string;
} & Partial<Record<keyof Conversation, unknown>>;

export interface SessionsPersistSlice {
  conversations: Record<string, PersistableConversation>;
  order: string[];
  activeId: string | null;
}

function persistOne(conversation: PersistableConversation): PersistableConversation {
  const {
    messages: _messages,
    requestBody: _requestBody,
    historyBaseIndex: _historyBaseIndex,
    commands: _commands,
    customEntries: _customEntries,
    dispatchMainEvents: _dispatchMainEvents,
    generation: _generation,
    lastSeq: _lastSeq,
    spawning: _spawning,
    error: _error,
    started: _started,
    status: _status,
    runStartedAt: _runStartedAt,
    lastOutputAt: _lastOutputAt,
    toolOutputs: _toolOutputs,
    toolStartedAt: _toolStartedAt,
    toolDeadlineAt: _toolDeadlineAt,
    pendingApprovals: _pendingApprovals,
    pendingAsks: _pendingAsks,
    pendingCapabilityAsks: _pendingCapabilityAsks,
    activeOauthAsk: _activeOauthAsk,
    historyOnly: _historyOnly,
    historyLoadAttempted: _historyLoadAttempted,
    historyLoading: _historyLoading,
    reloading: _reloading,
    backgroundTasks: _backgroundTasks,
    subagents: _subagents,
    activeTabId: _activeTabId,
    draftText: _draftText,
    prefillAgentTypeKey: _prefillAgentTypeKey,
    worktreeMissing: _worktreeMissing,
    workspaceMigrating: _workspaceMigrating,
    abortRequested: _abortRequested,
    compaction: _compaction,
    compactionError: _compactionError,
    rewinding: _rewinding,
    restoringFiles: _restoringFiles,
    // 标题总结的运行态：在飞 Map 随重启作废，失败与摘要都不值得跨重启保留
    titleSummaryPending: _titleSummaryPending,
    titleSummaryError: _titleSummaryError,
    lastTurnDigest: _lastTurnDigest,
    ...kept
  } = conversation;
  return {
    ...kept,
    lastActiveAt:
      conversation.messages.at(-1)?.timestamp ??
      conversation.lastActiveAt ??
      conversation.createdAt,
    messages: [],
    historyBaseIndex: undefined,
    commands: [],
    customEntries: [],
    dispatchMainEvents: {},
    generation: undefined,
    lastSeq: 0,
    spawning: false,
    error: undefined,
    ...(conversation.started && !conversation.sessionFile
      ? { status: 'failed', error: 'Session ended — history not restored' }
      : { status: 'idle' }),
    started: false,
    runStartedAt: undefined,
    lastOutputAt: undefined,
    toolOutputs: {},
    toolStartedAt: {},
    toolDeadlineAt: {},
    pendingApprovals: [],
    pendingAsks: [],
    pendingCapabilityAsks: [],
    activeOauthAsk: undefined,
    historyOnly: undefined,
    historyLoadAttempted: undefined,
    historyLoading: undefined,
    reloading: undefined,
    backgroundTasks: [],
    subagents: [],
    activeTabId: undefined,
    draftText: undefined,
    prefillAgentTypeKey: undefined,
    worktreeMissing: undefined,
    workspaceMigrating: undefined,
    abortRequested: undefined,
    compaction: undefined,
    compactionError: undefined,
    rewinding: undefined,
    restoringFiles: undefined,
    titleSummaryPending: undefined,
    titleSummaryError: undefined,
    lastTurnDigest: undefined,
  };
}

type PersistedEntry = { value: PersistableConversation; json: string };

// 每次 set 都会 partialize：按会话对象身份缓存，流式时只有活跃会话重算，其余几百个直接复用
const entries = new WeakMap<PersistableConversation, PersistedEntry>();
let cached: {
  entries: Map<string, PersistedEntry>;
  order: string[];
  value: SessionsPersistSlice;
} | null = null;

function entryOf(conversation: PersistableConversation): PersistedEntry {
  let entry = entries.get(conversation);
  if (!entry) {
    const value = persistOne(conversation);
    entry = { value, json: JSON.stringify(value) };
    entries.set(conversation, entry);
  }
  return entry;
}

export function cachedPartializeSessions(state: SessionsPersistSlice): SessionsPersistSlice {
  const keep = (id: string): boolean =>
    Boolean(state.conversations[id]) && !state.conversations[id]?.btwParentId;
  const previous = cached;
  const next = new Map<string, PersistedEntry>();
  let changed = !previous;
  for (const [id, conversation] of Object.entries(state.conversations)) {
    if (conversation.btwParentId) continue;
    let entry = entryOf(conversation);
    const old = previous?.entries.get(id);
    if (old && old !== entry && old.json === entry.json) {
      entry = old;
      entries.set(conversation, old);
    }
    if (old !== entry) changed = true;
    next.set(id, entry);
  }
  const order = state.order.filter(keep);
  const activeId = state.activeId && keep(state.activeId) ? state.activeId : (order[0] ?? null);
  if (
    previous &&
    !changed &&
    previous.entries.size === next.size &&
    previous.value.activeId === activeId &&
    previous.order.length === order.length &&
    previous.order.every((id, index) => order[index] === id)
  ) {
    return previous.value;
  }
  const value: SessionsPersistSlice = {
    conversations: Object.fromEntries([...next].map(([id, entry]) => [id, entry.value])),
    order,
    activeId,
  };
  cached = { entries: next, order, value };
  return value;
}
