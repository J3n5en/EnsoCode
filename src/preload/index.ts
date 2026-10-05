import type { BotTemplateLibrary } from '@shared/bots/templateLibrary';
import type {
  BtwAbortRequest,
  BtwDisposeRequest,
  BtwPromptRequest,
  BtwPromptResult,
  BtwSpawnRequest,
} from '@shared/btw';
import type { AgentTypeRegistrySnapshot } from '@shared/builtinAgents';
import type {
  CapabilityAskDecisionAck,
  CapabilityAskRequest,
  CapabilityAskResponse,
  OauthFlowControlRequest,
  OauthFlowEvent,
  OauthFlowPromptResponse,
  StartOauthResult,
  StartOauthWizardRequest,
} from '@shared/capabilities/types';
import type {
  ChatModelDto,
  DistillableSessionDto,
  EmbeddingDownloadProgressDto,
  EmbeddingModelDto,
  EvolvesEdgeDto,
  MemoryDetail,
  MemoryJobsSnapshot,
  MemoryListQuery,
  MemoryListResult,
  MemoryMutationResult,
  MemoryStats,
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
import type { PlanRespondAction } from '@shared/planMode';
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
import type { SettingsDeepLink } from '@shared/settingsDeepLink';
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
  FilesReadImageResult,
  FilesReadRelResult,
  FilesSearchRequest,
  FilesSearchResult,
  FilesWatchEvent,
  FilesWatchResult,
  FilesWriteResult,
  GitDiffResult,
  InstalledPluginInfo,
  ListModelsResult,
  LocalAssetScanResult,
  LocalProviderScanResult,
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
import { IPC_CHANNELS } from '@shared/types';
import type {
  AgentActionResult,
  AgentSpawnRequest,
  ApprovalDecision,
  ApprovalMode,
  AttachedImage,
  AuthorityMutationResult,
  ChildHistoryResult,
  ConversationAuthorityProjection,
  ConversationAuthorityRequest,
  ConversationReloadResult,
  CreateConversationAuthorityRequest,
  CreateProjectAuthorityRequest,
  DispatchMainEvent,
  McpStatusEvent,
  McpStatusPush,
  ParentHistoryTailResult,
  ProjectAuthorityProjection,
  RemoveProjectAuthorityRequest,
  RendererAgentEvent,
  SelectProjectAuthorityRequest,
  SourceAuthorityProjection,
  ThinkingLevel,
  TitleSummaryInput,
  UpdateConversationSelectionRequest,
} from '@shared/types/agent';
import { parseDispatchMainEvent } from '@shared/types/agent';
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
  BrowserClearKind,
  BrowserDesignModeEvent,
  BrowserTabState,
} from '@shared/types/browser';
import type { SessionChangeSnapshots } from '@shared/types/fileChanges';
import type {
  AgentComposerPrefillEvent,
  AgentDispatchRequest,
  AgentDispatchResult,
  AgentSummonRequest,
  MainModelSelectionBindingResult,
  ParentModelSelectionRequest,
  ParentSourceBindingRequest,
  ParentSourceBindingResult,
} from '@shared/types/mentions';
import type {
  NodeActionResult,
  NodeMessage,
  NodePairResult,
  NodesStatus,
} from '@shared/types/nodes';
import type { ExternalSessionSource, SimpleMessage } from '@shared/types/sessionImport';
import type {
  TerminalCreateRequest,
  TerminalCreateResult,
  TerminalDataEvent,
  TerminalExitEvent,
} from '@shared/types/sidePanel';
import type {
  SpeechDownloadProgressDto,
  SpeechModelId,
  SpeechPartialDto,
  SpeechStatusDto,
  SpeechTranscribeResult,
} from '@shared/types/speech';
import type { UpdateStatus } from '@shared/types/updater';
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
import type { BotUsageOverviewResult, BotUsageSummaryResult } from '@shared/usage/botUsage';
import type { UsageRangeDays, UsageSummaryResult } from '@shared/usage/types';
import type {
  WorkspaceSearchQueryRequest,
  WorkspaceSearchQueryResult,
} from '@shared/workspaceSearchQuery';
import { contextBridge, ipcRenderer, webUtils } from 'electron';

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
    writeKey: (name: string, value: unknown): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_WRITE_KEY, name, value),
    /** 其他窗口修改设置后触发，用于多窗口同步 */
    onChanged: (callback: () => void): (() => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.SETTINGS_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SETTINGS_CHANGED, listener);
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

  memory: {
    list: (query: MemoryListQuery): Promise<MemoryListResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_LIST, query),
    detail: (id: string): Promise<MemoryDetail | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_DETAIL, id),
    archive: (id: string): Promise<MemoryMutationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_ARCHIVE, id),
    restore: (id: string): Promise<MemoryMutationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_RESTORE, id),
    delete: (id: string): Promise<MemoryMutationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_DELETE, id),
    stats: (): Promise<MemoryStats> => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_STATS),
    jobs: (): Promise<MemoryJobsSnapshot> => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_JOBS),
    clearJobs: (): Promise<number> => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_JOBS_CLEAR),
    evolvesPending: (): Promise<EvolvesEdgeDto[]> =>
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

  speech: {
    status: (): Promise<SpeechStatusDto> => ipcRenderer.invoke(IPC_CHANNELS.SPEECH_STATUS),
    download: (modelId: SpeechModelId): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.SPEECH_DOWNLOAD, modelId),
    cancelDownload: (modelId: SpeechModelId): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.SPEECH_CANCEL, modelId),
    remove: (modelId: SpeechModelId): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.SPEECH_DELETE, modelId),
    /** 16kHz 单声道 PCM；首块到达即开会话 */
    pushAudio: (sessionId: string, audio: Float32Array): void =>
      ipcRenderer.send(IPC_CHANNELS.SPEECH_SESSION_PUSH, sessionId, audio),
    finishSession: (sessionId: string): Promise<SpeechTranscribeResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.SPEECH_SESSION_FINISH, sessionId),
    cancelSession: (sessionId: string): void =>
      ipcRenderer.send(IPC_CHANNELS.SPEECH_SESSION_CANCEL, sessionId),
    onPartial: (listener: (partial: SpeechPartialDto) => void): (() => void) => {
      const handler = (_event: unknown, partial: SpeechPartialDto) => listener(partial);
      ipcRenderer.on(IPC_CHANNELS.SPEECH_PARTIAL, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SPEECH_PARTIAL, handler);
    },
    requestMicAccess: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.SPEECH_MIC_ACCESS),
    onProgress: (listener: (progress: SpeechDownloadProgressDto) => void): (() => void) => {
      const handler = (_event: unknown, progress: SpeechDownloadProgressDto) => listener(progress);
      ipcRenderer.on(IPC_CHANNELS.SPEECH_PROGRESS, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SPEECH_PROGRESS, handler);
    },
    onStatusChanged: (listener: () => void): (() => void) => {
      const handler = () => listener();
      ipcRenderer.on(IPC_CHANNELS.SPEECH_STATUS_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SPEECH_STATUS_CHANGED, handler);
    },
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
    listInstalledPlugins: (): Promise<InstalledPluginInfo[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.PLUGINS_LIST_INSTALLED),
    collectImport: (scanId: string, candidateIds: string[]): Promise<CollectedAsset[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.ASSETS_COLLECT_IMPORT, scanId, candidateIds),
    listProjectSkills: (cwd: string): Promise<{ name: string; description: string }[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.ASSETS_LIST_PROJECT_SKILLS, cwd),
    /** 按会话列出工作流预设；项目根由 Main 从会话记录推导 */
    listWorkflowPresets: (conversationId: string): Promise<WorkflowPresetSummary[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.ASSETS_LIST_WORKFLOW_PRESETS, conversationId),
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
    /** local 为 false 时读源文件，为 true 时读本地副本 */
    read: (
      id: string,
      local: boolean,
      sourcePath?: string
    ): Promise<{ ok: boolean; content: string; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.INSTRUCTIONS_READ, id, local, sourcePath),
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
    search: (request: FilesSearchRequest): Promise<FilesSearchResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILES_SEARCH_WORKSPACE, request),
  },

  files: {
    /** 在 root 下按文件名/路径模糊搜索（@ 提及用） */
    search: (root: string, query: string): Promise<{ relativePath: string; name: string }[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILES_SEARCH, root, query),
    /** 取粘贴/拖入的 File 对象的磁盘路径（渲染层拿不到，需经 webUtils） */
    pathForFile: (file: File): string => webUtils.getPathForFile(file),
    /** 读取文件内容（edit diff 还原上下文/行号用）；失败返回 null */
    read: (filePath: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILES_READ, filePath),
    /** 枚举目录下的媒体文件（背景图文件夹随机模式），返回绝对路径 */
    listMedia: (dir: string): Promise<string[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILES_LIST_MEDIA, dir),
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
      images?: AttachedImage[],
      deliveryId?: string
    ): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_PROMPT, sessionId, text, images, deliveryId),
    steer: (
      sessionId: string,
      text: string,
      images?: AttachedImage[],
      deliveryId?: string
    ): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_STEER, sessionId, text, images, deliveryId),
    abort: (sessionId: string): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_ABORT, sessionId),
    abortRetry: (sessionId: string): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_ABORT_RETRY, sessionId),
    retry: (sessionId: string): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_RETRY, sessionId),
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
    /** 已结束 child 的只读历史；只传 conversationId，路径由 Main 推导 */
    readChildHistory: (conversationId: string): Promise<ChildHistoryResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_CHILD_HISTORY_READ, { conversationId }),
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
    setApprovalMode: (sessionId: string, mode: ApprovalMode): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_SET_APPROVAL_MODE, sessionId, mode),
    setPlanMode: (sessionId: string, active: boolean): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_SET_PLAN_MODE, sessionId, active),
    respondPlan: (
      sessionId: string,
      response: { planId: string; action: PlanRespondAction; feedback?: string }
    ): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_PLAN_RESPOND, sessionId, response),
    stopTask: (sessionId: string, taskId: string): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_TASK_STOP, sessionId, taskId),
    backgroundTool: (sessionId: string, toolCallId: string): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_TOOL_BACKGROUND, sessionId, toolCallId),
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
      anchor: { entryId: string } | { userIndexFromEnd: number }
    ): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_FORK, sessionId, targetConversationId, anchor),
    /** 上报当前正在查看的会话（null = 没在看任何会话），供 main 抑制重复的系统通知 */
    setViewedSession: (sessionId: string | null): void =>
      ipcRenderer.send(IPC_CHANNELS.NOTIFICATION_ACTIVE_SESSION, sessionId),
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

  capabilities: {
    onAsk: (callback: (request: CapabilityAskRequest) => void): (() => void) => {
      const listener = (_event: unknown, request: CapabilityAskRequest) => callback(request);
      ipcRenderer.on(IPC_CHANNELS.CAPABILITIES_ASK, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CAPABILITIES_ASK, listener);
    },
    respond: (response: CapabilityAskResponse): Promise<CapabilityAskDecisionAck> =>
      ipcRenderer.invoke(IPC_CHANNELS.CAPABILITIES_RESPOND, response),
  },

  proxy: {
    apply: (settings: {
      mode: string;
      customUrl: string;
    }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROXY_APPLY, settings),
  },

  updater: {
    checkForUpdates: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.UPDATER_CHECK),
    downloadUpdate: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.UPDATER_DOWNLOAD_UPDATE),
    quitAndInstall: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.UPDATER_QUIT_AND_INSTALL),
    setAutoUpdateEnabled: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.UPDATER_SET_AUTO_UPDATE_ENABLED, enabled),
    setAutoRestartWhenIdle: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.UPDATER_SET_AUTO_RESTART_WHEN_IDLE, enabled),
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
    remove: (nodeId: string): Promise<NodeActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.NODES_REMOVE, nodeId),
    rename: (nodeId: string, label: string): Promise<NodeActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.NODES_RENAME, nodeId, label),
    /** 发 @enso/pair 的 PhoneToHost 命令（main 按白名单校验后加密上行） */
    send: (nodeId: string, command: unknown): Promise<NodeActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.NODES_SEND, nodeId, command),
    onStatusChanged: (callback: (status: NodesStatus) => void): (() => void) => {
      const listener = (_: unknown, status: NodesStatus) => callback(status);
      ipcRenderer.on(IPC_CHANNELS.NODES_STATUS_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.NODES_STATUS_CHANGED, listener);
    },
    /** 解密后的 host 下行帧（catalog/projects/providers/agent-event/history） */
    onMessage: (callback: (message: NodeMessage) => void): (() => void) => {
      const listener = (_: unknown, message: NodeMessage) => callback(message);
      ipcRenderer.on(IPC_CHANNELS.NODES_MESSAGE, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.NODES_MESSAGE, listener);
    },
  },

  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MINIMIZE),
    maximize: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MAXIMIZE),
    close: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CLOSE),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_IS_MAXIMIZED),
    isFullScreen: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_IS_FULLSCREEN),
    setTrafficLightsVisible: (visible: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_SET_TRAFFIC_LIGHTS_VISIBLE, visible),
    openSettings: (link?: SettingsDeepLink): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_OPEN_SETTINGS, link),
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
    summonAgent: (request: AgentSummonRequest): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_SUMMON, request),
    onAgentComposerPrefill: (
      callback: (event: AgentComposerPrefillEvent) => void
    ): (() => void) => {
      const listener = (_event: unknown, prefill: AgentComposerPrefillEvent) => callback(prefill);
      ipcRenderer.on(IPC_CHANNELS.AGENT_COMPOSER_PREFILL, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_COMPOSER_PREFILL, listener);
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
    cloneChat: (request: { chatId: string; title: string }): Promise<BotChatWriteResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_CHAT_CLONE, request),
    stopChat: (chatId: string): Promise<BotActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOT_CHAT_STOP, { chatId }),
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
      viewport: { x: number; y: number; width: number; height: number } | null,
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
    setDevToolsViewport: (
      tabId: string,
      conversationId: string,
      viewport: { x: number; y: number; width: number; height: number } | null,
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
  },

  workspaceSearch: {
    query: (request: WorkspaceSearchQueryRequest): Promise<WorkspaceSearchQueryResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SEARCH_QUERY, request),
  },
};

export type ElectronAPI = typeof electronAPI;

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

import type { ComputerCapabilities } from '@shared/computer/types';
