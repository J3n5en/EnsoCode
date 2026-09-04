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
import type { BrowserSearchTab } from '@shared/searchAnything';
import type { SettingsDeepLink } from '@shared/settingsDeepLink';
import type {
  AssetOccupancyRow,
  CollectedAsset,
  CollectedProvider,
  FilesListResult,
  FilesReadRelResult,
  FilesWatchEvent,
  FilesWatchResult,
  FilesWriteResult,
  GitDiffResult,
  ListModelsResult,
  LocalAssetScanResult,
  LocalProviderScanResult,
  ModelMetaQuery,
  ModelMetaResult,
  OauthAccountUsage,
  OauthProviderInfo,
  PairCatalogPayload,
  PairCreatedSession,
  PairQueueAction,
  PairSessionConfig,
  PairStatus,
  ProviderApiConfig,
  RecentProject,
  SshConnection,
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
  CreateConversationAuthorityRequest,
  CreateProjectAuthorityRequest,
  DispatchMainEvent,
  McpStatusEvent,
  McpStatusPush,
  ProjectAuthorityProjection,
  RemoveProjectAuthorityRequest,
  RendererAgentEvent,
  SelectProjectAuthorityRequest,
  SourceAuthorityProjection,
  ThinkingLevel,
  UpdateConversationSelectionRequest,
} from '@shared/types/agent';
import { parseDispatchMainEvent } from '@shared/types/agent';
import type {
  BrowserClearKind,
  BrowserDesignModeEvent,
  BrowserTabState,
} from '@shared/types/browser';
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
import type { UpdateStatus } from '@shared/types/updater';
import type { SessionWorktree, WorktreeStatus } from '@shared/types/worktree';
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

  usage: {
    summary: (days: UsageRangeDays): Promise<UsageSummaryResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.USAGE_SUMMARY, days),
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
    listProjectSkills: (cwd: string): Promise<{ name: string; description: string }[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.ASSETS_LIST_PROJECT_SKILLS, cwd),
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
  },

  git: {
    diffHead: (request: { conversationId: string; projectId: string }): Promise<GitDiffResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_DIFF_HEAD, request),
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
      images?: AttachedImage[]
    ): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_PROMPT, sessionId, text, images),
    steer: (
      sessionId: string,
      text: string,
      images?: AttachedImage[]
    ): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_STEER, sessionId, text, images),
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
    /** 标题总结：只传 id + 首条消息文本（+会话模型作回退链末级），凭证由 Main 自读；结果经 title-generated 事件回流 */
    summarizeTitle: (
      conversationId: string,
      text: string,
      sessionModel?: { providerId: string; modelId: string }
    ): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_SUMMARIZE_TITLE, {
        conversationId,
        text,
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
    stopTask: (sessionId: string, taskId: string): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_TASK_STOP, sessionId, taskId),
    /** 手动压缩上下文；忙碌时 worker 自行排队，进度经 compaction 事件回来 */
    compact: (sessionId: string, instructions?: string): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_COMPACT, sessionId, instructions),
    /** 回退到倒数第 N+1 条 user 消息（0 = 最后一条）；结果经 rewind-done 事件回来。
     *  restoreFiles 同时把工作树还原到该轮首个写操作前(无快照静默降级) */
    rewind: (
      sessionId: string,
      userIndexFromEnd: number,
      restoreFiles?: boolean
    ): Promise<AgentActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_REWIND, sessionId, userIndexFromEnd, restoreFiles),
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
    test: (id: string): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SSH_CONNECTIONS_TEST, id),
    listDirs: (
      id: string,
      path?: string
    ): Promise<{ ok: true; path: string; dirs: string[] } | { ok: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SSH_CONNECTIONS_LIST_DIRS, id, path),
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
    /** main 通知：手机操作了排队消息，应用到会话 store */
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

  workspaceSearch: {
    query: (request: WorkspaceSearchQueryRequest): Promise<WorkspaceSearchQueryResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SEARCH_QUERY, request),
  },
};

export type ElectronAPI = typeof electronAPI;

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
