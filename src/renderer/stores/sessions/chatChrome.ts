import { conversationHasRunningChild } from '@shared/conversationDotTone';
import type { Conversation } from './index';
import { chatSurfaceBusy } from './messageCache';

export interface ChatChrome {
  id: string;
  parentId: string;
  projectId: string;
  parentProjectId: string;
  status: Conversation['status'];
  spawning: boolean;
  started: boolean;
  sessionFile?: string;
  parentStarted: boolean;
  parentStatus: Conversation['status'];
  parentSessionFile?: string;
  parentWorktreeMissing?: boolean;
  parentWorktreePath?: string;
  parentWorktreeBranch?: string;
  lastProviderId?: string;
  lastModelId?: string;
  parentLastProviderId?: string;
  parentLastModelId?: string;
  reasoningEnabled?: boolean;
  thinkingLevel: Conversation['thinkingLevel'];
  presetId?: string;
  approvalMode: Conversation['approvalMode'];
  autoRejectApprovals: Conversation['autoRejectApprovals'];
  draftText?: Conversation['draftText'];
  draftImages?: Conversation['draftImages'];
  draftAppend?: Conversation['draftAppend'];
  prefillAgentTypeKey?: Conversation['prefillAgentTypeKey'];
  commands: Conversation['commands'];
  compactionError?: string;
  agentType?: Conversation['agentType'];
  parentHasRunningChild: boolean;
  retry: Conversation['retry'];
  pendingApprovals: Conversation['pendingApprovals'];
  pendingAsks: Conversation['pendingAsks'];
  pendingCapabilityAsks: Conversation['pendingCapabilityAsks'];
  backgroundTasks: Conversation['backgroundTasks'];
  subagents: Conversation['subagents'];
  queuedMessages: Conversation['queuedMessages'];
  goal: Conversation['goal'];
  planState: Conversation['planState'];
  rewinding?: boolean;
  restoringFiles?: boolean;
  childLockedProfileId?: string;
  activeOauthAsk: Conversation['activeOauthAsk'];
  displayedParentId?: string;
  busy: boolean;
}

/**
 * 无选中会话时的展示分支：
 * - 'hydrating'：useSessionsStore 尚未完成持久化水合，不闪现空会话提示且挂 data-timeline-loading；
 * - 'empty'：水合已完成且确实无选中会话，显示引导占位；
 * - null：已有选中会话。
 */
export function selectEmptyChatState(
  chrome: ChatChrome | null,
  sessionsHydrated: boolean
): 'hydrating' | 'empty' | null {
  if (chrome) return null;
  return sessionsHydrated ? 'empty' : 'hydrating';
}

type SessionsSlice = {
  activeId: string | null;
  conversations: Record<string, Conversation | undefined>;
};

export function displayedConversationId(state: SessionsSlice): string | null {
  const active = state.activeId ? state.conversations[state.activeId] : undefined;
  if (!active) return null;
  if (!active.activeTabId) return active.id;
  return state.conversations[active.activeTabId]?.id ?? active.id;
}

/** 聊天框/工具条用的会话切片：不含 messages，思考流式时字段引用保持稳定。 */
export function selectChatChrome(state: SessionsSlice): ChatChrome | null {
  const parent = state.activeId ? state.conversations[state.activeId] : undefined;
  if (!parent) return null;
  const displayed = parent.activeTabId
    ? (state.conversations[parent.activeTabId] ?? parent)
    : parent;
  return {
    id: displayed.id,
    parentId: parent.id,
    projectId: displayed.projectId,
    parentProjectId: parent.projectId,
    status: displayed.status,
    spawning: displayed.spawning,
    started: displayed.started,
    sessionFile: displayed.sessionFile,
    parentStarted: parent.started,
    parentStatus: parent.status,
    parentSessionFile: parent.sessionFile,
    parentWorktreeMissing: parent.worktreeMissing,
    parentWorktreePath: parent.worktree?.path,
    parentWorktreeBranch: parent.worktree?.branch,
    lastProviderId: displayed.lastProviderId,
    lastModelId: displayed.lastModelId,
    parentLastProviderId: parent.lastProviderId,
    parentLastModelId: parent.lastModelId,
    reasoningEnabled: displayed.reasoningEnabled,
    thinkingLevel: displayed.thinkingLevel,
    presetId: displayed.presetId,
    approvalMode: displayed.approvalMode,
    autoRejectApprovals: displayed.autoRejectApprovals,
    draftText: displayed.draftText,
    draftImages: displayed.draftImages,
    draftAppend: displayed.draftAppend,
    prefillAgentTypeKey: displayed.prefillAgentTypeKey,
    commands: displayed.commands,
    compactionError: displayed.compactionError,
    agentType: displayed.agentType,
    parentHasRunningChild: conversationHasRunningChild(parent, state.conversations),
    retry: displayed.retry,
    pendingApprovals: displayed.pendingApprovals,
    pendingAsks: displayed.pendingAsks,
    pendingCapabilityAsks: displayed.pendingCapabilityAsks,
    backgroundTasks: displayed.backgroundTasks,
    subagents: displayed.subagents,
    queuedMessages: displayed.queuedMessages,
    goal: displayed.goal,
    planState: displayed.planState,
    rewinding: displayed.rewinding,
    restoringFiles: displayed.restoringFiles,
    childLockedProfileId: displayed.child?.lockedProfileId,
    activeOauthAsk: displayed.activeOauthAsk,
    displayedParentId: displayed.parentId,
    busy: chatSurfaceBusy(displayed),
  };
}
