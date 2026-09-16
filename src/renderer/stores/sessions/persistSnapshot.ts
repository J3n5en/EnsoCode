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
    titleSummaryPending: undefined,
    titleSummaryError: undefined,
    lastTurnDigest: undefined,
  };
}

let cached: { fingerprint: string; value: SessionsPersistSlice } | null = null;

export function cachedPartializeSessions(state: SessionsPersistSlice): SessionsPersistSlice {
  const keep = (id: string): boolean =>
    Boolean(state.conversations[id]) && !state.conversations[id]?.btwParentId;
  const value: SessionsPersistSlice = {
    conversations: Object.fromEntries(
      Object.entries(state.conversations)
        .filter(([, conversation]) => !conversation.btwParentId)
        .map(([id, conversation]) => [id, persistOne(conversation)])
    ),
    order: state.order.filter(keep),
    activeId:
      state.activeId && keep(state.activeId) ? state.activeId : (state.order.find(keep) ?? null),
  };
  const fingerprint = JSON.stringify(value);
  if (cached?.fingerprint === fingerprint) return cached.value;
  cached = { fingerprint, value };
  return value;
}
