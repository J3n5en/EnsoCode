import type { AppLogEntry, LogExportResult, LogSummaryLevel } from '@shared/appLog';
import type { BotTemplateLibrary } from '@shared/bots/templateLibrary';
import type {
  BtwAbortRequest,
  BtwDisposeRequest,
  BtwPromptRequest,
  BtwPromptResult,
  BtwSpawnRequest,
} from '@shared/btw';
import type { AgentTypeRegistrySnapshot } from '@shared/builtinAgents';
import type { CaCertStatus } from '@shared/caCert';
import type { DropShelfDelivery } from '@shared/dropShelf';
import type { ElevationRequestView } from '@shared/elevation';
import type { InterruptedTurn } from '@shared/exitInterrupt';
import type {
  ChatModelDto,
  DistillableSessionDto,
  EmbeddingDownloadProgressDto,
  EmbeddingModelDto,
  MemoryArchiveCandidatesResult,
  MemoryArchiveConfirmResult,
  MemoryDecayRunDto,
  MemoryDeletionImpact,
  MemoryDetail,
  MemoryEditPatch,
  MemoryJobsSnapshot,
  MemoryListQuery,
  MemoryListResult,
  MemoryMutationResult,
  MemoryReconcileRunDto,
  MemoryStats,
  PendingEvolvesReviewDto,
  PendingMemoryWriteDecision,
  PendingMemoryWriteDto,
} from '@shared/memory/dto';
import type {
  CrystallizeRequest,
  CrystallizeResult,
  GraphQuery,
  InsightRequest,
  InsightResult,
  MemoryBriefDto,
  MemoryGraphDto,
  TreeNodeDto,
  TreeQuery,
} from '@shared/memory/graphDto';
import type {
  ImportProjectSessionsMode,
  ImportProjectSessionsPreview,
  ImportProjectSessionsResult,
  RemoveEmptyProjectResult,
} from '@shared/moveConversation';
import type {
  OauthFlowControlRequest,
  OauthFlowEvent,
  OauthFlowPromptResponse,
  StartOauthResult,
  StartOauthWizardRequest,
} from '@shared/oauthFlow';
import type { PastedTextFileResult } from '@shared/pastedText';
import type { PlanRespondAction } from '@shared/planMode';
import type { PresetImportDraft } from '@shared/presetImport';
import type { PrivacyMaskRecord } from '@shared/privacyMask/report';
import type { RemoteApi } from '@shared/remoteBridge';
import type {
  ResourceSnapshot,
  SessionCleanRequest,
  StorageCategoryId,
  StorageCleanResult,
  StorageRootId,
  StorageScanProgress,
  StorageSnapshot,
} from '@shared/resources';
import type { BrowserSearchTab } from '@shared/searchAnything';
import type { FeedEvent } from '@shared/secretary/feed';
import type { SettingsDeepLink } from '@shared/settingsDeepLink';
import type { ShellIntegration } from '@shared/shellIntegration';
import type {
  AssetOccupancyRow,
  CollectedAsset,
  CollectedProvider,
  ConfigSyncCommitOptions,
  ConfigSyncCommitResult,
  ConfigSyncExportOptions,
  ConfigSyncExportResult,
  ConfigSyncOpenResult,
  ConfigSyncPreviewOptions,
  ConfigSyncPreviewResult,
  FilesAbsResult,
  FilesFetchRemoteImageResult,
  FilesListResult,
  FilesMutateResult,
  FilesOpenContextRequest,
  FilesOpenRequest,
  FilesOpenResult,
  FilesReadImageResult,
  FilesReadRelResult,
  FilesResolveLinksRequest,
  FilesResolveLinksResult,
  FilesSearchRequest,
  FilesSearchResult,
  FilesWatchEvent,
  FilesWatchResult,
  FilesWriteResult,
  GitCommitDiffRequest,
  GitCommitFilesResult,
  GitCommitRequest,
  GitCreateCommitRequest,
  GitDiffResult,
  GitDiscardRequest,
  GitFileDiffRequest,
  GitFileDiffResult,
  GitHistoryRequest,
  GitHistoryResult,
  GitOperationResult,
  GitPathsRequest,
  GitRequest,
  GitStatusResult,
  HostDirListing,
  ListModelsResult,
  LocalAssetScanResult,
  LocalProviderScanResult,
  ModelCatalogRefreshResult,
  ModelMetaQuery,
  ModelMetaResult,
  OauthAccountUsage,
  OauthCodexImportResult,
  OauthProviderInfo,
  OpenInApp,
  PairCatalogPayload,
  PairCreatedSession,
  PairQueueAction,
  PairSessionConfig,
  PairStatus,
  ProviderApiConfig,
  RecentProject,
  SshConnection,
  SshHostKeyChallenge,
  TestProviderResult,
} from '@shared/types';
import {
  type AgentActionResult,
  type AgentRunProgress,
  type AgentSpawnRequest,
  type ApprovalDecision,
  type ApprovalMode,
  type AttachedImage,
  type AuthorityMutationResult,
  type ChildHistoryResult,
  type ChildRunListResult,
  type ConversationAuthorityProjection,
  type ConversationAuthorityRequest,
  type ConversationReloadResult,
  type CreateConversationAuthorityRequest,
  type CreateProjectAuthorityRequest,
  type DispatchMainEvent,
  type McpStatusEvent,
  type McpStatusPush,
  type ParentHistoryTailResult,
  type ProjectAuthorityProjection,
  parseDispatchMainEvent,
  type RemoveProjectAuthorityRequest,
  type RendererAgentEvent,
  type SelectProjectAuthorityRequest,
  type SourceAuthorityProjection,
  type ThinkingLevel,
  type TitleSummaryInput,
  type UpdateConversationSelectionRequest,
} from '@shared/types/agent';
import type {
  BotAbilitySuggestRequest,
  BotAbilitySuggestResult,
  BotActionResult,
  BotArtifactOpenAction,
  BotArtifactReadRequest,
  BotArtifactReadResult,
  BotArtifactsResult,
  BotArtifactTarget,
  BotChatCreateInput,
  BotChatSessionsResult,
  BotChatStateResult,
  BotChatsListResult,
  BotChatUpdateInput,
  BotChatWriteResult,
  BotDelegationRetryResult,
  BotDelegationsResult,
  BotDraftInput,
  BotEvent,
  BotFileSearchRequest,
  BotFileSearchResult,
  BotGetResult,
  BotGoalSuggestRequest,
  BotGoalSuggestResult,
  BotInboxListResult,
  BotInboxUpdateInput,
  BotNewSessionResult,
  BotNotesResult,
  BotPersonaSuggestRequest,
  BotPersonaSuggestResult,
  BotRoutineReviewResult,
  BotRoutineRunsResult,
  BotRoutineSaveInput,
  BotRoutineSaveResult,
  BotRoutinesResult,
  BotSearchRequest,
  BotSearchResult,
  BotSendRequest,
  BotSendResult,
  BotsListResult,
  BotTaskSaveInput,
  BotTasksResult,
  BotTaskWriteResult,
  BotTeamCreateRequest,
  BotTeamCreateResult,
  BotTeamPreviewRequest,
  BotTeamPreviewResult,
  BotTemplatesResult,
  BotTimelineResult,
  BotWriteIpcResult,
} from '@shared/types/botIpc';
import type {
  BrowserAnnotationPinSpec,
  BrowserClearKind,
  BrowserDesignModeEvent,
  BrowserDesignMoveDirection,
  BrowserOpenPinResult,
  BrowserPickedElementRef,
  BrowserSelectionDescription,
  BrowserTabState,
  DesignCssSnapshot,
  DesignTopLeftRect,
  DesignXyRect,
} from '@shared/types/browser';
import type {
  DcgActionResult,
  DcgRuleExemption,
  DcgRuleState,
  DcgStatus,
  DcgUpdateCheck,
} from '@shared/types/dcg';
import type { SessionChangeSnapshots } from '@shared/types/fileChanges';
import {
  IPC_CHANNELS,
  type OpenDevToolsResult,
  type RestartBlocker,
  type RestartOverlayState,
} from '@shared/types/ipc';
import type {
  AgentDispatchRequest,
  AgentDispatchResult,
  MainModelSelectionBindingResult,
  ParentModelSelectionRequest,
  ParentSourceBindingRequest,
  ParentSourceBindingResult,
} from '@shared/types/mentions';
import type { NodeActionResult, NodePairResult, NodesStatus } from '@shared/types/nodes';
import type {
  DispatchDraft,
  SecretaryBoard,
  SecretaryContactChannelPrefs,
  SecretaryContactState,
  SecretaryContactTopicsResult,
  SecretaryDaily,
  SecretaryDeletePreview,
  SecretaryDoneReport,
  SecretaryProfile,
  SecretaryProfileDraft,
  SecretaryProposal,
  SecretaryScheduleView,
  SecretarySkillView,
  SecretaryState,
  SecretarySummary,
  SecretaryTakeoverView,
  SecretaryTodoMutate,
  SecretaryToolDraft,
  SecretaryUntrackedView,
} from '@shared/types/secretary';
import type { ExternalSessionSource, SimpleMessage } from '@shared/types/sessionImport';
import type {
  TerminalCreateRequest,
  TerminalCreateResult,
  TerminalDataEvent,
  TerminalExitEvent,
} from '@shared/types/sidePanel';
import type { RestartToUpdateResult, UpdaterState, UpdateStatus } from '@shared/types/updater';
import type {
  WorkflowPresetDraft,
  WorkflowPresetSaveResult,
  WorkflowPresetSummary,
} from '@shared/types/workflow';
import type {
  SessionWorktree,
  WorkspaceBranchesResult,
  WorkspaceBranchSwitchRequest,
  WorkspaceBranchSwitchResult,
  WorktreeStatus,
} from '@shared/types/worktree';
import type { UpdateChannel } from '@shared/updater/channel';
import type { AutoRestartMode } from '@shared/updater/idleRestart';
import type { GoalUpstreamRetry, ProviderHealthSnapshot } from '@shared/upstreamRecovery';
import type { BotUsageOverviewResult, BotUsageSummaryResult } from '@shared/usage/botUsage';
import type { UsageRangeDays, UsageSummaryResult } from '@shared/usage/types';
import type { TitleBarAppearance } from '@shared/windowControls';
import type {
  WorkspaceSearchQueryRequest,
  WorkspaceSearchQueryResult,
} from '@shared/workspaceSearchQuery';
import { zoomPercent } from '@shared/zoomBanner';
import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron';

function parseRestartOverlay(value: unknown): RestartOverlayState | null {
  if (!value || typeof value !== 'object') return null;
  const { phase, reason, exit, blockers } = value as {
    phase?: unknown;
    reason?: unknown;
    exit?: unknown;
    blockers?: unknown;
  };
  if (phase === 'restarting' || phase === 'resuming') return { phase };
  if (phase !== 'waiting') return null;
  const parsed = parseRestartBlockers(blockers);
  return {
    phase,
    reason: reason === 'background-not-detachable' || reason === 'reply' ? reason : 'tool',
    exit: exit === 'update' || exit === 'quit' ? exit : 'restart',
    ...(parsed ? { blockers: parsed } : {}),
  };
}

function isBlockerKind(value: unknown): value is RestartBlocker['kind'] {
  return (
    value === 'tool' ||
    value === 'background' ||
    value === 'reply' ||
    value === 'starting' ||
    value === 'turn'
  );
}

function parseRestartBlockers(value: unknown): RestartBlocker[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const blockers: RestartBlocker[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { sessionId?: unknown; kind?: unknown; tools?: unknown };
    if (typeof row.sessionId !== 'string' || row.sessionId.length === 0) continue;
    if (!isBlockerKind(row.kind)) continue;
    const blocker: RestartBlocker = { sessionId: row.sessionId, kind: row.kind };
    if (row.kind === 'tool' && Array.isArray(row.tools)) {
      const tools = row.tools.filter(
        (name): name is string => typeof name === 'string' && name.length > 0
      );
      if (tools.length > 0) blocker.tools = tools;
    }
    blockers.push(blocker);
  }
  return blockers.length > 0 ? blockers : undefined;
}

const electronAPI = {
  env: {
    platform: process.platform,
  },

  app: {
    onCloseRequest: (callback: (requestId: string) => void): (() => void) => {
      const listener = (_: unknown, requestId: string) => callback(requestId);
      ipcRenderer.on(IPC_CHANNELS.APP_CLOSE_REQUEST, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_CLOSE_REQUEST, listener);
    },
    respondCloseRequest: (
      requestId: string,
      payload: { action: 'cancel' | 'quit' | 'tray' }
    ): void => {
      ipcRenderer.send(IPC_CHANNELS.APP_CLOSE_RESPONSE, requestId, payload);
    },
    onFlushPersist: (callback: (requestId: string) => void): (() => void) => {
      const listener = (_: unknown, requestId: string) => callback(requestId);
      ipcRenderer.on(IPC_CHANNELS.APP_FLUSH_PERSIST_REQUEST, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_FLUSH_PERSIST_REQUEST, listener);
    },
    respondFlushPersist: (requestId: string): void => {
      ipcRenderer.send(IPC_CHANNELS.APP_FLUSH_PERSIST_RESPONSE, requestId);
    },
    onRestartWaiting: (callback: (state: RestartOverlayState | null) => void): (() => void) => {
      const listener = (_: unknown, state: unknown) => callback(parseRestartOverlay(state));
      ipcRenderer.on(IPC_CHANNELS.APP_RESTART_WAITING, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_RESTART_WAITING, listener);
    },
    getRestartWaiting: async (): Promise<RestartOverlayState | null> =>
      parseRestartOverlay(await ipcRenderer.invoke(IPC_CHANNELS.APP_RESTART_WAITING_GET)),
    forceRestart: (): void => {
      ipcRenderer.send(IPC_CHANNELS.APP_RESTART_FORCE);
    },
    setBadgeCount: (count: number): void => {
      ipcRenderer.send(IPC_CHANNELS.APP_SET_BADGE_COUNT, count);
    },
  },

  settings: {
    read: (): Promise<Record<string, unknown> | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_READ),
    write: (data: Record<string, unknown>): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_WRITE, data),
    /** 只更新单个顶层键（多 store 并发写不互相覆盖）；value undefined 表示删除该键 */
    writeKey: (name: string, value: unknown, ackSeq?: number): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_WRITE_KEY, name, value, ackSeq),
    /** 会话记录读回，带补丁序号；读的同时把本 renderer 的会话账本重置为磁盘值 */
    readConversations: (): Promise<{ value: unknown; seq: number }> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATIONS_READ),
    /** 用户明确删除会话：Main 先删行，空表写回不会被整表删除守卫拦下 */
    removeConversations: (ids: string[]): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATIONS_REMOVE, ids),
    /** 新建的根会话：Main 立即登记这一行（已有则不动），不依赖整表写回送达 */
    registerConversation: (row: unknown): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATIONS_REGISTER, row),
    moveConversation: (input: {
      conversationId: string;
      targetProjectId: string;
    }): Promise<
      { ok: true; value: ConversationAuthorityProjection } | { ok: false; error: string }
    > => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATIONS_MOVE, input),
    importProjectSessions: (input: {
      sourceProjectId: string;
      targetProjectId: string;
      mode: ImportProjectSessionsMode;
    }): Promise<ImportProjectSessionsResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATIONS_IMPORT_PROJECT, input),
    importProjectSessionsPreview: (input: {
      sourceProjectId: string;
      targetProjectId: string;
    }): Promise<ImportProjectSessionsPreview> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATIONS_IMPORT_PROJECT_PREVIEW, input),
    removeEmptyProject: (input: { projectId: string }): Promise<RemoveEmptyProjectResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_REMOVE_EMPTY, input),
    /** Main 拒收本窗口的会话写回，要求重新读会话 */
    onConversationsResync: (callback: () => void): (() => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.CONVERSATIONS_RESYNC, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CONVERSATIONS_RESYNC, listener);
    },
    /** 其他窗口修改设置后触发，用于多窗口同步 */
    onChanged: (callback: () => void): (() => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.SETTINGS_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SETTINGS_CHANGED, listener);
    },
    /** 其他主界面（远程浏览器/桌面窗口）改动的会话元数据补丁 */
    onConversationsPatch: (callback: (patch: unknown) => void): (() => void) => {
      const listener = (_event: unknown, patch: unknown) => callback(patch);
      ipcRenderer.on(IPC_CHANNELS.CONVERSATIONS_PATCH, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CONVERSATIONS_PATCH, listener);
    },
  },

  secretary: {
    /** 工作台与聊天卡片读同一份 Main 状态；开关关闭时 enabled 为 false */
    getState: (secretaryId?: string): Promise<SecretaryState> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_GET_STATE, secretaryId),
    /** 秘书清单：侧栏、设置页与新建流程用 */
    list: (): Promise<SecretarySummary[]> => ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_LIST),
    onListChanged: (callback: (list: SecretarySummary[]) => void): (() => void) => {
      const listener = (_event: unknown, list: SecretarySummary[]) => callback(list);
      ipcRenderer.on(IPC_CHANNELS.SECRETARY_LIST_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SECRETARY_LIST_CHANGED, listener);
    },
    /** 新建秘书：只建目录与隐藏项目，档案走它自己的欢迎页 */
    create: (): Promise<
      { ok: true; secretaryId: string; projectId: string | null } | { ok: false; error: string }
    > => ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_CREATE),
    /** 删除前的提醒：它在管的会话、待办、定时、联系方式与记忆 */
    deletePreview: (
      secretaryId: string
    ): Promise<{ ok: true; preview: SecretaryDeletePreview } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_DELETE_PREVIEW, secretaryId),
    /** 删除秘书：只有用户在提醒上再点一次确认时才带 confirmed */
    deleteSecretary: (
      secretaryId: string,
      confirmed: boolean
    ): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_DELETE, { secretaryId, confirmed }),
    /** 把会话从管理它的秘书转交给另一个秘书 */
    transfer: (
      conversationId: string,
      toSecretaryId: string
    ): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_TRANSFER, { conversationId, toSecretaryId }),
    /** 总看板：每个秘书一份 */
    overview: (): Promise<
      | {
          ok: true;
          boards: { secretaryId: string; name: string | null; board: SecretaryBoard }[];
        }
      | { ok: false; error: string }
    > => ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_OVERVIEW),
    /** 动态的一页。before 是上一页最旧一条的时间与 id，缺省取最新一页 */
    feed: (
      query?: {
        before?: { at: number; id: string };
        limit?: number;
      },
      secretaryId?: string
    ): Promise<
      { ok: true; events: FeedEvent[]; hasMore: boolean } | { ok: false; error: string }
    > => ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_FEED, query ?? {}, secretaryId),
    /** 按天汇总的看板：day 是本地日历日 YYYY-MM-DD，缺省今天 */
    daily: (
      day?: string,
      secretaryId?: string
    ): Promise<{ ok: true; daily: SecretaryDaily } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_DAILY, day ? { day } : {}, secretaryId),
    /** 已完成条目的结果：汇报、截图标识、PR 与改动文件 */
    doneReport: (
      conversationId: string
    ): Promise<{ ok: true; result: SecretaryDoneReport } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_DONE_REPORT, conversationId),
    onStateChanged: (callback: (state: SecretaryState) => void): (() => void) => {
      const listener = (_event: unknown, state: SecretaryState) => callback(state);
      ipcRenderer.on(IPC_CHANNELS.SECRETARY_STATE_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SECRETARY_STATE_CHANGED, listener);
    },
    /** 同一提案确认两次只执行一次 */
    resolveProposal: (
      proposalId: string,
      action: 'confirm' | 'reject',
      edits?: Partial<DispatchDraft>,
      /** 档案提案卡片上就地改过的整份草案 */
      profileDraft?: SecretaryProfileDraft
    ): Promise<{ ok: true; proposal: SecretaryProposal } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_RESOLVE_PROPOSAL, {
        proposalId,
        action,
        ...(edits ? { edits } : {}),
        ...(profileDraft ? { profileDraft } : {}),
      }),
    /** 用户把会话点名叫给秘书；Main 逐个校验，只返回通过的 id */
    referenceConversations: (
      secretaryConversationId: string,
      conversationIds: string[]
    ): Promise<{ ok: true; named: string[] } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_REFERENCE_CONVERSATIONS, {
        secretaryConversationId,
        conversationIds,
      }),
    mutateTodo: (
      request: SecretaryTodoMutate,
      secretaryId?: string
    ): Promise<{ ok: true; todoId: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_TODO_MUTATE, request, secretaryId),
    /** 结果卡「知道了」：这条结果不再占工作台的「需要你处理」 */
    dismissResult: (conversationId: string): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_DISMISS_RESULT, { conversationId }),
    /** 出问题的等待派发卡「忽略」：从等待表里移除 */
    dismissPending: (pendingId: string): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_DISMISS_PENDING, { pendingId }),
    /** 用户手动把一条派发记录标记完成，或撤销这个标记放回进行中 */
    markResult: (
      conversationId: string,
      action: 'done' | 'undo' | 'dismiss'
    ): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_MARK_RESULT, { conversationId, action }),
    /** 看板「停止遗留任务」：停掉这条派发记录里还在跑的后台任务 */
    stopTasks: (
      conversationId: string
    ): Promise<{ ok: true; stopped: string[] } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_STOP_TASKS, { conversationId }),
    /** 派出会话的目标与队列由 Main 驱动：设/暂停/恢复/清除都交给它 */
    goalAction: (request: {
      conversationId: string;
      action: 'set' | 'pause' | 'resume' | 'clear';
      text?: string;
    }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_GOAL_ACTION, request),
    /** 排队会话立即开始：不看上限；followUp 是排队期间在输入框发的消息，排在首条之后送达 */
    startQueued: (
      conversationId: string,
      followUp?: { text: string; images?: AttachedImage[] }
    ): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_QUEUED_START, {
        conversationId,
        ...(followUp ? { followUp } : {}),
      }),
    /** 取消排队会话：还没开始的会话直接删除；已开始或正在启动的拒绝 */
    cancelQueued: (conversationId: string): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_QUEUED_CANCEL, { conversationId }),
    /** 全部定时（含系统生成的每日简报与待办提醒），下一次触发时间由 Main 算 */
    listSchedules: (
      secretaryId?: string
    ): Promise<{ ok: true; schedules: SecretaryScheduleView[] } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_SCHEDULES_LIST, secretaryId),
    /** 系统生成的条目由档案与待办派生，删除会被拒绝 */
    removeSchedule: (
      scheduleId: string,
      secretaryId?: string
    ): Promise<{ ok: true; scheduleId: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_SCHEDULE_REMOVE, { scheduleId }, secretaryId),
    /** profile 为 null 表示还没完成初次设置 */
    getProfile: (
      secretaryId?: string
    ): Promise<
      { ok: true; profile: SecretaryProfile | null; persona: string } | { ok: false; error: string }
    > => ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_GET_PROFILE, secretaryId),
    /** 只带要改的字段；null 清掉该可选字段。越界取值由 Main 拒绝 */
    saveProfile: (
      draft: SecretaryProfileDraft,
      secretaryId?: string
    ): Promise<{ ok: true; profile: SecretaryProfile } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_SAVE_PROFILE, draft, secretaryId),
    /** 重新设置：默认保留会话与私有记忆 */
    resetProfile: (
      clearMemory: boolean,
      secretaryId?: string
    ): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_RESET_PROFILE, { clearMemory }, secretaryId),
    /** image=null 移除图片头像，恢复颜色头像 */
    setAvatar: (
      image: Uint8Array | null,
      secretaryId?: string
    ): Promise<{ ok: true; profile: SecretaryProfile } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_SET_AVATAR, { image }, secretaryId),
    /** 秘书可用的 skill：自有 + 勾选的全局，设置页与右侧面板共用 */
    listSkills: (
      secretaryId?: string
    ): Promise<{ ok: true; skills: SecretarySkillView[] } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_SKILLS_LIST, secretaryId),
    removeSkill: (
      name: string,
      secretaryId?: string
    ): Promise<{ ok: true; name: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_SKILL_DELETE, { name }, secretaryId),
    /** 启用或停用：自有写档案的停用名单，全局改勾选；都走档案同一条写入路径 */
    setSkillEnabled: (
      request: {
        id: string;
        source: 'own' | 'global';
        enabled: boolean;
      },
      secretaryId?: string
    ): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_SKILL_SET_ENABLED, request, secretaryId),
    /** 读 SKILL.md 正文：只给用户看，不喂给秘书 */
    readSkill: (
      request: {
        id: string;
        source: 'own' | 'global';
      },
      secretaryId?: string
    ): Promise<{ ok: true; body: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_SKILL_READ, request, secretaryId),
    /** 秘书自造的工具：名字即目录名，代码供设置页展开查看 */
    listTools: (
      secretaryId?: string
    ): Promise<{ ok: true; tools: SecretaryToolDraft[] } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_TOOLS_LIST, secretaryId),
    removeTool: (
      name: string,
      secretaryId?: string
    ): Promise<{ ok: true; name: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_TOOL_DELETE, { name }, secretaryId),
    revokeTakeover: (
      conversationId: string
    ): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_TAKEOVER_REVOKE, { conversationId }),
    /** 不带秘书 id 时列出全部秘书的接管；设置页带上只看这一个 */
    listTakeovers: (
      secretaryId?: string
    ): Promise<{ ok: true; takeovers: SecretaryTakeoverView[] } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_TAKEOVERS_LIST, secretaryId),
    /** 用户收回跟踪后不再由范围权限覆盖的会话；移除只恢复范围权限 */
    listUntracked: (
      secretaryId?: string
    ): Promise<{ ok: true; untracked: SecretaryUntrackedView[] } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_UNTRACKED_LIST, secretaryId),
    removeUntracked: (
      conversationId: string,
      secretaryId?: string
    ): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_UNTRACKED_REMOVE, { conversationId }, secretaryId),
    /** 联系方式：每个秘书一份；绑定状态里不含 token，只有前几位提示 */
    contactState: (secretaryId?: string): Promise<SecretaryContactState> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_CONTACT_STATE, secretaryId),
    onContactChanged: (callback: (state: SecretaryContactState) => void): (() => void) => {
      const listener = (_event: unknown, state: SecretaryContactState) => callback(state);
      ipcRenderer.on(IPC_CHANNELS.SECRETARY_CONTACT_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SECRETARY_CONTACT_CHANGED, listener);
    },
    /** 第 2 步：校验 token 并生成绑定码；不带 token 表示用已存的 bot 重新生成 */
    contactBind: (
      token?: string,
      secretaryId?: string
    ): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_CONTACT_BIND, token ? { token } : {}, secretaryId),
    contactCancel: (secretaryId?: string): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_CONTACT_CANCEL, secretaryId),
    /** 解绑：清 chat 与群/话题路由、停轮询，保留 bot 与 token */
    contactUnbind: (secretaryId?: string): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_CONTACT_UNBIND, secretaryId),
    /** 更换 bot：token 一起清，向导回到第 1 步 */
    contactForgetBot: (
      secretaryId?: string
    ): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_CONTACT_FORGET_BOT, secretaryId),
    contactTest: (secretaryId?: string): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_CONTACT_TEST, secretaryId),
    /** 总开关 enabled、Telegram 老开关，或某个渠道卡片上的通用开关 */
    contactSettings: (
      patch:
        | { enabled?: boolean; allowCardConfirm?: boolean; allowMemory?: boolean }
        | { channelId: string; prefs: Partial<SecretaryContactChannelPrefs> }
        | { telegramGroup: { action: 'add' | 'remove'; chatId: string } }
        | { telegramRoute: { action: 'remove'; chatId: string; topicId?: string } }
        | { telegramGroupScope: { chatId: string; scope: 'all' | string[] } },
      secretaryId?: string
    ): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_CONTACT_SETTINGS, patch, secretaryId),
    /** 拉一个 Telegram 群的论坛话题：失败带错误码与 Telegram 的说明 */
    contactTelegramTopics: (
      chatId: string,
      secretaryId?: string
    ): Promise<SecretaryContactTopicsResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_CONTACT_TELEGRAM_TOPICS, { chatId }, secretaryId),
    /** 手机关注的任务：取消一项或全清 */
    contactFollowing: (
      request: { action: 'cancel'; id: string } | { action: 'clear' },
      secretaryId?: string
    ): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETARY_CONTACT_FOLLOWING, request, secretaryId),
    /** 深链 enso://secretary?conversation=<id>[&proposal=<id>]：选中会话，带卡就定位那张卡 */
    onOpenConversation: (
      callback: (target: { conversationId: string; proposalId?: string }) => void
    ): (() => void) => {
      const listener = (_event: unknown, target: { conversationId: string; proposalId?: string }) =>
        callback(target);
      ipcRenderer.on(IPC_CHANNELS.SECRETARY_OPEN_CONVERSATION, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SECRETARY_OPEN_CONVERSATION, listener);
    },
  },

  modelDirectory: {
    get: (): Promise<unknown> => ipcRenderer.invoke(IPC_CHANNELS.MODEL_DIRECTORY_GET),
    onChanged: (callback: (snapshot: unknown) => void): (() => void) => {
      const listener = (_event: unknown, snapshot: unknown) => callback(snapshot);
      ipcRenderer.on(IPC_CHANNELS.MODEL_DIRECTORY_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.MODEL_DIRECTORY_CHANGED, listener);
    },
  },

  configSync: {
    exportConfig: (options: ConfigSyncExportOptions): Promise<ConfigSyncExportResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONFIG_SYNC_EXPORT, options),
    openImport: (): Promise<ConfigSyncOpenResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONFIG_SYNC_OPEN_IMPORT),
    previewImport: (options: ConfigSyncPreviewOptions): Promise<ConfigSyncPreviewResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONFIG_SYNC_PREVIEW_IMPORT, options),
    commitImport: (options: ConfigSyncCommitOptions): Promise<ConfigSyncCommitResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONFIG_SYNC_COMMIT_IMPORT, options),
    cancelImport: (token: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONFIG_SYNC_CANCEL_IMPORT, token),
  },

  usage: {
    summary: (days: UsageRangeDays): Promise<UsageSummaryResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.USAGE_SUMMARY, days),
  },

  privacyMask: {
    records: (days: 1 | 7 | 30): Promise<PrivacyMaskRecord[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.PRIVACY_MASK_RECORDS, days),
  },

  /** bash 提权口令：只有桌面主窗口与完整模式主界面能读写，其它窗口拿到空列表 */
  elevation: {
    pending: (): Promise<ElevationRequestView[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.ELEVATION_PENDING),
    answer: (id: string, password: string | null): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.ELEVATION_ANSWER, id, password),
    onChanged: (callback: (views: ElevationRequestView[]) => void): (() => void) => {
      const listener = (_: unknown, views: ElevationRequestView[]) => callback(views);
      ipcRenderer.on(IPC_CHANNELS.ELEVATION_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.ELEVATION_CHANGED, listener);
    },
  },

  resources: {
    sample: (): Promise<ResourceSnapshot> => ipcRenderer.invoke(IPC_CHANNELS.RESOURCES_SAMPLE),
    scanStorage: (): Promise<StorageSnapshot> =>
      ipcRenderer.invoke(IPC_CHANNELS.RESOURCES_STORAGE_SCAN),
    cancelScan: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.RESOURCES_STORAGE_CANCEL),
    lastStorage: (): Promise<StorageSnapshot | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.RESOURCES_STORAGE_LAST),
    onScanProgress: (callback: (progress: StorageScanProgress) => void): (() => void) => {
      const listener = (_event: unknown, progress: StorageScanProgress) => callback(progress);
      ipcRenderer.on(IPC_CHANNELS.RESOURCES_STORAGE_PROGRESS, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.RESOURCES_STORAGE_PROGRESS, listener);
    },
    cleanStorage: (category: StorageCategoryId): Promise<StorageCleanResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.RESOURCES_STORAGE_CLEAN, category),
    revealStorage: (root: StorageRootId, relPath: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.RESOURCES_STORAGE_REVEAL, root, relPath),
    cleanSessions: (
      request: SessionCleanRequest
    ): Promise<{ removed: number; snapshot: StorageSnapshot }> =>
      ipcRenderer.invoke(IPC_CHANNELS.RESOURCES_SESSIONS_CLEAN, request),
    onSessionsCleanRequest: (
      callback: (event: { requestId: string; request: SessionCleanRequest }) => void
    ): (() => void) => {
      const listener = (
        _event: unknown,
        payload: { requestId: string; request: SessionCleanRequest }
      ) => callback(payload);
      ipcRenderer.on(IPC_CHANNELS.RESOURCES_SESSIONS_CLEAN_REQUEST, listener);
      return () =>
        ipcRenderer.removeListener(IPC_CHANNELS.RESOURCES_SESSIONS_CLEAN_REQUEST, listener);
    },
    sessionsCleanDone: (requestId: string, removed: number): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.RESOURCES_SESSIONS_CLEAN_DONE, requestId, removed),
  },

  logs: {
    errors: (minLevel: LogSummaryLevel): Promise<AppLogEntry[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.LOGS_ERRORS, minLevel),
    export: (hours: number): Promise<LogExportResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.LOGS_EXPORT, hours),
    revealExport: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.LOGS_REVEAL_EXPORT),
  },

  memory: {
    list: (query: MemoryListQuery): Promise<MemoryListResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_LIST, query),
    detail: (id: string): Promise<MemoryDetail | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_DETAIL, id),
    archive: (id: string): Promise<MemoryMutationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_ARCHIVE, id),
    restore: (id: string): Promise<MemoryMutationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_RESTORE, id),
    runForgetting: (): Promise<MemoryDecayRunDto | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_FORGETTING_RUN),
    runReconcile: (): Promise<MemoryReconcileRunDto | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_RECONCILE_RUN),
    archiveCandidates: (query?: {
      limit?: number;
      offset?: number;
    }): Promise<MemoryArchiveCandidatesResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_ARCHIVE_CANDIDATES, query),
    confirmArchiveCandidates: (ids: string[]): Promise<MemoryArchiveConfirmResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_ARCHIVE_CANDIDATES_CONFIRM, ids),
    delete: (id: string): Promise<MemoryMutationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_DELETE, id),
    deletePreview: (ids: string[]): Promise<MemoryDeletionImpact | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_DELETE_PREVIEW, ids),
    update: (id: string, patch: MemoryEditPatch): Promise<MemoryMutationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_UPDATE, id, patch),
    stats: (): Promise<MemoryStats> => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_STATS),
    jobs: (): Promise<MemoryJobsSnapshot> => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_JOBS),
    clearJobs: (): Promise<number> => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_JOBS_CLEAR),
    retryFailedKgJobs: (): Promise<number> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_KG_RETRY_FAILED),
    evolvesPending: (): Promise<PendingEvolvesReviewDto[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_EVOLVES_PENDING),
    evolvesReview: (id: string, state: 'accepted' | 'rejected'): Promise<MemoryMutationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_EVOLVES_REVIEW, id, state),
    pendingWrites: (): Promise<PendingMemoryWriteDto[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_PENDING_WRITES),
    reviewPendingWrite: (
      id: string,
      decision: PendingMemoryWriteDecision
    ): Promise<MemoryMutationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_PENDING_WRITE_REVIEW, id, decision),
    models: (): Promise<EmbeddingModelDto[]> => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_MODELS),
    downloadModel: (modelId: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_MODEL_DOWNLOAD, modelId),
    cancelModelDownload: (modelId: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_MODEL_CANCEL, modelId),
    deleteModel: (modelId: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_MODEL_DELETE, modelId),
    reembed: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_REEMBED),
    graph: (query: GraphQuery): Promise<MemoryGraphDto> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_GRAPH, query),
    graphEntity: (entityId: string): Promise<MemoryBriefDto[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_GRAPH_ENTITY, entityId),
    tree: (query: TreeQuery): Promise<TreeNodeDto[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_TREE, query),
    insight: (request: InsightRequest): Promise<InsightResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_INSIGHT, request),
    crystallize: (request: CrystallizeRequest): Promise<CrystallizeResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_CRYSTALLIZE, request),
    distillableSessions: (): Promise<DistillableSessionDto[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_DISTILLABLE_SESSIONS),
    distillSession: (sessionId: string, force = false): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_DISTILL_SESSION, sessionId, force),
    /** 记忆库发生任何写入（含 agent 工具写入）时触发，用于让列表/图谱重拉 */
    onChanged: (listener: () => void): (() => void) => {
      const handler = () => listener();
      ipcRenderer.on(IPC_CHANNELS.MEMORY_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.MEMORY_CHANGED, handler);
    },
    onModelProgress: (listener: (progress: EmbeddingDownloadProgressDto) => void): (() => void) => {
      const handler = (_event: unknown, progress: EmbeddingDownloadProgressDto) =>
        listener(progress);
      ipcRenderer.on(IPC_CHANNELS.MEMORY_MODEL_PROGRESS, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.MEMORY_MODEL_PROGRESS, handler);
    },
    chatModels: (): Promise<ChatModelDto[]> => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_CHAT_MODELS),
    downloadChatModel: (modelId: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_CHAT_MODEL_DOWNLOAD, modelId),
    cancelChatModelDownload: (modelId: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_CHAT_MODEL_CANCEL, modelId),
    deleteChatModel: (modelId: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_CHAT_MODEL_DELETE, modelId),
    onChatModelProgress: (
      listener: (progress: EmbeddingDownloadProgressDto) => void
    ): (() => void) => {
      const handler = (_event: unknown, progress: EmbeddingDownloadProgressDto) =>
        listener(progress);
      ipcRenderer.on(IPC_CHANNELS.MEMORY_CHAT_MODEL_PROGRESS, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.MEMORY_CHAT_MODEL_PROGRESS, handler);
    },
  },

  dcg: {
    status: (): Promise<DcgStatus> => ipcRenderer.invoke(IPC_CHANNELS.DCG_STATUS),
    install: (): Promise<DcgActionResult> => ipcRenderer.invoke(IPC_CHANNELS.DCG_INSTALL),
    uninstall: (): Promise<DcgActionResult> => ipcRenderer.invoke(IPC_CHANNELS.DCG_UNINSTALL),
    checkUpdate: (): Promise<DcgUpdateCheck> => ipcRenderer.invoke(IPC_CHANNELS.DCG_CHECK_UPDATE),
    ruleState: (ruleId: string): Promise<DcgRuleState | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.DCG_RULE_STATE, ruleId),
    ruleAllowed: (ruleId: string): Promise<DcgRuleState | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.DCG_RULE_ALLOWED, ruleId),
    ruleExempt: (ruleId: string): Promise<DcgRuleState | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.DCG_RULE_EXEMPT, ruleId),
    ruleRevoke: (ruleId: string): Promise<DcgRuleExemption[] | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.DCG_RULE_REVOKE, ruleId),
    listExemptions: (): Promise<DcgRuleExemption[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.DCG_EXEMPTIONS_LIST),
    clearExemptions: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.DCG_EXEMPTIONS_CLEAR),
  },

  providers: {
    scanLocal: (): Promise<LocalProviderScanResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDERS_SCAN_LOCAL),
    collectImport: (scanId: string, candidateIds: string[]): Promise<CollectedProvider[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDERS_COLLECT_IMPORT, scanId, candidateIds),
    listModels: (config: ProviderApiConfig): Promise<ListModelsResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDERS_LIST_MODELS, config),
    test: (config: ProviderApiConfig, modelId?: string): Promise<TestProviderResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDERS_TEST, config, modelId),
    /** 设置里某个 provider 条目可用的 pi 分类器模型（虚拟模型分档用）；不支持分类的返回空 */
    classifierModels: (providerId: string): Promise<Array<{ id: string; name: string }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDERS_CLASSIFIER_MODELS, providerId),
    modelMeta: (query: ModelMetaQuery): Promise<ModelMetaResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDERS_MODEL_META, query),
    refreshModelCatalog: (): Promise<ModelCatalogRefreshResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDERS_REFRESH_MODEL_CATALOG),
    listOauth: (): Promise<OauthProviderInfo[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.OAUTH_PROVIDERS_LIST),
    listOauthCredentialKeys: (): Promise<string[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.OAUTH_CREDENTIAL_KEYS_LIST),
    /** Wizard 只提交公开 provider id；Main 按 sender 生成 flow identity。 */
    oauthLogin: (request: StartOauthWizardRequest): Promise<StartOauthResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.OAUTH_LOGIN, request),
    oauthLoginRespond: (request: OauthFlowPromptResponse): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.OAUTH_LOGIN_RESPOND, request),
    oauthLoginCancel: (request: OauthFlowControlRequest): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.OAUTH_LOGIN_CANCEL, request),
    oauthLoginReopen: (request: OauthFlowControlRequest): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.OAUTH_LOGIN_REOPEN, request),
    oauthLogout: (accountKey: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.OAUTH_LOGOUT, accountKey),
    oauthImportCodex: (): Promise<OauthCodexImportResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.OAUTH_IMPORT_CODEX),
    oauthAccountUsage: (accountKey: string): Promise<OauthAccountUsage> =>
      ipcRenderer.invoke(IPC_CHANNELS.OAUTH_ACCOUNT_INFO, accountKey),
    onOauthLoginEvent: (callback: (event: OauthFlowEvent) => void): (() => void) => {
      const listener = (_: unknown, event: OauthFlowEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.OAUTH_LOGIN_EVENT, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.OAUTH_LOGIN_EVENT, listener);
    },
    onOauthCredentialsChanged: (callback: () => void): (() => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.OAUTH_CREDENTIALS_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.OAUTH_CREDENTIALS_CHANGED, listener);
    },
  },

  assets: {
    scanLocal: (): Promise<LocalAssetScanResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.ASSETS_SCAN_LOCAL),
    collectImport: (scanId: string, candidateIds: string[]): Promise<CollectedAsset[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.ASSETS_COLLECT_IMPORT, scanId, candidateIds),
    /** cwd 为空只列插件 skill；presetId 决定哪些插件预设圈定的 skill 计入 */
    listProjectSkills: (
      cwd: string,
      presetId?: string
    ): Promise<{ name: string; description: string }[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.ASSETS_LIST_PROJECT_SKILLS, cwd, presetId),
    /** 按会话列出工作流预设；项目根由 Main 从会话记录推导，presetId 决定哪些插件预设圈定的 workflow 计入 */
    listWorkflowPresets: (
      conversationId: string,
      presetId?: string
    ): Promise<WorkflowPresetSummary[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.ASSETS_LIST_WORKFLOW_PRESETS, conversationId, presetId),
    skillOccupancy: (ids: string[]): Promise<AssetOccupancyRow[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.ASSETS_SKILL_OCCUPANCY, ids),
    instructionOccupancy: (ids: string[]): Promise<AssetOccupancyRow[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.ASSETS_INSTRUCTION_OCCUPANCY, ids),
    mcpOccupancy: (ids: string[]): Promise<AssetOccupancyRow[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.ASSETS_MCP_OCCUPANCY, ids),
    builtinToolOccupancy: (): Promise<AssetOccupancyRow[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.ASSETS_BUILTIN_TOOL_OCCUPANCY),
  },

  instructions: {
    /**
     * 按条目 id 读内容；读本地副本还是登记的源文件由 Main 按登记条目推导。
     * 后两个参数只为兼容旧调用方的实参保留，不再发送
     */
    read: (
      id: string,
      _local?: boolean,
      _sourcePath?: string
    ): Promise<{ ok: boolean; content: string; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.INSTRUCTIONS_READ, id),
    /** 写入本地副本，首次写入即完成 copy-on-write */
    write: (id: string, content: string): Promise<{ ok: boolean; bytes: number }> =>
      ipcRenderer.invoke(IPC_CHANNELS.INSTRUCTIONS_WRITE, id, content),
    /** 直接写回源应用的原文件（会改动对方配置） */
    writeSource: (
      id: string,
      sourcePath: string,
      content: string
    ): Promise<{ ok: boolean; bytes: number; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.INSTRUCTIONS_WRITE_SOURCE, id, sourcePath, content),
    delete: (id: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.INSTRUCTIONS_DELETE, id),
  },

  /** 设置页托管的工作流预设；id 由 Main 生成，文件路径不经 renderer */
  workflowPresets: {
    list: (): Promise<WorkflowPresetSummary[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_PRESETS_LIST),
    read: (id: string): Promise<(WorkflowPresetDraft & { id: string }) | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_PRESETS_READ, id),
    save: (draft: WorkflowPresetDraft, id?: string): Promise<WorkflowPresetSaveResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_PRESETS_SAVE, draft, id),
    delete: (id: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_PRESETS_DELETE, id),
  },

  presets: {
    readSystemPrompt: (id?: string): Promise<{ ok: boolean; content: string; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PRESETS_SYSTEM_PROMPT_READ, id),
    writeSystemPrompt: (id: string, content: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PRESETS_SYSTEM_PROMPT_WRITE, id, content),
    fetchImport: (
      url: string
    ): Promise<{ ok: true; draft: PresetImportDraft } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PRESETS_FETCH_IMPORT, url),
  },

  dialog: {
    /** 打开系统目录选择框，取消时返回 null */
    selectDirectory: (): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_DIRECTORY),
    /** 打开系统文件选择框（可按扩展名过滤），取消时返回 null */
    selectFile: (extensions?: string[]): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_FILE, extensions),
  },

  projects: {
    /** 从本机编辑器 / 编程应用读取最近打开的目录 */
    getRecent: (): Promise<RecentProject[]> => ipcRenderer.invoke(IPC_CHANNELS.PROJECTS_GET_RECENT),
    /** 列出宿主机目录的可见子目录；不传或路径不存在时从家目录 / 最近的已存在祖先开始 */
    listHostDirs: (path?: string): Promise<HostDirListing> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECTS_LIST_HOST_DIRS, path),
    /** 在宿主机 parent 目录下新建子文件夹，成功时返回新目录的列表 */
    createHostDir: (parent: string, name: string): Promise<HostDirListing> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECTS_CREATE_HOST_DIR, parent, name),
    /** 在系统文件管理器（或 appId 指定的应用）里打开项目或会话的实际工作目录；ssh 项目返回 unsupported */
    reveal: (request: {
      projectId: string;
      conversationId?: string;
      appId?: string;
    }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECTS_REVEAL, request),
    openInApps: (): Promise<OpenInApp[]> => ipcRenderer.invoke(IPC_CHANNELS.PROJECTS_OPEN_IN_APPS),
    /** 项目（或会话 worktree）里会被当作代码加载的 pi 扩展/包来源 */
    codeSources: (request: { projectId: string; conversationId?: string }): Promise<string[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECTS_CODE_SOURCES, request),
  },

  git: {
    diffHead: (request: { conversationId: string; projectId: string }): Promise<GitDiffResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_DIFF_HEAD, request),
    status: (request: GitRequest): Promise<GitStatusResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_STATUS, request),
    fileDiff: (request: GitFileDiffRequest): Promise<GitFileDiffResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_FILE_DIFF, request),
    history: (request: GitHistoryRequest): Promise<GitHistoryResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_HISTORY, request),
    commitFiles: (request: GitCommitRequest): Promise<GitCommitFilesResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_COMMIT_FILES, request),
    commitDiff: (request: GitCommitDiffRequest): Promise<GitFileDiffResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_COMMIT_DIFF, request),
    stage: (request: GitPathsRequest): Promise<GitOperationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_STAGE, request),
    unstage: (request: GitPathsRequest): Promise<GitOperationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_UNSTAGE, request),
    discard: (request: GitDiscardRequest): Promise<GitOperationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_DISCARD, request),
    commit: (request: GitCreateCommitRequest): Promise<GitOperationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_COMMIT, request),
    fetch: (request: GitRequest): Promise<GitOperationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_FETCH, request),
    pull: (request: GitRequest): Promise<GitOperationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_PULL, request),
    push: (request: GitRequest): Promise<GitOperationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_PUSH, request),
  },

  changes: {
    /** Changes 面板会话快照（编辑前全文）：主进程按会话落盘，不进 localStorage */
    readSnapshots: (request: { conversationId: string }): Promise<SessionChangeSnapshots> =>
      ipcRenderer.invoke(IPC_CHANNELS.CHANGES_SNAPSHOTS_READ, request),
    writeSnapshots: (request: {
      conversationId: string;
      snapshots: SessionChangeSnapshots;
    }): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.CHANGES_SNAPSHOTS_WRITE, request),
  },

  workspaceFiles: {
    openContext: (request: FilesOpenContextRequest): Promise<FilesMutateResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILES_OPEN_CONTEXT, request),
    open: (request: FilesOpenRequest): Promise<FilesOpenResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILES_OPEN, request),
    listDir: (request: {
      conversationId: string;
      projectId: string;
      rel?: string;
    }): Promise<FilesListResult> => ipcRenderer.invoke(IPC_CHANNELS.FILES_LIST_DIR, request),
    read: (request: {
      conversationId: string;
      projectId: string;
      rel: string;
    }): Promise<FilesReadRelResult> => ipcRenderer.invoke(IPC_CHANNELS.FILES_READ_REL, request),
    /** Markdown 预览相对图片：主进程按工作区边界解析后返回 data URL */
    readImage: (request: {
      conversationId: string;
      projectId: string;
      rel: string;
    }): Promise<FilesReadImageResult> => ipcRenderer.invoke(IPC_CHANNELS.FILES_READ_IMAGE, request),
    /** Markdown 预览远程图片：主进程带 SSRF 防护代理读取，返回 data URL */
    fetchRemoteImage: (request: {
      conversationId: string;
      projectId: string;
      url: string;
    }): Promise<FilesFetchRemoteImageResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILES_FETCH_REMOTE_IMAGE, request),
    write: (request: {
      conversationId: string;
      projectId: string;
      rel: string;
      content: string;
    }): Promise<FilesWriteResult> => ipcRenderer.invoke(IPC_CHANNELS.FILES_WRITE, request),
    watchStart: (request: {
      conversationId: string;
      projectId: string;
      rel: string;
    }): Promise<FilesWatchResult> => ipcRenderer.invoke(IPC_CHANNELS.FILES_WATCH_START, request),
    watchStop: (request: {
      conversationId: string;
      projectId: string;
      rel: string;
    }): Promise<FilesWatchResult> => ipcRenderer.invoke(IPC_CHANNELS.FILES_WATCH_STOP, request),
    onChange: (callback: (event: FilesWatchEvent) => void): (() => void) => {
      const listener = (_: unknown, event: FilesWatchEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.FILES_WATCH_EVENT, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.FILES_WATCH_EVENT, listener);
    },
    mkdir: (request: {
      conversationId: string;
      projectId: string;
      rel?: string;
      name: string;
    }): Promise<FilesMutateResult> => ipcRenderer.invoke(IPC_CHANNELS.FILES_MKDIR, request),
    createFile: (request: {
      conversationId: string;
      projectId: string;
      rel?: string;
      name: string;
    }): Promise<FilesMutateResult> => ipcRenderer.invoke(IPC_CHANNELS.FILES_CREATE, request),
    rename: (request: {
      conversationId: string;
      projectId: string;
      rel: string;
      name: string;
    }): Promise<FilesMutateResult> => ipcRenderer.invoke(IPC_CHANNELS.FILES_RENAME, request),
    remove: (request: {
      conversationId: string;
      projectId: string;
      rel: string;
    }): Promise<FilesMutateResult> => ipcRenderer.invoke(IPC_CHANNELS.FILES_REMOVE, request),
    absPath: (request: {
      conversationId: string;
      projectId: string;
      rel?: string;
    }): Promise<FilesAbsResult> => ipcRenderer.invoke(IPC_CHANNELS.FILES_ABS, request),
    copyPath: (request: {
      conversationId: string;
      projectId: string;
      rel?: string;
      mode: 'absolute' | 'relative';
    }): Promise<FilesMutateResult> => ipcRenderer.invoke(IPC_CHANNELS.FILES_COPY_PATH, request),
    copyFile: (request: {
      conversationId: string;
      projectId: string;
      rel: string;
    }): Promise<FilesMutateResult> => ipcRenderer.invoke(IPC_CHANNELS.FILES_COPY_FILE, request),
    reveal: (request: {
      conversationId: string;
      projectId: string;
      rel?: string;
    }): Promise<FilesMutateResult> => ipcRenderer.invoke(IPC_CHANNELS.FILES_REVEAL, request),
    /** 工作区外文件只定位：Main 按真实路径与本会话写入记录校验，未写过的先弹确认 */
    revealExternal: (request: {
      conversationId: string;
      projectId: string;
      path: string;
    }): Promise<FilesMutateResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILES_REVEAL_EXTERNAL, request),
    search: (request: FilesSearchRequest): Promise<FilesSearchResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILES_SEARCH_WORKSPACE, request),
    /** 聊天文件链接批量判定能否打开（单批 ≤ 200） */
    resolveLinks: (request: FilesResolveLinksRequest): Promise<FilesResolveLinksResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILES_RESOLVE_LINKS, request),
  },

  files: {
    /** 在 root 下按文件名/路径模糊搜索（@ 提及用） */
    search: (root: string, query: string): Promise<{ relativePath: string; name: string }[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILES_SEARCH, root, query),
    /** 拖放浮窗收到的路径：Main 推 pending 提醒，renderer 主动取走 */
    takeShelfDrop: (): Promise<DropShelfDelivery[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.DROP_SHELF_TAKE),
    onShelfDrop: (callback: () => void): (() => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.DROP_SHELF_PENDING, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.DROP_SHELF_PENDING, listener);
    },
    /** 取粘贴/拖入的 File 对象的磁盘路径（渲染层拿不到，需经 webUtils） */
    pathForFile: (file: File): string => webUtils.getPathForFile(file),
    /**
     * 读文件内容，失败返回 null。Main 不收任意路径，只认两种请求：
     * - 会话工作区内文件（edit diff 还原上下文/行号）：会话标识 + 工作区相对路径，根目录由 Main 推导；
     * - 工作区外、本会话写过的文件：会话标识 + 绝对路径，Main 对照会话 jsonl 里的写入记录；
     * - 后台任务完整日志：任务完成提示里给出的 task-logs 路径，Main 只认该目录下的 task-*.log
     */
    read: (
      request:
        | { conversationId: string; projectId: string; rel: string }
        | { conversationId: string; projectId: string; path: string }
        | string
    ): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.FILES_READ, request),
    /** 枚举目录下的媒体文件（背景图文件夹随机模式），返回绝对路径 */
    listMedia: (dir: string): Promise<string[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILES_LIST_MEDIA, dir),
    /** 超长粘贴存成 txt：只传会话 id 与文本，路径由 Main 推导 */
    savePastedText: (request: {
      conversationId: string;
      text: string;
    }): Promise<PastedTextFileResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILES_SAVE_PASTED_TEXT, request),
  },

  sessionImport: {
    /** 列出各本地 AI 应用在项目目录下的会话 */
    scan: (projectPath: string): Promise<ExternalSessionSource[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSIONS_SCAN_EXTERNAL, projectPath),
    /** 读取外部会话的拉平消息（预览用） */
    read: (sourceId: string, sessionPath: string): Promise<SimpleMessage[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSIONS_READ_EXTERNAL, sourceId, sessionPath),
    /** 转成 pi jsonl，返回可 resume 的文件与标题 */
    import: (
      sourceId: string,
      sessionPath: string,
      projectPath: string
    ): Promise<{ sessionFile: string; title: string; messageCount: number } | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSIONS_IMPORT_EXTERNAL, sourceId, sessionPath, projectPath),
  },

  agent: {
    spawn: (request: AgentSpawnRequest): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_SPAWN, request),
    prompt: (
      sessionId: string,
      text: string,
      images: AttachedImage[] | undefined,
      deliveryId: string
    ): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_PROMPT, sessionId, text, images, deliveryId),
    steer: (
      sessionId: string,
      text: string,
      images?: AttachedImage[],
      deliveryId?: string
    ): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_STEER, sessionId, text, images, deliveryId),
    withdrawSteer: (sessionId: string, deliveryId: string): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_WITHDRAW_STEER, sessionId, deliveryId),
    /** 用户停止带 stopSubagents 与 cancelReminders：一并停子代理、取消会话自己定的提醒 */
    abort: (
      sessionId: string,
      options?: { stopSubagents?: boolean; cancelReminders?: boolean }
    ): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_ABORT, sessionId, options),
    abortRetry: (sessionId: string): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_ABORT_RETRY, sessionId),
    retry: (
      sessionId: string,
      options?: { unfinishedOnly?: boolean }
    ): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_RETRY, sessionId, options),
    reportUpstreamFailure: (input: {
      sessionId: string;
      error: string;
      provider?: string;
      retryExhausted?: boolean;
      since?: number;
      previousAttempt?: number;
    }): Promise<
      | { action: 'wait'; retry: GoalUpstreamRetry }
      | { action: 'exhausted'; note: string }
      | { action: 'permanent'; hint?: string }
    > => ipcRenderer.invoke(IPC_CHANNELS.AGENT_UPSTREAM_REPORT_FAILURE, input),
    retryUpstreamNow: (waiterId: string): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_UPSTREAM_RETRY_NOW, { waiterId }),
    cancelUpstreamWait: (sessionId: string): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_UPSTREAM_CANCEL, sessionId),
    listUpstreamHealth: (): Promise<ProviderHealthSnapshot[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_UPSTREAM_HEALTH_LIST),
    /** 释放父会话（worker 侧销毁，jsonl 留盘），之后可携新 cwd resume（Move to worktree） */
    release: (sessionId: string): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_RELEASE, sessionId),
    respondAsk: (
      sessionId: string,
      requestId: string,
      answer: string
    ): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_ASK_RESPOND, sessionId, requestId, answer),
    dismissCoworker: (
      parentSessionId: string,
      coworkerId: string,
      notify?: boolean
    ): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_DISMISS_COWORKER, parentSessionId, coworkerId, notify),
    /** 手动雇佣：走 Main dispatch（typed child），tab 由 child-reserved/ready 回流建立 */
    hireCoworker: (
      parentConversationId: string,
      name: string,
      agentType?: string
    ): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_HIRE_COWORKER, parentConversationId, name, agentType),
    /** 请求 worker 投影快照（结果经 onEvent 回来）。传 sessionId 只补这一路。 */
    requestSnapshot: (sessionId?: string): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_SNAPSHOT, sessionId),
    /** 取走上次应用退出（含安装更新）打断的回合（取一次即清空） */
    takeInterruptedTurns: (): Promise<InterruptedTurn[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_TAKE_INTERRUPTED_TURNS),
    /** 已结束 child 的只读历史；只传 conversationId，路径由 Main 推导 */
    readChildHistory: (conversationId: string): Promise<ChildHistoryResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_CHILD_HISTORY_READ, { conversationId }),
    listChildRuns: (parentConversationId: string): Promise<ChildRunListResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_CHILD_RUNS_LIST, { parentConversationId }),
    readChildRun: (
      parentConversationId: string,
      childId: string,
      beforeIndex?: number
    ): Promise<ParentHistoryTailResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_CHILD_RUN_READ, {
        parentConversationId,
        childId,
        beforeIndex,
      }),
    /** 手动「重新读取会话」：只传 conversationId，来源（worker 活快照 / safe journal）由 Main 决定，只读不 spawn */
    reloadConversation: (conversationId: string): Promise<ConversationReloadResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_CONVERSATION_RELOAD, { conversationId }),
    readParentHistoryTail: (
      conversationId: string,
      beforeIndex?: number
    ): Promise<ParentHistoryTailResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_PARENT_HISTORY_TAIL, { conversationId, beforeIndex }),
    /** 标题总结：只传 id + 输入（首条即时 / 每轮滚动，+会话模型作回退链末级），凭证由 Main 自读；结果经 title-generated 事件回流 */
    summarizeTitle: (
      conversationId: string,
      input: TitleSummaryInput,
      sessionModel?: { providerId: string; modelId: string }
    ): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_SUMMARIZE_TITLE, {
        conversationId,
        input,
        sessionModel,
      }),
    /** 已启动会话就地换模型（未启动的会话只需记忆，下次 spawn 生效） */
    setModel: (
      sessionId: string,
      providerId: string,
      modelId: string
    ): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_SET_MODEL, sessionId, providerId, modelId),
    setThinking: (sessionId: string, level: ThinkingLevel): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_SET_THINKING, sessionId, level),
    setReasoning: (
      sessionId: string,
      enabled: boolean,
      level?: ThinkingLevel
    ): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_SET_REASONING, sessionId, enabled, level),
    respondApproval: (
      sessionId: string,
      requestId: string,
      decision: ApprovalDecision
    ): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_APPROVAL_RESPOND, sessionId, requestId, decision),
    setApprovalMode: (
      sessionId: string,
      mode: ApprovalMode,
      autoReject?: boolean
    ): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_SET_APPROVAL_MODE, sessionId, mode, autoReject),
    setPlanMode: (sessionId: string, active: boolean): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_SET_PLAN_MODE, sessionId, active),
    respondPlan: (
      sessionId: string,
      response: { planId: string; action: PlanRespondAction; feedback?: string }
    ): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_PLAN_RESPOND, sessionId, response),
    stopTask: (sessionId: string, taskId: string): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_TASK_STOP, sessionId, taskId),
    /** 手动保留后台任务（可附理由）；reason 为 null 取消保留 */
    keepTask: (
      sessionId: string,
      taskId: string,
      reason: string | null
    ): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_TASK_KEEP, sessionId, taskId, reason),
    backgroundTool: (sessionId: string, toolCallId: string): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_TOOL_BACKGROUND, sessionId, toolCallId),
    subagentProgress: (sessionId: string): Promise<AgentRunProgress[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_SUBAGENT_PROGRESS, sessionId),
    onSubagentProgress: (
      callback: (push: { sessionId: string; runs: AgentRunProgress[] }) => void
    ): (() => void) => {
      const listener = (_: unknown, push: { sessionId: string; runs: AgentRunProgress[] }) =>
        callback(push);
      ipcRenderer.on(IPC_CHANNELS.AGENT_SUBAGENT_PROGRESS_CHANGED, listener);
      return () =>
        ipcRenderer.removeListener(IPC_CHANNELS.AGENT_SUBAGENT_PROGRESS_CHANGED, listener);
    },
    stopSubagent: (sessionId: string, agentId: string): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_SUBAGENT_STOP, sessionId, agentId),
    stopWorkflow: (sessionId: string, runId: string): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_WORKFLOW_STOP, sessionId, runId),
    /** 手动压缩上下文；忙碌时 worker 自行排队，进度经 compaction 事件回来 */
    compact: (sessionId: string, instructions?: string): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_COMPACT, sessionId, instructions),
    /** 回退到已持久化的 user entry；结果经 rewind-done 事件回来。
     *  restoreFiles 同时把工作树还原到该轮首个写操作前(无快照静默降级) */
    rewind: (
      sessionId: string,
      entryId: string,
      restoreFiles?: boolean
    ): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_REWIND, sessionId, entryId, restoreFiles),
    fork: (
      sessionId: string,
      targetConversationId: string,
      anchor: { entryId: string } | { turnIndexFromEnd: number }
    ): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_FORK, sessionId, targetConversationId, anchor),
    /** 上报当前正在查看的会话（null = 没在看任何会话），供 main 抑制重复的系统通知 */
    setViewedSession: (sessionId: string | null): void =>
      ipcRenderer.send(IPC_CHANNELS.NOTIFICATION_ACTIVE_SESSION, sessionId),
    /** 会话静音立即告诉 main。持久化仍走会话 store */
    setSessionMuted: (sessionId: string, muted: boolean): void =>
      ipcRenderer.send(IPC_CHANNELS.AGENT_SESSION_MUTED, sessionId, muted),
    /** 系统通知点击后由 main 下发：切到对应会话 */
    onFocusSession: (callback: (sessionId: string) => void): (() => void) => {
      const listener = (_: unknown, sessionId: string) => callback(sessionId);
      ipcRenderer.on(IPC_CHANNELS.NOTIFICATION_FOCUS_SESSION, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.NOTIFICATION_FOCUS_SESSION, listener);
    },
    onEvent: (callback: (event: RendererAgentEvent) => void): (() => void) => {
      const listener = (_: unknown, event: RendererAgentEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.AGENT_EVENT, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_EVENT, listener);
    },
    onUpstreamHealth: (callback: (snapshots: ProviderHealthSnapshot[]) => void): (() => void) => {
      const listener = (_: unknown, snapshots: ProviderHealthSnapshot[]) => callback(snapshots);
      ipcRenderer.on(IPC_CHANNELS.AGENT_UPSTREAM_HEALTH_EVENT, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_UPSTREAM_HEALTH_EVENT, listener);
    },
    onUpstreamWake: (
      callback: (event: {
        conversationId: string;
        reason: 'probe' | 'recovered' | 'manual';
      }) => void
    ): (() => void) => {
      const listener = (
        _: unknown,
        event: { conversationId: string; reason: 'probe' | 'recovered' | 'manual' }
      ) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.AGENT_UPSTREAM_WAKE_EVENT, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_UPSTREAM_WAKE_EVENT, listener);
    },
  },

  agentRegistry: {
    list: (): Promise<AgentTypeRegistrySnapshot> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_TYPES_REGISTRY_LIST),
  },

  agentDispatch: {
    bindSource: (request: ParentSourceBindingRequest): Promise<ParentSourceBindingResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_DISPATCH_BIND_SOURCE, request),
    registerModelSelection: (
      request: ParentModelSelectionRequest
    ): Promise<MainModelSelectionBindingResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_MODEL_SELECTION_REGISTER, request),
    dispatch: (request: AgentDispatchRequest): Promise<AgentDispatchResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_DISPATCH, request),
    onEvent: (callback: (event: DispatchMainEvent) => void): (() => void) => {
      const listener = (_: unknown, event: unknown) => {
        const parsed = parseDispatchMainEvent(event);
        if (parsed) callback(parsed);
      };
      ipcRenderer.on(IPC_CHANNELS.AGENT_DISPATCH_EVENT, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_DISPATCH_EVENT, listener);
    },
  },

  worktree: {
    branches: (conversationId: string): Promise<WorkspaceBranchesResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_BRANCHES, conversationId),
    switchBranch: (request: WorkspaceBranchSwitchRequest): Promise<WorkspaceBranchSwitchResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_SWITCH_BRANCH, request),
    bind: (
      conversationId: string,
      sourceConversationId: string
    ): Promise<{ ok: true; value: SessionWorktree } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_BIND, conversationId, sourceConversationId),
    rename: (
      conversationId: string,
      name: string
    ): Promise<{ ok: true; value: SessionWorktree[] } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_RENAME, conversationId, name),
    create: (
      conversationId: string,
      projectId: string
    ): Promise<{ ok: true; value: SessionWorktree } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_CREATE, { conversationId, projectId }),
    get: (conversationId: string): Promise<SessionWorktree | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_GET, conversationId),
    list: (): Promise<SessionWorktree[]> => ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_LIST),
    status: (
      conversationId: string
    ): Promise<{ ok: true; value: WorktreeStatus } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_STATUS, conversationId),
    statuses: (): Promise<Record<string, WorktreeStatus>> =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_STATUSES),
    remove: (
      conversationId: string
    ): Promise<{ ok: true; value: null } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_REMOVE, conversationId),
    rebuild: (
      conversationId: string
    ): Promise<{ ok: true; value: SessionWorktree } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_REBUILD, conversationId),
    repoClean: (
      projectId: string
    ): Promise<{ ok: true; value: boolean } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_REPO_CLEAN, projectId),
  },
  mcp: {
    authorize: (serverId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.MCP_AUTHORIZE, serverId),
    revoke: (serverId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.MCP_REVOKE, serverId),
    authState: (): Promise<Record<string, boolean>> =>
      ipcRenderer.invoke(IPC_CHANNELS.MCP_AUTH_STATE),
    /** 最近一次连接状态：worker 只在建连那刻上报，晚打开的设置页靠它回填 */
    statusSnapshot: (): Promise<McpStatusEvent[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.MCP_STATUS_SNAPSHOT),
    onStatus: (callback: (push: McpStatusPush) => void): (() => void) => {
      const listener = (_: unknown, push: McpStatusPush) => callback(push);
      ipcRenderer.on(IPC_CHANNELS.MCP_STATUS_EVENT, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.MCP_STATUS_EVENT, listener);
    },
  },
  sshConnections: {
    list: (): Promise<SshConnection[]> => ipcRenderer.invoke(IPC_CHANNELS.SSH_CONNECTIONS_LIST),
    upsert: (request: {
      id?: string;
      name: string;
      host: string;
      user?: string;
      port?: number;
      auth: SshConnection['auth'];
      password?: string;
    }): Promise<{ ok: true; value: SshConnection } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SSH_CONNECTIONS_UPSERT, request),
    delete: (id: string): Promise<{ ok: true; value: null } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SSH_CONNECTIONS_DELETE, id),
    test: (
      id: string
    ): Promise<{ ok: true } | { ok: false; error: string; hostKey?: SshHostKeyChallenge }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SSH_CONNECTIONS_TEST, id),
    listDirs: (
      id: string,
      path?: string
    ): Promise<
      | { ok: true; path: string; dirs: string[] }
      | { ok: false; error: string; hostKey?: SshHostKeyChallenge }
    > => ipcRenderer.invoke(IPC_CHANNELS.SSH_CONNECTIONS_LIST_DIRS, id, path),
    trustHost: (id: string): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SSH_CONNECTIONS_TRUST_HOST, id),
  },
  sourceAuthority: {
    read: (): Promise<SourceAuthorityProjection> =>
      ipcRenderer.invoke(IPC_CHANNELS.SOURCE_AUTHORITY_READ),
    onChanged: (callback: (projection: SourceAuthorityProjection) => void): (() => void) => {
      const listener = (_: unknown, projection: SourceAuthorityProjection) => callback(projection);
      ipcRenderer.on(IPC_CHANNELS.SOURCE_AUTHORITY_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SOURCE_AUTHORITY_CHANGED, listener);
    },
    createProject: (
      request: CreateProjectAuthorityRequest
    ): Promise<AuthorityMutationResult<ProjectAuthorityProjection>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SOURCE_PROJECT_CREATE, request),
    selectProject: (
      request: SelectProjectAuthorityRequest
    ): Promise<AuthorityMutationResult<ProjectAuthorityProjection>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SOURCE_PROJECT_SELECT, request),
    removeProject: (
      request: RemoveProjectAuthorityRequest
    ): Promise<AuthorityMutationResult<ProjectAuthorityProjection>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SOURCE_PROJECT_REMOVE, request),
    createConversation: (
      request: CreateConversationAuthorityRequest
    ): Promise<AuthorityMutationResult<ConversationAuthorityProjection>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SOURCE_CONVERSATION_CREATE, request),
    selectConversation: (
      request: ConversationAuthorityRequest
    ): Promise<AuthorityMutationResult<ConversationAuthorityProjection>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SOURCE_CONVERSATION_SELECT, request),
    endConversation: (
      request: ConversationAuthorityRequest
    ): Promise<AuthorityMutationResult<ConversationAuthorityProjection>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SOURCE_CONVERSATION_END, request),
    removeConversation: (
      request: ConversationAuthorityRequest
    ): Promise<AuthorityMutationResult<ConversationAuthorityProjection>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SOURCE_CONVERSATION_REMOVE, request),
    updateConversationSelection: (
      request: UpdateConversationSelectionRequest
    ): Promise<AuthorityMutationResult<ConversationAuthorityProjection>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SOURCE_CONVERSATION_UPDATE_SELECTION, request),
  },

  proxy: {
    apply: (settings: {
      mode: string;
      customUrl: string;
    }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROXY_APPLY, settings),
  },

  caCert: {
    status: (): Promise<CaCertStatus> => ipcRenderer.invoke(IPC_CHANNELS.CA_CERT_STATUS),
    /** 空串清除；生效值变化时 Main 会重启 agent worker */
    apply: (path: string): Promise<CaCertStatus> =>
      ipcRenderer.invoke(IPC_CHANNELS.CA_CERT_APPLY, path),
  },

  appearance: {
    readUserCss: (): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.APPEARANCE_USER_CSS_GET),
    /** 不存在时先写入模板 */
    openUserCss: (): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.APPEARANCE_USER_CSS_OPEN),
    onUserCssChanged: (callback: () => void): (() => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.APPEARANCE_USER_CSS_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.APPEARANCE_USER_CSS_CHANGED, listener);
    },
  },

  compaction: {
    getReserveTokens: (): Promise<number | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.COMPACTION_RESERVE_TOKENS_GET),
    setReserveTokens: (
      value: number | null
    ): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.COMPACTION_RESERVE_TOKENS_SET, value),
  },

  updater: {
    checkForUpdates: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.UPDATER_CHECK),
    downloadUpdate: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.UPDATER_DOWNLOAD_UPDATE),
    /** 走优雅重启的安全点：当前工具结束后重启安装，后台命令交给新实例 */
    quitAndInstall: (): Promise<RestartToUpdateResult | undefined> =>
      ipcRenderer.invoke(IPC_CHANNELS.UPDATER_QUIT_AND_INSTALL),
    setAutoUpdateEnabled: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.UPDATER_SET_AUTO_UPDATE_ENABLED, enabled),
    setAutoRestartMode: (mode: AutoRestartMode): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.UPDATER_SET_AUTO_RESTART_MODE, mode),
    /** 输入框里有没有重启后会丢的未发送草稿：只在有无变化时报 */
    reportUnsentDraft: (has: boolean): void =>
      ipcRenderer.send(IPC_CHANNELS.COMPOSER_UNSENT_DRAFT, has),
    setChannel: (channel: UpdateChannel): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.UPDATER_SET_CHANNEL, channel),
    getState: (): Promise<UpdaterState> => ipcRenderer.invoke(IPC_CHANNELS.UPDATER_GET_STATE),
    restart: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.UPDATER_RESTART),
    onStatus: (callback: (status: UpdateStatus) => void): (() => void) => {
      const listener = (_: unknown, status: UpdateStatus) => callback(status);
      ipcRenderer.on(IPC_CHANNELS.UPDATER_STATUS, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.UPDATER_STATUS, listener);
    },
  },

  pair: {
    start: (): Promise<{ ok: boolean; inviteUri?: string; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PAIR_START),
    cancel: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.PAIR_CANCEL),
    revoke: (pairId: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.PAIR_REVOKE, pairId),
    rename: (pairId: string, deviceName: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PAIR_RENAME, pairId, deviceName),
    setScope: (
      pairId: string,
      scope: 'read' | 'operate'
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PAIR_SET_SCOPE, pairId, scope),
    status: (): Promise<PairStatus> => ipcRenderer.invoke(IPC_CHANNELS.PAIR_STATUS),
    setRelayUrl: (url: string): Promise<PairStatus> =>
      ipcRenderer.invoke(IPC_CHANNELS.PAIR_SET_RELAY, url),
    /** renderer → main 推会话目录 / 项目 / provider（provider 须已剥密） */
    pushCatalog: (payload: PairCatalogPayload): void =>
      ipcRenderer.send(IPC_CHANNELS.PAIR_CATALOG, payload),
    onStatusChanged: (callback: (status: PairStatus) => void): (() => void) => {
      const listener = (_: unknown, status: PairStatus) => callback(status);
      ipcRenderer.on(IPC_CHANNELS.PAIR_STATUS_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PAIR_STATUS_CHANGED, listener);
    },
    /** main 请求恢复某会话（手机订阅了历史会话） */
    onResumeSession: (callback: (sessionId: string) => void): (() => void) => {
      const listener = (_: unknown, sessionId: string) => callback(sessionId);
      ipcRenderer.on(IPC_CHANNELS.PAIR_RESUME_SESSION, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PAIR_RESUME_SESSION, listener);
    },
    /** main 通知：手机新建了会话，请求登记到桌面列表 */
    onSessionCreated: (callback: (session: PairCreatedSession) => void): (() => void) => {
      const listener = (_: unknown, session: PairCreatedSession) => callback(session);
      ipcRenderer.on(IPC_CHANNELS.PAIR_SESSION_CREATED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PAIR_SESSION_CREATED, listener);
    },
    /** main 通知：手机改了会话模型/推理档位，应用到会话 store */
    onSessionConfig: (callback: (config: PairSessionConfig) => void): (() => void) => {
      const listener = (_: unknown, config: PairSessionConfig) => callback(config);
      ipcRenderer.on(IPC_CHANNELS.PAIR_SESSION_CONFIG, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PAIR_SESSION_CONFIG, listener);
    },
    /** main 通知：手机操作了排队消息 / 会话目标，应用到会话 store */
    onQueueAction: (callback: (action: PairQueueAction) => void): (() => void) => {
      const listener = (_: unknown, action: PairQueueAction) => callback(action);
      ipcRenderer.on(IPC_CHANNELS.PAIR_QUEUE_ACTION, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PAIR_QUEUE_ACTION, listener);
    },
  },

  /** 连接到节点：本机作为 guest 连别的 EnsoCode 桌面（密钥与连接在 main） */
  nodes: {
    list: (): Promise<NodesStatus> => ipcRenderer.invoke(IPC_CHANNELS.NODES_LIST),
    /** 粘贴对方的配对链接（https 或 enso://） */
    pair: (inviteUri: string): Promise<NodePairResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.NODES_PAIR, inviteUri),
    /** 节点层里：请所在电脑切回本机界面并打开配对对话框 */
    requestPair: (): Promise<NodeActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.NODES_REQUEST_PAIR),
    onPairRequested: (callback: () => void): (() => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.NODES_PAIR_REQUESTED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.NODES_PAIR_REQUESTED, listener);
    },
    remove: (nodeId: string): Promise<NodeActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.NODES_REMOVE, nodeId),
    rename: (nodeId: string, label: string): Promise<NodeActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.NODES_RENAME, nodeId, label),
    /** 在本机新窗口打开该节点的设置（宿主设置页经隧道运行） */
    openSettings: (nodeId: string): Promise<NodeActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.NODES_OPEN_SETTINGS, nodeId),
    /** 主窗口可见层切到本机（'local'）或某节点的完整界面 */
    switch: (target: string): Promise<NodeActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.NODES_SWITCH, target),
    active: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.NODES_ACTIVE),
    onActiveChanged: (callback: (active: string) => void): (() => void) => {
      const listener = (_: unknown, active: string) => callback(active);
      ipcRenderer.on(IPC_CHANNELS.NODES_ACTIVE_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.NODES_ACTIVE_CHANGED, listener);
    },
    onStatusChanged: (callback: (status: NodesStatus) => void): (() => void) => {
      const listener = (_: unknown, status: NodesStatus) => callback(status);
      ipcRenderer.on(IPC_CHANNELS.NODES_STATUS_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.NODES_STATUS_CHANGED, listener);
    },
  },

  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MINIMIZE),
    maximize: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MAXIMIZE),
    close: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CLOSE),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_IS_MAXIMIZED),
    isFullScreen: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_IS_FULLSCREEN),
    setTitleBarAppearance: (
      appearance: TitleBarAppearance
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_SET_TITLE_BAR_APPEARANCE, appearance),
    setTrafficLightsVisible: (visible: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_SET_TRAFFIC_LIGHTS_VISIBLE, visible),
    refreshDragRegions: (): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_REFRESH_DRAG_REGIONS),
    openSettings: (link?: SettingsDeepLink): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_OPEN_SETTINGS, link),
    openDevTools: (): Promise<OpenDevToolsResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_OPEN_DEV_TOOLS),
    onToggleSidebar: (callback: () => void): (() => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.WINDOW_TOGGLE_SIDEBAR, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.WINDOW_TOGGLE_SIDEBAR, listener);
    },
    onSettingsDeepLink: (callback: (link: SettingsDeepLink) => void): (() => void) => {
      const listener = (_: unknown, link: SettingsDeepLink) => callback(link);
      ipcRenderer.on(IPC_CHANNELS.SETTINGS_DEEP_LINK, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SETTINGS_DEEP_LINK, listener);
    },
    consumeSettingsDeepLink: (): Promise<SettingsDeepLink | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_DEEP_LINK_CONSUME),
    popupMenu: (
      items: { id: string; label: string }[],
      x: number,
      y: number
    ): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_POPUP_MENU, items, x, y),
    takeOpenFolders: (): Promise<string[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_TAKE_OPEN_FOLDERS),
    installShellIntegration: (kind: ShellIntegration): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_INSTALL_SHELL_INTEGRATION, kind),
    shellIntegrationStatus: (): Promise<Record<ShellIntegration, boolean>> =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_SHELL_INTEGRATION_STATUS),
    onOpenFolderRequested: (callback: () => void): (() => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.WINDOW_OPEN_FOLDER_REQUESTED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.WINDOW_OPEN_FOLDER_REQUESTED, listener);
    },
    onMaximizedChange: (callback: (maximized: boolean) => void): (() => void) => {
      const listener = (_: unknown, maximized: boolean) => callback(maximized);
      ipcRenderer.on(IPC_CHANNELS.WINDOW_MAXIMIZED_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.WINDOW_MAXIMIZED_CHANGED, listener);
    },
    onFullScreenChange: (callback: (fullscreen: boolean) => void): (() => void) => {
      const listener = (_: unknown, fullscreen: boolean) => callback(fullscreen);
      ipcRenderer.on(IPC_CHANNELS.WINDOW_FULLSCREEN_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.WINDOW_FULLSCREEN_CHANGED, listener);
    },
    getZoomPercent: (): number => zoomPercent(webFrame.getZoomFactor()),
    resetZoom: (): void => {
      webFrame.setZoomFactor(1);
    },
  },
  btw: {
    prompt: (request: BtwPromptRequest): Promise<BtwPromptResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BTW_PROMPT, request),
    abort: (request: BtwAbortRequest): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.BTW_ABORT, request),
    spawn: (request: BtwSpawnRequest): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.BTW_SPAWN, request),
    dispose: (request: BtwDisposeRequest): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.BTW_DISPOSE, request),
  },
  bots: {
    delegations: (request: { chatId?: string } = {}): Promise<BotDelegationsResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_DELEGATIONS_LIST, request),
    cancelDelegation: (id: string): Promise<BotActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_DELEGATION_CANCEL, { id }),
    retryDelegation: (id: string, mode?: 'resume' | 'restart'): Promise<BotDelegationRetryResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_DELEGATION_RETRY, mode ? { id, mode } : { id }),
    routines: {
      list: (request: { botId?: string } = {}): Promise<BotRoutinesResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.BOT_ROUTINES_LIST, request),
      save: (request: BotRoutineSaveInput): Promise<BotRoutineSaveResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.BOT_ROUTINE_SAVE, request),
      remove: (request: { botId: string; id: string }): Promise<BotActionResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.BOT_ROUTINE_DELETE, request),
      runNow: (request: {
        botId: string;
        id: string;
        dryRun?: boolean;
      }): Promise<BotActionResult> => ipcRenderer.invoke(IPC_CHANNELS.BOT_ROUTINE_RUN_NOW, request),
      review: (request: {
        botId: string;
        id: string;
        approve: boolean;
      }): Promise<BotRoutineReviewResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.BOT_ROUTINE_REVIEW, request),
      runs: (request: { botId: string; id: string }): Promise<BotRoutineRunsResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.BOT_ROUTINE_RUNS, request),
    },
    /** 成员 / 群核心笔记：target 只传 { botId } 或 { chatId } */
    notes: {
      get: (target: { botId: string } | { chatId: string }): Promise<BotNotesResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.BOT_NOTES_GET, target),
      save: (
        request: ({ botId: string } | { chatId: string }) & { content: string; version: string }
      ): Promise<BotNotesResult> => ipcRenderer.invoke(IPC_CHANNELS.BOT_NOTES_SAVE, request),
    },
    tasks: {
      list: (chatId: string): Promise<BotTasksResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.BOT_TASKS_LIST, { chatId }),
      save: (request: BotTaskSaveInput): Promise<BotTaskWriteResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.BOT_TASK_SAVE, request),
      assign: (request: {
        chatId: string;
        id: string;
        botId: string;
      }): Promise<BotTaskWriteResult> => ipcRenderer.invoke(IPC_CHANNELS.BOT_TASK_ASSIGN, request),
      complete: (request: {
        chatId: string;
        id: string;
        result?: string;
      }): Promise<BotTaskWriteResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.BOT_TASK_COMPLETE, request),
      cancel: (request: { chatId: string; id: string }): Promise<BotTaskWriteResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.BOT_TASK_CANCEL, request),
      remove: (request: { chatId: string; id: string }): Promise<BotActionResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.BOT_TASK_DELETE, request),
      /** 验收：通过 → done；退回需 reason → todo，rework 时原执行人在原会话返工 */
      review: (
        request: { chatId: string; id: string } & (
          | { accept: true }
          | { accept: false; reason: string; rework?: boolean }
        )
      ): Promise<BotTaskWriteResult> => ipcRenderer.invoke(IPC_CHANNELS.BOT_TASK_REVIEW, request),
      /** 任务卡回复：缺信息卡住时解除并让原执行人接着做；执行中插入当前执行；其他状态记评论 */
      reply: (request: { chatId: string; id: string; text: string }): Promise<BotTaskWriteResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.BOT_TASK_REPLY, request),
    },
    list: (): Promise<BotsListResult> => ipcRenderer.invoke(IPC_CHANNELS.BOTS_LIST),
    get: (botId: string): Promise<BotGetResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_GET, { botId }),
    create: (draft: BotDraftInput): Promise<BotWriteIpcResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_CREATE, draft),
    suggestAbilities: (request: BotAbilitySuggestRequest): Promise<BotAbilitySuggestResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_SUGGEST_ABILITIES, request),
    suggestPersona: (request: BotPersonaSuggestRequest): Promise<BotPersonaSuggestResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_SUGGEST_PERSONA, request),
    suggestGoal: (request: BotGoalSuggestRequest): Promise<BotGoalSuggestResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_SUGGEST_GOAL, request),
    previewTeam: (request: BotTeamPreviewRequest): Promise<BotTeamPreviewResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_TEAM_PREVIEW, request),
    createTeam: (request: BotTeamCreateRequest): Promise<BotTeamCreateResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_TEAM_CREATE, request),
    update: (request: {
      botId: string;
      expectedVersion?: number;
      draft: BotDraftInput;
    }): Promise<BotWriteIpcResult> => ipcRenderer.invoke(IPC_CHANNELS.BOT_UPDATE, request),
    archive: (botId: string, archived: boolean): Promise<BotWriteIpcResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_ARCHIVE, { botId, archived }),
    remove: (botId: string): Promise<BotActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_DELETE, { botId }),
    /** image=null 移除图片头像，恢复颜色头像 */
    setAvatar: (botId: string, image: Uint8Array | null): Promise<BotWriteIpcResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_SET_AVATAR, { botId, image }),
    chats: (): Promise<BotChatsListResult> => ipcRenderer.invoke(IPC_CHANNELS.BOT_CHATS_LIST),
    createChat: (request: BotChatCreateInput): Promise<BotChatWriteResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_CHAT_CREATE, request),
    updateChat: (request: BotChatUpdateInput): Promise<BotChatWriteResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_CHAT_UPDATE, request),
    deleteChat: (chatId: string): Promise<BotActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_CHAT_DELETE, { chatId }),
    newSession: (chatId: string): Promise<BotNewSessionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_CHAT_NEW_SESSION, { chatId }),
    switchSession: (chatId: string, conversationId: string): Promise<BotActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_CHAT_SWITCH_SESSION, { chatId, conversationId }),
    cloneChat: (request: { chatId: string; title: string }): Promise<BotChatWriteResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_CHAT_CLONE, request),
    createThread: (chatId: string): Promise<BotChatWriteResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_THREAD_CREATE, { chatId }),
    selectThread: (chatId: string, threadId: string): Promise<BotActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_THREAD_SELECT, { chatId, threadId }),
    renameThread: (chatId: string, title: string): Promise<BotChatWriteResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_THREAD_UPDATE, { chatId, title }),
    deleteThread: (chatId: string): Promise<BotActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_THREAD_DELETE, { chatId }),
    stopChat: (chatId: string): Promise<BotActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_CHAT_STOP, { chatId }),
    interjectQueued: (chatId: string, deliveryId: string): Promise<BotActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_CHAT_INTERJECT_QUEUED, { chatId, deliveryId }),
    chatState: (chatId: string): Promise<BotChatStateResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_CHAT_STATE, { chatId }),
    chatSessions: (chatId: string): Promise<BotChatSessionsResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_CHAT_SESSIONS, { chatId }),
    timeline: (request: {
      chatId: string;
      beforeSeq?: number;
      /** 只要该 seq 之后的增量；缺口超过 limit 时返回最新一页 */
      afterSeq?: number;
      limit?: number;
    }): Promise<BotTimelineResult> => ipcRenderer.invoke(IPC_CHANNELS.BOT_CHAT_TIMELINE, request),
    send: (request: BotSendRequest): Promise<BotSendResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_SEND, request),
    openWorkspace: (target: { chatId: string } | { botId: string }): Promise<BotActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_OPEN_WORKSPACE, target),
    sessionHistory: (request: {
      conversationId: string;
      beforeIndex?: number;
    }): Promise<ParentHistoryTailResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_SESSION_HISTORY, request),
    search: (request: BotSearchRequest): Promise<BotSearchResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_SEARCH, request),
    searchFiles: (request: BotFileSearchRequest): Promise<BotFileSearchResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_FILE_SEARCH, request),
    /** 超长粘贴存成 txt：存放目录由 Main 按 chatId 推导 */
    savePastedText: (request: { chatId: string; text: string }): Promise<PastedTextFileResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_CHAT_SAVE_PASTED_TEXT, request),
    /** 私聊回退到持久化 user entry；结果经 AGENT_EVENT 的 rewind-done 回来 */
    rewind: (request: {
      chatId: string;
      entryId: string;
      restoreFiles?: boolean;
    }): Promise<BotActionResult> => ipcRenderer.invoke(IPC_CHANNELS.BOT_REWIND, request),
    retry: (chatId: string, entryId?: string): Promise<BotActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_RETRY, { chatId, ...(entryId ? { entryId } : {}) }),
    templates: {
      get: (): Promise<BotTemplatesResult> => ipcRenderer.invoke(IPC_CHANNELS.BOT_TEMPLATES_GET),
      save: (library: BotTemplateLibrary): Promise<BotTemplatesResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.BOT_TEMPLATES_SAVE, library),
      onChanged: (callback: (library: BotTemplateLibrary) => void): (() => void) => {
        const listener = (_: unknown, library: BotTemplateLibrary) => callback(library);
        ipcRenderer.on(IPC_CHANNELS.BOT_TEMPLATES_CHANGED, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.BOT_TEMPLATES_CHANGED, listener);
      },
    },
    usageSummary: (days: UsageRangeDays): Promise<BotUsageSummaryResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_USAGE_SUMMARY, days),
    usage: (): Promise<BotUsageOverviewResult> => ipcRenderer.invoke(IPC_CHANNELS.BOT_USAGE),
    inbox: {
      list: (): Promise<BotInboxListResult> => ipcRenderer.invoke(IPC_CHANNELS.BOT_INBOX_LIST),
      update: (request: BotInboxUpdateInput): Promise<BotActionResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.BOT_INBOX_UPDATE, request),
    },
    artifacts: {
      list: (target: BotArtifactTarget): Promise<BotArtifactsResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.BOT_ARTIFACTS_LIST, target),
      read: (request: BotArtifactReadRequest): Promise<BotArtifactReadResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.BOT_ARTIFACT_READ, request),
      open: (
        request: BotArtifactTarget & { rel: string; action: BotArtifactOpenAction }
      ): Promise<BotActionResult> => ipcRenderer.invoke(IPC_CHANNELS.BOT_ARTIFACT_OPEN, request),
    },
    onEvent: (callback: (event: BotEvent) => void): (() => void) => {
      const listener = (_: unknown, event: BotEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.BOT_EVENT, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.BOT_EVENT, listener);
    },
  },
  terminal: {
    create: (request: TerminalCreateRequest): Promise<TerminalCreateResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_CREATE, request),
    write: (termId: string, data: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_WRITE, termId, data),
    resize: (termId: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_RESIZE, termId, cols, rows),
    dispose: (termId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_DISPOSE, termId),
    onData: (callback: (event: TerminalDataEvent) => void): (() => void) => {
      const listener = (_: unknown, event: TerminalDataEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.TERMINAL_DATA, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_DATA, listener);
    },
    onExit: (callback: (event: TerminalExitEvent) => void): (() => void) => {
      const listener = (_: unknown, event: TerminalExitEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.TERMINAL_EXIT, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_EXIT, listener);
    },
  },
  browser: {
    /** 面板可见时报矩形（CSS px）；不可见传 null。covered：有 HTML 浮层压在网页上 */
    setViewport: (
      tabId: string,
      conversationId: string,
      viewport: { x: number; y: number; width: number; height: number; radius?: number } | null,
      covered = false
    ): Promise<BrowserTabState> =>
      ipcRenderer.invoke(
        IPC_CHANNELS.BROWSER_SET_VIEWPORT,
        tabId,
        conversationId,
        viewport,
        covered
      ),
    /** 模态浮层开合：fire-and-forget，越早越好 */
    setOverlayActive: (active: boolean): void => {
      ipcRenderer.send(IPC_CHANNELS.BROWSER_SET_OVERLAY_ACTIVE, active);
    },
    navigate: (
      tabId: string,
      conversationId: string,
      url: string
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_NAVIGATE, tabId, conversationId, url),
    goBack: (tabId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_GO_BACK, tabId),
    goForward: (tabId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_GO_FORWARD, tabId),
    reload: (tabId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_RELOAD, tabId),
    closeTab: (tabId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CLOSE_TAB, tabId),
    closeSession: (conversationId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CLOSE_SESSION, conversationId),
    clearData: (kind: BrowserClearKind): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CLEAR_DATA, kind),
    setLocked: (conversationId: string, locked: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_SET_LOCKED, conversationId, locked),
    setDevTools: (tabId: string, open: boolean): Promise<BrowserTabState> =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_SET_DEVTOOLS, tabId, open),
    setDesignMode: (tabId: string, enabled: boolean): Promise<BrowserTabState> =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_SET_DESIGN_MODE, tabId, enabled),
    describeSelection: (tabId: string, crop?: DesignXyRect): Promise<BrowserSelectionDescription> =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_DESCRIBE_SELECTION, tabId, crop),
    moveSelection: (
      tabId: string,
      direction: BrowserDesignMoveDirection
    ): Promise<{
      elements: BrowserPickedElementRef[];
      description: BrowserSelectionDescription;
    }> => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_MOVE_SELECTION, tabId, direction),
    clearSelection: (tabId: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CLEAR_SELECTION, tabId),
    setAnnotationPins: (
      tabId: string,
      pageKey: string,
      pins: BrowserAnnotationPinSpec[]
    ): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_SET_ANNOTATION_PINS, tabId, pageKey, pins),
    openAnnotationPin: (
      tabId: string,
      pinId: string | null,
      reveal = false
    ): Promise<BrowserOpenPinResult | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_OPEN_ANNOTATION_PIN, tabId, pinId, reveal),
    readDesignCss: (tabId: string, uid: string): Promise<DesignCssSnapshot | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_READ_DESIGN_CSS, tabId, uid),
    previewDesignCss: (
      tabId: string,
      slot: 'queue' | 'draft',
      spec: Record<string, Record<string, string | null>>
    ): Promise<DesignTopLeftRect | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_PREVIEW_DESIGN_CSS, tabId, slot, spec),
    setDevToolsViewport: (
      tabId: string,
      conversationId: string,
      viewport: { x: number; y: number; width: number; height: number; radius?: number } | null,
      covered = false
    ): Promise<BrowserTabState> =>
      ipcRenderer.invoke(
        IPC_CHANNELS.BROWSER_SET_DEVTOOLS_VIEWPORT,
        tabId,
        conversationId,
        viewport,
        covered
      ),
    onState: (
      callback: (event: { conversationId: string; tabId: string; state: BrowserTabState }) => void
    ): (() => void) => {
      const listener = (
        _: unknown,
        event: { conversationId: string; tabId: string; state: BrowserTabState }
      ) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.BROWSER_STATE, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_STATE, listener);
    },
    restoreTabs: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_RESTORE_TABS),
    listSearchableTabs: (): Promise<BrowserSearchTab[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_LIST_SEARCHABLE_TABS),
    onReveal: (
      callback: (event: { conversationId: string; tabId: string }) => void
    ): (() => void) => {
      const listener = (_: unknown, event: { conversationId: string; tabId: string }) =>
        callback(event);
      ipcRenderer.on(IPC_CHANNELS.BROWSER_REVEAL, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_REVEAL, listener);
    },
    onTabClosed: (
      callback: (event: { conversationId: string; tabId: string }) => void
    ): (() => void) => {
      const listener = (_: unknown, event: { conversationId: string; tabId: string }) =>
        callback(event);
      ipcRenderer.on(IPC_CHANNELS.BROWSER_TAB_CLOSED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_TAB_CLOSED, listener);
    },
    onDesignMode: (callback: (event: BrowserDesignModeEvent) => void): (() => void) => {
      const listener = (_: unknown, event: BrowserDesignModeEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.BROWSER_DESIGN_MODE_EVENT, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_DESIGN_MODE_EVENT, listener);
    },
  },

  computer: {
    capabilities: (): Promise<
      { ok: true; capabilities: ComputerCapabilities } | { ok: false; error: string }
    > => ipcRenderer.invoke(IPC_CHANNELS.COMPUTER_CAPABILITIES),
    openPermissions: (kind: 'screen' | 'accessibility'): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.COMPUTER_OPEN_PERMISSIONS, kind),
    allowedApps: (): Promise<ComputerAllowedApp[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.COMPUTER_ALLOWED_APPS),
    /** key 为 bundle id（无 bundle id 的 app 用其路径） */
    revokeApp: (key: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.COMPUTER_REVOKE_APP, key),
  },

  workspaceSearch: {
    query: (request: WorkspaceSearchQueryRequest): Promise<WorkspaceSearchQueryResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SEARCH_QUERY, request),
  },

  extensionPlugins: {
    list: (): Promise<ExtensionPluginSummary[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_LIST),
    registryNotice: (): Promise<RegistryNotice | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_REGISTRY_NOTICE),
    dismissRegistryNotice: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_DISMISS_REGISTRY_NOTICE),
    onChanged: (callback: () => void): (() => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.EXTENSION_PLUGINS_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.EXTENSION_PLUGINS_CHANGED, listener);
    },
    onNotice: (callback: (notice: ExtensionPluginNotice) => void): (() => void) => {
      const listener = (_event: unknown, notice: ExtensionPluginNotice) => callback(notice);
      ipcRenderer.on(IPC_CHANNELS.EXTENSION_PLUGINS_NOTICE, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.EXTENSION_PLUGINS_NOTICE, listener);
    },
    pickAndStage: (
      kind: 'dir' | 'zip'
    ): Promise<
      | { ok: true; preview: ExtensionPluginInstallPreview }
      | { ok: true; cancelled: true }
      | { ok: false; error: string }
    > => ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_PICK_AND_STAGE, kind),
    stageFromUrl: (
      url: string
    ): Promise<
      { ok: true; preview: ExtensionPluginInstallPreview } | { ok: false; error: string }
    > => ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_STAGE_URL, url),
    restage: (
      id: string
    ): Promise<
      { ok: true; preview: ExtensionPluginInstallPreview } | { ok: false; error: string }
    > => ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_RESTAGE, id),
    checkUpdates: (): Promise<{ checked: number; available: number; failed: number }> =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_CHECK_UPDATES),
    marketList: (refresh = false): Promise<ExtensionPluginMarketList> =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_MARKET_LIST, refresh),
    marketStage: (
      id: string,
      version?: string
    ): Promise<
      { ok: true; preview: ExtensionPluginInstallPreview } | { ok: false; error: string }
    > => ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_MARKET_STAGE, id, version),
    setMarketChinaMirror: (on: boolean): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_MARKET_SET_MIRROR, on),
    readme: (request: {
      id: string;
      from: 'installed' | 'market';
    }): Promise<{ ok: true; markdown: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_README, request),
    commit: (token: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_COMMIT, token),
    discard: (token: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_DISCARD, token),
    setEnabled: (id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_SET_ENABLED, id, enabled),
    setCrossSessionInject: (
      id: string,
      allowed: boolean
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_SET_CROSS_SESSION_INJECT, id, allowed),
    setDevWatch: (id: string, on: boolean): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_SET_DEV_WATCH, id, on),
    approvePending: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_APPROVE_PENDING, id),
    rejectPending: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_REJECT_PENDING, id),
    uninstall: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_UNINSTALL, id),
    configGet: (
      id: string
    ): Promise<{ ok: true; fields: ExtensionPluginConfigField[] } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_CONFIG_GET, id),
    logs: (id: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_LOGS, id),
    /** 省略的键不变，null 清除 */
    configSet: (
      id: string,
      patch: Record<string, string | number | boolean | null>
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_CONFIG_SET, id, patch),
    artifactsList: (
      pluginId?: string
    ): Promise<{ ok: true; artifacts: PluginArtifactInfo[] } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_ARTIFACTS_LIST, pluginId),
    artifactRead: (
      id: string
    ): Promise<
      { ok: true; info: PluginArtifactInfo; base64: string } | { ok: false; error: string }
    > => ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_ARTIFACT_READ, id),
    artifactDelete: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_ARTIFACT_DELETE, id),
    artifactSave: (
      id: string
    ): Promise<{ ok: true; cancelled?: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_ARTIFACT_SAVE, id),
    viewStateGet: (
      pluginId: string
    ): Promise<{ ok: true; state: Record<string, string> } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_VIEW_STATE_GET, pluginId),
    viewStateSet: (
      pluginId: string,
      patch: Record<string, string | null>
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_VIEW_STATE_SET, pluginId, patch),
    pickPath: (
      kind: 'file' | 'directory'
    ): Promise<
      { ok: true; path: string } | { ok: true; cancelled: true } | { ok: false; error: string }
    > => ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_PICK_PATH, kind),
    call: (request: {
      pluginId: string;
      method: 'command.run' | 'trigger.candidates' | 'trigger.pick' | 'renderer.call';
      payload: Record<string, unknown>;
      sessionId: string | null;
    }): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_CALL, request),
    asset: (
      pluginId: string,
      rel: string
    ): Promise<{ ok: true; mime: string; base64: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_ASSET, pluginId, rel),
    onDraftRequest: (
      callback: (request: {
        requestId: string;
        sessionId: string;
        op:
          | 'readDraft'
          | 'insertText'
          | 'replaceDraft'
          | 'focusSession'
          | 'focusSubagent'
          | 'openChildRun'
          | 'createSession'
          | 'ensureSession'
          | 'openPluginView'
          | 'closePluginView';
        payload: Record<string, unknown>;
      }) => void
    ): (() => void) => {
      const listener = (_e: unknown, request: Parameters<typeof callback>[0]) => callback(request);
      ipcRenderer.on(IPC_CHANNELS.EXTENSION_PLUGINS_DRAFT_REQUEST, listener);
      return () =>
        ipcRenderer.removeListener(IPC_CHANNELS.EXTENSION_PLUGINS_DRAFT_REQUEST, listener);
    },
    onViewEvent: (
      callback: (event: { pluginId: string; name: string; data: unknown }) => void
    ): (() => void) => {
      const listener = (_e: unknown, event: Parameters<typeof callback>[0]) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.EXTENSION_PLUGINS_VIEW_EVENT, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.EXTENSION_PLUGINS_VIEW_EVENT, listener);
    },
    respondDraft: (
      response:
        | { requestId: string; ok: true; value: unknown }
        | { requestId: string; ok: false; code: string; error: string }
    ): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_PLUGINS_DRAFT_RESPONSE, response),
  },

  /** 仅远程浏览器里的 web-preload 提供 */
  remote: undefined as RemoteApi | undefined,
};

export type ElectronAPI = typeof electronAPI;

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

import type { ComputerAllowedApp, ComputerCapabilities } from '@shared/computer/types';
import type { PluginArtifactInfo } from '@shared/extensionPlugins/protocol';
import type {
  ExtensionPluginConfigField,
  ExtensionPluginInstallPreview,
  ExtensionPluginMarketList,
  ExtensionPluginNotice,
  ExtensionPluginSummary,
  RegistryNotice,
} from '@shared/extensionPlugins/types';
