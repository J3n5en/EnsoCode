import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  Agent,
  type AgentEvent,
  type AgentTool,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import {
  type Api,
  type AssistantMessage,
  getCurrentTools,
  isRetryableAssistantError,
  type Message,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  type InlineExtension,
  ModelRuntime,
  type PromptOptions,
  SessionManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { AGENT_COMPACTION_LOG } from '@shared/agentWorkerExit';
import { setAppLoggingEnabled } from '@shared/appLogFile';
import type { ApprovalAllowThreshold } from '@shared/approvalReviewRecord';
import { autoRetryOverrides, DEFAULT_AUTO_RETRY_LIMIT } from '@shared/autoRetry';
import { snapshotMainConversation } from '@shared/btw';
import {
  type ChildSessionIdentity,
  isSameChildSessionIdentity,
  type SessionIdentity,
} from '@shared/builtinAgents';
import { appendCappedLog } from '@shared/cappedLog';
import { WORKSPACE_WRITE_TOOL_ID } from '@shared/childProfileTools';
import { type CompactStrategy, resolveCompactStrategy } from '@shared/compactStrategy';
import {
  PLUGIN_AGENT_ARGS_MAX_CHARS,
  PLUGIN_AGENT_OUTPUT_MAX_CHARS,
  PLUGIN_AGENT_TEXT_MAX_CHARS,
  type PluginAgentRunEvent,
  type PluginAgentSource,
} from '@shared/extensionPlugins/protocol';
import type { PluginEventPlan, PluginToolDescriptor } from '@shared/extensionPlugins/types';
import {
  RESTART_CHECKPOINT_ARCHIVE,
  RESTART_CHECKPOINT_FILE,
  type RestartCheckpointEntry,
  restartGate,
  takeRestartCheckpoint,
  writeRestartCheckpoint,
} from '@shared/gracefulRestart';
import { isHeadlessRun } from '@shared/headlessRun';
import { HUMAN_REQUEST_TIMEOUT_MS } from '@shared/humanRequestTimeout';
import type { ImageGenerationState } from '@shared/imageGeneration';
import { DEFAULT_MAX_ACTIVE_COWORKERS } from '@shared/maxActiveCoworkers';
import { positiveContextWindow } from '@shared/modelCatalog';
import type { ModelDirectorySnapshot } from '@shared/modelDirectory';
import { cloneModelsDevOauthModel, findModelsDevModel } from '@shared/modelsDevCatalog';
import { isOauthAccountPool } from '@shared/oauthAccountPool';
import { resolveOauthCatalogModel } from '@shared/oauthCatalog';
import { ensureAccountProvider } from '@shared/piAccounts';
import { EMPTY_PLAN_STATE, PLAN_ENTRY_TYPE, parsePlanMessage } from '@shared/planMode';
import {
  type MaskReport,
  mergeMaskReports,
  PRIVACY_MASK_ENTRY,
  type PrivacyMaskRecord,
} from '@shared/privacyMask/report';
import { isClassifierOnlyProvider } from '@shared/providerCatalog';
import { ANTIGRAVITY_PROVIDER_ID, antigravityProviderConfig } from '@shared/providers/antigravity';
import { installCodexLinkedRefresh } from '@shared/providers/codexAuth';
import { DEVIN_PROVIDER_ID, devinProviderConfig } from '@shared/providers/devin';
import {
  QODER_CN_PROVIDER_ID,
  QODER_PROVIDER_ID,
  qoderProviderConfig,
} from '@shared/providers/qoder';
import { looksLikeRefusal } from '@shared/refusalRetry';
import { REMINDER_MAX_DELAY_MS, REMINDERS_FILE, toReminderSummary } from '@shared/reminders';
import type { RequestBodyUsage } from '@shared/requestBodyUsage';
import { turnCalledSilenceTurn, turnRequestedSilence } from '@shared/secretary/silence';
import { isSecretaryToolAllowed, type SecretaryInvokeOp } from '@shared/secretary/tools';
import { computeStats, toUsageTotals } from '@shared/sessionStats';
import type { SmartCompactMode } from '@shared/smartCompactMode';
import { buildSshShellCommand, shellQuote } from '@shared/ssh';
import { DEFAULT_SSH_TIMEOUT_SECONDS } from '@shared/sshTimeout';
import { toolBatchDigest } from '@shared/toolBatchLabel';
import { prependTurnNote, splitTurnNotes } from '@shared/turnNotes';
import type {
  AgentCommand,
  AgentRemoteConfig,
  AgentSessionCustomEntry,
  AgentTypeSpawnConfig,
  AgentWorkerEvent,
  ApprovalMode,
  AttachedImage,
  BackgroundTaskInfo,
  ChildConversationMetadata,
  ContextPart,
  CoworkerInfo,
  McpOAuthRefreshResult,
  McpServerSpawnConfig,
  MessageTiming,
  ModelRef,
  NodeStatus,
  ProjectedMessage,
  ResolvedAgentTypeSpawnConfig,
  RestartReplyProgress,
  RetrySkippedReason,
  SessionSnapshot,
  SlashCommand,
  SpawnModelConfig,
  SubagentModelOption,
  ThinkingLevel,
  VirtualClassifierCredentials,
} from '@shared/types/agent';
import { parseAgentSessionCustomEntry, STALE_SESSION_ERROR } from '@shared/types/agent';
import { type EditMode, resolveEditMode } from '@shared/types/editMode';
import type { ModelEntry } from '@shared/types/llm';
import { providerIdOfAccountKey } from '@shared/types/oauthProviders';
import type { SecretaryToolDescriptor } from '@shared/types/secretary';
import { classifyUpstreamError } from '@shared/upstreamRecovery';
import { VIRTUAL_PROVIDER_ID } from '@shared/virtualModels';
import type { WebSearchChainEntry } from '@shared/webSearchChain';
import type { WindowsLocalShell } from '@shared/windowsLocalShell';
import { AgentControlInvoker } from './agentControl';
import {
  createApplyPatchTool,
  createRemoteApplyPatchIo,
  getApplyPatchPaths,
  validateApplyPatchTargets,
} from './applyPatch';
import { applyPatchResultExtension } from './applyPatchResultExtension';
import {
  ApprovalGate,
  type ApprovalReviewResult,
  withApproval,
  withMandatoryApproval,
  withProtectedFloor,
} from './approval';
import {
  APPROVAL_REVIEW_TIMEOUT_MS,
  buildApprovalClassifierRequest,
  buildApprovalReviewSystemPrompt,
  buildApprovalReviewUserPrompt,
  computeApprovalActionHash,
  decideFromApprovalClassifier,
  decideManagedApproval,
  normalizeReviewDecision,
  recentReviewMessages,
} from './approvalReview';
import { approvalReviewResultExtension } from './approvalReviewRecords';
import { AskManager, createAskTool } from './ask';
import { ensureAssistantUsage } from './assistantUsage';
import { auxiliaryReasoning } from './auxiliaryReasoning';
import {
  BackgroundTaskManager,
  createTaskTools,
  foregroundCommandTimeoutMs,
  withBackground,
} from './backgroundTasks';
import { enabledHotBuiltins, nextActiveToolNames } from './builtinLoadout';
import { CheckpointManager, withCheckpoint } from './checkpoint/manager';
import { createRemoteCheckpointHost } from './checkpoint/remoteHost';
import {
  appendSystemPromptExtension,
  SUBAGENT_CONTRACT_PROMPT,
  tailSystemPromptSection,
} from './childContract';
import {
  type ChildThinkingLevel,
  fitChildReasoningToModel,
  pickChildReasoningOverride,
  resolveChildReasoning,
} from './childReasoning';
import {
  CODEMODE_FORBIDDEN_TOOLS,
  CODEMODE_TOOL_NAME,
  CodemodeHost,
  isDeferredMcp,
  prepareCodemodeInput,
} from './codemode';
import {
  collectContextOccupancy,
  estimateConversationTokens,
  type OccupancyBranchEntry,
  type OccupancySkill,
} from './contextOccupancy';
import { buildContextParts } from './contextParts';
import {
  type ContextUsageTracker,
  contextBreakdownMessages,
  toAnchorMessage,
  ContextUsageTracker as UsageTracker,
} from './contextUsage';
import {
  cancelContinuousMemory,
  continuousMemoryInlineExtension,
} from './continuousMemory/extension';
import { CURSOR_PROVIDER_ID, loadCursorProvider } from './cursor/loadProvider';
import {
  attachCursorBridgeToSession,
  type CursorSessionBridge,
  indexCursorTools,
  isCursorModel,
} from './cursor/sessionBridge';
import {
  installPushedCustomProviders,
  type ModelDirectoryPushState,
  previewModelDirectoryPush,
  registerCustomProviderModels,
} from './customProviderRegistry';
import { createDcgGuard, withDcgExemptions, withTempRootGuard } from './dcg';
import {
  appendInterruptedTasks,
  DETACHED_TASKS_FILE,
  INTERRUPTED_TASKS_FILE,
  takeDetachedTasksManifest,
  takeInterruptedTasks,
  writeDetachedTasksManifest,
} from './detachedTasksManifest';
import { omitNamedTools } from './disallowedTools';
import { createNormalizedEditTool } from './editTool';
import { type CompactCancel, formatCompactCancel, takeCompactCancel } from './ensoCompact/cancel';
import type { EnsoCompactOptions } from './ensoCompact/types';
import {
  createExploreFoldState,
  createExploreFoldTools,
  exploreFoldExtension,
} from './exploreFold';
import { OperationGate } from './gate';
import { createGoalTools } from './goal';
import {
  buildGoalVerifierRequest,
  GOAL_VERIFIER_SYSTEM_PROMPT,
  GOAL_VERIFIER_TIMEOUT_MS,
  parseGoalVerdict,
} from './goalVerifier';
import { readHarnessRuleFiles, resolveHarnessSkillRoots } from './harnessAssets';
import { type ContextMessage, sanitizeContextMessages } from './imageContext';
import { localReadOperations } from './localReadOperations';
import { installLongCacheRetention } from './longCacheRetention';
import { McpManager } from './mcp';
import { partitionMcpNamespaces } from './mcpNames';
import { MCP_SERVER_REGISTRY_DIR } from './mcpStdio';
import { createMessageCoworkerTool } from './messageCoworker';
import { createMessageMainTool } from './messageMain';
import { microcompactExtension } from './microcompact';
import { installModelContextCompat } from './modelContextCompat';
import { modelsDevModelsFromEnv } from './modelsDevCache';
import { ParentNotifier } from './notify';
import {
  installOauthPoolSelector,
  type OauthPoolSelector,
  oauthPoolRecoveryExtension,
  releaseOauthPoolSession,
  resetOauthPoolActivity,
  resolveOauthPoolModel,
} from './oauthAccountPool';
import { outputLimitRecoveryExtension } from './outputLimitRecovery';
import {
  applyOwnerAskResolution,
  OWNER_GATE_AUDIT_LOG,
  OwnerGate,
  withOwnerGate,
} from './ownerGate';
import { withPathHints } from './pathHints';
import { PendingNotificationStore } from './pendingNotifications';
import { type PersonaHolder, personaExtension } from './personaExtension';
import { createSubmitPlanTool, PlanController, withPlanGate } from './planMode';
import {
  childPluginEventPlan,
  contextUsagePayload,
  createPluginEventsExtension,
  PluginEventInvoker,
} from './pluginEvents';
import { ReadLedger, withPathRecord, withPriorRead } from './priorRead';
import {
  configurePrivacyMasking,
  installPrivacyMasking,
  runWithPrivacySink,
} from './privacyMask/runtime';
import { createProjectSettingsManager } from './projectCode';
import { projectMessage } from './projection';
import { promptCatalogExtension } from './promptCatalog';
import { applyWorkerProxyEnv, runWithProviderProxy } from './proxyEnv';
import { withReadTruncationMeta } from './readTruncation';
import { enqueueReminder, REMINDER_QUEUE_LIMIT } from './reminderQueue';
import { createReminderTools, REMINDER_RETRY_MS, ReminderStore, reminderNotice } from './reminders';
import { withRequestBodyBudget } from './requestBodyBudget';
import { runWithRequestBodyObserver } from './requestBodyTelemetry';
import { budgetWrapUpPrompt, RequestBudget } from './requestBudget';
import { projectMessages, projectResumeTail } from './resumeSnapshots';
import { withRtkOptimization } from './rtk';
import { RunawayGuard } from './runawayGuard';
import {
  abortedReplyEntryId,
  batchSteering,
  buildSessionDisplayMessages,
  continueSessionActivity,
  editLatestAssistantForRetry,
  editUnfinishedAssistantForResume,
  markRestartResumedReply,
  settleInterruptedToolCalls,
  silentTurnRecoveryExtension,
  steerActiveSession,
  steerDetachable,
  withdrawFollowUps,
} from './sessionAdapter';
import {
  EVICTION_SWEEP_INTERVAL_MS,
  type EvictionCandidate,
  selectEvictable,
} from './sessionEviction';
import { branchSessionFromPersistedFile, resolveForkLeafId } from './sessionFork';
import { createSessionCommandTool } from './sessionShell';
import { sessionTempDir } from './sessionTempDir';
import { killRunGroup, sweepOrphanRuns } from './shell/detachedRun';
import { prepareElevation, withElevation } from './shell/elevation';
import { type SilentTurnKind, silentTurnKind } from './silentTurn';
import { skillChainExtension } from './skillChainExtension';
import { assignCompactRoute, providerKeyFor, smartCompactInlineExtension } from './smartCompact';
import {
  createSshExecutor,
  resolveSshControlPath,
  type SshExecutor,
  sshPasswordEnv,
} from './ssh/executor';
import { applyRemoteWorkingDirectory } from './ssh/posixPath';
import { createRemoteGrepToolDefinition } from './ssh/remoteGrep';
import { createRemoteOperations } from './ssh/remoteOperations';
import { installStreamGuard } from './streamGuard';
import {
  appendYieldJson,
  parseJsonFromAssistant,
  validateAgainstSchema,
  withAgentRead,
} from './structuredYield';
import { CoworkerIdleReminder, createUnifiedSubagentTool, lastAssistantText } from './subagent';
import {
  SystemReminderRegistry,
  systemReminderExtension,
  withSystemReminders,
} from './systemReminder';
import { awaitChecklist, settleChecklist } from './taskHygiene';
import {
  buildInitialTitleUserText,
  buildRollingTitleUserText,
  buildTurnDigest,
  buildTurnReport,
  describeTitleModel,
  extractTitle,
  ROLLING_TITLE_SYSTEM_PROMPT,
  TITLE_SYSTEM_PROMPT,
  titleRejectReason,
  titleSummaryTimeoutMs,
} from './titleSummary';
import { createTodoTool, TodoStaleReminder } from './todo';
import { decorateSessionTools } from './toolDecorators';
import { installStableToolOrder } from './toolOrder';
import { ToolOutputBudget } from './toolOutputBudget';
import { BrowserInvoker, createBrowserTools, withNavigateApproval } from './tools/browser';
import { ComputerInvoker, createComputerTool, withComputerApproval } from './tools/computer';
import { createDelegationTools, type DelegationOp } from './tools/delegation';
import { createGroupHistoryTool } from './tools/groupHistory';
import { createGroupTasksTool } from './tools/groupTasks';
import { confirmImageReference, createImageGenTool } from './tools/imageGen';
import { createImageViewTool } from './tools/imageView';
import { createMemoryTools, MemoryInvoker } from './tools/memory';
import { createPluginTools, PluginToolInvoker } from './tools/pluginTools';
import { createRoutineProposeTool } from './tools/routinePropose';
import { createSecretaryTools } from './tools/secretary';
import { createSecretaryCustomTools } from './tools/secretaryCustomTools';
import { confirmOutsideImage, createSendImageTool } from './tools/sendImage';
import { createSilenceTurnTool } from './tools/silenceTurn';
import { createSkillReadTool } from './tools/skills';
import { createWebTools } from './tools/web';
import {
  createTurnDiscardState,
  createTurnDiscardTools,
  type TurnDiscardState,
  turnDiscardExtension,
} from './turnDiscard';
import {
  consumeUnattendedNote,
  UNATTENDED_OFF_NOTE,
  UNATTENDED_ON_NOTE,
  unattendedPrompt,
  unattendedSwitchNote,
} from './unattended';
import { createVirtualChooser, resolveClassifierModel } from './virtualClassifier';
import { registerVirtualModel } from './virtualModels';
import { ACTIVE_WORKFLOW_RUN_IDS, createWorkflowTool, WORKFLOW_STOPPED_BY_USER } from './workflow';
import { claimInterruptedWorkflowRuns } from './workflowJournal';
import { listWorkflowPresets, loadWorkflowPreset, workflowPresetRoots } from './workflowPresets';
import { WorkspaceClaims, withExclusiveCommand, withFileClaims } from './workspaceClaims';
import { VIZ_GUIDANCE_PROMPT, WORKSPACE_POLICY_PROMPT } from './workspacePolicy';
import { WorkspaceSwitchGate, workspaceBranchContextExtension } from './workspaceSwitch';
import { extractEditTargetPath, withWritePreflight, withWriteScope } from './writeScope';

/** 子会话产物：实际 session、模型与精确工具集合。 */
interface ChildSessionResult {
  session: AgentSession;
  modelId: string;
  modelRef: { providerId: string; modelId: string };
  toolIds: string[];
  proofToolIds: string[];
  runawayGuard?: RunawayGuard;
  requestBudget?: RequestBudget;
  pluginTools?: PluginToolInvoker;
  pluginEvents?: PluginEventInvoker;
}

/** 子会话在插件侧的身份；没有就不挂插件能力 */
interface ChildPluginSource {
  identity: SessionIdentity;
  kind: PluginAgentSource['kind'];
  name: string;
}

/** 会话工厂：父 runtime/resource/tool 配置的唯一 child 创建入口。 */
interface SessionFactory {
  cwd: string;
  /** gate 验收命令执行器(远程会话走 ssh,本地会话走 /bin/sh) */
  runGate: (gate: string) => Promise<string>;
  agentTypes: AgentTypeSpawnConfig[];
  subagentModels: SubagentModelOption[];
  modelId: string;
  createChildSession(opts: {
    agentType?: AgentTypeSpawnConfig;
    resolved?: ResolvedAgentTypeSpawnConfig;
    /** 主 agent 显式指定的模型,优先于 resolved/agentType 绑定模型 */
    modelOverride?: SpawnModelConfig;
    /** 派发时 /thinking 档位，赢过模型条目预设 */
    thinkingOverride?: ChildThinkingLevel;
    identity?: ChildSessionIdentity;
    gate: ApprovalGate;
    resumeFile?: string;
    extraTools?: unknown[];
    pluginSource?: ChildPluginSource;
    /** 临时会话：记录只在内存，不落 jsonl */
    ephemeral?: boolean;
    /** 没有 ChildSessionIdentity 的子会话（工具直雇 coworker）：后台任务按这个会话 id 归属 */
    sessionId?: string;
  }): Promise<ChildSessionResult>;
}

/** pi 未从包入口导出 `PromptDisposition`，从 `PromptOptions.preflightResult` 的参数推导。 */
type PromptDisposition = Parameters<NonNullable<PromptOptions['preflightResult']>>[0];

interface ForkBase {
  model: Model<Api>;
  messages: Message[];
  options?: SimpleStreamOptions;
  stream: StreamFn;
  /** 请求发出时会话的选择模型（虚拟模型为虚拟 id）；换过模型则前缀不同，fork 静默降级 */
  selection: { provider: string; id: string };
  /** 这次请求的回复；正常收尾（无工具调用）时接在前缀后面 */
  reply?: AssistantMessage;
}

/** fork 代理能真正执行的工具；其余照原样声明（保住缓存前缀）但调用时拒绝 */
const FORK_TOOLS = new Set(['read', 'grep', 'find', 'ls']);

interface AgentRunHold {
  id: string;
  /** 第一次持有起算的时限；设过即表示这次 Run 进入过持有 */
  holdTimer?: ReturnType<typeof setTimeout>;
  /** 到时限：due 时子代理正忙、待这一轮结束再告知；told 已要它交报告，回合结束不再持有 */
  expiry?: 'due' | 'told';
}

interface ManagedSession {
  identity: SessionIdentity;
  childIdentity?: ChildSessionIdentity;
  childMetadata?: ChildConversationMetadata;
  session: AgentSession;
  status: NodeStatus;
  seq: number;
  messages: ProjectedMessage[];
  customEntries: AgentSessionCustomEntry[];
  commands: SlashCommand[];
  modelId: string;
  toolIds: string[];
  proofToolIds: string[];
  currentTurnId?: string;
  /** 上一轮结束时 messages.length：本轮消息从这里开始，供 agent_end 切本轮摘要 */
  turnStartIndex: number;
  promptedRequestIds: Set<string>;
  browser?: BrowserInvoker;
  memory?: MemoryInvoker;
  delegation?: MemoryInvoker<DelegationOp>;
  secretary?: MemoryInvoker<SecretaryInvokeOp>;
  agentControl?: AgentControlInvoker;
  /** 已因不支持 adaptive 降级过的模型（虚拟模型下每个成员各降一次） */
  adaptiveDowngraded: Set<string>;
  computer?: ComputerInvoker;
  pluginTools?: PluginToolInvoker;
  pluginEvents?: PluginEventInvoker;
  ownerGate?: OwnerGate;
  /** 最近一次 auto_retry_start 携带的原始错误（取消重试时的终态错误文案） */
  lastRetryError?: string;
  /** 无人值守开关翻转后待告知模型的一条提示（只追加，不重开会话） */
  unattendedNote?: string;
  /** 回合收尾时还有没表态的后台任务：清单搭下一条工具结果或进模型的消息，不另起一轮 */
  taskWrapUpPending?: boolean;
  /** 已在时间线提醒过的任务：同一批不重复提醒 */
  taskWrapUpNudged?: Set<string>;
  /** 本轮 pi 已做过回合内自动重试；轮次收口时清掉 */
  turnRetried?: boolean;
  /** 本轮被 abort 命令中断：收口时随 turn-completed 下发，各窗口据此不泵队列；新轮起点清掉 */
  turnAborted?: boolean;
  /** abort 时清掉 currentTurnId 前的原 turnId：中止后的收口仍用它，Main 才对得上这一轮（子代理 Run） */
  abortedTurnId?: string;
  /** 已见终态 agent_end、待 agent_settled 收口；failTurn 等提前收口时清掉，settled 不再重复收 */
  settlePending?: boolean;
  /** 排进 pi followUp 队列的用户 prompt：text 是 pi 队列里的那条文本，叫停撤回时据此对上 deliveryId */
  queuedPrompts?: { text: string; deliveryId?: string }[];
  /** 当前用户轮已做过一次空回复自动续跑 */
  silentTurnNudgeUsed: boolean;
  /** 推脱补发正文；缺省不重试 */
  refusalRetryPrompt?: string;
  /** 本 turnId 已补发过一次 */
  refusalRetriedTurn?: string;
  /** 本次空回复恢复的类型；post-tool 第二次仍空则失败 */
  silentTurnKind?: SilentTurnKind;
  runawayGuard?: RunawayGuard;
  /** 子代理请求软预算；只有带 requestBudget 标记的 Run 才 arm，主会话与 Bot 成员不 arm */
  requestBudget?: RequestBudget;
  timings: (MessageTiming | undefined)[];
  /** 最近一次 turn_start 时刻；pi 在发起每次模型请求前触发，下一条 assistant message_start 消费 */
  requestStartMs?: number;
  /** 当前模型请求的发出 / 首 token / 最近出 token 时刻；回复写完（message_end）清掉。重启等安全点时报给 Main */
  replyProgress?: RestartReplyProgress;
  toolStartAt: Map<string, number>;
  /** 在跑的工具调用名：重启等安全点时告诉 Main 在等哪个工具 */
  toolNames: Map<string, string>;
  toolDurations: Map<string, number>;
  /** 优雅重启：loop 停在下一次模型请求之前（新一轮的首个请求或工具批之后），消息已落盘；调用即放行 */
  restartHold?: () => void;
  /** 优雅重启等不到安全点、收尾时中止了正在写的回复：断点记成同一轮的模型请求，新进程续跑 */
  restartAbortedTurnId?: string;
  lastCompletedToolCallId?: string;
  /** 上一代 worker 的断点，parent-ready 之后据此续跑 */
  restartResume?: RestartCheckpointEntry;
  /** 流式增量合并窗口：窗口内只记下待发下标，窗口结束或遇到其他事件时发最新正文 */
  upsertTimer?: ReturnType<typeof setTimeout>;
  upsertPending?: number;
  gate: ApprovalGate;
  asks: AskManager;
  pendingTaskReminders: string[];
  /** 子会话自己起的后台任务的完成通知：只搭它的下一条工具结果，不为此唤起新回合 */
  childTaskNotices?: string[];
  /** AgentService 子代理 Run：从 prompt-child / retry 起，到这次 Run 的终态那一轮为止。
   *  回合结束时还有自己的后台任务就继续持有，任务完成时唤醒子代理接着这次 Run 跑 */
  agentRun?: AgentRunHold;
  /** 通知队列溢出只报一次 */
  reminderEvictionReported?: boolean;
  /** 忙碌时收到的手动压缩请求：本轮收束后自动执行（用户选择「排队」而非打断） */
  pendingCompact?: { instructions?: string };
  /**
   * 压缩进度与压完锚点，随快照下发。compaction 是瞬时事件且不重放，
   * 不存在这里的话 guest（手机刷新）重建投影时拿不到，压完提示会丢。
   */
  compaction?: 'queued' | 'running';
  /** 绝对消息 index 口径：压完那刻 messages.length（须在 reconcileMessages 之后取） */
  compactionNoticeAt?: number;
  /** 在跑的 workflow（同步与后台）；用户停止与会话释放时 abort */
  workflowRuns?: Map<string, AbortController>;
  factory?: SessionFactory;
  parentId?: string;
  coworkerName?: string;
  pendingRole?: string;
  /** 父会话 spawn 时带了系统提示词：秘书档案改了就地换正文 */
  persona?: PersonaHolder;
  /** 最近一次会话请求原样留底：插件 fork 代理据此重放前缀，命中同一份提示缓存 */
  forkBase?: ForkBase;
  /** 仅父会话：Plan 模式状态机（设置里关闭时缺省） */
  plan?: PlanController;
  /** 父会话：按 Main 推来的禁用列表增删已注册的内置工具 */
  applyBuiltinTools?: (disabled: readonly string[]) => void;
  /** 回合进行中到达的禁用列表：换工具表会让前缀缓存失效，留到回合收口再应用 */
  pendingBuiltinTools?: readonly string[];
  /** 下一条 prompt 产生的 user 消息的投递回执；id 为 null 表示该投递无乐观回显 */
  promptDelivery?: { id: string | null };
  /** 已入 pi steer 队列、尚未上屏的投递回执，与 pi 队列同序 */
  /** detach：Bot 插话结算时交回 Main；withdraw：用户在模型取用前撤回 */
  steerDeliveries?: { id: string | null; detach?: () => boolean; withdraw?: () => boolean }[];
  pendingBranch?: string;
  pendingBranchRequestId?: string;
  pendingVerifications?: number;
  /** 最近一轮的完整摘要(不含 gate),供 coworker report/wait 取用;由 settleRound 在每轮终态统一记入 */
  lastRoundSummary?: string;
  /** 等待本轮终态(idle/failed/销毁)的回调;由 settleRound 统一触发 */
  roundWaiters: Set<() => void>;
  /** 父正在 wait 阻塞等本轮;message_main_agent 据此免去冗余上报 */
  parentWaiting?: boolean;
  /** 已投递、尚未进入 running 的一轮(send 与 agent_start 之间);wait 据此不把它当空闲 */
  roundPending?: boolean;
  checkpoints?: CheckpointManager;
  coworkers: Map<string, CoworkerInfo>;
  pendingYieldSchema?: unknown;
  /** 最近一次收到命令或产生事件；闲置回收的计时起点 */
  lastActivityAt: number;
  /** 会话事件计数：排队 prompt 据此判断等待期间轮次是否还在产出（同时刻的事件也算） */
  activityNonce: number;
  contextUsage: ContextUsageTracker;
  requestBody?: RequestBodyUsage;
  /** 已发出、待挂到下一条 assistant 消息上的脱敏报告 */
  pendingPrivacyMask?: MaskReport;
  unsubscribe: () => void;
  /** 仅父会话：最近一次 spawn-parent 绑定的 Main 实例号，parent-ended 回显（Bot 宿主据此确定归属） */
  instanceId?: string;
}

/** 会话 spawn 时选中的常驻 MCP。授权后把当时没连上的工具补进这个会话。 */
interface McpHotplug {
  serverKeys: ReadonlySet<string>;
  adopt: (tools: readonly ToolDefinition[]) => void;
  pending: ToolDefinition[];
}

/** ManagedSession 上所有带 pendingCount 的能力字段 */
type PendingCounterKey = {
  [K in keyof ManagedSession]-?: NonNullable<ManagedSession[K]> extends {
    readonly pendingCount: number;
  }
    ? K
    : never;
}[keyof ManagedSession];

/**
 * 挂起判定的探针登记表：新增带 pendingCount 的能力而不登记会编译失败，
 * 不再靠驱逐 / 工作区锁两处手工清单各自记得补（曾漏 memory、delegation）。
 */
const PENDING_COUNTERS: Record<PendingCounterKey, true> = {
  browser: true,
  memory: true,
  delegation: true,
  secretary: true,
  agentControl: true,
  computer: true,
  pluginTools: true,
  pluginEvents: true,
};

export function hasPendingCalls(managed: ManagedSession): boolean {
  return (Object.keys(PENDING_COUNTERS) as PendingCounterKey[]).some(
    (key) => (managed[key]?.pendingCount ?? 0) > 0
  );
}

export interface SupervisorOptions {
  emit(event: AgentWorkerEvent): void;
  /** pi 全局目录（auth/models/settings），指到 app userData 下以隔离用户的 ~/.pi */
  agentDir: string;
  /** 会话 jsonl 目录 */
  sessionDir: string;
  /** 设置页新增的工作流预设目录（Main 写入，worker 只读） */
  workflowDir?: string;
  /** 应用 agent 数据目录（ENSO_AGENT_DATA_DIR）；给出时压缩取消原因追加到 compaction.log */
  dataDir?: string;
  /** 应用存放用户图片的目录（ENSO_USER_IMAGE_DIRS）：编码会话的 image_view 白名单里带上它 */
  userImageDirs?: readonly string[];
  /** 优雅重启拉起的新 worker：接管上一代留下的断点文件 */
  restartCheckpointFile?: string;
}

/** 指令走 loader 覆盖：去掉 agentDir 里的共享 AGENTS.md，再按会话前置一份；开关打开时追加项目内其它 harness 的规则文件。 */
function sessionAgentsFilesOverride(
  agentDir: string,
  instruction?: { path: string; content: string },
  extraFiles: Array<{ path: string; content: string }> = []
) {
  const resolvedAgentDir = path.resolve(agentDir);
  return (current: { agentsFiles: Array<{ path: string; content: string }> }) => ({
    agentsFiles: [
      ...(instruction ? [instruction] : []),
      ...current.agentsFiles.filter(
        (file) => path.resolve(path.dirname(file.path)) !== resolvedAgentDir
      ),
      ...extraFiles,
    ],
  });
}

function createSessionResourceLoader(options: {
  branchContext: InlineExtension;
  silentTurnRecovery: InlineExtension;
  oauthPoolRecovery?: InlineExtension;
  cwd: string;
  agentDir: string;
  noSkills: boolean;
  /** 类型化子代理:不装项目扩展(扩展注册的工具与 systemPrompt 注入是给主会话的,漏进去会让它误以为要再委派) */
  noExtensions?: boolean;
  skillPaths: string[];
  instruction?: { path: string; content: string };
  /** 远程会话:替换掉本地 cwd 扫描出的 AGENTS.md(cwd 在本机不存在),只用预取的远端文件 */
  remoteAgentsFiles?: Array<{ path: string; content: string }>;
  /** 远程会话:把系统提示里的 Windows 盘符 cwd 改回 POSIX */
  remoteSsh?: { host: string };
  /** 加载项目内 .claude/.codex/.cursor 的 skills 与规则文件；远程会话不适用（cwd 不在本机） */
  loadHarnessAssets?: boolean;
  /** 用户已信任的项目代码来源；未全部信任时不加载项目扩展与包 */
  trustedProjectCode?: readonly string[];
  pluginEvents?: { invoker: PluginEventInvoker };
  exploreFold?: ReturnType<typeof createExploreFoldState>;
  /** 主会话：允许丢弃插件自动投递触发的无关轮次 */
  turnDiscard?: TurnDiscardState;
  reminders?: SystemReminderRegistry;
  /** codemode / tool_search 与按需 MCP；排在最前，mcp_servers 段先于 persona 强制提示词写入 */
  codemode?: InlineExtension;
  /** 仅父会话：互斥压缩策略。 */
  compactStrategy?: CompactStrategy;
  smartCompactSummaryModel?: SpawnModelConfig;
  smartCompactMode?: SmartCompactMode;
  /** 已打开会话共用；设置变更后原地改，下一次压缩读最新模型 */
  compactRoute?: EnsoCompactOptions;
  /** 仅普通 parent：替换 pi 默认提示词开头的角色段落；会强制整段提示词，故排在扩展最后。 */
  persona?: PersonaHolder;
  /** skills/cwd 之后的真尾 */
  systemPromptAppend?: string;
  /** 真尾之后的短覆盖块 */
  systemPromptBoost?: string;
  /** 仅子会话：追加子代理行为合同到系统提示词（进 system prompt 才不会随压缩丢失） */
  childContract?: boolean;
  /** 无人值守：把「没人在线」写进系统提示词（同样为了不随压缩丢失） */
  autoRejectApprovals?: boolean;
  /** 无人值守时 ask_user 会转给秘书：换用转发变体 */
  askRelay?: boolean;
}): DefaultResourceLoader {
  const harness = options.loadHarnessAssets && !options.remoteAgentsFiles;
  const skillPaths = harness
    ? [...options.skillPaths, ...resolveHarnessSkillRoots(options.cwd)]
    : options.skillPaths;
  const persona = options.persona;
  const loader: DefaultResourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: createProjectSettingsManager(
      options.cwd,
      options.agentDir,
      options.trustedProjectCode ?? []
    ).settingsManager,
    noSkills: options.noSkills,
    ...(options.noExtensions ? { noExtensions: true } : {}),
    ...(skillPaths.length > 0 ? { additionalSkillPaths: skillPaths } : {}),
    // noExtensions 只挡磁盘上的项目/全局扩展；inline factory 不受影响，图片修剪对所有会话生效
    extensionFactories: [
      ...(options.codemode ? [options.codemode] : []),
      ...(options.oauthPoolRecovery ? [options.oauthPoolRecovery] : []),
      options.branchContext,
      applyPatchResultExtension,
      approvalReviewResultExtension,
      promptCatalogExtension,
      {
        name: 'image-context',
        hidden: true,
        factory: (pi) => {
          pi.on('context', (event) => ({
            messages: sanitizeContextMessages(
              event.messages as unknown as ContextMessage[]
            ) as unknown as typeof event.messages,
          }));
        },
      } satisfies InlineExtension,
      microcompactExtension(),
      outputLimitRecoveryExtension,
      ...(options.exploreFold ? [exploreFoldExtension(options.exploreFold)] : []),
      ...(options.turnDiscard ? [turnDiscardExtension(options.turnDiscard)] : []),
      ...(options.reminders ? [systemReminderExtension(options.reminders)] : []),
      ...(options.remoteSsh
        ? [
            {
              name: 'ssh-cwd-prompt',
              hidden: true,
              factory: (pi) => {
                pi.on('before_agent_start', (event) => {
                  applyRemoteWorkingDirectory(
                    event.systemPromptOptions,
                    options.cwd,
                    options.remoteSsh!.host
                  );
                });
              },
            } satisfies InlineExtension,
          ]
        : []),
      ...(!options.noExtensions && options.compactStrategy === 'continuous-memory'
        ? [
            continuousMemoryInlineExtension({
              model: options.smartCompactSummaryModel,
              mode: options.smartCompactMode,
              compact: options.compactRoute,
            }),
          ]
        : !options.noExtensions &&
            (options.compactStrategy === 'smart' || options.compactStrategy === 'codex-native')
          ? [
              smartCompactInlineExtension(
                options.compactRoute
                  ? null
                  : {
                      summaryModel: options.smartCompactSummaryModel,
                      mode: options.smartCompactMode,
                    },
                options.compactStrategy === 'codex-native',
                options.compactRoute
              ),
            ]
          : []),
      ...(options.pluginEvents ? [createPluginEventsExtension(options.pluginEvents.invoker)] : []),
      skillChainExtension(() => loader.getSkills().skills),
      options.silentTurnRecovery,
      appendSystemPromptExtension('workspace-policy', WORKSPACE_POLICY_PROMPT),
      appendSystemPromptExtension('viz-guidance', VIZ_GUIDANCE_PROMPT),
      ...(options.childContract
        ? [appendSystemPromptExtension('subagent-contract', SUBAGENT_CONTRACT_PROMPT)]
        : []),
      ...(options.autoRejectApprovals
        ? [appendSystemPromptExtension('unattended', unattendedPrompt(options.askRelay === true))]
        : []),
      ...(options.systemPromptAppend
        ? [tailSystemPromptSection('preset_tail', options.systemPromptAppend)]
        : []),
      ...(options.systemPromptBoost
        ? [tailSystemPromptSection('preset_boost', options.systemPromptBoost)]
        : []),
      ...(persona ? [personaExtension(persona)] : []),
    ],
    agentsFilesOverride: options.remoteAgentsFiles
      ? () => ({
          agentsFiles: [
            ...(options.instruction ? [options.instruction] : []),
            ...(options.remoteAgentsFiles ?? []),
          ],
        })
      : sessionAgentsFilesOverride(options.agentDir, options.instruction, [
          ...(harness ? readHarnessRuleFiles(options.cwd) : []),
        ]),
  });
  return loader;
}

/** Enso 不走 pi 的会话切换流程，session_shutdown 要自己发 */
async function emitSessionShutdown(session: AgentSession): Promise<void> {
  try {
    const runner = session.extensionRunner;
    if (runner.hasHandlers('session_shutdown')) {
      await runner.emit({ type: 'session_shutdown', reason: 'quit' });
    }
  } catch {}
}

async function emitPluginSessionStart(
  session: AgentSession,
  reason: 'startup' | 'resume'
): Promise<void> {
  try {
    const runner = session.extensionRunner;
    if (runner.hasHandlers('session_start')) {
      await runner.emit({ type: 'session_start', reason });
    }
  } catch {}
}

/**
 * pi 的 SessionManager._persist 在第一条 assistant 前不写文件；纯派发父容器永远没有 assistant，
 * 派发通知等 custom entry 只在内存里，resume 指向的文件也不存在。所以没有 assistant 时由我们强制落盘。
 *
 * `_rewriteFile()` 不会置 `flushed`：不补上，后续 entry 不追加，首条 assistant 还会以 `wx` 重建文件抛 EEXIST。
 * 依赖 pi 私有 API，升级需复检；回归测试断言落盘与重开结果，不断言内部调用。
 */
export function materializeSessionFile(session: AgentSession): void {
  const hasAssistant = (session.messages as { role?: string }[] | undefined)?.some(
    (message) => message?.role === 'assistant'
  );
  if (hasAssistant) return;
  const manager = session.sessionManager as unknown as {
    _rewriteFile?: () => void;
    flushed?: boolean;
  };
  try {
    if (typeof manager._rewriteFile !== 'function') return;
    manager._rewriteFile();
    manager.flushed = true;
  } catch {
    // 落盘失败不能弄挂派发；内存中的通知仍然可用。
  }
}

/** pi 的 branch() 只改内存叶子；jsonl 重开以最后一行为准。回退后写一条不可见锚点，重启才停在回退处。 */
export function persistRewindLeaf(session: AgentSession): void {
  session.sessionManager.appendCustomEntry('enso-rewind-leaf', { at: Date.now() });
  materializeSessionFile(session);
}

function requiredSessionFile(session: AgentSession): string {
  if (!session.sessionFile) throw new Error('SessionManager did not provide a session file.');
  return session.sessionFile;
}

/** pi 模型声明的输入类型里有没有图片：秘书转发的图据此决定给图片块还是只给路径 */
function acceptsImageInput(model: AgentSession['model']): boolean {
  return model?.input?.includes('image') === true;
}

function settingsModelRef(model: SpawnModelConfig): ModelRef {
  if (
    'settingsProviderId' in model &&
    typeof model.settingsProviderId === 'string' &&
    model.settingsProviderId
  ) {
    return { providerId: model.settingsProviderId, modelId: model.modelId };
  }
  throw new Error('Spawn model is missing its settings provider identity.');
}

function isSameGeneration(left: SessionIdentity, right: SessionIdentity): boolean {
  return left.sessionId === right.sessionId && left.generation === right.generation;
}

async function refreshWorkerProviderModels(
  runtime: ModelRuntime,
  providerId: string,
  options?: { force?: boolean }
): Promise<void> {
  try {
    await runtime.refresh({
      providers: [providerId],
      allowNetwork: true,
      ...(options?.force ? { force: true } : {}),
    });
  } catch {
    // 拉不到就留用该 provider 的兜底清单，不该让 worker 起不来
  }
}

/**
 * 注册 worker 自己的订阅 provider，并在解析会话模型前补齐联网发现的真实清单。
 */
export async function initializeWorkerRuntime(runtime: ModelRuntime): Promise<ModelRuntime> {
  // 推理发生在本进程：Main 侧注册过不算，worker 不注册就会以「未知 provider」流不起来
  runtime.registerProvider(ANTIGRAVITY_PROVIDER_ID, antigravityProviderConfig());
  runtime.registerProvider(DEVIN_PROVIDER_ID, devinProviderConfig());
  runtime.registerProvider(QODER_PROVIDER_ID, qoderProviderConfig('global'));
  runtime.registerProvider(QODER_CN_PROVIDER_ID, qoderProviderConfig('cn'));
  await loadCursorProvider(runtime);
  // 已关联 Codex 的账号也可能在 worker 里触发刷新，必须同样接管；须在按需注册克隆之前
  installCodexLinkedRefresh(runtime);
  // registerProvider 只触发 allowNetwork:false 的 refresh，拿到的是兜底清单；Main 侧界面
  // 展示的却是联网发现结果。必须拆成两次并各自吞错，避免一个 provider 的发现服务异常
  // 连带另一个拿不到清单；失败方只回退自己的兜底，worker 仍能启动。
  // await 而非 fire-and-forget：resolveBaseModel 紧接着就要用这份清单。
  // enso-server run 只允许打到用户配置的模型端点，不在启动时刷新订阅目录。
  if (!isHeadlessRun()) {
    await refreshWorkerProviderModels(runtime, ANTIGRAVITY_PROVIDER_ID);
    await refreshWorkerProviderModels(runtime, DEVIN_PROVIDER_ID);
    await refreshWorkerProviderModels(runtime, QODER_PROVIDER_ID);
    await refreshWorkerProviderModels(runtime, QODER_CN_PROVIDER_ID);
    await refreshWorkerProviderModels(runtime, CURSOR_PROVIDER_ID);
  }
  installModelContextCompat(runtime);
  return runtime;
}

/** 故障域 A：本进程持有全部活会话。同一会话的命令串行，不同会话并行。 */
export class SessionSupervisor {
  private readonly sessions = new Map<string, ManagedSession>();
  /** 优雅重启：请求后每次状态变化复查；committed 后不再推进任何会话，等 Main 换进程 */
  private restart?: {
    committed: boolean;
    deferredKey?: string;
    checkScheduled?: boolean;
    /** 重启会把能脱离的转后台命令交给下一代：安全点不等它们 */
    keepBackground?: boolean;
  };
  /** 进程收尾中：此后中止的子代理回合不是 Run 的结局 */
  private exiting = false;
  /** 上一代 worker 的断点，按 sessionId 等对应的 spawn-parent 认领 */
  private readonly restartResume = new Map<string, RestartCheckpointEntry>();
  private readonly gate = new OperationGate();
  private readonly workspaceSwitch = new WorkspaceSwitchGate(this.sessions);
  private readonly pendingCommands = new Map<string, number>();
  /** 正在 spawn、还没注册的父会话：重启等它落定时要报出来，不能悄悄等 */
  private readonly spawning = new Map<string, SessionIdentity>();
  private readonly mcp = new McpManager({
    emit: (event) => this.options.emit(event),
    refreshOAuth: (serverId, rejected) => this.requestMcpOAuthRefresh(serverId, rejected),
    processRegistryDir: () =>
      this.options.dataDir && path.join(this.options.dataDir, MCP_SERVER_REGISTRY_DIR),
  });
  private readonly mcpOAuthPending = new Map<string, (result: McpOAuthRefreshResult) => void>();
  /** 插件经 Main 发起的宿主 MCP 调用，按 requestId 可取消 */
  private readonly pluginMcpCalls = new Map<string, AbortController>();
  private readonly pluginAgentRuns = new Map<string, AbortController>();
  private readonly mcpHotplug = new Map<string, McpHotplug>();
  /** MCP access token 续期只在 Main 做（refresh_token 不进 worker）；超时按临时故障处理 */
  private readonly requestMcpOAuthRefresh = (
    serverId: string,
    rejected?: string
  ): Promise<McpOAuthRefreshResult> =>
    new Promise((resolve) => {
      const requestId = randomUUID();
      const finish = (result: McpOAuthRefreshResult) => {
        clearTimeout(timer);
        this.mcpOAuthPending.delete(requestId);
        resolve(result);
      };
      const timer = setTimeout(
        () => finish({ ok: false, unauthorized: false, error: 'MCP OAuth refresh timed out.' }),
        30_000
      );
      this.mcpOAuthPending.set(requestId, finish);
      this.options.emit({
        type: 'mcp-oauth-refresh',
        requestId,
        serverId,
        ...(rejected ? { rejected } : {}),
      });
    });
  private readonly bgTasks: BackgroundTaskManager;
  /** Bot 写成员在同一工作区的文件占用 / 全局命令独占（全部会话同进程共享） */
  private readonly workspaceClaims = new WorkspaceClaims();
  private runtimePromise: Promise<ModelRuntime> | null = null;
  private readonly oauthPoolPending = new Map<
    string,
    (command: Extract<AgentCommand, { type: 'oauth-pool-result' }>) => void
  >();
  private oauthPoolRecovery(): InlineExtension {
    return oauthPoolRecoveryExtension(
      this.selectOauthPool,
      (sessionId, accountKey, previousAccountKey, scope) => {
        const managed = [...this.sessions.values()].find(
          (item) => item.session.sessionId === sessionId
        );
        if (!managed) return;
        const entry: AgentSessionCustomEntry = {
          kind: 'oauth-account-selected',
          accountKey,
          ...scope,
          ...(previousAccountKey ? { previousAccountKey } : {}),
          at: Date.now(),
        };
        managed.session.sessionManager.appendCustomEntry('enso-agent-session', entry);
        managed.customEntries.push(entry);
        this.options.emit({
          type: 'session-custom-entry',
          identity: managed.identity,
          seq: ++managed.seq,
          entry,
        });
      }
    );
  }
  private readonly selectOauthPool: OauthPoolSelector = (
    settingsProviderId,
    modelId,
    failed,
    signal,
    excludedAccountKeys
  ) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('ChatGPT pool selection cancelled.'));
        return;
      }
      const requestId = randomUUID();
      const finish = (error?: string, key?: string, selectionReceipt?: string) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.oauthPoolPending.delete(requestId);
        if (error || !key) reject(new Error(error ?? 'ChatGPT pool selection failed.'));
        else resolve({ accountKey: key, ...(selectionReceipt ? { selectionReceipt } : {}) });
      };
      const abort = () => finish('ChatGPT pool selection cancelled.');
      const timer = setTimeout(() => finish('ChatGPT pool coordinator timed out.'), 30_000);
      signal?.addEventListener('abort', abort, { once: true });
      this.oauthPoolPending.set(requestId, (command) =>
        finish(command.error, command.accountKey, command.selectionReceipt)
      );
      this.options.emit({
        type: 'oauth-pool-select',
        requestId,
        settingsProviderId,
        modelId,
        ...(failed ? { failed } : {}),
        ...(excludedAccountKeys ? { excludedAccountKeys: [...excludedAccountKeys] } : {}),
      });
    });
  /** 不可回收的会话（桌面正在查看 / 手机订阅），由 Main 全量下发 */
  private pinned: ReadonlySet<string> = new Set();
  private readonly evictionTimer: ReturnType<typeof setInterval>;
  /** 代审来源：聊天模型走 JSON 契约，分类器（System One）走三选一概率 */
  private approvalReviewer: ApprovalReviewerSource | undefined;
  /** 所有已打开会话的压缩摘要路线；设置变更时原地改 */
  private readonly compactRoute: EnsoCompactOptions = {};
  private maxActiveCoworkers = DEFAULT_MAX_ACTIVE_COWORKERS;
  private autoRetryLimit = DEFAULT_AUTO_RETRY_LIMIT;
  private longCacheRetention = false;
  private readonly isLongCacheRetention = () => this.longCacheRetention;
  private disabledWorkflowPresets: string[] = [];
  /** undefined 跟随会话；空数组表示已配置但全部不可用，直接走 Exa。 */
  private webSearchChain: readonly WebSearchChainEntry[] | undefined;
  private imageGeneration: ImageGenerationState = { config: null };
  /**
   * Main 推送的统一模型目录。revision 与自定义 provider 语义都没变时不再注册。
   * 当前消费者是自定义 provider 预注册；快照本体由后续的全局 web_search
   * 候选链（按目录派生可原生搜索的模型）消费——不要当死代码删。
   */
  private modelDirectory: ModelDirectorySnapshot | undefined;
  private modelDirectoryPush: ModelDirectoryPushState | undefined;
  /** 父会话通知(合并投递):闲则注入合成提示唤醒,忙则挂 pending 搭下次工具结果 */
  private readonly notifier = new ParentNotifier((sessionId, text) => {
    this.deliverNotification(sessionId, text);
  });
  private readonly pendingNotifications: PendingNotificationStore;
  private readonly reminders: ReminderStore;
  /** 已请 Main 叫醒的根会话：同一会话在途只发一次，收到 fire/clear 或隔 60 秒才重发 */
  private readonly reminderDueSent = new Map<string, number>();
  /** 已请 Main 打开、打开后要把待投递通知交给新一轮的会话 */
  private readonly wakeOnOpen = new Set<string>();
  /** spawn 尚未注册完就到达的内置工具开关，注册后补用 */
  private readonly pendingBuiltinTools = new Map<
    string,
    { identity: SessionIdentity; disabled: string[] }
  >();
  private readonly completeTextAborts = new Map<string, AbortController>();
  private readonly completeTextPendingAborts = new Set<string>();
  private readonly classifyAborts = new Map<string, AbortController>();
  private readonly classifyPendingAborts = new Set<string>();

  private branchContextExtension(getSession: () => ManagedSession | undefined): InlineExtension {
    return workspaceBranchContextExtension(getSession, (requestId) => {
      const managed = getSession();
      if (!managed || this.sessions.get(managed.identity.sessionId) !== managed) return;
      this.options.emit({
        type: 'workspace-branch-context-consumed',
        identity: managed.identity,
        seq: ++managed.seq,
        requestId,
      });
    });
  }

  /** 子会话（coworker / child）创建时拷贝父档位，父会话切档后同步下去：
   *  否则子会话里已挂起的卡片仍会等人，与「切档即时生效」矛盾 */
  private applyApprovalModeToChildren(parentId: string, mode: ApprovalMode): void {
    const autoReject = this.sessions.get(parentId)?.gate.autoReject ?? false;
    for (const [id, child] of this.sessions) {
      if (id === parentId || child.parentId !== parentId) continue;
      const flipped = child.gate.autoReject !== autoReject;
      child.gate.mode = mode;
      child.gate.autoReject = autoReject;
      child.asks.autoReject = autoReject;
      if (flipped) child.unattendedNote = autoReject ? UNATTENDED_ON_NOTE : UNATTENDED_OFF_NOTE;
      child.gate.reconsider();
    }
  }

  private deliverNotification(sessionId: string, text: string): void {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;
    if (this.workspaceSwitch.defer(sessionId, () => this.deliverNotification(sessionId, text)))
      return;
    // 先入持久化账簿：通知只有在确认送达（user 消息进轮）或被工具结果搭车消费时才出账。
    // 送达是尽力而为且可能静默失败（pi 收尾期 defer 的 prompt 抛错无人观察、压缩期被拒），
    // 留在账簿里的条目由 pump 的各触发点收敛补投——这是「完成/失败/超时必然唤醒」的保证。
    this.queueReminder(managed, text);
    // 断点已落盘：不再唤起新回合，进持久化队列由下一代补投
    if (this.restart?.committed) return;
    // 已有一轮通知在起飞（roundPending）：这条留在账簿，那一轮的收口触发点会把它带上
    if (managed.roundPending) return;
    // 失败（含前台中止后按错误收口）同空闲：能接新回合就立即唤起，不攒到用户下一条消息
    if (managed.status !== 'running' && !managed.compaction && !managed.session.isCompacting) {
      this.promptNotification(managed, [text]);
    }
  }

  /**
   * 把一组通知合成一轮合成提示投给空闲会话。
   * 确认语义：pi 的 preflightResult 只在 prompt 被接受后回调（handled/queued/started），
   * 被拒收时不回调而是直接抛错——回调即视为送达，从账簿出清；拒收留在账簿由下一触发点补投。
   */
  private promptNotification(managed: ManagedSession, texts: string[]): void {
    managed.roundPending = true;
    const bundle = texts.join('\n\n---\n\n');
    // 合成提示不是用户输入：标 extension 让插件 input 拦截跳过。
    // 投影说空闲、pi 却还在跑时用 followUp 排进活轮，不抛 already processing
    void managed.session
      .prompt(`<agent-notification>\n${bundle}\n</agent-notification>`, {
        source: 'extension',
        streamingBehavior: 'followUp',
        preflightResult: () => {
          this.clearDeliveredNotifications(managed, texts);
        },
      })
      .finally(() => {
        if (managed.status !== 'running') managed.roundPending = false;
      })
      .catch(() => {
        // 拒收（压缩中 / pi 收尾中）不出账：条目留在账簿，由 pump 的下一触发点补投
      });
  }

  /** 出清已确认送达的账簿条目：按文本逐条移除（一条送达一条出账，同批未投的不误清） */
  private clearDeliveredNotifications(managed: ManagedSession, texts: string[]): void {
    let cleared = 0;
    for (const text of texts) {
      const index = managed.pendingTaskReminders.indexOf(text);
      if (index === -1) continue;
      managed.pendingTaskReminders.splice(index, 1);
      cleared += 1;
    }
    if (cleared > 0) this.persistPendingReminders(managed);
  }

  private queueReminder(managed: ManagedSession, text: string): void {
    if (enqueueReminder(managed.pendingTaskReminders, text) && !managed.reminderEvictionReported) {
      managed.reminderEvictionReported = true;
      console.warn(
        `[notify] pending reminders exceeded ${REMINDER_QUEUE_LIMIT}; oldest dropped for ${managed.identity.sessionId}`
      );
    }
    this.persistPendingReminders(managed);
  }

  private persistPendingReminders(managed: ManagedSession): void {
    this.pendingNotifications.save(managed.identity.sessionId, managed.pendingTaskReminders);
  }

  /** 会话还没打开（重启后认回的任务先结束）：直接落盘，会话打开时随 pendingTaskReminders 恢复 */
  private persistUnopenedNotification(sessionId: string, text: string): void {
    const texts = this.pendingNotifications.load(sessionId);
    enqueueReminder(texts, text);
    this.pendingNotifications.save(sessionId, texts);
  }

  /**
   * 通知只落了盘、没人叫醒的空闲根会话：请 Main 按恢复清单打开，打开后交给新一轮。
   * 本代也在重启时只存盘（下一代再叫）；子会话不随换代恢复，照旧等打开时补投
   */
  private requestWake(sessionId: string): void {
    if (
      this.restart ||
      sessionId.includes('::') ||
      this.sessions.has(sessionId) ||
      this.wakeOnOpen.has(sessionId)
    )
      return;
    this.wakeOnOpen.add(sessionId);
    this.options.emit({ type: 'session-wake-requested', sessionId });
  }

  /**
   * 重启认回的命令所在会话不会自动打开（渲染层点开只读 jsonl 尾窗，不 spawn）：
   * 任务变化不能只走带 identity 的事件，否则要等用户发消息打开会话才看得到
   */
  private emitUnopenedTasks(
    sessionId: string,
    tasks: BackgroundTaskInfo[] = this.bgTasks.snapshot(sessionId)
  ): void {
    this.options.emit({ type: 'unopened-background-tasks', sessionId, tasks });
  }

  /** 打开的会话没在续跑上一轮：攒下的完成通知立即开一轮；在续跑的由轮末补投 */
  private wakeAfterOpen(managed: ManagedSession): void {
    this.fireDueReminders(managed);
    if (!this.wakeOnOpen.delete(managed.identity.sessionId) || managed.currentTurnId !== undefined)
      return;
    this.flushPendingReminders(managed);
  }

  /** 提醒定时器到点：子会话直接处理；根会话请 Main 判定后回 reminders-fire（冷会话先打开） */
  private onRemindersDue(): void {
    const now = Date.now();
    const due = this.reminders.due(now);
    for (const owner of new Set(due.map((item) => item.sessionId))) {
      if (owner.includes('::')) {
        const child = this.sessions.get(owner);
        if (child) this.fireDueReminders(child);
        continue;
      }
      // 换代中不叫醒，下一代启动时补
      if (this.restart) continue;
      const managed = this.sessions.get(owner);
      // 正在跑且到点的都等空闲：轮末直接触发
      if (
        managed &&
        this.reminderBusy(managed) &&
        due.every((item) => item.sessionId !== owner || item.ifIdle)
      )
        continue;
      // 正在打开：就绪时补发
      if (!managed && this.spawning.has(owner)) continue;
      const sent = this.reminderDueSent.get(owner);
      if (sent !== undefined && now - sent < REMINDER_RETRY_MS) continue;
      this.reminderDueSent.set(owner, now);
      this.options.emit({ type: 'session-reminder-due', sessionId: owner });
    }
  }

  private reminderBusy(managed: ManagedSession): boolean {
    return (
      managed.status === 'running' ||
      managed.roundPending === true ||
      managed.currentTurnId !== undefined
    );
  }

  /**
   * 把该会话已到点的提醒交给它：先从存储删再投递，保证只发一次。
   * 正在跑且 ifIdle 的留到轮末；子代理不在 Run 里就丢弃（没人等它的结果）
   */
  private fireDueReminders(managed: ManagedSession): void {
    const id = managed.identity.sessionId;
    if (this.restart || this.sessions.get(id) !== managed) return;
    const child = id.includes('::');
    const busy = this.reminderBusy(managed);
    const texts: string[] = [];
    let chain = 0;
    for (const item of this.reminders.due(Date.now())) {
      if (item.sessionId !== id) continue;
      if (child && !managed.agentRun) {
        this.reminders.take(item.id);
        continue;
      }
      if (busy && item.ifIdle) continue;
      if (!this.reminders.take(item.id)) continue;
      texts.push(
        reminderNotice(item, this.reminders.missedWhileDown(item.id) ? Date.now() : undefined)
      );
      chain = Math.max(chain, item.chain);
    }
    if (texts.length === 0) return;
    this.reminders.setChain(id, chain);
    this.reminderDueSent.delete(id);
    const text = texts.join('\n\n---\n\n');
    if (child && busy) {
      managed.childTaskNotices ??= [];
      enqueueReminder(managed.childTaskNotices, text);
      return;
    }
    this.deliverNotification(id, text);
  }

  private restartDataDir(): string {
    return this.options.dataDir ?? path.dirname(this.options.sessionDir);
  }

  private workflowJournalDir(): string {
    return path.join(this.options.sessionDir, 'workflows');
  }

  /**
   * 回合收口 / 压缩结束等触发点补投账簿里未确认送达的通知（中止后 pi 收尾期间被拒的 prompt 也在这里）。
   * 不 splice 出账：条目由 user 消息进轮的确认（message_start 含 <agent-notification>）或工具结果搭车消费移除，
   * 投递本身静默失败（pi defer 窗口吞错）时下一轮触发点会再投——收敛而不是一次性尝试。
   */
  private flushPendingReminders(managed: ManagedSession): void {
    if (managed.pendingTaskReminders.length === 0) return;
    setTimeout(() => {
      if (managed.status === 'running' || managed.pendingTaskReminders.length === 0) return;
      this.deliverPendingNotifications(managed);
    }, 150);
  }

  /** 把账簿里全部未确认送达的通知合成一轮合成提示投给空闲会话（忙碌时不动：搭车消费或轮末再投） */
  private deliverPendingNotifications(managed: ManagedSession): void {
    if (this.sessions.get(managed.identity.sessionId) !== managed) return;
    if (managed.status === 'running' || managed.compaction || managed.session.isCompacting) return;
    if (this.restart?.committed) return;
    if (managed.roundPending) return;
    this.promptNotification(managed, [...managed.pendingTaskReminders]);
  }

  constructor(private readonly options: SupervisorOptions) {
    const restartFile = options.restartCheckpointFile;
    if (restartFile) {
      const archive = path.join(path.dirname(restartFile), RESTART_CHECKPOINT_ARCHIVE);
      for (const entry of takeRestartCheckpoint(restartFile, archive)?.sessions ?? []) {
        this.restartResume.set(entry.sessionId, entry);
      }
    }
    this.pendingNotifications = new PendingNotificationStore(
      path.join(options.sessionDir, 'pending-notifications')
    );
    this.reminders = new ReminderStore(
      path.join(options.sessionDir, REMINDERS_FILE),
      () => this.onRemindersDue(),
      (rootIds) => {
        for (const rootId of rootIds) {
          const reminders = this.reminders
            .forRoot(rootId)
            .sort((a, b) => a.dueAt - b.dueAt)
            .map(toReminderSummary);
          this.options.emit({
            type: 'session-reminders-changed',
            sessionId: rootId,
            reminders,
          });
        }
      }
    );
    this.bgTasks = new BackgroundTaskManager(
      {
        onStarted: (sessionId, task) => {
          const managed = this.sessions.get(sessionId);
          if (managed) {
            this.options.emit({
              type: 'task-started',
              identity: managed.identity,
              seq: ++managed.seq,
              task,
            });
          }
        },
        onOutput: (sessionId, taskId, tail, status, outputBytes) => {
          const managed = this.sessions.get(sessionId);
          if (managed) {
            this.options.emit({
              type: 'task-output',
              identity: managed.identity,
              seq: ++managed.seq,
              taskId,
              tail,
              status,
              ...(outputBytes !== undefined ? { outputBytes } : {}),
            });
          } else if (status === 'running') this.emitUnopenedTasks(sessionId);
        },
        onEnded: (sessionId, taskId, status, exitCode) => {
          const managed = this.sessions.get(sessionId);
          if (managed) {
            this.options.emit({
              type: 'task-ended',
              identity: managed.identity,
              seq: ++managed.seq,
              taskId,
              status,
              ...(exitCode !== undefined ? { exitCode } : {}),
            });
          }
          // 转后台的命令结束：可能刚好到了安全点（完成通知在同一同步段里入队，检查时一并投递）
          this.scheduleRestartCheck();
        },
        onLevel: (sessionId, tasks) => {
          const managed = this.sessions.get(sessionId);
          if (managed) {
            this.options.emit({
              type: 'background-tasks-level',
              identity: managed.identity,
              seq: ++managed.seq,
              tasks,
            });
          } else this.emitUnopenedTasks(sessionId, tasks);
        },
        // 完成通知走合并投递:多任务同时完成合并成一条,失败在 manager 文本里自带标注
        onCompletionNotify: (sessionId, text, notifyOptions) => {
          // 子代理起的任务只通知子代理本身，不打扰父会话：它持有 Run 且空闲时唤醒它，否则搭下一条工具结果。
          // 子代理已不在时丢弃：父会话从子代理结果里得知它起过哪些任务，可用 task_output 查看
          if (sessionId.includes('::')) {
            const child = this.sessions.get(sessionId);
            if (child?.agentRun && child.status !== 'running') {
              this.deliverNotification(sessionId, text);
            } else if (child) {
              child.childTaskNotices ??= [];
              enqueueReminder(child.childTaskNotices, text);
            } else if (notifyOptions?.durable) this.persistUnopenedNotification(sessionId, text);
            return;
          }
          if (notifyOptions?.durable && !this.sessions.has(sessionId)) {
            this.persistUnopenedNotification(sessionId, text);
            if (!notifyOptions.quiet) this.requestWake(sessionId);
            return;
          }
          this.notifier.notify(sessionId, text);
        },
      },
      path.join(options.agentDir, 'task-logs')
    );
    // 上一代重启前交出的后台命令：认回在跑的、收尾已结束的；再清掉异常退出留下的孤儿
    const handled = this.bgTasks.recover(
      takeDetachedTasksManifest(
        path.join(this.restartDataDir(), DETACHED_TASKS_FILE),
        this.bgTasks.outputDir
      )
    );
    sweepOrphanRuns(this.bgTasks.outputDir, handled);
    // 上一代收尾时停掉的在跑任务（含空闲会话的）：任务表留「因重启中断」，通知所属会话一次并叫醒
    this.bgTasks.recoverInterrupted(
      takeInterruptedTasks(
        path.join(this.restartDataDir(), INTERRUPTED_TASKS_FILE),
        this.bgTasks.outputDir
      )
    );
    // 断点里空闲的会话带着待投递通知：重启收尾期间结束的命令只存了盘，这一代叫醒它
    for (const entry of this.restartResume.values()) {
      if (
        entry.nextStep === 'await-user' &&
        this.pendingNotifications.load(entry.sessionId).length > 0
      )
        this.requestWake(entry.sessionId);
    }
    // 点开过的会话否则常驻到 app 退出（每个 AgentSession 持有全量 jsonl 上下文）
    this.evictionTimer = setInterval(() => this.evictIdleSessions(), EVICTION_SWEEP_INTERVAL_MS);
    this.evictionTimer.unref?.();
  }

  private evictionCandidate(managed: ManagedSession): EvictionCandidate {
    const id = managed.identity.sessionId;
    return {
      sessionId: id,
      isChild: Boolean(managed.parentId || managed.childIdentity),
      status: managed.status,
      lastActivityAt: managed.lastActivityAt,
      hasPendingWork:
        this.workspaceSwitch.isLocked(id) ||
        // 串行门里还排着该会话的命令（prompt/steer 等）：此刻回收会让它们撞上已删除的会话
        this.pendingCommands.has(id) ||
        managed.pendingBranch !== undefined ||
        !!managed.pendingVerifications ||
        managed.currentTurnId !== undefined ||
        managed.gate.snapshot().length > 0 ||
        managed.asks.snapshot().length > 0 ||
        hasPendingCalls(managed) ||
        (managed.workflowRuns?.size ?? 0) > 0 ||
        managed.pendingTaskReminders.length > 0 ||
        this.bgTasks.snapshot(id).some((task) => task.status === 'running'),
      hasChildren:
        managed.coworkers.size > 0 ||
        [...this.sessions.keys()].some((key) => key.startsWith(`${id}::`)),
    };
  }

  private evictIdleSessions(): void {
    const candidates = [...this.sessions.values()].map((m) => this.evictionCandidate(m));
    for (const sessionId of selectEvictable(candidates, this.pinned, Date.now())) {
      void this.gate
        .run(sessionId, async () => {
          // 排队期间可能有 prompt/pin 插队，进门后重新校验
          const managed = this.sessions.get(sessionId);
          if (!managed) return;
          const still = selectEvictable([this.evictionCandidate(managed)], this.pinned, Date.now());
          if (still.length === 0) return;
          await this.releaseParent(managed, 'evicted');
        })
        .catch((error) => {
          console.error('[evict] failed:', toErrorMessage(error));
        });
    }
  }

  /** 释放父会话：中断 + 销毁 worker 侧会话树，jsonl 留盘。下游靠 parent-ended 把 started
   *  清回 false，之后可携新 cwd + resumeFile 重新 spawn（Move to worktree / 闲置回收后再点开）。 */
  private async releaseParent(managed: ManagedSession, reason: string): Promise<void> {
    const parentId = managed.identity.sessionId;
    this.workspaceClaims.forget(parentId);
    // 先收掉整棵子会话（coworker/child 都以 `${parentId}::` 为键前缀）
    for (const [id, child] of [...this.sessions]) {
      if (!id.startsWith(`${parentId}::`)) continue;
      this.closeChildPlugins(child, 'parent_ended');
      child.gate.cancelAll();
      child.asks.cancelAll();
      cancelContinuousMemory(child.session.sessionManager);
      try {
        await child.session.abort();
      } catch {}
      child.unsubscribe();
      try {
        releaseOauthPoolSession(child.session.sessionId);
        child.session.dispose();
      } catch {}
      this.sessions.delete(id);
      this.mcpHotplug.delete(id);
      this.settleRound(child);
    }
    managed.coworkers.clear();
    for (const controller of managed.workflowRuns?.values() ?? []) controller.abort();
    managed.workflowRuns?.clear();
    managed.gate.cancelAll();
    managed.asks.cancelAll();
    cancelContinuousMemory(managed.session.sessionManager);
    managed.browser?.cancelAll('Session released');
    managed.memory?.cancelAll('Session released');
    managed.delegation?.cancelAll('Session released');
    managed.secretary?.cancelAll('Session released');
    managed.agentControl?.close('Session released');
    managed.computer?.cancelAll('Session released');
    managed.pluginTools?.cancelAll('Session released');
    managed.pluginEvents?.cancelAll();
    if (!this.restart?.committed) managed.restartHold?.();
    try {
      await managed.session.abort();
    } catch {}
    await emitSessionShutdown(managed.session);
    managed.unsubscribe();
    try {
      releaseOauthPoolSession(managed.session.sessionId);
      managed.session.dispose();
    } catch {}
    this.sessions.delete(parentId);
    this.mcpHotplug.delete(parentId);
    this.options.emit({
      type: 'parent-ended',
      identity: managed.identity,
      seq: managed.seq + 1,
      reason,
      ...(managed.instanceId ? { instanceId: managed.instanceId } : {}),
    });
    this.scheduleRestartCheck();
  }

  handleCommand(command: AgentCommand): void {
    if (command.type === 'graceful-restart') {
      this.restart ??= { committed: false };
      if (command.keepBackgroundTasks) this.restart.keepBackground = true;
      this.checkRestart();
      return;
    }
    if (command.type === 'detach-background-tasks') {
      this.detachBackgroundTasks();
      return;
    }
    if (command.type === 'oauth-pool-result') {
      this.oauthPoolPending.get(command.requestId)?.(command);
      return;
    }
    if (command.type === 'mcp-oauth-refresh-result') {
      this.mcpOAuthPending.get(command.requestId)?.(command.result);
      return;
    }
    if (command.type === 'lock-workspace' || command.type === 'unlock-workspace') {
      const ok =
        command.type === 'lock-workspace'
          ? !this.bgTasks.hasRunningInWorkspace(command.conversationIds) &&
            !command.conversationIds.some(
              (id) => this.pendingCommands.has(id) || this.gate.hasPending(id)
            ) &&
            this.workspaceSwitch.lock(
              command.requestId,
              command.conversationIds,
              (managed) =>
                managed.status === 'running' ||
                managed.session.isStreaming ||
                managed.session.isRetrying ||
                !!managed.roundPending ||
                !!managed.pendingVerifications ||
                managed.currentTurnId !== undefined ||
                !!managed.compaction ||
                !!managed.pendingCompact ||
                this.pendingCommands.has(managed.identity.sessionId) ||
                this.gate.hasPending(managed.identity.sessionId) ||
                managed.gate.snapshot().length > 0 ||
                managed.asks.snapshot().length > 0 ||
                hasPendingCalls(managed) ||
                this.bgTasks
                  .snapshot(managed.identity.sessionId)
                  .some((task) => task.status === 'running')
            )
          : this.workspaceSwitch.unlock(command.requestId, command.conversationIds, command.branch);
      this.options.emit({
        type:
          command.type === 'lock-workspace' ? 'workspace-lock-result' : 'workspace-unlock-result',
        requestId: command.requestId,
        ok,
        ...(ok ? {} : { error: 'Workspace is busy or the operation lock does not match.' }),
      });
      return;
    }
    if (command.type === 'reload-session') {
      // 只读旁路：不得进入执行门、更新活动时间或触发模型调用。
      const managed = this.sessions.get(command.sessionId);
      const snapshot = managed
        ? this.snapshotSessions().find(
            (session) => session.identity.sessionId === command.sessionId
          )
        : undefined;
      this.options.emit({
        type: 'session-reloaded',
        requestId: command.requestId,
        result:
          managed && snapshot
            ? { ok: true, snapshot, seq: managed.seq }
            : { ok: false, error: 'Session is no longer active.' },
      });
      return;
    }
    if (command.type === 'snapshot') {
      const sessions = command.sessionId
        ? this.snapshotSessions().filter(
            (session) => session.identity.sessionId === command.sessionId
          )
        : this.snapshotSessions();
      this.options.emit({
        type: 'snapshot',
        sessions,
        ...(command.sessionId ? { partial: true, sessionId: command.sessionId } : {}),
      });
      // 渲染层启动 / 点开冷会话时补拉：认回的任务早在 worker 构造时就发过，那时可能没人收
      for (const sessionId of command.sessionId ? [command.sessionId] : this.bgTasks.sessionIds()) {
        if (this.sessions.has(sessionId)) continue;
        const tasks = this.bgTasks.snapshot(sessionId);
        if (tasks.length > 0) this.emitUnopenedTasks(sessionId, tasks);
      }
      return;
    }
    if (command.type === 'warm-mcp') {
      const deferred = command.servers.filter(isDeferredMcp);
      for (const server of deferred) this.mcp.refresh(server);
      void this.adoptDirectMcp(command.servers.filter((server) => !isDeferredMcp(server)));
      return;
    }
    if (command.type === 'plugin-mcp-cancel') {
      this.pluginMcpCalls.get(command.requestId)?.abort();
      return;
    }
    if (command.type === 'plugin-agent-cancel') {
      this.pluginAgentRuns.get(command.requestId)?.abort();
      return;
    }
    if (command.type === 'plugin-agent-run') {
      void this.runPluginAgent(command);
      return;
    }
    if (command.type === 'plugin-mcp-list' || command.type === 'plugin-mcp-call') {
      const { requestId } = command;
      const controller = new AbortController();
      this.pluginMcpCalls.set(requestId, controller);
      const run =
        command.type === 'plugin-mcp-list'
          ? this.mcp.pluginTools(command.servers)
          : this.mcp.callPluginTool(
              command.servers,
              command.server,
              command.tool,
              command.args,
              controller.signal
            );
      void run
        .then(
          (value) => this.options.emit({ type: 'plugin-mcp-result', requestId, ok: true, value }),
          (error: unknown) =>
            this.options.emit({
              type: 'plugin-mcp-result',
              requestId,
              ok: false,
              error: error instanceof Error ? error.message : String(error) || 'MCP call failed',
            })
        )
        .finally(() => this.pluginMcpCalls.delete(requestId));
      return;
    }
    if (command.type === 'pin-sessions') {
      this.pinned = new Set(command.sessionIds);
      return;
    }
    if (command.type === 'summarize-title') {
      // 标题总结不属于任何会话：旁路串行门；失败静默（截断标题已是可用兑底，不值得报错打扰）
      void this.summarizeTitle(command).catch(() => {});
      return;
    }
    if (command.type === 'complete-text') {
      void this.completeText(command).catch((error) =>
        this.options.emit({
          type: 'text-failed',
          requestId: command.requestId,
          error: toErrorMessage(error),
        })
      );
      return;
    }
    if (command.type === 'abort-complete-text') {
      const active = this.completeTextAborts.get(command.requestId);
      if (active) active.abort();
      else this.completeTextPendingAborts.add(command.requestId);
      return;
    }
    if (command.type === 'classify-choice') {
      void this.classifyChoice(command).catch((error) =>
        this.options.emit({
          type: 'choice-failed',
          requestId: command.requestId,
          error: toErrorMessage(error) || 'classify failed',
        })
      );
      return;
    }
    if (command.type === 'abort-classify-choice') {
      const active = this.classifyAborts.get(command.requestId);
      if (active) active.abort();
      else this.classifyPendingAborts.add(command.requestId);
      return;
    }
    if (command.type === 'set-proxy-env') {
      applyWorkerProxyEnv(command.env);
      return;
    }
    if (command.type === 'set-approval-reviewer') {
      this.approvalReviewer = approvalReviewerSource(
        command.model,
        command.classifier,
        command.managed,
        command.allowThreshold
      );
      return;
    }
    if (command.type === 'set-compact-route') {
      this.publishCompactRoute(command.model, command.mode);
      return;
    }
    if (command.type === 'set-max-active-coworkers') {
      this.maxActiveCoworkers = command.limit;
      return;
    }
    if (command.type === 'set-auto-retry-limit') {
      this.autoRetryLimit = command.limit;
      return;
    }
    if (command.type === 'set-long-cache-retention') {
      this.longCacheRetention = command.enabled;
      return;
    }
    if (command.type === 'set-app-logging') {
      setAppLoggingEnabled(command.enabled);
      return;
    }
    if (command.type === 'set-privacy-masking') {
      configurePrivacyMasking(this.options.agentDir, command.settings);
      return;
    }
    if (command.type === 'set-shell-limits') {
      this.bgTasks.setLimits(command.limits);
      return;
    }
    if (command.type === 'set-disabled-workflow-presets') {
      this.disabledWorkflowPresets = command.ids;
      return;
    }
    if (command.type === 'set-builtin-tools') {
      const managed = this.sessions.get(command.identity.sessionId);
      if (managed?.applyBuiltinTools && isSameGeneration(managed.identity, command.identity)) {
        managed.pendingBuiltinTools = command.disabledTools;
        this.flushPendingBuiltinTools(managed);
      } else if (!managed) {
        this.pendingBuiltinTools.set(command.identity.sessionId, {
          identity: command.identity,
          disabled: command.disabledTools,
        });
      }
      return;
    }
    if (command.type === 'set-image-generation-config') {
      this.imageGeneration = {
        config: command.config ? { ...command.config } : null,
        ...(command.error ? { error: command.error } : {}),
      };
      return;
    }
    if (command.type === 'set-web-search-config') {
      this.webSearchChain =
        (command.configured ?? command.chain.length > 0) ? command.chain : undefined;
      // OAuth 第二账号克隆在 worker runtime 里按需注册，否则链物化时 find 取不到
      void this.getRuntime()
        .then((runtime) => {
          for (const ref of command.chain) {
            ensureAccountProvider(runtime, ref.providerId);
            const exact = runtime.getModel(ref.providerId, ref.modelId);
            if (!exact) {
              const baseId = providerIdOfAccountKey(ref.providerId);
              const clone = resolveOauthCatalogModel(
                baseId,
                ref.modelId,
                runtime.getModels(ref.providerId),
                undefined
              );
              if (clone) listCatalogClone(runtime, clone);
            }
          }
        })
        .catch((error) => console.warn('[web-search] ensure account providers failed:', error));
      return;
    }
    if (command.type === 'set-model-directory') {
      const previous: ModelDirectoryPushState | undefined = this.modelDirectory
        ? {
            snapshot: this.modelDirectory,
            providers: this.modelDirectoryPush?.providers ?? [],
          }
        : undefined;
      const preview = previewModelDirectoryPush(
        previous,
        command.snapshot,
        command.customProviders
      );
      if (preview.status === 'ignored') {
        console.warn(`[model-directory] ignored push: ${preview.reason}`);
        return;
      }
      if (preview.status === 'unchanged') return;
      const parsed = preview.parsed;
      this.modelDirectory = parsed.snapshot;
      this.modelDirectoryPush = parsed;
      void this.getRuntime()
        .then((runtime) => {
          installPushedCustomProviders(runtime, parsed.providers);
        })
        .catch((error) => {
          // 回滚只覆盖簿记：累积语义下中途已注册的 provider 留在注册表无害
          // （枚举/鉴权可用），下次推送会补齐剩余部分
          if (this.modelDirectoryPush === parsed) {
            this.modelDirectory = previous?.snapshot;
            this.modelDirectoryPush = previous;
          }
          console.error('[model-directory] register failed:', toErrorMessage(error));
        });
      return;
    }
    // 按会话 id 寻址，不要求会话已打开（重启认回的任务所在会话可能还没 spawn）；worker 校验归属
    if (command.type === 'task-stop') {
      // 卡片上的停止按钮：用户主动停的，完成通知要告诉模型别重启
      if (this.bgTasks.owns(command.taskId, command.sessionId))
        this.bgTasks.stop(command.taskId, true);
      return;
    }
    if (command.type === 'task-keep') {
      if (!this.bgTasks.owns(command.taskId, command.sessionId)) return;
      if (command.reason === null) this.bgTasks.unkeep(command.taskId);
      else this.bgTasks.keep(command.taskId, { by: 'user', reason: command.reason });
      const held = this.sessions.get(command.sessionId);
      if (held?.agentRun && held.status !== 'running' && !this.awaitsOwnTasks(held))
        this.deliverNotification(
          command.sessionId,
          `The user kept background task ${command.taskId} running; you no longer need to wait for it before reporting.`
        );
      return;
    }
    if (command.type === 'reminders-fire') {
      this.reminderDueSent.delete(command.sessionId);
      const managed = this.sessions.get(command.sessionId);
      if (managed) this.fireDueReminders(managed);
      return;
    }
    if (command.type === 'reminders-clear') {
      this.reminderDueSent.delete(command.sessionId);
      this.reminders.clear(command.sessionId);
      return;
    }
    const identity =
      command.type === 'browser-result' ||
      command.type === 'memory-result' ||
      command.type === 'delegation-result' ||
      command.type === 'secretary-result' ||
      command.type === 'computer-result' ||
      command.type === 'plugin-tool-result' ||
      command.type === 'plugin-tool-progress' ||
      command.type === 'plugin-intercept-result' ||
      command.type === 'plugin-inject'
        ? command.identity
        : command.type === 'dismiss-child' ||
            command.type === 'dismiss-coworker' ||
            command.type === 'resume-coworker'
          ? command.parent
          : command.identity;
    const scopeId =
      command.type === 'spawn-child' ? command.identity.parent.sessionId : identity.sessionId;
    if (this.workspaceSwitch.defer(scopeId, () => this.handleCommand(command))) return;
    const touched = this.sessions.get(identity.sessionId);
    if (touched) touched.lastActivityAt = Date.now();
    // abort 必须旁路串行门：它要打断的正是占着门的那一轮，排队等于永远等不到
    if (command.type === 'abort') {
      void this.execute(command).catch((error) => {
        const message = toErrorMessage(error);
        // 会话已销毁或已换代：要停的东西已经不在了，重复 abort 是幂等终态
        if (message.startsWith(STALE_SESSION_ERROR)) console.debug('[abort] skipped:', message);
        else console.error('[abort] failed:', message);
      });
      return;
    }
    if (
      command.type === 'plugin-tool-result' ||
      command.type === 'plugin-tool-progress' ||
      command.type === 'plugin-intercept-result' ||
      command.type === 'plugin-inject'
    ) {
      void this.execute(command).catch((error) => {
        console.error(`[${command.type}] failed:`, toErrorMessage(error));
      });
      return;
    }
    this.pendingCommands.set(scopeId, (this.pendingCommands.get(scopeId) ?? 0) + 1);
    const spawning = command.type === 'spawn-parent' ? command.identity : undefined;
    if (spawning) this.spawning.set(spawning.sessionId, spawning);
    void this.gate
      .run(identity.sessionId, () => this.execute(command))
      .finally(() => {
        const count = (this.pendingCommands.get(scopeId) ?? 1) - 1;
        if (count) this.pendingCommands.set(scopeId, count);
        else this.pendingCommands.delete(scopeId);
        if (spawning && this.spawning.get(spawning.sessionId) === spawning)
          this.spawning.delete(spawning.sessionId);
        this.scheduleRestartCheck();
      })
      .catch((error) => {
        const message = toErrorMessage(error);
        if (command.type === 'spawn-parent') {
          this.options.emit({
            type: 'parent-rejected',
            identity: command.identity,
            seq: 0,
            reason: message,
            ...(command.instanceId ? { instanceId: command.instanceId } : {}),
          });
          return;
        }
        if (command.type === 'spawn-child') {
          this.options.emit({
            type: 'child-rejected',
            identity: command.identity,
            seq: 0,
            reason: message,
          });
          return;
        }
        if (
          command.type === 'dismiss-child' ||
          command.type === 'dismiss-coworker' ||
          command.type === 'resume-coworker'
        ) {
          // 清理/恢复类命令按 parent 归因只为排队，失败不影响父会话本身，不能把它标成 failed（之后所有委派都会被拒）
          console.error(`[${command.type}] failed:`, message);
          return;
        }
        const managed = this.sessions.get(identity.sessionId);
        if (!managed || !isSameGeneration(managed.identity, identity)) {
          // 会话已不在 worker（驱逐 / 释放 / 换代）而 renderer 仍认为 started：静默丢弃会让
          // 后续每次发送都绕过 spawn 直发到空会话。按拒绝回流，让 renderer 清 started 并报错。
          // retry 同理：静默丢弃会让等着这次续跑的宿主轮次只能干等；
          // rewind 同理：renderer 的回退锁只等 rewind-done 或拒绝，静默丢弃会让会话一直卡在回退中
          if (
            command.type === 'prompt' ||
            command.type === 'steer' ||
            command.type === 'retry' ||
            command.type === 'rewind'
          ) {
            // 命令类型声明为 SessionIdentity，但 coworker tab 发来的是完整 ChildSessionIdentity
            const target = command.identity as SessionIdentity | ChildSessionIdentity;
            const instanceId = 'instanceId' in command ? command.instanceId : undefined;
            this.options.emit(
              'parent' in target
                ? { type: 'child-rejected', identity: target, seq: 0, reason: message }
                : {
                    type: 'parent-rejected',
                    identity: target,
                    seq: 0,
                    reason: message,
                    // 回显这条命令自己带的实例号：Main 只把发给当前实例的命令被拒算作当前实例结束
                    ...(instanceId ? { instanceId } : {}),
                  }
            );
          }
          return;
        }
        // 通用异常只标 failed，不保证该会话当前活动已终止；failed 之后的终态不一定会出现（见 #41、#43）
        managed.status = 'failed';
        this.emitStatus(managed, message);
      });
  }

  private async execute(
    command: Exclude<AgentCommand, { type: 'snapshot' | 'reload-session' | 'set-model-directory' }>
  ): Promise<void> {
    switch (command.type) {
      case 'spawn-parent':
        await this.spawn(
          command.identity,
          command.cwd,
          command.model,
          command.resumeFile,
          command.reasoningEnabled ?? false,
          command.thinkingLevel,
          command.loadLocalSkills,
          command.skillPaths,
          command.mcpServers,
          command.approvalMode,
          approvalReviewerSource(
            command.approvalReviewer,
            command.approvalReviewerClassifier,
            command.approvalReviewerManaged,
            command.approvalReviewerAllowThreshold
          ),
          command.agentTypes,
          command.disabledTools,
          command.instruction,
          command.subagentModels,
          command.remote,
          command.loadHarnessAssets,
          command.windowsLocalShell,
          command.exploreFoldEnabled,
          command.hashlineEditEnabled,
          resolveCompactStrategy(command.compactStrategy, command.smartCompactEnabled),
          command.smartCompactSummaryModel,
          command.smartCompactMode,
          command.memoryLanguage,
          command.editMode,
          command.rolePrompt,
          command.systemPrompt,
          command.systemPromptAppend,
          command.systemPromptBoost,
          command.refusalRetryPrompt,
          command.rtkEnabled,
          command.planMode,
          command.trustedProjectCode,
          command.botMode,
          command.botGroupTasks,
          command.protectedActions,
          command.botRoutines,
          command.secretaryMode ?? false,
          command.botWriteLock,
          command.botDelegationTask,
          command.pluginTools,
          command.pluginEvents,
          command.dcgPath,
          command.autoRejectApprovals ?? false,
          command.botDiscussMode,
          command.instanceId,
          command.workflowPresetFiles,
          command.secretaryTools,
          command.askRelay,
          command.dcgExemptRules
        );
        if (command.forkFrom) this.injectForkTranscript(command.identity, command.forkFrom);
        return;
      case 'spawn-child':
        await this.spawnTypedChild(
          command.identity,
          command.cwd,
          command.config,
          command.resumeFile
        );
        return;
      case 'dismiss-child': {
        this.must(command.parent);
        // 清理幂等：子会话从未建成（spawn 被拒）或已换代时无事可做，不能抛错连累父会话
        const child = this.sessions.get(command.child.sessionId);
        // 实体已不在（task 跑完/失败/重启）：仍回流 dismissed，否则渲染层 tab 永远卡住
        if (!child) {
          await this.dismissCoworker(command.parent.sessionId, command.child.sessionId);
          return;
        }
        if (
          !child.childIdentity ||
          !isSameChildSessionIdentity(command.child, child.childIdentity)
        ) {
          return;
        }
        const name = await this.dismissCoworker(command.parent.sessionId, command.child.sessionId);
        if (command.notify) {
          this.notifier.notify(
            command.parent.sessionId,
            `The user dismissed coworker "${name}". Its session is closed; do not send to it again.`,
            { urgent: true }
          );
        }
        return;
      }
      case 'resume-coworker': {
        // 重启后恢复工具直雇 coworker：name/agentType/resumeFile 全部来自 Main
        // 自己读的持久化；spawnCoworker 的 resumeFile 分支自带容量豁免与类型降级容错。
        this.must(command.parent);
        await this.spawnCoworker(
          command.parent.sessionId,
          command.coworkerId,
          command.name,
          command.agentType,
          undefined,
          command.resumeFile
        );
        return;
      }
      case 'dismiss-coworker': {
        // 双形状过渡：工具直雇 coworker 无 ChildSessionIdentity，Main 按
        // parent.coworkers 映射发裸 id；这里以 exact 父代为门（must 抛即拒）。
        this.must(command.parent);
        const name = await this.dismissCoworker(command.parent.sessionId, command.coworkerId);
        if (command.notify) {
          this.notifier.notify(
            command.parent.sessionId,
            `The user dismissed coworker "${name}". Its session is closed; do not send to it again.`,
            { urgent: true }
          );
        }
        return;
      }
      case 'prompt-child': {
        const managed = this.must(command.identity);
        if (
          !managed.childIdentity ||
          !isSameChildSessionIdentity(command.identity, managed.childIdentity) ||
          managed.promptedRequestIds.has(command.requestId)
        ) {
          return;
        }
        managed.promptedRequestIds.add(command.requestId);
        managed.currentTurnId = command.requestId;
        this.releaseRun(managed);
        if (command.requestBudget) managed.agentRun = { id: command.requestId };
        this.reminders.resetChain(managed.identity.sessionId);
        managed.turnAborted = false;
        // 只有子代理 Run（Main 带 requestBudget 标记）计数；Bot 成员等不 arm，不计数
        if (command.requestBudget) managed.requestBudget?.arm();
        else managed.requestBudget?.disarm();
        const images = command.task.images.map((image) => ({ type: 'image' as const, ...image }));
        void managed.session
          .prompt(
            consumeRole(managed, command.task.text),
            images.length > 0 ? { images } : undefined
          )
          .catch((error) => {
            this.failTurn(managed, toErrorMessage(error));
          });
        return;
      }
      case 'prompt': {
        const managed = this.must(command.identity);
        managed.plan?.supersede();
        // 非提醒来源的输入：提醒连续链从头算
        this.reminders.resetChain(managed.identity.sessionId);
        const images = command.images?.map((image) => ({ type: 'image' as const, ...image }));
        if (await this.interruptRetryIfAny(managed)) {
          this.promptFresh(managed, command.text, images, command.deliveryId, command.resume);
          return;
        }
        // 活轮还在（含 resume）：prompt 是排队消息，用 followUp 排到本轮之后，不插话也不报错；
        // 插话走 steer 命令。resume 只对空闲会话开新轮时生效（promptFresh 内判流式）
        if (managed.status === 'running') {
          this.promptFresh(managed, command.text, images, command.deliveryId, command.resume);
          return;
        }
        // 投影已 idle 但 pi 仍忙：压缩中（pi 拒收 prompt）不限时等压完；仍 streaming 要么
        // agent_end 尚未回流，要么是 abort 后工具不响应信号的僵尸轮——steer 进僵尸轮永远
        // 无人投递，故限时等空闲后走新轮。仍在产出或投影已回到 running 的不是僵尸，继续等。
        // 超时按 deliveryId 回执这条 prompt，绝不静默。它没开出新轮，不发 turn-*、不动 status：
        // 消费者按会话把 turn-* 当本轮终态，仍在收束的那一轮由它自己的 agent_settled 收口。
        let activityAt = managed.activityNonce;
        if (
          !(await waitPromptable(managed.session, ZOMBIE_TURN_WAIT_MS, () => {
            if (managed.status === 'running') return true;
            if (managed.activityNonce > activityAt) {
              activityAt = managed.activityNonce;
              return true;
            }
            return false;
          }))
        ) {
          this.emitDeliveryRejected(managed, command.deliveryId, 'turn-stuck');
          return;
        }
        this.promptFresh(managed, command.text, images, command.deliveryId, command.resume);
        return;
      }
      case 'steer': {
        const managed = this.must(command.identity);
        if (command.activeOnly && command.deliveryId) {
          await this.steerActive(managed, command.text, command.images, command.deliveryId);
          return;
        }
        managed.plan?.supersede();
        const images = command.images?.map((image) => ({ type: 'image' as const, ...image }));
        // 重试倒计时期间 renderer 看到的仍是 running 会发 steer：此时没有活轮可插，
        // 语义是用户接管——打断重试，改为新轮 prompt
        if (await this.interruptRetryIfAny(managed)) {
          this.promptFresh(managed, command.text, images, command.deliveryId);
          return;
        }
        // 持有中空闲：没有活轮可插，pi 只会把插话排进没人取的队列，改开新一轮接着这次 Run
        // 空闲等异步子代理 / 后台任务或刚结束回合的竞态同样没有活轮可插，一律改开新一轮
        if (managed.status !== 'running' && !managed.session.isStreaming) {
          this.promptFresh(managed, command.text, images, command.deliveryId);
          return;
        }
        await this.steerTracked(managed, command.text, images, command.deliveryId);
        // 用户插话时长命令不阻塞投递：前台命令转后台（不杀），让 pi 在工具返回后读到插话
        this.bgTasks.backgroundAllForeground(managed.identity.sessionId, 'steer');
        return;
      }
      case 'abort-retry':
        this.cancelRetry(this.must(command.identity));
        return;
      case 'withdraw-steer': {
        const managed = this.must(command.identity);
        const slot = managed.steerDeliveries?.find((item) => item.id === command.deliveryId);
        if (!slot?.withdraw?.()) return;
        managed.steerDeliveries = managed.steerDeliveries?.filter((item) => item !== slot);
        this.options.emit({
          type: 'delivery-rejected',
          identity: managed.identity,
          seq: ++managed.seq,
          deliveryId: command.deliveryId,
        });
        return;
      }
      case 'retry': {
        const managed = this.must(command.identity);
        // 没开出新轮的两条路都要回执：Main 的 bot 宿主据此结算等着这次续跑的轮次，
        // 不回执就只能靠计时器猜，猜早了晚到的 running 会变成无主运行（#29）
        if (!managed.session.isIdle || managed.status === 'running') {
          this.emitRetrySkipped(managed, 'busy');
          return;
        }
        const agent = managed.session.agent;
        if (command.unfinishedOnly) {
          // 子会话续跑：中断时还在跑的工具补上结果未知的结果，让模型先核对现状而不是原样重放
          if (managed.childIdentity) settleInterruptedToolCalls(managed.session);
          editUnfinishedAssistantForResume(managed.session);
        } else editLatestAssistantForRetry(managed.session);
        if (agent.state.messages.at(-1)?.role === 'assistant') {
          // 重启前持有 Run 在等后台任务的子代理：任务的消息（含因重启中断）还没交给它，接着原 Run 继续等 / 交给它
          if (managed.childIdentity && command.requestBudget && this.awaitsOwnTasks(managed)) {
            this.releaseRun(managed);
            const run: AgentRunHold = { id: command.turnId ?? randomUUID() };
            managed.agentRun = run;
            managed.requestBudget?.arm(command.requestsUsed);
            this.holdRun(managed, run);
            this.flushPendingReminders(managed);
            this.fireDueReminders(managed);
            return;
          }
          this.emitRetrySkipped(managed, 'nothing-to-retry');
          return;
        }
        ensureAssistantUsage(agent.state.messages as unknown[]);
        managed.currentTurnId = command.turnId ?? randomUUID();
        this.releaseRun(managed);
        if (command.requestBudget) managed.agentRun = { id: managed.currentTurnId };
        if (command.requestBudget) managed.requestBudget?.arm(command.requestsUsed);
        resetOauthPoolActivity(managed.session);
        void continueSessionActivity(managed.session).catch((error) =>
          this.failTurn(managed, toErrorMessage(error))
        );
        return;
      }
      case 'agent-control-result': {
        const managed = this.must(command.identity);
        if (!managed.agentControl?.resolve(command.requestId, command.response)) {
          console.warn(`[agent-control] dropped result for unknown request ${command.requestId}`);
        }
        return;
      }
      case 'set-thinking':
        this.must(command.identity).session.setThinkingLevel(command.level);
        return;
      case 'set-model': {
        const managed = this.must(command.identity);
        const runtime = await this.getRuntime();
        const base = await resolveSessionModel(runtime, command.model);
        const next = applyReasoningToModel(
          { ...base, compat: base.compat ? { ...base.compat } : undefined },
          managed.session.model ? Boolean(managed.session.model.reasoning) : false,
          command.model.modelId
        );
        await managed.session.setModel(next);
        ensureAssistantUsage(managed.session.messages as unknown[]);
        managed.modelId = command.model.modelId;
        const usage = managed.session.getContextUsage();
        const compaction = managed.session.settingsManager.getCompactionSettings(
          managed.session.model
        );
        if (
          managed.status !== 'running' &&
          managed.compaction !== 'running' &&
          shouldCompactAfterModelSwitch(usage, compaction)
        ) {
          void this.runCompaction(managed);
        }
        // 必须回报：Main 的 agentSessionIndex 只认 parent-ready 与本事件，
        // 不回报就会让后续派发的 selection 校验永远对不上（issue #30）。
        this.options.emit({
          type: 'model-changed',
          identity: managed.identity,
          seq: ++managed.seq,
          model: settingsModelRef(command.model),
          imageInput: acceptsImageInput(managed.session.model),
        });
        return;
      }
      case 'set-system-prompt': {
        const managed = this.must(command.identity);
        if (managed.persona) managed.persona.current = command.systemPrompt;
        return;
      }
      case 'set-reasoning': {
        const managed = this.must(command.identity);
        if (managed.session.model) {
          applyReasoningToModel(managed.session.model, command.enabled, managed.modelId);
        }
        if (command.enabled && command.level) {
          managed.session.setThinkingLevel(command.level);
        }
        return;
      }
      case 'approval-respond':
        this.must(command.identity).gate.respond(command.requestId, command.decision);
        return;
      case 'request-timeout': {
        const managed = this.sessions.get(command.identity.sessionId);
        if (!managed || !isSameGeneration(managed.identity, command.identity)) return;
        if (command.kind === 'approval') managed.gate.expire(command.requestId);
        else managed.asks.expire(command.requestId);
        return;
      }
      case 'agent-notify': {
        const managed = this.sessions.get(command.identity.sessionId);
        // 只挡投递途中换代的命令；Main 总按当前 generation 发，不区分 Run 派出时的 generation
        if (!managed || !isSameGeneration(managed.identity, command.identity)) return;
        this.notifier.notify(managed.identity.sessionId, command.text, { urgent: command.urgent });
        return;
      }
      case 'set-approval-mode': {
        const managed = this.must(command.identity);
        managed.gate.mode = command.mode;
        if (command.autoReject !== undefined) {
          // 系统提示词改不了，用一次性提示告知模型「人没了 / 人回来了」
          const relay = Boolean(managed.asks.relay);
          const note = unattendedSwitchNote(
            { autoReject: managed.gate.autoReject, relay },
            { autoReject: command.autoReject, relay }
          );
          if (note) managed.unattendedNote = note;
          managed.gate.autoReject = command.autoReject;
          managed.asks.autoReject = command.autoReject;
        }
        // 切档即时生效：已挂起的请求按新档位重判，不留在原地等超时
        managed.gate.reconsider();
        this.applyApprovalModeToChildren(managed.identity.sessionId, command.mode);
        return;
      }
      case 'set-plan-mode':
        this.must(command.identity).plan?.setActive(command.active);
        return;
      case 'set-ask-relay': {
        const managed = this.must(command.identity);
        const autoReject = managed.asks.autoReject;
        const note = unattendedSwitchNote(
          { autoReject, relay: Boolean(managed.asks.relay) },
          { autoReject, relay: Boolean(command.relay) }
        );
        if (note) managed.unattendedNote = note;
        if (command.relay) managed.asks.relay = command.relay;
        else delete managed.asks.relay;
        return;
      }
      case 'plan-respond': {
        const managed = this.must(command.identity);
        const plan = managed.plan;
        if (!plan) return;
        const result = plan.respond(command.planId, command.action, command.feedback);
        // 过期决策：重发当前状态让渲染层对齐
        if (!result) this.emitPlanState(managed);
        else if (result.prompt) this.promptFresh(managed, result.prompt);
        return;
      }
      case 'set-approval-reviewer':
        this.approvalReviewer = approvalReviewerSource(
          command.model,
          command.classifier,
          command.managed,
          command.allowThreshold
        );
        return;
      case 'ask-respond':
        this.must(command.identity).asks.respond(command.requestId, command.answer, {
          ...(command.by ? { by: command.by } : {}),
          ...(command.name ? { name: command.name } : {}),
        });
        return;
      case 'browser-result': {
        const managed = this.must(command.identity);
        if (!managed.browser?.resolve(command)) {
          console.warn(`[browser] dropped result for unknown request ${command.requestId}`);
        }
        return;
      }
      case 'memory-result': {
        const memory = this.must(command.identity).memory;
        if (!memory?.resolve(command)) {
          if (memory?.wasCancelled(command.requestId)) {
            console.debug(
              `[memory] dropped late result for cancelled request ${command.requestId}`
            );
          } else {
            console.warn(`[memory] dropped result for unknown request ${command.requestId}`);
          }
        }
        return;
      }
      case 'delegation-result': {
        this.must(command.identity).delegation?.resolve(command);
        return;
      }
      case 'secretary-result': {
        this.must(command.identity).secretary?.resolve(command);
        return;
      }
      case 'computer-result': {
        const managed = this.must(command.identity);
        if (!managed.computer?.resolve(command)) {
          console.warn(`[computer] dropped result for unknown request ${command.requestId}`);
        }
        return;
      }
      case 'plugin-tool-result': {
        this.must(command.identity).pluginTools?.resolve(command);
        return;
      }
      case 'plugin-tool-progress': {
        const managed = this.sessions.get(command.identity.sessionId);
        if (!managed || !isSameGeneration(managed.identity, command.identity)) return;
        managed.pluginTools?.progress(command.requestId, command.text);
        return;
      }
      case 'plugin-intercept-result': {
        const managed = this.sessions.get(command.identity.sessionId);
        if (!managed || !isSameGeneration(managed.identity, command.identity)) return;
        managed.pluginEvents?.resolve(command);
        return;
      }
      case 'plugin-inject': {
        const managed = this.sessions.get(command.identity.sessionId);
        if (!managed || !isSameGeneration(managed.identity, command.identity)) return;
        const delivered = managed.pluginEvents?.deliver({
          pluginId: command.pluginId,
          pluginName: command.pluginName,
          text: command.text,
          ...(command.images?.length ? { images: command.images } : {}),
          deliverAs: command.deliverAs,
          triggerTurn: command.triggerTurn,
          ...(command.origin ? { origin: command.origin } : {}),
          ...(command.sender ? { sender: command.sender } : {}),
          ...(typeof command.ownerConfirm === 'boolean'
            ? { ownerConfirm: command.ownerConfirm }
            : {}),
        });
        if (!delivered?.ok) {
          console.warn('[plugin-inject]', delivered?.error ?? '会话未接受注入');
        }
        return;
      }
      case 'append-session-custom-entry': {
        const managed = this.must(command.identity);
        managed.session.sessionManager.appendCustomEntry('enso-agent-session', command.entry);
        materializeSessionFile(managed.session);
        managed.customEntries.push(command.entry);
        this.options.emit({
          type: 'session-custom-entry',
          identity: managed.identity,
          seq: ++managed.seq,
          entry: command.entry,
        });
        return;
      }
      case 'workflow-stop':
        this.must(command.identity)
          .workflowRuns?.get(command.runId)
          ?.abort(WORKFLOW_STOPPED_BY_USER);
        return;
      case 'tool-background':
        this.must(command.identity);
        this.bgTasks.backgroundForeground(command.identity.sessionId, command.toolCallId, 'user');
        return;
      // 旧子代理状态链路已无来源，命令仍在共享协议里，worker 侧不再有可停的对象
      case 'subagent-stop':
        this.must(command.identity);
        return;
      case 'fork': {
        const managed = this.must(command.identity);
        if (managed.status !== 'idle' || managed.childIdentity) {
          this.options.emit({
            type: 'fork-done',
            identity: managed.identity,
            seq: ++managed.seq,
            targetConversationId: command.targetConversationId,
            error: 'source-not-idle',
          });
          return;
        }
        const entryId = resolveForkLeafId(
          managed.session.sessionManager.getBranch(),
          command.entryId
            ? { entryId: command.entryId }
            : { turnIndexFromEnd: command.turnIndexFromEnd ?? 0 }
        );
        if (!entryId) {
          this.options.emit({
            type: 'fork-done',
            identity: managed.identity,
            seq: ++managed.seq,
            targetConversationId: command.targetConversationId,
            error: 'anchor-not-found',
          });
          return;
        }
        const branched = branchSessionFromPersistedFile(
          managed.session.sessionManager,
          entryId,
          (sessionFile) => SessionManager.open(sessionFile)
        );
        this.options.emit({
          type: 'fork-done',
          identity: managed.identity,
          seq: ++managed.seq,
          targetConversationId: command.targetConversationId,
          entryId,
          ...(branched.ok ? { sessionFile: branched.sessionFile } : { error: branched.error }),
        });
        return;
      }
      case 'compact': {
        const managed = this.must(command.identity);
        // 只有轮次真在跑才排队：failed 是静止态，排队后没有 completeTurn 来消费会永远停在 queued；
        // 其余状态直接压，pi 的 compact() 自己会先 abort 并等残留活动收尾
        if (managed.status === 'running') {
          // 忙碌时排队：不打断当前轮次，turn 收束后由 runCompaction 接手
          managed.pendingCompact = command.instructions
            ? { instructions: command.instructions }
            : {};
          managed.compaction = 'queued';
          this.options.emit({
            type: 'compaction',
            identity: managed.identity,
            seq: ++managed.seq,
            state: 'queued',
          });
          return;
        }
        await this.runCompaction(managed, command.instructions);
        return;
      }
      case 'rewind': {
        const managed = this.must(command.identity);
        if (managed.status === 'running') {
          this.rejectRewind(managed, command.restoreFiles);
          return;
        }
        const userEntries = managed.session.sessionManager
          .getBranch()
          .filter((entry) => entry.type === 'message' && entry.message.role === 'user');
        const targetIndex =
          command.entryId !== undefined
            ? userEntries.findIndex((entry) => entry.id === command.entryId)
            : userEntries.length - 1 - (command.userIndexFromEnd ?? -1);
        const target = userEntries[targetIndex];
        if (target?.type !== 'message' || target.message.role !== 'user') {
          this.rejectRewind(managed, command.restoreFiles);
          return;
        }
        if (command.entryId && !managed.messages.some((message) => message.entryId === target.id)) {
          this.reconcileMessages(managed, this.transcript(managed));
        }
        this.truncateProjectionForRewind(
          managed,
          command.entryId ?? userEntries.length - 1 - targetIndex
        );
        const restorePromise =
          command.restoreFiles && managed.checkpoints
            ? managed.checkpoints
                .restoreForEntry(target.id, new Date(target.timestamp).getTime())
                .catch((error) => {
                  console.error('[rewind] file restore failed:', toErrorMessage(error));
                  return false;
                })
            : null;
        const result = await managed.session.navigateTree(target.id);
        if (!result.cancelled) persistRewindLeaf(managed.session);
        const fallbackEditorText = Array.isArray(target.message.content)
          ? target.message.content
              .filter((part) => part.type === 'text' && 'text' in part && part.text)
              .map((part) => (part.type === 'text' ? part.text : ''))
              .join('')
          : '';
        const editorImages = Array.isArray(target.message.content)
          ? target.message.content.flatMap((part) =>
              part.type === 'image' && part.data && part.mimeType
                ? [{ data: part.data, mimeType: part.mimeType }]
                : []
            )
          : [];
        this.replaceMessagesAfterRewind(managed);
        managed.plan?.refresh();
        // 失败轮已回退掉：不再停在 failed，否则界面残留旧错误和指向上一轮的「重试」
        if (!result.cancelled && managed.status === 'failed') {
          managed.status = 'idle';
          this.emitStatus(managed);
        }
        const editorText = planFreeEditorText(result.editorText || fallbackEditorText);
        this.options.emit({
          type: 'rewind-done',
          identity: managed.identity,
          seq: ++managed.seq,
          ...(!result.cancelled && editorText ? { editorText } : {}),
          ...(!result.cancelled && editorImages.length > 0 ? { editorImages } : {}),
        });
        if (command.restoreFiles) {
          void Promise.resolve(restorePromise ?? false).then((filesRestored) => {
            this.options.emit({
              type: 'rewind-done',
              identity: managed.identity,
              seq: ++managed.seq,
              filesRestored: Boolean(filesRestored),
            });
          });
        }
        return;
      }
      case 'abort': {
        const managed = this.must(command.identity);
        // 重试倒计时中 pi 只发 auto_retry_end、不再有 agent_end：须按取消重试同口径收口，
        // 否则 renderer 的中断标记吞掉下一轮收束（队列不再泵），排队压缩永远停在 queued
        const retrying = managed.session.isRetrying;
        if (managed.status === 'running') this.withdrawQueuedPrompts(managed);
        managed.gate.cancelAll();
        managed.asks.cancelAll();
        cancelContinuousMemory(managed.session.sessionManager);
        managed.browser?.cancelAll('Browser action aborted');
        managed.memory?.cancelAll('Memory action aborted');
        managed.delegation?.cancelAll('Delegation action aborted');
        const abortedTurnId = managed.currentTurnId;
        managed.currentTurnId = undefined;
        // 进入过持有的 Run 被叫停：它在等的任务没人再等，一并停掉
        if (managed.agentRun?.holdTimer) this.stopAwaitedTasks(managed);
        // 用户中止：预算 Run 就此结束，不再补交报告，之后的回合也不再计数
        managed.requestBudget?.disarm();
        managed.computer?.cancelAll('Computer action aborted');
        managed.pluginTools?.cancelAll('Plugin tool aborted');
        managed.pluginEvents?.cancelAll();
        if (!this.restart?.committed) managed.restartHold?.();
        // 立即收口投影：不 await session.abort()（内部 waitForIdle 会一直等到工具/流
        // 真正结束，工具不响应 signal 时永远等不到，UI 就卡在 running 上）。
        // 中断信号发出即视为本轮终止，后续 agent_end 回流由 status 守卫幂等吸收。
        if (retrying) {
          managed.turnAborted = true;
          managed.abortedTurnId = abortedTurnId;
          this.failTurn(managed, managed.lastRetryError ?? 'Auto-retry cancelled.');
        } else {
          if (managed.status === 'running') {
            managed.turnAborted = true;
            managed.abortedTurnId = abortedTurnId;
          } else if (managed.agentRun) {
            // 持有中空闲：没有在跑的回合可收口，单独发一个接上原 Run 的终态，否则 Run 永远收不了口
            this.options.emit({
              type: 'turn-completed',
              identity: managed.identity,
              seq: ++managed.seq,
              turnId: randomUUID(),
              aborted: true,
              continues: managed.agentRun.id,
            });
            this.releaseRun(managed);
          }
          managed.turnRetried = false;
          managed.status = 'idle';
          this.emitStatus(managed);
        }
        void managed.session.abort().catch(() => {});
        return;
      }
      case 'release-parent':
        await this.releaseParent(this.must(command.identity), 'released');
        return;
    }
  }

  private publishCompactRoute(
    model: SpawnModelConfig | undefined,
    mode: SmartCompactMode | undefined
  ): void {
    assignCompactRoute(this.compactRoute, model, mode);
    if (!model) return;
    void this.getRuntime()
      .then((runtime) => resolveBaseModelOrRefresh(runtime, model))
      .catch((error: unknown) => {
        console.warn('[compact] summary model unavailable:', toErrorMessage(error));
      });
  }

  private async spawn(
    identity: SessionIdentity,
    cwd: string,
    model: SpawnModelConfig,
    resumeFile?: string,
    reasoningEnabled = false,
    thinkingLevel?: ThinkingLevel,
    loadLocalSkills = true,
    skillPaths: string[] = [],
    mcpServers: McpServerSpawnConfig[] = [],
    approvalMode: ApprovalMode = 'full',
    approvalReviewer?: ApprovalReviewerSource,
    agentTypes: AgentTypeSpawnConfig[] = [],
    disabledTools: string[] = [],
    instruction?: { path: string; content: string },
    subagentModels: SubagentModelOption[] = [],
    remote?: AgentRemoteConfig,
    loadHarnessAssets = false,
    windowsLocalShell?: WindowsLocalShell,
    exploreFoldEnabled = false,
    hashlineEditEnabled = false,
    compactStrategy: CompactStrategy = 'standard',
    smartCompactSummaryModel?: SpawnModelConfig,
    smartCompactMode?: SmartCompactMode,
    memoryLanguage?: string,
    requestedEditMode?: EditMode,
    rolePrompt?: string,
    systemPrompt?: string,
    systemPromptAppend?: string,
    systemPromptBoost?: string,
    refusalRetryPrompt?: string,
    rtkEnabled = true,
    planMode?: boolean,
    trustedProjectCode: readonly string[] = [],
    botMode = false,
    botGroupTasks = false,
    protectedActions = false,
    botRoutines = false,
    secretaryMode = false,
    botWriteLock?: { label: string; ancestors: string[] },
    botDelegationTask = false,
    pluginToolDescriptors: readonly PluginToolDescriptor[] = [],
    pluginEvents?: PluginEventPlan,
    dcgPath?: string,
    autoRejectApprovals = false,
    botDiscussMode = false,
    instanceId?: string,
    workflowPresetFiles: readonly string[] = [],
    secretaryToolDescriptors: readonly SecretaryToolDescriptor[] = [],
    askRelay?: { name: string },
    dcgExemptRules: readonly string[] = []
  ): Promise<void> {
    const sessionId = identity.sessionId;
    const sessionEditMode = resolveEditMode(requestedEditMode, hashlineEditEnabled);
    const toolEnabled = (id: string) => !disabledTools.includes(id);
    this.publishCompactRoute(smartCompactSummaryModel, smartCompactMode);
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (!isSameGeneration(existing.identity, identity) || existing.childIdentity) {
        throw new Error('Parent session identity is already reserved by another generation.');
      }
      // Main 已把这次 spawn 记成新实例：改绑实例号，之后结束时回显的是 Main 当前认的号
      existing.instanceId = instanceId;
      // 秘书重启时 worker 仍在：沿用旧会话与历史，但提示词换成 Main 刚按档案拼的
      if (secretaryMode && systemPrompt && existing.persona)
        existing.persona.current = systemPrompt;
      this.options.emit({
        type: 'parent-ready',
        identity,
        seq: ++existing.seq,
        sessionFile: requiredSessionFile(existing.session),
        model: settingsModelRef(model),
        imageInput: acceptsImageInput(existing.session.model),
      });
      return;
    }
    const spawnStart = Date.now();
    const runtime = await this.getRuntime();
    const baseModel = await resolveSessionModel(runtime, model);
    const piModel = applyReasoningToModel(
      { ...baseModel, compat: baseModel.compat ? { ...baseModel.compat } : undefined },
      reasoningEnabled,
      model.modelId
    );
    // 远程会话：ssh 执行器(ControlMaster 按 host 哈希共享连接) + 远端 AGENTS.md 单文件预取
    const sshExecutor = remote
      ? (() => {
          const controlDir = path.join(this.options.agentDir, 'ssh');
          mkdirSync(controlDir, { recursive: true });
          return createSshExecutor(remote.host, controlDir, undefined, remote);
        })()
      : undefined;
    const remoteOps = sshExecutor ? createRemoteOperations(sshExecutor) : undefined;
    const remoteAgentsFiles = sshExecutor
      ? await sshExecutor
          .exec(['cat', '--', `${cwd}/AGENTS.md`], {
            timeoutMs: (remote?.timeoutSeconds ?? DEFAULT_SSH_TIMEOUT_SECONDS) * 1000,
          })
          .then((result) =>
            result.code === 0 && result.stdout.trim().length > 0
              ? [{ path: `${cwd}/AGENTS.md`, content: result.stdout }]
              : []
          )
          .catch(() => [] as Array<{ path: string; content: string }>)
      : undefined;
    const exploreFold = exploreFoldEnabled ? createExploreFoldState() : undefined;
    const turnDiscard = createTurnDiscardState();
    if (smartCompactSummaryModel) {
      await resolveBaseModelOrRefresh(runtime, smartCompactSummaryModel);
    }
    const { kept: sessionMcp, conflicts: mcpConflicts } = partitionMcpNamespaces(mcpServers);
    for (const { server, clash } of mcpConflicts) {
      this.options.emit({
        type: 'mcp-status',
        ...(server.id ? { serverId: server.id } : {}),
        serverName: server.name,
        state: 'error',
        error: `Server name conflicts with "${clash}" (tool names would collide)`,
      });
    }
    const deferredMcp = sessionMcp.filter(isDeferredMcp);
    const directMcp = sessionMcp.filter((server) => !isDeferredMcp(server));
    const codemodeHost = new CodemodeHost({
      codemode: toolEnabled('isolated_sandbox') && !secretaryMode,
      deferredServers: deferredMcp,
    });
    // 非 Bot 会话即使启动时没有任何插件也挂上注入入口：插件可能在会话之后才启用
    const pluginEventPlan = botMode
      ? undefined
      : (pluginEvents ?? { observe: [], intercept: [], inject: false });
    const pluginEventInvoker = pluginEventPlan
      ? new PluginEventInvoker(pluginEventPlan, (event) => {
          const managed = this.sessions.get(sessionId);
          if (!managed || !isSameGeneration(managed.identity, identity)) return;
          this.options.emit({
            ...event,
            identity: managed.identity,
            seq: ++managed.seq,
          });
        })
      : undefined;
    const reminders = new SystemReminderRegistry();
    const persona: PersonaHolder | undefined = systemPrompt ? { current: systemPrompt } : undefined;
    const resourceLoader = createSessionResourceLoader({
      branchContext: this.branchContextExtension(() => managedRef),
      oauthPoolRecovery: this.oauthPoolRecovery(),
      silentTurnRecovery: silentTurnRecoveryExtension((kind) => {
        if (!managedRef) return;
        managedRef.silentTurnNudgeUsed = true;
        managedRef.silentTurnKind = kind;
      }),
      cwd,
      agentDir: this.options.agentDir,
      noSkills: loadLocalSkills === false,
      // 磁盘上的扩展会自行 registerTool，绕过按名字的允许列表；秘书只保留 inline 工厂
      ...(secretaryMode ? { noExtensions: true } : {}),
      skillPaths,
      instruction,
      remoteAgentsFiles,
      ...(remote ? { remoteSsh: { host: remote.host } } : {}),
      loadHarnessAssets,
      trustedProjectCode,
      ...(pluginEventInvoker ? { pluginEvents: { invoker: pluginEventInvoker } } : {}),
      exploreFold,
      turnDiscard,
      reminders,
      codemode: codemodeHost.extension,
      persona,
      systemPromptAppend,
      systemPromptBoost,
      autoRejectApprovals,
      askRelay: Boolean(askRelay),
      ...(compactStrategy !== 'standard'
        ? {
            compactStrategy,
            compactRoute: this.compactRoute,
            smartCompactSummaryModel,
            smartCompactMode,
          }
        : {}),
    });
    const toolsStart = Date.now();
    const [, mcpTools] = await Promise.all([
      resourceLoader.reload(),
      directMcp.length > 0 ? this.mcp.toolsFor(directMcp, 3000) : Promise.resolve([]),
    ]);
    const toolsMs = Date.now() - toolsStart;
    if (approvalReviewer) this.approvalReviewer = approvalReviewer;

    let managedRef: ManagedSession | undefined;
    const gate = new ApprovalGate(
      approvalMode,
      (request) => {
        if (managedRef) {
          this.options.emit({
            type: 'approval-request',
            identity: managedRef.identity,
            seq: ++managedRef.seq,
            request,
          });
        }
      },
      (requestId) => {
        if (managedRef) {
          this.options.emit({
            type: 'approval-resolved',
            identity: managedRef.identity,
            seq: ++managedRef.seq,
            requestId,
          });
        }
      },
      {
        review: (info, signal) => this.reviewApproval(info, signal),
        protectedFloor: botMode || protectedActions,
        autoReject: autoRejectApprovals,
        ...(botMode ? { exemptFull: true, humanTimeoutMs: HUMAN_REQUEST_TIMEOUT_MS } : {}),
        commandGuard: withTempRootGuard(
          dcgPath ? withDcgExemptions(createDcgGuard(dcgPath), dcgExemptRules) : undefined
        ),
        sessionTempDir: remote ? null : sessionTempDir(sessionId, { cwd }),
      }
    );
    const checkpoints = new CheckpointManager(
      cwd,
      sessionId,
      () => {
        const managed = managedRef ?? this.sessions.get(sessionId);
        const last = managed?.session.sessionManager
          .getBranch()
          .filter((entry) => entry.type === 'message' && entry.message.role === 'user')
          .at(-1);
        return last ? { entryId: last.id, entryTimestamp: new Date(last.timestamp).getTime() } : {};
      },
      // 远程会话:快照直接打在远端 repo(非 git 目录仍然静默降级)
      sshExecutor ? createRemoteCheckpointHost(sshExecutor) : undefined
    );
    // 工具注入：noTools:'builtin' 下 read 也需重注册（免审）；bash 叠 background 能力
    // 后包审批门（审批先问，批准后分流后台），edit 叠宽容版，MCP 同门，todo/task_* 免审。
    // 最外层 decorateSessionTools：引用 / 输出外置 / runaway / system reminder
    type Def = Parameters<typeof withApproval>[2];
    const takePendingReminders = () => {
      if (!managedRef || managedRef.pendingTaskReminders.length === 0) return [];
      const taken = managedRef.pendingTaskReminders.splice(0);
      this.persistPendingReminders(managedRef);
      return taken;
    };
    // 无人值守开关翻转的提示优先走工具结果（无人值守时可能很久没有用户消息，等不到下一条就白说了）
    reminders.register('unattended', () => {
      const managed = managedRef ?? this.sessions.get(sessionId);
      const note = managed?.unattendedNote;
      if (!note || !managed) return [];
      managed.unattendedNote = undefined;
      return [note];
    });
    reminders.register('background-task', () => {
      const pending = takePendingReminders();
      return pending.map((text) => `<background-task-update>\n${text}\n</background-task-update>`);
    });
    reminders.register('task-wrap-up', () => {
      const managed = managedRef ?? this.sessions.get(sessionId);
      if (!managed?.taskWrapUpPending) return [];
      managed.taskWrapUpPending = false;
      const note = this.taskWrapUp(sessionId);
      return note ? [note] : [];
    });
    const todoReminder = new TodoStaleReminder();
    reminders.register('todo-stale', () => todoReminder.take(), -1);
    const runaway = new RunawayGuard();
    const budget = new ToolOutputBudget({
      rootDir: path.join(this.options.sessionDir, 'tool-output', sessionId),
    });
    // 只读探索四件套(read/grep/find/ls,免审):readonly 子代理的全部工具,也是 base 的底座。
    // 远程会话经 operations 注入落到 ssh(grep 无注入点,换整个定义)
    const structuredById = new Map<string, unknown>();
    // 改前须读只对本地工作区生效：远程会话的路径不在本机文件系统上
    const readLedger = remoteOps ? undefined : new ReadLedger(cwd);
    const targetPath = (params: unknown) => {
      const target = extractEditTargetPath(params);
      return target ? [target] : [];
    };
    const recordPaths = (definition: Def, paths: (params: unknown) => string[]): Def =>
      readLedger ? withPathRecord(definition, readLedger, paths) : definition;
    const wrapRead = (definition: Def): Def =>
      recordPaths(
        withReadTruncationMeta(withAgentRead(definition, () => structuredById)),
        targetPath
      );
    const readOnlyTools = (toolGate: ApprovalGate): Def[] => {
      const stock =
        remoteOps && sshExecutor
          ? {
              read: wrapRead(
                createReadToolDefinition(cwd, {
                  operations: remoteOps.read,
                }) as unknown as Def
              ),
              grep: createRemoteGrepToolDefinition(cwd, sshExecutor) as unknown as Def,
            }
          : {
              read: withPathHints(
                wrapRead(
                  createReadToolDefinition(cwd, {
                    operations: localReadOperations,
                  }) as unknown as Def
                ),
                cwd
              ),
              grep: withPathHints(createGrepToolDefinition(cwd) as unknown as Def, cwd),
            };
      // grep 显式指向密钥文件时同样会把内容带回来（pi 的 grep 带 --hidden），与 read 一起受底线约束
      const read = withProtectedFloor(toolGate, 'read', stock.read);
      const grep = withProtectedFloor(toolGate, 'read', stock.grep);
      return remoteOps && sshExecutor
        ? [
            read,
            grep,
            createFindToolDefinition(cwd, { operations: remoteOps.find }) as unknown as Def,
            createLsToolDefinition(cwd, { operations: remoteOps.ls }) as unknown as Def,
          ]
        : [
            read,
            grep,
            withPathHints(createFindToolDefinition(cwd) as unknown as Def, cwd),
            withPathHints(createLsToolDefinition(cwd) as unknown as Def, cwd),
          ];
    };
    // Bot 写成员（本地工作区）参与同工作区写协调
    const writeLock = botWriteLock && !remote ? botWriteLock : undefined;
    if (writeLock) this.workspaceClaims.register({ id: sessionId, ...writeLock });
    // 后台任务 manager 本体始终本地 spawn:远程会话把命令变换成本地 ssh 命令
    const backgroundTransform = remote
      ? (command: string, taskCwd: string) => {
          const controlDir = path.join(this.options.agentDir, 'ssh');
          let sshCommand = buildSshShellCommand(remote.host, command, {
            cwd: taskCwd,
            controlPath: resolveSshControlPath(controlDir),
            auth: remote.auth,
            port: remote.port,
          });
          if (remote.auth === 'password' && remote.password) {
            const env = sshPasswordEnv(controlDir, remote.password);
            sshCommand = `${[
              'SSH_ASKPASS',
              'SSH_ASKPASS_REQUIRE',
              'DISPLAY',
              'ENSO_SSH_ASKPASS_PASSWORD',
              'SSH_AUTH_SOCK',
            ]
              .map((key) => `${key}=${shellQuote(env[key] ?? '')}`)
              .join(' ')} ${sshCommand}`;
          }
          return { command: sshCommand, cwd: process.cwd() };
        }
      : undefined;
    const buildBaseTools = (
      toolGate: ApprovalGate,
      cp?: CheckpointManager,
      writeScope?: readonly string[],
      foregroundSessionId = sessionId
    ): Def[] => {
      const guarded = (definition: Def): Def => (cp ? withCheckpoint(definition, cp) : definition);
      const claimContext = { owner: sessionId, cwd };
      const claimFiles = (definition: Def): Def =>
        writeLock ? withFileClaims(definition, this.workspaceClaims, claimContext) : definition;
      const exclusive = (definition: Def): Def =>
        writeLock
          ? withExclusiveCommand(definition, this.workspaceClaims, claimContext)
          : definition;
      // scope 与完整只读预检都在审批之外；checkpoint 仅在批准后触发。
      const scoped = (
        kind: 'file-edit' | 'file-write',
        definition: Def,
        preflight?: (params: unknown, signal: AbortSignal | undefined) => Promise<unknown>
      ): Def => {
        const approved = withApproval(toolGate, kind, claimFiles(guarded(definition)));
        return withWriteScope(
          preflight ? withWritePreflight(approved, preflight) : approved,
          cwd,
          writeScope
        );
      };
      const stockEdit = createNormalizedEditTool(
        cwd,
        remoteOps ? { operations: remoteOps.edit } : undefined
      ) as unknown as Def;
      const stockWrite = createWriteToolDefinition(
        cwd,
        remoteOps ? { operations: remoteOps.write } : undefined
      ) as unknown as Def;
      const patchIo = sshExecutor ? createRemoteApplyPatchIo(cwd, sshExecutor) : undefined;
      const mutations =
        sessionEditMode === 'apply_patch'
          ? [
              scoped(
                'file-edit',
                recordPaths(
                  createApplyPatchTool({
                    cwd,
                    ...(patchIo ? { io: patchIo } : {}),
                  }) as unknown as Def,
                  getApplyPatchPaths
                ),
                (params: unknown, signal: AbortSignal | undefined) =>
                  validateApplyPatchTargets(cwd, params, patchIo, signal)
              ),
            ]
          : [
              scoped('file-edit', recordPaths(stockEdit, targetPath)),
              ((write: Def) => (readLedger ? withPriorRead(write, readLedger, targetPath) : write))(
                scoped('file-write', recordPaths(stockWrite, targetPath))
              ),
            ];
      const commandTool = withBackground(
        withRtkOptimization(
          createSessionCommandTool({
            cwd,
            remote: Boolean(remoteOps),
            preference: windowsLocalShell,
            operations: remoteOps?.bash,
          }) as unknown as Def,
          {
            binaryPath: process.env.ENSO_RTK_PATH,
            dataDir: path.join(this.options.agentDir, 'rtk'),
            cwd,
            remote: Boolean(remoteOps),
            enabled: rtkEnabled,
          }
        ),
        this.bgTasks,
        foregroundSessionId,
        cwd,
        backgroundTransform
      );
      // 提权只在本机 bash：远程会话的 sudo 在远端，连不上本机 askpass 服务
      const elevation = remoteOps ? null : prepareElevation();
      return [
        ...readOnlyTools(toolGate),
        withApproval(
          toolGate,
          'command',
          exclusive(
            guarded(
              elevation
                ? withElevation(commandTool, {
                    ...elevation,
                    unattended: () => toolGate.autoReject,
                  })
                : commandTool
            )
          )
        ),
        ...mutations,
      ];
    };
    const wrapMcpTools = (toolGate: ApprovalGate): Def[] =>
      mcpTools.map((tool) => withApproval(toolGate, 'mcp', tool));
    /** 按需 MCP：首次 codemode / tool_search 调用时连接，工具经同一套审批与装饰后动态注册 */
    const deferredMcpLoader =
      (toolGate: ApprovalGate, finish: (tools: Def[]) => Def[]) =>
      async (server: McpServerSpawnConfig): Promise<Def[] | null> => {
        const resolved = await this.mcp.resolve(server);
        return resolved.ok
          ? finish(resolved.tools.map((tool) => withApproval(toolGate, 'mcp', tool)))
          : null;
      };
    const buildCoreTools = (): Def[] => [
      ...(toolEnabled(WORKSPACE_WRITE_TOOL_ID)
        ? buildBaseTools(gate, checkpoints)
        : readOnlyTools(gate)),
      ...wrapMcpTools(gate),
    ];
    // 会话工厂：一次性 subagent 与持久 coworker 共用。gate 参数化——subagent 复用父门,
    // coworker 用独立门(否则审批条落错 tab、allowSession 白名单跨会话泄漏)
    const factory: SessionFactory = {
      cwd,
      runGate: (gateCommand) => runGateCommand(cwd, gateCommand, sshExecutor),
      agentTypes,
      subagentModels,
      modelId: model.modelId,
      createChildSession: async ({
        agentType,
        resolved,
        modelOverride,
        thinkingOverride,
        identity: childIdentity,
        gate: childGate,
        resumeFile: childResume,
        extraTools = [],
        pluginSource,
        ephemeral,
        sessionId: childSessionId,
      }) => {
        // 子会话起的后台任务归子会话：完成通知、任务条与收尾清单都按它算，不落到父会话
        const taskOwnerId = childIdentity?.sessionId ?? childSessionId;
        // 插件能力下沉：只读档不挂插件工具（可能有副作用，
        // Plan 模式靠只读子代理保证不写）；事件只拦 tool_call（独立预算），其余只通知
        const childPlugins = pluginSource
          ? this.childPluginBridge(
              pluginSource,
              resolved?.displayName ?? agentType?.name,
              resolved?.tools === 'readonly' || agentType?.tools === 'readonly'
                ? []
                : pluginToolDescriptors,
              childPluginEventPlan(pluginEventPlan)
            )
          : undefined;
        const selectedMcp = resolved?.mcpServers ?? agentType?.mcpServers ?? [];
        // 冷连接最长 3s：与模型解析、资源加载并行，不串在首字节前的关键路径最前面
        const mcpPending =
          selectedMcp.length > 0
            ? Promise.all(selectedMcp.map((server) => this.mcp.toolsFor([server], 3000)))
            : Promise.resolve([]);
        const selectedModel = modelOverride ?? resolved?.model ?? agentType?.model ?? model;
        const base = await resolveSessionModel(runtime, selectedModel);
        // 派发 thinking > 类型预设 > 父会话 > 模型条目预设：默认值不压过用户当下的选择。
        // 类型预设来源：typed-spawn 用 resolved（Main 组装的类型配置），
        // coworker 直雇用 agentType（worker 侧快照）——此前 typed-spawn 不传，类型档被静默丢弃。
        // 父会话读实时状态：会话中途改档走 set-thinking/set-reasoning，闭包里的 spawn 参数已过期。
        const parentSession = this.sessions.get(identity.sessionId)?.session;
        const parentLevel = parentSession
          ? parentSession.thinkingLevel
          : reasoningEnabled
            ? thinkingLevel
            : 'off';
        const parentEnabled = parentSession
          ? parentSession.model?.reasoning === true && parentLevel !== 'off'
          : reasoningEnabled;
        const childReasoning = resolveChildReasoning(
          pickChildReasoningOverride(thinkingOverride, resolved ?? agentType),
          parentEnabled,
          parentLevel === 'off' ? undefined : parentLevel,
          selectedModel
        );
        const fittedReasoning = fitChildReasoningToModel(childReasoning, base);
        const subModel = applyReasoningToModel(
          { ...base, compat: base.compat ? { ...base.compat } : undefined },
          fittedReasoning.enabled,
          selectedModel.modelId
        );
        const childExploreFold = exploreFoldEnabled ? createExploreFoldState() : undefined;
        const typed = Boolean(resolved || agentType);
        const childCodemode = new CodemodeHost({
          codemode: toolEnabled('isolated_sandbox'),
          deferredServers: typed ? [] : deferredMcp,
        });
        const selectedSkillPaths = resolved?.skillPaths ?? agentType?.skillPaths ?? [];
        const branchContext = this.branchContextExtension(() =>
          [...this.sessions.values()].find((managed) => managed.session === session)
        );
        const silentTurnRecovery = silentTurnRecoveryExtension((kind) => {
          if (!childIdentity) return;
          const managed = this.sessions.get(childIdentity.sessionId);
          if (!managed || !isSameGeneration(managed.identity, childIdentity)) return;
          managed.silentTurnNudgeUsed = true;
          managed.silentTurnKind = kind;
        });
        const childReminders = new SystemReminderRegistry();
        if (taskOwnerId) {
          childReminders.register('background-task', () => {
            const notices = this.sessions.get(taskOwnerId)?.childTaskNotices;
            if (!notices?.length) return [];
            return notices
              .splice(0)
              .map((text) => `<background-task-update>\n${text}\n</background-task-update>`);
          });
        }
        const subLoader = createSessionResourceLoader({
          branchContext,
          silentTurnRecovery,
          oauthPoolRecovery: this.oauthPoolRecovery(),
          cwd,
          agentDir: this.options.agentDir,
          noSkills: resolved || agentType ? true : loadLocalSkills === false,
          noExtensions: Boolean(resolved || agentType),
          skillPaths: resolved || agentType ? [...selectedSkillPaths] : skillPaths,
          instruction,
          remoteAgentsFiles,
          ...(remote ? { remoteSsh: { host: remote.host } } : {}),
          // 类型化子代理与项目资源隔离（同 noSkills/noExtensions），不追加 harness 资源
          loadHarnessAssets: resolved || agentType ? false : loadHarnessAssets,
          trustedProjectCode,
          ...(childPlugins?.events ? { pluginEvents: { invoker: childPlugins.events } } : {}),
          ...(childExploreFold ? { exploreFold: childExploreFold } : {}),
          reminders: childReminders,
          codemode: childCodemode.extension,
          childContract: true,
          autoRejectApprovals: childGate.autoReject,
          systemPromptAppend,
          systemPromptBoost,
        });
        const [mcpToolGroups] = await Promise.all([mcpPending, subLoader.reload()]);
        if (mcpToolGroups.some((tools) => tools.length === 0)) {
          throw new Error('Agent profile MCP resource failed to establish.');
        }
        const typeMcpTools = mcpToolGroups
          .flat()
          .map((tool) => withApproval(childGate, 'mcp', tool));
        // 子会话自己的门：审批条落在子会话 tab，allowSession 不跨会话（同 MCP）
        const childPluginTools = childPlugins?.tools
          ? createPluginTools([...childPlugins.descriptors], childPlugins.tools).map((tool) =>
              withApproval(childGate, 'mcp', tool)
            )
          : [];
        const childTools = [
          ...(!toolEnabled(WORKSPACE_WRITE_TOOL_ID) ||
          resolved?.tools === 'readonly' ||
          agentType?.tools === 'readonly'
            ? readOnlyTools(childGate)
            : [
                ...buildBaseTools(childGate, undefined, agentType?.writeScope, taskOwnerId),
                // 子代理要能读、停、表态自己起的任务，否则常驻任务会让持有中的 Run 收不了口
                ...(taskOwnerId
                  ? [
                      ...createTaskTools(this.bgTasks, taskOwnerId),
                      // 子代理的提醒只叫醒它自己，最长不超过 Run 持有上限
                      ...createReminderTools(this.reminders, taskOwnerId, {
                        maxDelayMs: AGENT_RUN_HOLD_LIMIT_MS,
                        unavailable: () =>
                          this.sessions.get(taskOwnerId)?.agentRun
                            ? undefined
                            : 'Reminders only work while you run a subagent Run for your parent.',
                      }),
                    ]
                  : []),
              ]),
          ...(typed ? typeMcpTools : wrapMcpTools(childGate)),
          ...childPluginTools,
          ...(extraTools as Def[]),
          ...(childExploreFold ? createExploreFoldTools(childExploreFold) : []),
        ];
        const childRunaway = new RunawayGuard();
        const requestBudget = new RequestBudget();
        // 到软预算时把一次性收尾提示排进下一条工具结果
        childReminders.register('request-budget', () => {
          const notice = requestBudget.takeNotice();
          return notice ? [notice] : [];
        });
        const childBudget = new ToolOutputBudget({
          rootDir: path.join(
            this.options.sessionDir,
            'tool-output',
            childIdentity?.sessionId ?? `${sessionId}-child`
          ),
        });
        const rawSubTools = childTools;
        const decorateChild = (tools: Def[]) =>
          decorateSessionTools(tools, {
            runaway: childRunaway,
            budget: childBudget,
          });
        const subTools = omitNamedTools(decorateChild(rawSubTools), disabledTools);
        childCodemode.bindDeferredTools(deferredMcpLoader(childGate, decorateChild));
        const sessionManager = childResume
          ? SessionManager.open(childResume, this.options.sessionDir, cwd)
          : ephemeral
            ? SessionManager.inMemory(cwd)
            : SessionManager.create(cwd, this.options.sessionDir);
        const { session } = await createAgentSession({
          cwd,
          agentDir: this.options.agentDir,
          modelRuntime: runtime,
          model: subModel,
          thinkingLevel: fittedReasoning.level,
          noTools: 'builtin',
          customTools: subTools,
          resourceLoader: subLoader,
          sessionManager,
        });
        installLongCacheRetention(session.agent, this.isLongCacheRetention);
        const childExtraTools = childCodemode.activeToolNames();
        const childCursor = isCursorModel(subModel)
          ? attachCursorBridgeToSession(
              session,
              subTools.map((tool) => withSystemReminders(tool, childReminders)),
              cwd
            )
          : undefined;
        if (childIdentity) {
          const childServers = typed
            ? selectedMcp
            : directMcp.filter((server) => !isDeferredMcp(server));
          this.rememberMcpHotplug(
            childIdentity.sessionId,
            new Set(childServers.map((server) => this.mcpServerKey(server))),
            (tools) => {
              this.installAdoptedMcpTools(
                childCodemode,
                childIdentity.sessionId,
                decorateChild(tools.map((tool) => withApproval(childGate, 'mcp', tool))),
                childCursor,
                childReminders
              );
            }
          );
        }
        return {
          session,
          modelId: selectedModel.modelId,
          modelRef: settingsModelRef(selectedModel),
          toolIds: [...subTools.map((tool) => tool.name), ...childExtraTools],
          // 装饰器会克隆工具，所以要在装饰前按对象引用排除 MCP 与插件工具。
          proofToolIds: [
            ...rawSubTools
              .filter((tool) => !typeMcpTools.includes(tool) && !childPluginTools.includes(tool))
              .map((tool) => tool.name),
            ...childExtraTools,
          ],
          runawayGuard: childRunaway,
          requestBudget,
          ...(childPlugins?.tools ? { pluginTools: childPlugins.tools } : {}),
          ...(childPlugins?.events ? { pluginEvents: childPlugins.events } : {}),
        };
      },
    };
    // 子代理：同 worker 子会话，复用 runtime/model/审批门/MCP 连接；不含 subagent/coworker（防递归）。
    // 隔离沙箱 / 探后折叠跟父会话同一开关，catalog 用子自己的工具集。
    const agentControl = new AgentControlInvoker(
      identity,
      (event) => this.options.emit(event),
      randomUUID,
      () => {
        const managed = managedRef ?? this.sessions.get(sessionId);
        if (!managed) throw new Error('Agent control session is not ready.');
        return ++managed.seq;
      }
    );
    const coworkerIdle = new CoworkerIdleReminder();
    const spawnedAgentTypes = new Map<string, string>();
    reminders.register(
      'coworker-idle',
      () =>
        coworkerIdle.take((runIds) => {
          // worker 不知道 agentId：按 Main 下发给子会话的 runId（prompt-child 的 requestId）对上队员
          const parent = managedRef ?? this.sessions.get(sessionId);
          for (const info of parent?.coworkers.values() ?? []) {
            const child = this.sessions.get(info.id);
            if (child && [...runIds].some((runId) => child.promptedRequestIds.has(runId))) {
              return { name: info.name, running: child.status === 'running' };
            }
          }
          return null;
        }),
      -1
    );
    const unifiedSubagentTool = createUnifiedSubagentTool({
      agentTypes,
      models: subagentModels,
      invoke: async (request, signal, detach) => {
        const response = await agentControl.invoke(request, signal, detach);
        coworkerIdle.observe(request, response);
        const receipt = (response.ok ? response.value : undefined) as
          | { agentId?: unknown }
          | undefined;
        if (request.operation === 'spawn' && typeof receipt?.agentId === 'string') {
          spawnedAgentTypes.set(receipt.agentId, request.agentType ?? '');
        }
        return response;
      },
      trackWait: (toolCallId) => this.bgTasks.trackBlockingWait(sessionId, toolCallId),
    });
    const askManager = this.createAskManager(identity, gate.humanTimeoutMs);
    askManager.autoReject = gate.autoReject;
    // 秘书派出/跟踪的会话：ask_user 先转给秘书，而不是按无人值守直接拒绝
    if (askRelay) askManager.relay = askRelay;
    // 可热切的内置工具始终注册；激活与否由 applyBuiltinTools 按当前设置决定
    const builtinGroups = new Map<string, string[]>();
    const builtin = (id: string, tools: Def[]): Def[] => {
      builtinGroups.set(id, [...(builtinGroups.get(id) ?? []), ...tools.map((tool) => tool.name)]);
      return tools;
    };
    // 内嵌浏览器：页面活在 Main，worker 只发 browser-invoke 事件。每个父会话一张挂起表。
    const browser = new BrowserInvoker(identity, (request) => {
      const managed = managedRef ?? this.sessions.get(sessionId);
      if (!managed) throw new Error('Session is not ready for browser actions.');
      this.options.emit({
        type: 'browser-invoke',
        identity: managed.identity,
        seq: ++managed.seq,
        requestId: request.requestId,
        op: request.op,
        params: request.params,
      });
    });
    // 记忆库活在 Main（better-sqlite3），worker 只发 memory-invoke 事件，同 browser 桥。
    const memory = new MemoryInvoker(identity, (request) => {
      const managed = managedRef ?? this.sessions.get(sessionId);
      if (!managed) throw new Error('Session is not ready for memory actions.');
      this.options.emit({
        type: 'memory-invoke',
        identity: managed.identity,
        seq: ++managed.seq,
        requestId: request.requestId,
        op: request.op,
        params: request.params,
      });
    });
    const delegation = botMode
      ? new MemoryInvoker<DelegationOp>(identity, (request) => {
          const managed = managedRef ?? this.sessions.get(sessionId);
          if (!managed) throw new Error('Session is not ready for delegations.');
          this.options.emit({
            type: 'delegation-invoke',
            identity: managed.identity,
            seq: ++managed.seq,
            requestId: request.requestId,
            op: request.op,
            params: request.params,
          });
        })
      : undefined;
    const secretary = secretaryMode
      ? new MemoryInvoker<SecretaryInvokeOp>(identity, (request) => {
          const managed = managedRef ?? this.sessions.get(sessionId);
          if (!managed) throw new Error('Session is not ready for secretary actions.');
          this.options.emit({
            type: 'secretary-invoke',
            identity: managed.identity,
            seq: ++managed.seq,
            requestId: request.requestId,
            op: request.op,
            params: request.params,
          });
        })
      : undefined;
    const workflowRoots = workflowPresetRoots(remote ? undefined : cwd, {
      customDir: this.options.workflowDir,
      pluginFiles: workflowPresetFiles,
    });
    const workflowRuns = new Map<string, AbortController>();
    const computer = !remote
      ? new ComputerInvoker(
          identity,
          (request) => {
            const managed = managedRef ?? this.sessions.get(sessionId);
            if (!managed) throw new Error('Session is not ready for computer actions.');
            this.options.emit({
              type: 'computer-invoke',
              identity: managed.identity,
              seq: ++managed.seq,
              requestId: request.requestId,
              op: request.op,
              params: request.params,
            });
          },
          {
            emitCancel: (requestId) => {
              const managed = managedRef ?? this.sessions.get(sessionId);
              if (!managed) return;
              this.options.emit({
                type: 'computer-cancel',
                identity: managed.identity,
                seq: ++managed.seq,
                requestId,
              });
            },
          }
        )
      : undefined;
    const pluginTools =
      pluginToolDescriptors.length > 0
        ? new PluginToolInvoker(
            identity,
            (request) => {
              const managed = managedRef ?? this.sessions.get(sessionId);
              if (!managed) throw new Error('Session is not ready for plugin tools.');
              this.options.emit({
                type: 'plugin-tool-invoke',
                identity: managed.identity,
                seq: ++managed.seq,
                requestId: request.requestId,
                toolName: request.toolName,
                args: request.args,
              });
            },
            {
              emitCancel: (requestId) => {
                const managed = managedRef ?? this.sessions.get(sessionId);
                if (!managed) return;
                this.options.emit({
                  type: 'plugin-tool-cancel',
                  identity: managed.identity,
                  seq: ++managed.seq,
                  requestId,
                });
              },
            }
          )
        : undefined;
    const sessionTools = [
      ...buildCoreTools(),
      ...(secretary ? createSecretaryTools(secretary) : []),
      ...(secretary ? [createSilenceTurnTool()] : []),
      // 秘书自造工具：名字与参数结构由 Main 下发，非只读的每次都要人确认
      ...(secretary
        ? createSecretaryCustomTools(secretary, secretaryToolDescriptors).map((tool) =>
            withMandatoryApproval(gate, 'mcp', tool)
          )
        : []),
      // 秘书没有 read：SKILL.md 只能按本次加载的 skill 表读
      ...(secretaryMode ? [createSkillReadTool(() => resourceLoader.getSkills().skills)] : []),
      // 编码会话看图：白名单是自己的工作目录、系统临时目录与应用存放用户图片的目录。
      // 远程会话的文件不在本机，装了只会读到错的路径
      ...(secretaryMode || remote
        ? []
        : [createImageViewTool({ cwd, userImageDirs: this.options.userImageDirs })]),
      ...builtin(
        'browser',
        createBrowserTools(browser).map((tool) => withNavigateApproval(gate, tool))
      ),
      ...builtin('memory', createMemoryTools(memory, { language: memoryLanguage })),
      ...(delegation
        ? createDelegationTools(delegation, {
            groupTasks: botGroupTasks,
            delegationTask: botDelegationTask,
            discussMode: botDiscussMode,
          })
        : []),
      ...(delegation && botGroupTasks
        ? [createGroupTasksTool(delegation), createGroupHistoryTool(delegation)]
        : []),
      ...(delegation && botRoutines
        ? [
            createRoutineProposeTool(delegation),
            createSendImageTool(delegation, cwd, confirmOutsideImage(gate)),
          ]
        : []),
      ...builtin('web', createWebTools({ chain: () => this.webSearchChain })),
      ...builtin('image_generation', [
        createImageGenTool({
          getConfig: () => this.imageGeneration,
          cwd,
          remote: !!remote,
          confirmOutside: confirmImageReference(gate, !!remote),
        }),
      ]),
      ...builtin('todo', [createTodoTool((todos) => todoReminder.update(todos))]),
      ...(computer
        ? builtin('computer', [withComputerApproval(gate, createComputerTool(computer))])
        : []),
      ...(pluginTools
        ? createPluginTools([...pluginToolDescriptors], pluginTools, {
            untrusted: secretaryMode,
          }).map((tool) =>
            // 秘书会话里的插件工具可能以用户身份往外发消息：非只读的每次都要人确认
            secretaryMode
              ? withMandatoryApproval(gate, 'mcp', tool)
              : withApproval(gate, 'mcp', tool)
          )
        : []),
      ...builtin('ask_user', [createAskTool(askManager, { secretary: secretaryMode })]),
      ...builtin('subagent', [unifiedSubagentTool]),
      ...builtin('workflow', [
        createWorkflowTool({
          invoke: (request, signal) => agentControl.invoke(request, signal),
          // 远程会话的 cwd 在远端，本地只读设置、全局与内置预设（与 Main 列表口径一致）
          loadPreset: (id) => loadWorkflowPreset(id, workflowRoots, this.disabledWorkflowPresets),
          presets: listWorkflowPresets(workflowRoots, this.disabledWorkflowPresets),
          models: subagentModels,
          agentTypes,
          activeRuns: workflowRuns,
          journalDir: this.workflowJournalDir(),
          sessionId,
          notify: (text, urgent) => this.notifier.notify(sessionId, text, { urgent }),
          emit: (run) => {
            const managed = managedRef ?? this.sessions.get(sessionId);
            if (!managed) return;
            this.options.emit({
              type: 'workflow-status',
              identity: managed.identity,
              seq: ++managed.seq,
              run,
            });
          },
        }),
      ]),
      ...(exploreFold ? createExploreFoldTools(exploreFold) : []),
      ...builtin('turn_discard', createTurnDiscardTools(turnDiscard)),
      ...builtin('background_tasks', [
        ...createTaskTools(this.bgTasks, sessionId),
        ...createReminderTools(this.reminders, sessionId, { maxDelayMs: REMINDER_MAX_DELAY_MS }),
      ]),
      ...(toolEnabled('goal')
        ? createGoalTools(
            (kind, note, result) => {
              const managed = managedRef ?? this.sessions.get(sessionId);
              if (!managed) return;
              this.options.emit({
                type: 'goal-signal',
                identity: managed.identity,
                seq: ++managed.seq,
                kind,
                note,
                ...(result ? { result } : {}),
              });
            },
            async (summary, signal) => {
              const managed = managedRef ?? this.sessions.get(sessionId);
              return managed ? this.verifyGoalCompletion(managed, summary, signal) : undefined;
            },
            () => this.taskWrapUp(sessionId)
          )
        : []),
    ];
    // Plan 工具门包在父会话工具最外层（codemode 嵌套调用同样受限）；目录跨模式不变
    const planRef: { current?: PlanController } = {};
    const planHost = {
      state: () => planRef.current?.state() ?? EMPTY_PLAN_STATE,
      submit: (doc: Parameters<PlanController['submit']>[0]) => planRef.current?.submit(doc),
    };
    const readonlyAgentTypes = new Set(
      agentTypes.filter((type) => type.tools === 'readonly').map((type) => type.name)
    );
    const ownerGate = new OwnerGate();
    const planGated = (tools: Def[]): Def[] =>
      tools.map((tool) =>
        withOwnerGate(
          withPlanGate(tool, {
            host: planHost,
            readonlyAgentTypes,
            agentTypeOf: (agentId) => spawnedAgentTypes.get(agentId),
          }),
          ownerGate,
          (entry) => {
            if (!this.options.dataDir) return;
            appendCappedLog(
              path.join(this.options.dataDir, OWNER_GATE_AUDIT_LOG),
              `owner-gate session=${sessionId} ${JSON.stringify(entry)}`
            );
          }
        )
      );
    // 秘书按名字做允许列表：黑名单只能关掉已知分组，核心工具、插件工具与自造工具都不在其中。
    // 插件工具与自造工具的名字只认 Main 本次下发的描述符，不按前缀放行
    const secretaryExtraToolNames = new Set([
      ...pluginToolDescriptors.map((tool) => tool.name),
      ...secretaryToolDescriptors.map((tool) => tool.name),
    ]);
    const customTools = omitNamedTools(
      decorateSessionTools(
        [
          ...planGated(sessionTools),
          ...builtin('plan', [createSubmitPlanTool(planHost, randomUUID)]),
        ],
        { runaway, budget }
      ),
      disabledTools
    ).filter(
      (tool) => !secretaryMode || isSecretaryToolAllowed(tool.name, secretaryExtraToolNames)
    );
    codemodeHost.bindDeferredTools(
      deferredMcpLoader(gate, (tools) =>
        decorateSessionTools(planGated(tools), { runaway, budget })
      )
    );

    const { session } = await createAgentSession({
      cwd,
      agentDir: this.options.agentDir,
      modelRuntime: runtime,
      model: piModel,
      thinkingLevel: reasoningEnabled ? (thinkingLevel ?? 'medium') : 'off',
      resourceLoader,
      noTools: 'builtin',
      ...(customTools.length > 0 ? { customTools } : {}),
      sessionManager: resumeFile
        ? SessionManager.open(resumeFile, this.options.sessionDir, cwd)
        : SessionManager.create(cwd, this.options.sessionDir),
    });
    ownerGate.syncFromMessages(session.messages);
    installLongCacheRetention(session.agent, this.isLongCacheRetention);
    const codemodeTools = codemodeHost.activeToolNames();
    const cursorBridge = isCursorModel(piModel)
      ? attachCursorBridgeToSession(
          session,
          customTools.map((tool) => withSystemReminders(tool, reminders)),
          cwd
        )
      : undefined;
    if (!cursorBridge) ensureAssistantUsage(session.messages as unknown[]);
    console.log(
      `[spawn] ${sessionId.slice(0, 8)} total ${Date.now() - spawnStart}ms` +
        ` (tools ${toolsMs}ms, mcp ${mcpTools.length} tools + ${deferredMcp.length} deferred servers, cwd ${cwd})`
    );

    managedRef = this.registerManagedSession(identity, session, gate, model.modelId, {
      resumeFile,
      asks: askManager,
      factory,
      toolIds: [...customTools.map((tool) => tool.name), ...codemodeTools],
      checkpoints,
      runawayGuard: runaway,
    });
    managedRef.ownerGate = ownerGate;
    // 秘书不订阅 MCP 热插拔：之后连上的 MCP 工具不走装配时的允许列表
    this.rememberMcpHotplug(
      sessionId,
      new Set(secretaryMode ? [] : directMcp.map((server) => this.mcpServerKey(server))),
      (tools) => {
        for (const tool of tools) {
          if (!mcpTools.some((existing) => existing.name === tool.name)) mcpTools.push(tool);
        }
        this.installAdoptedMcpTools(
          codemodeHost,
          sessionId,
          decorateSessionTools(planGated(tools.map((tool) => withApproval(gate, 'mcp', tool))), {
            runaway,
            budget,
          }),
          cursorBridge,
          reminders
        );
      }
    );
    if (instanceId) managedRef.instanceId = instanceId;
    managedRef.agentControl = agentControl;
    managedRef.workflowRuns = workflowRuns;
    if (rolePrompt && !resumeFile) managedRef.pendingRole = rolePrompt;
    if (persona) managedRef.persona = persona;
    if (refusalRetryPrompt) managedRef.refusalRetryPrompt = refusalRetryPrompt;
    managedRef.browser = browser;
    managedRef.memory = memory;
    const managed = managedRef;
    const plan = new PlanController(
      {
        branch: () => session.sessionManager.getBranch(),
        append: (entry) => session.sessionManager.appendCustomEntry(PLAN_ENTRY_TYPE, entry),
      },
      () => this.emitPlanState(managed)
    );
    // 关掉 plan 时先退出 plan 模式，再撤掉控制器：工具门不再限制，set-plan-mode 不再生效
    const setPlanEnabled = (enabled: boolean) => {
      if (enabled === (managed.plan !== undefined)) return;
      if (!enabled) {
        if (plan.state().active) plan.setActive(false);
        planRef.current = undefined;
        managed.plan = undefined;
        return;
      }
      planRef.current = plan;
      managed.plan = plan;
      this.emitPlanState(managed);
    };
    managed.applyBuiltinTools = (disabled) => {
      const enabled = enabledHotBuiltins(disabled);
      const active = session.getActiveToolNames();
      // 分组会把名字加回来，秘书再与允许列表求交，否则恢复一个分组就绕过了装配时的过滤
      const next = nextActiveToolNames(active, builtinGroups, enabled).filter(
        (name) => !secretaryMode || isSecretaryToolAllowed(name, secretaryExtraToolNames)
      );
      if (next.length !== active.length || next.some((name, index) => name !== active[index])) {
        session.setActiveToolsByName(next);
      }
      setPlanEnabled(enabled.has('plan'));
    };
    const pendingTools = this.pendingBuiltinTools.get(sessionId);
    this.pendingBuiltinTools.delete(sessionId);
    managed.applyBuiltinTools(
      pendingTools && isSameGeneration(pendingTools.identity, identity)
        ? pendingTools.disabled
        : disabledTools
    );
    if (managed.plan && planMode !== undefined) plan.setActive(planMode);
    managedRef.computer = computer;
    managedRef.pluginTools = pluginTools;
    managedRef.pluginEvents = pluginEventInvoker;
    managedRef.delegation = delegation;
    managedRef.secretary = secretary;
    if (pluginEventInvoker) {
      await emitPluginSessionStart(session, resumeFile ? 'resume' : 'startup');
    }
    this.options.emit({
      type: 'parent-ready',
      identity,
      seq: ++managedRef.seq,
      sessionFile: requiredSessionFile(session),
      model: settingsModelRef(model),
      imageInput: acceptsImageInput(session.model),
    });
    this.continueAfterRestart(managedRef);
    this.wakeAfterOpen(managedRef);
    checkpoints?.cleanupOldSessions();
  }

  private createAskManager(identity: SessionIdentity, humanTimeoutMs?: number): AskManager {
    return new AskManager(
      (ask) => {
        const managed = this.sessions.get(identity.sessionId);
        if (managed && isSameGeneration(managed.identity, identity)) {
          this.options.emit({
            type: 'ask-request',
            identity: managed.identity,
            seq: ++managed.seq,
            ask,
          });
        }
      },
      (requestId, resolution) => {
        const managed = this.sessions.get(identity.sessionId);
        if (managed && isSameGeneration(managed.identity, identity)) {
          applyOwnerAskResolution(managed.ownerGate, resolution);
          this.options.emit({
            type: 'ask-resolved',
            identity: managed.identity,
            seq: ++managed.seq,
            requestId,
            ...(resolution?.by ? { by: resolution.by } : {}),
            ...(resolution?.answer ? { answer: resolution.answer } : {}),
            ...(resolution?.name ? { name: resolution.name } : {}),
            ...(resolution?.relatesTo ? { relatesTo: resolution.relatesTo } : {}),
            ...(resolution?.askedAt !== undefined ? { askedAt: resolution.askedAt } : {}),
          });
        }
      },
      humanTimeoutMs
    );
  }

  /** pi 的 save()/reload() 会重算 settings 冲掉 applyOverrides，故包住实例读取口，每次取当前上限 */
  private bindAutoRetryLimit(session: AgentSession): void {
    const settings = session.settingsManager as AgentSession['settingsManager'] | undefined;
    if (!settings) return;
    const base = settings.getRetrySettings.bind(settings);
    settings.getRetrySettings = () => ({ ...base(), ...autoRetryOverrides(this.autoRetryLimit) });
    settings.getRetryEnabled = () => autoRetryOverrides(this.autoRetryLimit).enabled;
  }

  private registerManagedSession(
    identity: SessionIdentity,
    session: AgentSession,
    gate: ApprovalGate,
    modelId: string,
    opts: {
      factory?: SessionFactory;
      childIdentity?: ChildSessionIdentity;
      childMetadata?: ChildConversationMetadata;
      parentId?: string;
      coworkerName?: string;
      resumeFile?: string;
      asks?: AskManager;
      checkpoints?: CheckpointManager;
      toolIds?: string[];
      proofToolIds?: string[];
      runawayGuard?: RunawayGuard;
      requestBudget?: RequestBudget;
    } = {}
  ): ManagedSession {
    batchSteering(session);
    const restartResume = opts.resumeFile
      ? this.claimRestartResume(identity, opts.resumeFile)
      : undefined;
    const customEntries = session.sessionManager.getBranch().flatMap((entry) => {
      if (entry.type !== 'custom' || entry.customType !== 'enso-agent-session') return [];
      const parsed = parseAgentSessionCustomEntry(entry.data);
      return parsed ? [parsed] : [];
    });
    const managed: ManagedSession = {
      identity,
      ...(opts.childIdentity ? { childIdentity: opts.childIdentity } : {}),
      ...(opts.childMetadata ? { childMetadata: opts.childMetadata } : {}),
      session,
      status: 'idle',
      // 优雅重启接管：沿用上一代的序号，Main 与各窗口的单调守卫照常放行
      seq: restartResume?.seq ?? 0,
      ...(restartResume ? { restartResume } : {}),
      messages: [],
      turnStartIndex: 0,
      customEntries,
      commands: collectSlashCommands(session),
      modelId,
      toolIds: opts.toolIds ?? [],
      proofToolIds: opts.proofToolIds ?? opts.toolIds ?? [],
      promptedRequestIds: new Set(),
      adaptiveDowngraded: new Set<string>(),
      silentTurnNudgeUsed: false,
      ...(opts.runawayGuard ? { runawayGuard: opts.runawayGuard } : {}),
      ...(opts.requestBudget ? { requestBudget: opts.requestBudget } : {}),
      timings: [],
      toolStartAt: new Map(),
      toolNames: new Map(),
      toolDurations: new Map(),
      gate,
      asks: opts.asks ?? this.createAskManager(identity, gate.humanTimeoutMs),
      // 上次进程退出前没投出去的通知：恢复后随下一次工具结果或回合收口补投
      pendingTaskReminders: this.pendingNotifications.load(identity.sessionId),
      roundWaiters: new Set(),
      coworkers: new Map(),
      lastActivityAt: Date.now(),
      activityNonce: 0,
      contextUsage: new UsageTracker(),
      ...(opts.factory ? { factory: opts.factory } : {}),
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
      ...(opts.coworkerName ? { coworkerName: opts.coworkerName } : {}),
      ...(opts.checkpoints ? { checkpoints: opts.checkpoints } : {}),
      unsubscribe: () => {},
    };
    managed.unsubscribe = session.subscribe((event) => {
      this.onSessionEvent(managed, event);
      this.scheduleRestartCheck();
    });
    this.installRestartBoundary(managed);
    this.sessions.set(identity.sessionId, managed);
    const parentId = opts.childIdentity?.parent.sessionId ?? opts.parentId;
    if (parentId) {
      const parent = this.sessions.get(parentId);
      if (parent?.refusalRetryPrompt) managed.refusalRetryPrompt = parent.refusalRetryPrompt;
      // 子门在 await 建会话之前就按父档位铸好了：其间父会话若切过档，以注册时刻为准补同步
      if (parent) managed.gate.mode = parent.gate.mode;
    }
    this.flushPendingMcpTools(managed);
    // 上次进程退出时没跑完的 workflow：告诉模型可以 resume，随下一次工具结果或回合收口送达
    for (const run of claimInterruptedWorkflowRuns(
      this.workflowJournalDir(),
      identity.sessionId,
      ACTIVE_WORKFLOW_RUN_IDS
    )) {
      this.queueReminder(
        managed,
        `Workflow "${run.name}" (runId ${run.runId}) was interrupted before it finished (the app or worker restarted). ` +
          `Its recorded agent() results are kept: call workflow with resume:"${run.runId}" to continue it, or ignore it if it is no longer needed.`
      );
    }
    this.bindAutoRetryLimit(session);
    const stream = session.agent?.streamFunction;
    if (stream) {
      const privacySink = (report: MaskReport, model: { provider: string; id: string }) => {
        const record: PrivacyMaskRecord = {
          at: Date.now(),
          provider: model.provider,
          model: model.id,
          source: session.isCompacting ? 'compaction' : 'session',
          sessionId: session.sessionId,
          report,
        };
        if (record.source === 'compaction' || this.sessions.get(identity.sessionId) !== managed) {
          this.options.emit({ type: 'privacy-mask-ledger', record });
          return;
        }
        // 请求发出时落盘，排在 assistant 消息条目之前；投影时挂到下一条 assistant
        managed.pendingPrivacyMask = mergeMaskReports(managed.pendingPrivacyMask, report);
        session.sessionManager.appendCustomEntry(PRIVACY_MASK_ENTRY, record);
      };
      session.agent.streamFunction = (model, context, options) =>
        runWithPrivacySink(privacySink, () => {
          if (
            !session.isCompacting &&
            options?.sessionId === session.sessionId &&
            this.sessions.get(identity.sessionId) === managed
          )
            managed.forkBase = {
              model,
              messages: [...context.messages],
              options,
              stream: (m, c, o) => stream.call(session.agent, m, c, o),
              // 选择模型：虚拟模型（Auto）路由后 model 是物理成员，
              // 「换没换模型」只能按选择判定，否则虚拟选择永远对不上物理快照
              selection: session.model
                ? { provider: session.model.provider, id: session.model.id }
                : { provider: model.provider, id: model.id },
            };
          return runWithRequestBodyObserver(
            (usage) => {
              // 共享 runtime/provider 不意味着共享会话；释放、换代或换模型后的尾回调不能污染新投影。
              if (
                this.sessions.get(identity.sessionId) !== managed ||
                session.model?.id !== model.id ||
                session.model?.provider !== model.provider
              )
                return;
              managed.requestBody = usage;
              this.options.emit({
                type: 'request-body',
                identity: managed.identity,
                seq: ++managed.seq,
                usage,
              });
            },
            () => stream.call(session.agent, model, context, options),
            { sessionId: session.sessionId, signal: options?.signal }
          );
        });
    }
    if (opts.resumeFile) {
      const raw = this.transcript(managed);
      const { immediate, deferFull } = projectResumeTail(raw);
      // 重启后认回的后台任务：会话打开即带上，TaskBar 不必等下一次输出
      const backgroundTasks = this.bgTasks.snapshot(identity.sessionId);
      const emitResumeSnapshot = (
        payload: { messages: ProjectedMessage[]; baseIndex: number },
        resumeFull = false
      ) => {
        this.options.emit({
          type: 'snapshot',
          partial: true,
          ...(resumeFull ? { resumeFull: true } : {}),
          sessions: [
            {
              identity,
              status: managed.status,
              messages: payload.messages,
              ...(payload.baseIndex > 0 ? { baseIndex: payload.baseIndex } : {}),
              commands: managed.commands,
              ...(managed.childMetadata ? { child: managed.childMetadata } : {}),
              ...(managed.customEntries.length > 0 ? { customEntries: managed.customEntries } : {}),
              ...(backgroundTasks.length > 0 ? { backgroundTasks } : {}),
            },
          ],
        });
      };
      managed.messages = immediate.messages;
      emitResumeSnapshot(immediate);
      if (deferFull) {
        queueMicrotask(() => {
          if (this.sessions.get(identity.sessionId) !== managed) return;
          const full = { messages: projectMessages(raw), baseIndex: 0 };
          managed.messages = full.messages;
          emitResumeSnapshot(full, true);
        });
      }
      managed.turnStartIndex = managed.messages.length;
    }
    this.emitStatus(managed);
    this.options.emit({
      type: 'commands',
      identity,
      seq: ++managed.seq,
      commands: managed.commands,
    });
    if (opts.resumeFile) {
      queueMicrotask(() => {
        if (this.sessions.get(identity.sessionId) === managed) this.emitSessionMeta(managed);
      });
    } else {
      this.emitSessionMeta(managed);
    }
    return managed;
  }

  /**
   * 子会话的插件桥：工具与事件都以子会话自己的普通身份上报（Main 按 rootSessionId 归到主会话），
   * 并带 agent 来源。只在子会话仍是当前代时上报；解雇前先 cancelAll，取消才发得出去。
   */
  private childPluginBridge(
    source: ChildPluginSource,
    agentType: string | undefined,
    descriptors: readonly PluginToolDescriptor[],
    plan: PluginEventPlan | undefined
  ): {
    descriptors: readonly PluginToolDescriptor[];
    tools?: PluginToolInvoker;
    events?: PluginEventInvoker;
  } {
    const identity: SessionIdentity = {
      sessionId: source.identity.sessionId,
      generation: source.identity.generation,
    };
    const agent: PluginAgentSource = {
      kind: source.kind,
      sessionId: identity.sessionId,
      name: source.name,
      ...(agentType ? { agentType } : {}),
    };
    const current = () => {
      const managed = this.sessions.get(identity.sessionId);
      return managed && isSameGeneration(managed.identity, identity) ? managed : undefined;
    };
    const tools =
      descriptors.length > 0
        ? new PluginToolInvoker(
            identity,
            (request) => {
              const managed = current();
              if (!managed) throw new Error('Session is not ready for plugin tools.');
              this.options.emit({
                type: 'plugin-tool-invoke',
                identity,
                seq: ++managed.seq,
                requestId: request.requestId,
                toolName: request.toolName,
                args: request.args,
                agent,
              });
            },
            {
              emitCancel: (requestId) => {
                const managed = current();
                if (!managed) return;
                this.options.emit({
                  type: 'plugin-tool-cancel',
                  identity,
                  seq: ++managed.seq,
                  requestId,
                });
              },
            }
          )
        : undefined;
    const events = plan
      ? new PluginEventInvoker(
          plan,
          (event) => {
            // 子会话只拦 tool_call；其余拦截不上报，抛错让等待立即放行
            if (event.type === 'plugin-intercept' && event.event !== 'tool_call')
              throw new Error('Child sessions only intercept tool_call.');
            const managed = current();
            if (!managed) throw new Error('Child session is closed.');
            this.options.emit({ ...event, identity, seq: ++managed.seq, agent });
          },
          { childSession: true }
        )
      : undefined;
    return { descriptors, ...(tools ? { tools } : {}), ...(events ? { events } : {}) };
  }

  /** 子会话登记后挂上插件能力并通知 session_start */
  private attachChildPlugins(
    managed: ManagedSession,
    result: Pick<ChildSessionResult, 'pluginTools' | 'pluginEvents'>,
    resumed: boolean
  ): void {
    if (result.pluginTools) managed.pluginTools = result.pluginTools;
    if (!result.pluginEvents) return;
    managed.pluginEvents = result.pluginEvents;
    if (result.pluginEvents.plan.observe.includes('session_start')) {
      result.pluginEvents.notify('session_start', { reason: resumed ? 'resume' : 'startup' });
    }
  }

  /**
   * 子会话收尾：仍在会话表里时先发 session_end，再取消挂起的插件调用（通知 Main 一并取消）。
   * 挂起的 tool_call 检查由子会话 invoker 按拦下结束：不等本地兜底，也不让没检查完的工具在关闭后执行。
   */
  private closeChildPlugins(managed: ManagedSession, reason: string): void {
    const events = managed.pluginEvents;
    if (events?.plan.observe.includes('session_end')) events.notify('session_end', { reason });
    managed.pluginTools?.cancelAll('Child session closed');
    events?.cancelAll();
  }

  private async spawnTypedChild(
    identity: ChildSessionIdentity,
    cwd: string,
    config: ResolvedAgentTypeSpawnConfig,
    resumeFile?: string
  ): Promise<void> {
    const parent = this.must(identity.parent);
    const factory = parent.factory;
    if (!factory) throw new Error('Parent session cannot create child Agents.');
    if (cwd !== factory.cwd || identity.typeKey !== config.typeKey) {
      throw new Error('Child source or Agent type does not match the reserved identity.');
    }
    const existing = this.sessions.get(identity.sessionId);
    if (existing) {
      if (
        !existing.childIdentity ||
        !isSameChildSessionIdentity(existing.childIdentity, identity)
      ) {
        throw new Error('Child session id is owned by another generation.');
      }
      this.options.emit({
        type: 'child-ready',
        identity,
        seq: ++existing.seq,
        sessionFile: requiredSessionFile(existing.session),
        proof: {
          spawnSpecId: config.spawnSpecId,
          typeKey: config.typeKey,
          model: settingsModelRef(config.model),
          toolIds: existing.proofToolIds,
          loadedSkillBindingIds: config.skillBindingIds,
          loadedMcpBindingIds: config.mcpBindingIds,
          systemPromptHash: config.systemPromptHash,
        },
      });
      return;
    }
    // 容量对 resume 豁免（与 coworker 路径同语义）：恢复量受关机前存量约束，
    // 不是疯雇；上限的目的是防主 agent 循环雇人。
    if (!resumeFile && parent.coworkers.size >= this.maxActiveCoworkers) {
      throw new Error(`coworker limit reached (${this.maxActiveCoworkers} active)`);
    }

    let managedRef: ManagedSession | undefined;
    const gate = new ApprovalGate(
      parent.gate.mode,
      (request) => {
        if (!managedRef) return;
        this.options.emit({
          type: 'approval-request',
          identity,
          seq: ++managedRef.seq,
          request,
        });
      },
      (requestId) => {
        if (!managedRef) return;
        this.options.emit({
          type: 'approval-resolved',
          identity,
          seq: ++managedRef.seq,
          requestId,
        });
      },
      parent.gate.floorOptions
    );
    const askManager = this.createAskManager(identity, gate.humanTimeoutMs);
    const result = await factory.createChildSession({
      resolved: config,
      identity,
      gate,
      resumeFile,
      extraTools: [
        createMessageMainTool(
          (text, urgent) => this.notifier.notify(identity.parent.sessionId, text, { urgent }),
          identity.instanceName
        ),
        this.createPeerMessageTool(identity.parent.sessionId, identity.instanceName),
      ],
      pluginSource: { identity, kind: 'subagent', name: identity.instanceName },
    });
    const metadata: ChildConversationMetadata = {
      parentId: identity.parent.sessionId,
      childGeneration: identity.generation,
      agentTypeKey: identity.typeKey,
      agentInstanceId: identity.instanceId,
      agentInstanceName: identity.instanceName,
      dispatchOrigin: 'typed-mention',
    };
    const info: CoworkerInfo = {
      id: identity.sessionId,
      child: metadata,
      name: identity.instanceName,
      agentType: identity.typeKey,
      status: 'idle',
      modelId: result.modelId,
      sessionFile: result.session.sessionFile,
      createdAt: Date.now(),
    };
    parent.coworkers.set(identity.instanceName, info);
    this.options.emit({
      type: 'coworker-update',
      identity: parent.identity,
      seq: ++parent.seq,
      coworker: info,
    });
    managedRef = this.registerManagedSession(identity, result.session, gate, result.modelId, {
      childIdentity: identity,
      childMetadata: metadata,
      parentId: identity.parent.sessionId,
      coworkerName: identity.instanceName,
      resumeFile,
      asks: askManager,
      toolIds: result.toolIds,
      proofToolIds: result.proofToolIds,
      ...(result.runawayGuard ? { runawayGuard: result.runawayGuard } : {}),
      ...(result.requestBudget ? { requestBudget: result.requestBudget } : {}),
    });
    this.attachChildPlugins(managedRef, result, Boolean(resumeFile));
    if (!resumeFile) managedRef.pendingRole = config.systemPrompt;
    this.options.emit({
      type: 'child-ready',
      identity,
      seq: ++managedRef.seq,
      sessionFile: requiredSessionFile(result.session),
      proof: {
        spawnSpecId: config.spawnSpecId,
        typeKey: config.typeKey,
        model: result.modelRef,
        toolIds: result.proofToolIds,
        loadedSkillBindingIds: config.skillBindingIds,
        loadedMcpBindingIds: config.mcpBindingIds,
        systemPromptHash: config.systemPromptHash,
      },
    });
  }

  /** 雇佣 coworker：独立审批门 + 完整 ManagedSession(prompt/abort/审批通路全复用) */
  private async spawnCoworker(
    parentId: string,
    coworkerId: string,
    name: string,
    agentTypeName?: string,
    modelName?: string,
    resumeFile?: string,
    thinking?: ChildThinkingLevel
  ): Promise<CoworkerInfo> {
    const parent = this.mustCurrent(parentId);
    const factory = parent.factory;
    if (!factory) throw new Error(`session cannot hire coworkers: ${parentId}`);
    if (parent.coworkers.has(name)) throw new Error(`coworker name already in use: ${name}`);
    if (!resumeFile && parent.coworkers.size >= this.maxActiveCoworkers) {
      throw new Error(
        `coworker limit reached (${this.maxActiveCoworkers} active) — dismiss one before hiring more`
      );
    }
    if (this.sessions.has(coworkerId)) throw new Error(`coworker already exists: ${coworkerId}`);
    // 类型找不到降级 general(resume 时配置漂移不毁恢复;工具路径在 coworker.ts 已前置校验)
    const agentType = agentTypeName
      ? factory.agentTypes.find((type) => type.name === agentTypeName)
      : undefined;
    // 模型同样降级容错:resume/配置漂移时找不到就回 agentType/父模型(工具入口已前置校验)
    const modelOverride = modelName
      ? factory.subagentModels.find((option) => option.name === modelName)?.config
      : undefined;
    const identity: SessionIdentity = { sessionId: coworkerId, generation: randomUUID() };
    const gate = new ApprovalGate(
      parent.gate.mode,
      (request) => {
        const managed = this.sessions.get(coworkerId);
        if (managed) {
          this.options.emit({
            type: 'approval-request',
            identity: managed.identity,
            seq: ++managed.seq,
            request,
          });
        }
      },
      (requestId) => {
        const managed = this.sessions.get(coworkerId);
        if (managed) {
          this.options.emit({
            type: 'approval-resolved',
            identity: managed.identity,
            seq: ++managed.seq,
            requestId,
          });
        }
      },
      parent.gate.floorOptions
    );
    const askManager = this.createAskManager(identity, gate.humanTimeoutMs);
    const { session, modelId, toolIds, runawayGuard, requestBudget, pluginTools, pluginEvents } =
      await factory.createChildSession({
        agentType,
        modelOverride,
        thinkingOverride: thinking,
        gate,
        resumeFile,
        sessionId: coworkerId,
        extraTools: [
          createAskTool(askManager),
          createMessageMainTool(
            (text, urgent) => this.notifier.notify(parentId, text, { urgent }),
            name,
            () => this.sessions.get(coworkerId)?.parentWaiting === true
          ),
          this.createPeerMessageTool(parentId, name),
        ],
        pluginSource: { identity, kind: 'coworker', name },
      });
    const info: CoworkerInfo = {
      id: coworkerId,
      name,
      ...(agentType ? { agentType: agentType.name } : {}),
      status: 'idle',
      modelId,
      ...(session.sessionFile ? { sessionFile: session.sessionFile } : {}),
      createdAt: Date.now(),
    };
    this.options.emit({
      type: 'coworker-update',
      identity: parent.identity,
      seq: ++parent.seq,
      coworker: info,
      coworkerIdentity: identity,
    });
    const managed = this.registerManagedSession(identity, session, gate, modelId, {
      parentId,
      coworkerName: name,
      asks: askManager,
      toolIds,
      ...(resumeFile ? { resumeFile } : {}),
      ...(runawayGuard ? { runawayGuard } : {}),
      ...(requestBudget ? { requestBudget } : {}),
    });
    this.attachChildPlugins(managed, { pluginTools, pluginEvents }, Boolean(resumeFile));
    // 角色提示在首条消息前缀注入(无论来自主 agent send 还是用户 tab);resume 时 jsonl 已有
    if (!resumeFile && agentType?.systemPrompt) {
      managed.pendingRole = agentType.systemPrompt;
    }
    parent.coworkers.set(name, info);
    return info;
  }

  /**
   * 插件代理：用发起会话的工厂建临时只读子会话（内存记录、无人值守门），
   * 进度与终态按 requestId 推回 Main，跑完即弃，不进会话树。
   */
  private async runPluginAgent(
    command: Extract<AgentCommand, { type: 'plugin-agent-run' }>
  ): Promise<void> {
    const { requestId } = command;
    const emit = (event: PluginAgentRunEvent) =>
      this.options.emit({ type: 'plugin-agent-event', requestId, event });
    const controller = new AbortController();
    this.pluginAgentRuns.set(requestId, controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, command.timeoutMs);
    let child: AgentSession | undefined;
    let gate: ApprovalGate | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      const parent = this.sessions.get(command.identity.sessionId);
      if (!parent || !isSameGeneration(parent.identity, command.identity) || !parent.factory)
        throw new Error('这个会话不能运行插件代理');
      gate = new ApprovalGate(
        parent.gate.mode,
        () => {},
        () => {},
        { ...parent.gate.floorOptions, autoReject: true }
      );
      const base = command.context === 'fork' && !command.model ? forkBaseOf(parent) : undefined;
      const { session, modelId } = await parent.factory.createChildSession({
        agentType: { name: 'plugin-agent', description: '', systemPrompt: '', tools: 'readonly' },
        gate,
        ephemeral: true,
        ...(command.model ? { modelOverride: command.model } : {}),
      });
      child = session;
      const fork = base
        ? forkAgent(base, session, parent.session.agent.state.thinkingLevel)
        : undefined;
      if (controller.signal.aborted) throw new Error('aborted');
      controller.signal.addEventListener(
        'abort',
        () => (fork ? fork.abort() : void session.abort().catch(() => {})),
        { once: true }
      );
      let lastText = '';
      let lastTextAt = 0;
      const onEvent = (event: AgentSessionEvent | AgentEvent) => {
        if (event.type === 'tool_execution_start') {
          let args = '';
          try {
            args = JSON.stringify(event.args) ?? '';
          } catch {}
          emit({
            type: 'tool-start',
            id: event.toolCallId,
            name: event.toolName,
            args: args.slice(0, PLUGIN_AGENT_ARGS_MAX_CHARS),
            ...('parentToolCallId' in event && event.parentToolCallId
              ? { parentId: event.parentToolCallId }
              : {}),
          });
        } else if (event.type === 'tool_execution_end') {
          emit({
            type: 'tool-end',
            id: event.toolCallId,
            isError: event.isError,
            output: pluginAgentToolOutput(event.result),
          });
        } else if (event.type === 'message_update' && event.message.role === 'assistant') {
          const text = pluginAgentText(event.message);
          const now = Date.now();
          if (!text || text === lastText || now - lastTextAt < 300) return;
          lastText = text;
          lastTextAt = now;
          emit({ type: 'text', text: text.slice(-PLUGIN_AGENT_TEXT_MAX_CHARS) });
        }
      };
      const offChild = session.subscribe(onEvent);
      const offFork = fork?.subscribe(onEvent);
      unsubscribe = () => {
        offChild();
        offFork?.();
      };
      const parts: string[] = [];
      if (fork)
        parts.push(
          `（以下是从这段对话分叉出的只读旁路请求，主对话看不到这里。只能用 ${[...fork.runnable].join(' / ')}，其他工具会被拒绝。不要继续上面的任务，只完成下面这件事。）`
        );
      if (command.systemPrompt) parts.push(`<role>\n${command.systemPrompt}\n</role>`);
      if (command.context !== 'none' && !fork) {
        const snapshot = snapshotMainConversation(parent.messages);
        if (snapshot) parts.push(`<conversation>\n${snapshot}\n</conversation>`);
      }
      parts.push(command.prompt);
      await (fork ?? session).prompt(parts.join('\n\n'));
      if (controller.signal.aborted) throw new Error('aborted');
      const last = [...(fork ? fork.state.messages : session.messages)]
        .reverse()
        .find((message): message is AssistantMessage => message.role === 'assistant');
      if (last?.stopReason === 'error') throw new Error(last.errorMessage || '模型请求失败');
      const text = last ? pluginAgentText(last) : '';
      if (!text) throw new Error('代理没有给出回复');
      emit({
        type: 'end',
        ok: true,
        text: text.slice(-PLUGIN_AGENT_TEXT_MAX_CHARS),
        model: base ? base.model.id : modelId,
      });
    } catch (error) {
      const aborted = controller.signal.aborted;
      const message = timedOut
        ? '代理运行超时'
        : aborted
          ? '已取消'
          : toErrorMessage(error) || '代理运行失败';
      emit({
        type: 'end',
        ok: false,
        error: message.slice(0, 4096),
        ...(aborted && !timedOut ? { aborted: true } : {}),
      });
    } finally {
      clearTimeout(timer);
      this.pluginAgentRuns.delete(requestId);
      unsubscribe?.();
      gate?.cancelAll();
      if (child) {
        cancelContinuousMemory(child.sessionManager);
        try {
          releaseOauthPoolSession(child.sessionId);
          child.dispose();
        } catch {}
      }
    }
  }

  /** 解雇 coworker：中断并销毁会话,jsonl 留盘。返回解雇名(通知/事件用) */
  private async dismissCoworker(parentId: string, coworkerId: string): Promise<string> {
    const parent = this.mustCurrent(parentId);
    const managed = this.sessions.get(coworkerId);
    if (managed) {
      if (managed.agentRun?.holdTimer) this.stopAwaitedTasks(managed);
      this.releaseRun(managed);
      this.reminders.cancelAll(coworkerId);
      this.closeChildPlugins(managed, 'dismissed');
      managed.gate.cancelAll();
      managed.asks.cancelAll();
      cancelContinuousMemory(managed.session.sessionManager);
      try {
        await managed.session.abort();
      } catch {}
      managed.unsubscribe();
      try {
        releaseOauthPoolSession(managed.session.sessionId);
        managed.session.dispose();
      } catch {}
      this.sessions.delete(coworkerId);
      this.mcpHotplug.delete(coworkerId);
      this.settleRound(managed);
    }
    let dismissedName = managed?.coworkerName ?? coworkerId.split('::cw-').at(-1) ?? coworkerId;
    for (const [name, info] of parent.coworkers) {
      if (info.id === coworkerId) {
        dismissedName = name;
        parent.coworkers.delete(name);
        break;
      }
    }
    this.options.emit({
      type: 'coworker-update',
      identity: parent.identity,
      seq: ++parent.seq,
      coworker: { id: coworkerId, name: dismissedName, status: 'dismissed', createdAt: 0 },
    });
    if (managed?.childIdentity) {
      this.options.emit({
        type: 'child-ended',
        identity: managed.childIdentity,
        seq: ++managed.seq,
        reason: 'dismissed',
      });
    }
    return dismissedName;
  }

  /**
   * 向 coworker 发消息。经命令门串行启动(与用户 tab 的 prompt 一致排队);
   * running 时 steer 汇入当前轮。wait=false(默认)投递即返回,完成后经 notifier 通知父;
   * wait=true 阻塞至该轮结束返回结果。父 abort(signal)只提前返回,不杀 coworker(持久实体)。
   */
  private async coworkerSend(
    coworkerId: string,
    text: string,
    opts: { signal?: AbortSignal; wait?: boolean; gate?: string; schema?: unknown } = {}
  ): Promise<string> {
    const managed = this.mustCurrent(coworkerId);
    if (this.workspaceSwitch.isLocked(coworkerId)) {
      return new Promise<string>((resolve, reject) => {
        this.workspaceSwitch.defer(
          coworkerId,
          () => {
            this.coworkerSend(coworkerId, text, opts).then(resolve, reject);
          },
          () => reject(new Error('Coworker generation ended before workspace unlock.'))
        );
      });
    }
    if (opts.schema) managed.pendingYieldSchema = opts.schema;
    const { signal } = opts;
    // 先登记等待再启动,防终态竞态;终态由 settleRound 统一判定(含重试耗尽/abort/销毁)
    const done = this.waitRoundEnd(managed, signal);
    managed.roundPending = true;
    managed.currentTurnId = randomUUID();
    const start = async () => {
      if (managed.status === 'running') {
        await this.steerTracked(managed, text);
      } else {
        void this.promptTracked(managed, consumeRole(managed, text), {
          streamingBehavior: 'followUp',
        })
          .then(() => {
            // prompt 已归但未见任何终态事件(不应发生的退化路径):不让 wait 挂死
            if (managed.status !== 'running' && managed.roundPending) this.settleRound(managed);
          })
          .catch((error) => {
            this.failTurn(managed, toErrorMessage(error));
          });
      }
    };

    if (opts.wait) {
      managed.parentWaiting = true;
      try {
        await this.gate.run(coworkerId, start);
        await done;
      } finally {
        managed.parentWaiting = false;
      }
      if (signal?.aborted) {
        return `(send interrupted — coworker keeps running; use coworker wait/send to follow up)`;
      }
      return `${await this.coworkerRoundSummary(managed, opts.gate)}\n\n${COWORKER_FOLLOW_UP_HINT}`;
    }

    // 非阻塞:投递即返回;轮次完成后组摘要经 notifier 回父(失败立即,成功合并)
    void (async () => {
      await this.gate.run(coworkerId, start);
      await done;
      const parentId = managed.parentId;
      // 父正在 wait 阻塞等这一轮:结果由 wait 内联返回,不再重复通知
      // (本等待者先于 wait 登记,在 wait 的 finally 复位 parentWaiting 之前运行)
      if (
        !parentId ||
        !this.sessions.has(coworkerId) ||
        managed.parentWaiting ||
        managed.childMetadata?.dispatchOrigin === 'typed-mention'
      ) {
        return;
      }
      const summary = await this.coworkerRoundSummary(managed, opts.gate);
      const failed = managed.status === 'failed';
      const label = managed.coworkerName ?? coworkerId;
      const brief =
        summary.length > NOTIFY_SUMMARY_LIMIT
          ? `${summary.slice(0, NOTIFY_SUMMARY_LIMIT)}\n…(truncated — use coworker report "${label}" for the full text)`
          : summary;
      this.notifier.notify(
        parentId,
        `Coworker "${label}" finished a round:\n${brief}\n\n${COWORKER_FOLLOW_UP_HINT}`,
        { urgent: failed }
      );
    })().catch(() => {});
    const label = managed.coworkerName ?? coworkerId;
    return (
      `(dispatched to coworker "${label}" — you'll be notified when the round completes; ` +
      'keep working or return to the user meanwhile)'
    );
  }

  private createPeerMessageTool(parentId: string, from: string) {
    return createMessageCoworkerTool({
      from,
      peers: () => {
        const parent = this.sessions.get(parentId);
        if (!parent) return [];
        return [...parent.coworkers.keys()].filter((name) => name !== from);
      },
      notify: (to, text) => {
        const target = this.sessions.get(parentId)?.coworkers.get(to);
        if (target) this.notifier.notify(target.id, text);
      },
    });
  }

  private async runParentGate(managed: ManagedSession, gateCommand: string): Promise<string> {
    if (this.workspaceSwitch.isLocked(managed.identity.sessionId)) {
      return new Promise<string>((resolve, reject) => {
        this.workspaceSwitch.defer(
          managed.identity.sessionId,
          () => {
            this.runParentGate(managed, gateCommand).then(resolve, reject);
          },
          () => reject(new Error('Coworker generation ended before workspace unlock.'))
        );
      });
    }
    managed.pendingVerifications = (managed.pendingVerifications ?? 0) + 1;
    try {
      const parentFactory = this.sessions.get(managed.parentId ?? '')?.factory;
      return await (parentFactory
        ? parentFactory.runGate(gateCommand)
        : runGateCommand(process.cwd(), gateCommand));
    } finally {
      managed.pendingVerifications--;
    }
  }

  /** 轮次结果正文:最终文本 + 输出截断/上下文水位警告(不含 gate,可缓存) */
  private roundBaseSummary(managed: ManagedSession): string {
    let summary =
      managed.status === 'failed'
        ? '(coworker turn failed — check its tab for details)'
        : lastAssistantText(managed.session) || '(coworker produced no output)';
    const last = [
      ...(managed.session.messages as {
        role?: string;
        stopReason?: string;
        usage?: { input?: number; output?: number };
      }[]),
    ]
      .reverse()
      .find((message) => message.role === 'assistant');
    // 输出被模型上限截断的轮次按不完整处理,不当部分成功接受
    if (last?.stopReason === 'length') {
      summary = `(WARNING: output hit the model limit — treat this round as incomplete)\n${summary}`;
    }
    const used = (last?.usage?.input ?? 0) + (last?.usage?.output ?? 0);
    const window = positiveContextWindow(limitsModelOf(managed.session));
    if (window !== undefined && used > window * 0.85) {
      const pct = Math.round((used / window) * 100);
      summary += `\n\n(coworker context ${pct}% full — have it summarize, or dismiss it soon)`;
    }
    return summary;
  }

  /** 轮次结果摘要 = 缓存正文(settleRound 记入) + 本次 gate 验收结果 */
  private async coworkerRoundSummary(
    managed: ManagedSession,
    gateCommand?: string
  ): Promise<string> {
    const base = managed.lastRoundSummary ?? this.roundBaseSummary(managed);
    return gateCommand ? `${base}\n\n${await this.runParentGate(managed, gateCommand)}` : base;
  }

  private mcpServerKey(server: McpServerSpawnConfig): string {
    return server.id ?? server.name;
  }

  private rememberMcpHotplug(
    sessionId: string,
    serverKeys: ReadonlySet<string>,
    adopt: (tools: readonly ToolDefinition[]) => void
  ): void {
    this.mcpHotplug.set(sessionId, { serverKeys, adopt, pending: [] });
  }

  /** 会话正忙时先攒着：中途重建工具表会碰到还在执行的工具。 */
  private sessionAcceptsMcpTools(managed: ManagedSession): boolean {
    if (managed.status === 'running' || managed.session.isStreaming) return false;
    return managed.session.isIdle !== false;
  }

  private deliverMcpTools(sessionId: string, tools: readonly ToolDefinition[]): void {
    const plug = this.mcpHotplug.get(sessionId);
    const managed = this.sessions.get(sessionId);
    if (!plug || tools.length === 0) return;
    // 子会话可能还没登记：先攒着，registerManagedSession 收口时再补
    if (!managed || !this.sessionAcceptsMcpTools(managed)) {
      const seen = new Set(plug.pending.map((tool) => tool.name));
      for (const tool of tools) {
        if (seen.has(tool.name)) continue;
        plug.pending.push(tool);
        seen.add(tool.name);
      }
      return;
    }
    plug.adopt(tools);
  }

  private flushPendingMcpTools(managed: ManagedSession): void {
    const plug = this.mcpHotplug.get(managed.identity.sessionId);
    if (!plug || plug.pending.length === 0 || !this.sessionAcceptsMcpTools(managed)) return;
    const tools = plug.pending.splice(0);
    plug.adopt(tools);
  }

  private flushPendingBuiltinTools(managed: ManagedSession): void {
    const disabled = managed.pendingBuiltinTools;
    if (!disabled || !managed.applyBuiltinTools || !this.sessionAcceptsMcpTools(managed)) return;
    managed.pendingBuiltinTools = undefined;
    managed.applyBuiltinTools(disabled);
  }

  private installAdoptedMcpTools(
    host: CodemodeHost,
    sessionId: string,
    tools: readonly ToolDefinition[],
    cursor?: CursorSessionBridge,
    reminders?: SystemReminderRegistry
  ): void {
    const added = new Set(host.adoptDirectTools(tools));
    if (added.size === 0) return;
    if (cursor) {
      for (const tool of tools) {
        if (!added.has(tool.name)) continue;
        const bridgeTool = indexCursorTools([
          reminders ? withSystemReminders(tool, reminders) : tool,
        ]).get(tool.name);
        if (bridgeTool) cursor.tools.set(tool.name, bridgeTool);
      }
    }
    const managed = this.sessions.get(sessionId);
    if (!managed) return;
    for (const name of added) {
      if (!managed.toolIds.includes(name)) managed.toolIds.push(name);
    }
  }

  /** 授权或预热连上常驻 MCP 后，补进 spawn 时已经选了它、但当时没拿到工具的会话。 */
  private async adoptDirectMcp(servers: readonly McpServerSpawnConfig[]): Promise<void> {
    await Promise.all(
      servers.map(async (server) => {
        const tools = await this.mcp.toolsFor([server]);
        if (tools.length === 0) return;
        const key = this.mcpServerKey(server);
        for (const [sessionId, plug] of this.mcpHotplug) {
          if (!plug.serverKeys.has(key)) continue;
          this.deliverMcpTools(sessionId, tools);
        }
      })
    );
  }

  private onSessionEvent(
    managed: ManagedSession,
    event: Parameters<Parameters<AgentSession['subscribe']>[0]>[0]
  ): void {
    managed.lastActivityAt = Date.now();
    managed.activityNonce += 1;
    if (event.type !== 'message_update') this.flushStreamingUpsert(managed);
    switch (event.type) {
      case 'agent_start':
        managed.silentTurnNudgeUsed = false;
        managed.silentTurnKind = undefined;
        managed.runawayGuard?.resetTurn();
        managed.currentTurnId ??= randomUUID();
        managed.status = 'running';
        managed.checkpoints?.resetTurn();
        this.armPendingContextUsage(managed);
        this.emitStatus(managed);
        this.emitSessionMeta(managed);
        return;
      case 'turn_start':
        managed.requestStartMs = Date.now();
        managed.replyProgress = { requestStartMs: managed.requestStartMs };
        return;
      case 'turn_end': {
        managed.replyProgress = undefined;
        // 父会话的工具批次交给 Main 生成一句话标签（子代理不生成）
        if (managed.childIdentity || managed.coworkerName) return;
        const digest = toolBatchDigest(event.message, event.toolResults);
        if (digest)
          this.options.emit({ type: 'tool-batch-completed', identity: managed.identity, digest });
        return;
      }
      case 'message_start': {
        managed.ownerGate?.observeMessage(event.message);
        const index = managed.messages.length;
        const message = projectMessage(event.message);
        if (message?.role === 'assistant') {
          // pi-ai 收到响应头才推 start，紧接首个 delta；从 turn_start 起算才含等待首 token 的时间
          managed.timings[index] = { stepStartMs: managed.requestStartMs ?? Date.now() };
          managed.requestStartMs = undefined;
        }
        const deliveryId = event.message.role === 'user' ? this.takeDelivery(managed) : null;
        this.upsertLocalMessage(managed, message);
        if (deliveryId) {
          this.options.emit({
            type: 'delivery-settled',
            identity: managed.identity,
            seq: ++managed.seq,
            deliveryId,
          });
        }
        return;
      }
      case 'message_update': {
        const index = managed.messages.length - 1;
        const timing = managed.timings[index];
        const projected = projectMessage(event.message);
        if (managed.replyProgress) {
          const now = Date.now();
          managed.replyProgress.firstTokenMs ??= now;
          managed.replyProgress.lastOutputMs = now;
        }
        if (timing) {
          if (timing.firstTokenMs === undefined) timing.firstTokenMs = Date.now();
          if (
            timing.thinkingEndMs === undefined &&
            projected?.content.some(
              (part) =>
                (part.type === 'text' && part.text.trim()) ||
                part.type === 'toolCall' ||
                part.type === 'image'
            )
          ) {
            timing.thinkingEndMs = Date.now();
          }
        }
        this.replaceLastMessage(managed, projected, true);
        return;
      }
      case 'message_end': {
        const index = managed.messages.length - 1;
        const timing = managed.timings[index];
        if (timing) timing.completedMs = Date.now();
        if (event.message.role === 'assistant') {
          managed.replyProgress = undefined;
          // pi 在监听者之后才把这条写进会话文件：计时随消息落盘，供以后统计（投影白名单不透出）
          if (timing) (event.message as { timing?: MessageTiming }).timing = { ...timing };
        }
        this.stampContextSnapshot(managed, event.message);
        if (event.message.role === 'assistant' && managed.forkBase && !managed.forkBase.reply)
          managed.forkBase.reply = event.message;
        const projected = projectMessage(event.message);
        if (projected?.role === 'assistant' && managed.pendingPrivacyMask) {
          projected.privacyMask = managed.pendingPrivacyMask;
          managed.pendingPrivacyMask = undefined;
        }
        this.replaceLastMessage(managed, projected);
        if (projected?.role === 'assistant') this.noteBudgetRequest(managed, projected);
        this.emitSessionMeta(managed);
        return;
      }
      case 'auto_retry_start':
        managed.lastRetryError = event.errorMessage || 'Unknown error';
        managed.turnRetried = true;
        this.options.emit({
          type: 'turn-retry',
          identity: managed.identity,
          seq: ++managed.seq,
          attempt: event.attempt,
          maxAttempts: Number.isFinite(event.maxAttempts) ? event.maxAttempts : 0,
          delayMs: event.delayMs,
          error: event.errorMessage || 'Unknown error',
        });
        return;
      case 'auto_retry_end': {
        // 重试被取消（abortRetry）时没有后续 agent_end，在这里收口；
        // 重试耗尽已有 agent_end(willRetry=false)，交给 agent_settled 按末条错误收口
        if (event.success || managed.status !== 'running' || managed.settlePending) return;
        this.failTurn(managed, managed.lastRetryError ?? event.finalError ?? 'Auto-retry failed.');
        return;
      }
      case 'tool_execution_start': {
        // codemode 嵌套调用只进脚本，不上时间线
        if (event.parentToolCallId) return;
        // 父会话的工具（subagent / send 等结果）可能正等着自己的子会话：放开它们的挂起
        if (this.restart && !this.restart.committed && !this.parentOf(managed))
          this.releaseChildHolds(managed.identity.sessionId);
        managed.toolNames.set(event.toolCallId, event.toolName);
        // 耗时只从真正开始执行算：同轮后发工具不能把前面 bash 的排队算进去
        if (!managed.toolStartAt.has(event.toolCallId)) {
          const startedAt = Date.now();
          managed.toolStartAt.set(event.toolCallId, startedAt);
          // deadlineAt = 让位时刻（与显式 timeout 取小）：倒计时与卡死检测都以前台真实返回点为准
          const timeoutMs = foregroundCommandTimeoutMs(
            event.toolName,
            event.args,
            this.bgTasks.limits
          );
          this.options.emit({
            type: 'tool-output',
            identity: managed.identity,
            seq: ++managed.seq,
            toolCallId: event.toolCallId,
            output: '',
            startedAt,
            ...(timeoutMs === undefined ? {} : { deadlineAt: startedAt + timeoutMs }),
          });
        }
        return;
      }
      case 'tool_execution_update': {
        if (event.parentToolCallId) return;
        // pi 已按 BASH_UPDATE_THROTTLE_MS 节流下发全量快照，这里只做投影，不再二次节流
        const parts: unknown = event.partialResult?.content;
        if (!Array.isArray(parts)) return;
        const output = parts
          .filter(
            (part): part is { type: 'text'; text: string } =>
              typeof part === 'object' &&
              part !== null &&
              (part as { type?: string }).type === 'text'
          )
          .map((part) => part.text)
          .join('');
        if (!output) return;
        this.options.emit({
          type: 'tool-output',
          identity: managed.identity,
          seq: ++managed.seq,
          toolCallId: event.toolCallId,
          output,
        });
        return;
      }
      case 'tool_execution_end': {
        if (event.parentToolCallId) return;
        const start = managed.toolStartAt.get(event.toolCallId);
        managed.toolStartAt.delete(event.toolCallId);
        managed.toolNames.delete(event.toolCallId);
        managed.lastCompletedToolCallId = event.toolCallId;
        if (start !== undefined) {
          managed.toolDurations.set(event.toolCallId, Date.now() - start);
        }
        return;
      }
      case 'compaction_start':
        managed.compaction = 'running';
        this.options.emit({
          type: 'compaction',
          identity: managed.identity,
          seq: ++managed.seq,
          state: 'start',
        });
        return;
      case 'compaction_end': {
        // 自动压缩在 agent_end 之后异步完成：context 视图换了形，重新按完整记录对齐（历史不丢，summary 行入列）
        this.reconcileMessages(managed, this.transcript(managed));
        this.rebaseContextUsage(managed);
        managed.compaction = undefined;
        // 钩子主动取消时 pi 只给 aborted：取出钩子留下的原因，按失败上报，不当作放弃
        const cancel = takeCompactCancel(managed.session.sessionManager);
        const cancelled = event.aborted && !event.errorMessage ? cancel : undefined;
        if (cancelled) this.logCompactCancel(managed, cancelled);
        const error =
          event.errorMessage || (cancelled ? formatCompactCancel(cancelled) : undefined);
        // 被 abort 取消的压缩 pi 不带 errorMessage：按放弃收口，不能当作压完
        const succeeded = !error && !event.aborted;
        // 锚点必须在对齐之后取：否则摘要消息未入列，与 guest 事件口径 maxIndex+1 差 1
        if (succeeded) {
          managed.compactionNoticeAt = managed.messages.length;
          managed.plan?.compacted();
        }
        this.emitSessionMeta(managed);
        this.options.emit({
          type: 'compaction',
          identity: managed.identity,
          seq: ++managed.seq,
          state: 'end',
          ...(error ? { error } : {}),
          ...(!error && event.aborted ? { abandoned: true as const } : {}),
        });
        // 压缩期间被拒 / 排队未投的通知：压缩一结束就补投，否则空闲会话会永远干等已结束的命令。
        // 这是 pi 拒绝 prompt（compaction in progress）之后唯一必然到来的事件，必须在这里收口账簿。
        this.flushPendingReminders(managed);
        return;
      }
      case 'agent_end': {
        this.reconcileMessages(managed, this.transcript(managed));
        // pi 将自动重试瞬态错误（随后 auto_retry_start）：非终态，不 settle、
        // 不发 turn-completed、状态保持 running，否则输入框解锁后又自己跑起来
        if (event.willRetry) {
          // pi 的 _prepareRetry 稍后会把这条瞬态错误 assistant 消息从自身状态删掉重发；
          // 提前对齐投影，重试期间时间线不闪现错误（错误文本已在 RetryBar 上）
          const last = managed.messages.at(-1);
          if (last?.role === 'assistant' && last.stopReason === 'error') {
            managed.messages.length -= 1;
            managed.timings.length = managed.messages.length;
            this.options.emit({
              type: 'messages-truncated',
              identity: managed.identity,
              seq: ++managed.seq,
              length: managed.messages.length,
            });
          }
          return;
        }
        // agent_end 不是轮次边界：pi 之后还可能溢出压缩续跑、跑排队消息，agent_settled 才收口
        managed.settlePending = true;
        return;
      }
      case 'agent_settled': {
        this.flushPendingMcpTools(managed);
        for (const slot of managed.steerDeliveries ?? []) {
          if (!slot.id || !slot.detach?.()) continue;
          managed.steerDeliveries = managed.steerDeliveries?.filter((item) => item !== slot);
          this.options.emit({
            type: 'delivery-deferred',
            identity: managed.identity,
            seq: ++managed.seq,
            deliveryId: slot.id,
          });
        }
        if (!managed.settlePending) {
          this.flushPendingReminders(managed);
          return;
        }
        managed.settlePending = false;
        // 请求预算到 1.5 倍：这次中止是为了强制交出，不收口、不通知父会话。
        // 补一轮只交报告的请求，仍用原来的 turnId，父会话只看到一次收尾结果。
        if (managed.requestBudget?.phaseNow === 'stopping') {
          managed.requestBudget.markWrapup();
          setImmediate(() => {
            if (managed.requestBudget?.phaseNow !== 'wrapup') return;
            void managed.session
              .prompt(budgetWrapUpPrompt(), { streamingBehavior: 'followUp' })
              .catch((error) => {
                if (managed.requestBudget?.phaseNow !== 'wrapup') return;
                // 补报告发不出去也按预算停止交回已有输出，错误写进结果
                this.completeTurn(managed, { error: toErrorMessage(error) });
              });
          });
          return;
        }
        // 强制交出的那一轮（或宽限耗尽的硬停）按成功收口，但带上预算停止标记，不当成失败
        const budgetStopped =
          managed.requestBudget?.phaseNow === 'wrapup' ||
          managed.requestBudget?.phaseNow === 'done';
        if (budgetStopped) managed.requestBudget?.markDone();
        this.reconcileMessages(managed, this.transcript(managed));
        // 预算停止必须把已有结论交回去，不再降级或空回复续跑，否则结果被拖走
        if (!budgetStopped && this.tryAdaptiveDowngrade(managed)) return;
        // 终态错误轮（重试耗尽或不可重试）按失败收口，不再误报「回复完成」
        const lastAssistant = [...managed.messages]
          .reverse()
          .find((message) => message.role === 'assistant');
        if (budgetStopped) {
          this.completeTurn(managed, {
            ...(lastAssistant?.stopReason === 'error'
              ? { error: lastAssistant.errorMessage ?? 'Turn failed.' }
              : {}),
          });
          return;
        }
        if (lastAssistant?.stopReason === 'error') {
          // pi 回合内自动重试已用尽、最终仍是它判定的瞬态错误（网络 / 限流 / 5xx）：标给 Main 做外层自动重试
          const exhausted =
            managed.turnRetried === true &&
            (isRetryableAssistantError({
              stopReason: 'error',
              errorMessage: lastAssistant.errorMessage,
            } as AssistantMessage) ||
              classifyUpstreamError({ error: lastAssistant.errorMessage }).kind === 'transient');
          this.failTurn(managed, lastAssistant.errorMessage ?? 'Turn failed.', exhausted);
          return;
        }
        if (this.tryRefusalRetry(managed, lastAssistant)) return;
        if (this.trySilentTurnRecovery(managed)) return;
        this.completeTurn(managed);
        return;
      }
      default:
        return;
    }
  }

  /**
   * 收尾中止的是子代理 Run 的回合：照常收口（断点要它空闲），但不发回合结局，
   * 否则 Main 把被打断的 Run 记成已完成。Run 留在 running，Main 按 worker 退出记成被打断，重启后接着跑。
   */
  private exitingRun(managed: ManagedSession): boolean {
    return this.exiting && managed.agentRun !== undefined;
  }

  /** 本轮成功收口。budget：子代理因请求预算被强制停止，带上标记（及补报告的错误）交回已有输出。 */
  private completeTurn(managed: ManagedSession, budget?: { error?: string }): void {
    const sessionId = managed.identity.sessionId;
    const quiet = this.exitingRun(managed);
    const turnId = managed.currentTurnId ?? managed.abortedTurnId ?? randomUUID();
    const aborted = managed.turnAborted === true;
    const run = managed.agentRun;
    const continues = run && run.id !== turnId ? run.id : undefined;
    const awaitingTasks =
      run !== undefined &&
      run.expiry !== 'told' &&
      !aborted &&
      !budget &&
      this.awaitsOwnTasks(managed);
    if (awaitingTasks) this.holdRun(managed, run);
    else this.releaseRun(managed);
    // 子代理 Run 真正收口：它的提醒没人再等；退出收尾打断的 Run 重启后接着跑，提醒留着
    if (!awaitingTasks && !quiet && sessionId.includes('::')) this.reminders.cancelAll(sessionId);
    const awaitingReminder = !sessionId.includes('::') && this.reminders.list(sessionId).length > 0;
    managed.currentTurnId = undefined;
    managed.abortedTurnId = undefined;
    managed.turnAborted = false;
    managed.turnRetried = false;
    // 预算只管一次 Run：收口即清零，之后用户自己发起的回合不计数；持有中的 Run 还没收口
    if (!awaitingTasks) managed.requestBudget?.disarm();
    managed.status = 'idle';
    this.emitStatus(managed);
    this.flushPendingBuiltinTools(managed);
    managed.plan?.turnSettled();
    managed.contextUsage.setPendingSnapshot(undefined);
    this.emitSessionMeta(managed);
    // 本轮摘要随 turn-completed 下发：renderer 冷会话没有正文，只能由 worker 切
    const digest = buildTurnDigest(managed.messages, managed.turnStartIndex);
    const report = buildTurnReport(managed.messages, managed.turnStartIndex);
    const silent = turnRequestedSilence(managed.messages, managed.turnStartIndex);
    managed.turnStartIndex = managed.messages.length;
    this.workspaceClaims.release(managed.identity.sessionId);
    if (!aborted && !budget) this.nudgeTaskWrapUp(managed);
    if (!quiet)
      this.options.emit({
        type: 'turn-completed',
        identity: managed.identity,
        seq: ++managed.seq,
        turnId,
        ...(digest ? { digest } : {}),
        ...(report ? { report } : {}),
        ...(silent ? { silent: true as const } : {}),
        ...(aborted ? { aborted: true as const } : {}),
        ...(budget ? { requestBudgetStop: true } : {}),
        ...(budget?.error ? { requestBudgetError: budget.error } : {}),
        ...(continues ? { continues } : {}),
        ...(awaitingTasks ? { awaitingTasks: true as const } : {}),
        ...(awaitingReminder ? { awaitingReminder: true as const } : {}),
        ...(managed.session.model?.provider ? { provider: managed.session.model.provider } : {}),
      });
    if (awaitingTasks) {
      // 常驻任务没有完成事件：第一次因这批任务持有时唤醒一次
      const fresh = this.takeUnnudged(managed);
      if (fresh) this.queueReminder(managed, awaitChecklist(fresh, Date.now()));
      // 忙时攒下、没等到工具结果的完成通知：持有中就开新一轮交给它
      for (const text of managed.childTaskNotices?.splice(0) ?? [])
        this.queueReminder(managed, text);
    }
    // 到时限时它正忙：这一轮结束再要它表态交报告
    if (awaitingTasks && run.expiry === 'due')
      this.queueReminder(managed, this.tellHoldExpired(managed, run));
    if (managed.pendingCompact) {
      const queued = managed.pendingCompact;
      managed.pendingCompact = undefined;
      void this.runCompaction(managed, queued.instructions);
    }
    this.flushPendingReminders(managed);
    this.fireDueReminders(managed);
  }

  /** 子代理还有自己起的、在跑、没表态的后台任务，或还有没交给它的完成通知 */
  private awaitsOwnTasks(managed: ManagedSession): boolean {
    return (
      this.bgTasks.undeclared(managed.identity.sessionId).length > 0 ||
      (managed.childTaskNotices?.length ?? 0) > 0 ||
      managed.pendingTaskReminders.length > 0 ||
      this.reminders.list(managed.identity.sessionId).length > 0
    );
  }

  /** 第一次持有起算时限：常驻服务、挂死的任务永远等不到完成，Run 不能跟着一直挂 */
  private holdRun(managed: ManagedSession, run: AgentRunHold): void {
    if (run.holdTimer) return;
    run.holdTimer = setTimeout(() => {
      if (managed.agentRun !== run || this.sessions.get(managed.identity.sessionId) !== managed)
        return;
      run.expiry = 'due';
      if (managed.status !== 'running' && !managed.roundPending)
        this.deliverNotification(managed.identity.sessionId, this.tellHoldExpired(managed, run));
    }, AGENT_RUN_HOLD_LIMIT_MS);
    run.holdTimer.unref?.();
  }

  /** 到时限的要求：不再等，给任务表态并在这一轮交报告；这一轮结束 Run 就收口 */
  private tellHoldExpired(managed: ManagedSession, run: AgentRunHold): string {
    run.expiry = 'told';
    return [
      `This Run has waited ${AGENT_RUN_HOLD_LIMIT_MS / 60_000} minutes for your background tasks and will not wait any longer. Give your final report in this turn; the Run ends when this turn ends.`,
      settleChecklist(this.bgTasks.undeclared(managed.identity.sessionId), Date.now()),
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private releaseRun(managed: ManagedSession): void {
    clearTimeout(managed.agentRun?.holdTimer);
    managed.agentRun = undefined;
  }

  /** 被持有的 Run 等着的任务（自己起的、在跑、没表态的）：Run 被叫停或子代理被回收时一并停掉 */
  private stopAwaitedTasks(managed: ManagedSession): void {
    for (const task of this.bgTasks.undeclared(managed.identity.sessionId))
      this.bgTasks.stop(task.taskId, true);
    this.reminders.cancelAll(managed.identity.sessionId);
  }

  /** 没表态的任务里有没提醒过的：整批记为已提醒并返回，同一批任务只提醒一次 */
  private takeUnnudged(managed: ManagedSession): BackgroundTaskInfo[] | undefined {
    const open = this.bgTasks.undeclared(managed.identity.sessionId);
    managed.taskWrapUpNudged ??= new Set();
    const nudged = managed.taskWrapUpNudged;
    if (!open.some((task) => !nudged.has(task.taskId))) return undefined;
    for (const task of open) nudged.add(task.taskId);
    return open;
  }

  /** 收尾清单：根会话自己起的、还在跑、没表态的后台任务（子代理起的归子代理，不要求父会话表态） */
  private taskWrapUp(sessionId: string): string | undefined {
    if (sessionId.includes('::')) return undefined;
    return settleChecklist(this.bgTasks.undeclared(sessionId), Date.now());
  }

  /**
   * 回合收尾还有没表态的任务：时间线记一行灰色提醒，清单挂到下一条工具结果 / 进模型的消息上。
   * 不为此另起一轮；同一批任务只提醒一次。
   */
  private nudgeTaskWrapUp(managed: ManagedSession): void {
    if (managed.identity.sessionId.includes('::')) return;
    const open = this.takeUnnudged(managed);
    if (!open) return;
    managed.taskWrapUpPending = true;
    const entry: AgentSessionCustomEntry = {
      kind: 'task-wrap-up-nudge',
      count: open.length,
      at: Date.now(),
    };
    managed.session.sessionManager.appendCustomEntry('enso-agent-session', entry);
    managed.customEntries.push(entry);
    this.options.emit({
      type: 'session-custom-entry',
      identity: managed.identity,
      seq: ++managed.seq,
      entry,
    });
  }

  /** 收尾清单搭在进模型的消息前（展示层按 splitTurnNotes 剥掉） */
  private withTaskWrapUp(managed: ManagedSession, text: string): string {
    if (!managed.taskWrapUpPending) return text;
    managed.taskWrapUpPending = false;
    const note = this.taskWrapUp(managed.identity.sessionId);
    return note ? prependTurnNote(note, text) : text;
  }

  private withTiming(
    managed: ManagedSession,
    index: number,
    message: ProjectedMessage
  ): ProjectedMessage {
    const timing = managed.timings[index];
    let decorated = timing ? { ...message, timing } : message;
    if (decorated.role === 'toolResult' && decorated.toolCallId) {
      const durationMs = managed.toolDurations.get(decorated.toolCallId);
      if (durationMs !== undefined && decorated.toolDurationMs === undefined) {
        decorated = { ...decorated, toolDurationMs: durationMs };
      }
    }
    return decorated;
  }

  private tryRefusalRetry(
    managed: ManagedSession,
    lastAssistant: ProjectedMessage | undefined
  ): boolean {
    const hardening = managed.refusalRetryPrompt;
    if (!hardening) return false;
    const turnId = managed.currentTurnId;
    if (!turnId || managed.refusalRetriedTurn === turnId) return false;
    const text = (lastAssistant?.content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    if (!looksLikeRefusal(text)) return false;
    managed.refusalRetriedTurn = turnId;
    managed.turnStartIndex = managed.messages.length;
    void this.promptTracked(managed, hardening, { streamingBehavior: 'followUp' }).catch(
      (error) => {
        this.failTurn(managed, toErrorMessage(error));
      }
    );
    return true;
  }

  private trySilentTurnRecovery(managed: ManagedSession): boolean {
    // silence_turn 之后按提示词不再写正文。空回复是故意的，不能当成工具做完却没总结。
    if (turnCalledSilenceTurn(managed.messages, managed.turnStartIndex)) return false;
    const kind = silentTurnKind(managed.messages);
    if (!kind) return false;
    if (managed.silentTurnNudgeUsed) {
      if (kind === 'post-tool' || managed.silentTurnKind === 'post-tool') {
        this.failTurn(managed, 'The tools completed, but the assistant reply was empty.');
        return true;
      }
    }
    return false;
  }

  private tryAdaptiveDowngrade(managed: ManagedSession): boolean {
    const lastError = managed.messages.at(-1)?.errorMessage ?? '';
    if (!lastError.includes('adaptive thinking is not supported')) return false;
    // 虚拟模型：真正不支持的是这次路由到的成员
    const routed = (managed.session.messages.at(-1) as { model?: unknown } | undefined)?.model;
    const failedModel = typeof routed === 'string' ? routed : managed.modelId;
    if (managed.adaptiveDowngraded.has(failedModel)) return false;
    managed.adaptiveDowngraded.add(failedModel);
    runtimeAdaptiveBlocklist.add(managed.modelId);
    runtimeAdaptiveBlocklist.add(failedModel);
    const compat = managed.session.model?.compat as { forceAdaptiveThinking?: boolean } | undefined;
    if (compat) compat.forceAdaptiveThinking = undefined;
    const lastUser = [...managed.messages].reverse().find((message) => message.role === 'user');
    const text = lastUser?.content.find((part) => part.type === 'text')?.text;
    if (!text) return false;
    // 重发同一请求：本轮摘要从重发点起算，避免失败的首次尝试重复计入
    managed.turnStartIndex = managed.messages.length;
    void this.promptTracked(managed, text, { streamingBehavior: 'followUp' }).catch((error) => {
      this.failTurn(managed, toErrorMessage(error));
    });
    return true;
  }

  private upsertLocalMessage(managed: ManagedSession, message: ProjectedMessage | null): void {
    if (!message) return;
    const index = managed.messages.length;
    const decorated = this.withTiming(managed, index, message);
    managed.messages.push(decorated);
    this.options.emit({
      type: 'message-upsert',
      identity: managed.identity,
      seq: ++managed.seq,
      index,
      message: decorated,
    });
  }

  private replaceLastMessage(
    managed: ManagedSession,
    message: ProjectedMessage | null,
    streaming = false
  ): void {
    if (!message) return;
    if (managed.messages.length === 0) {
      this.upsertLocalMessage(managed, message);
      return;
    }
    const index = managed.messages.length - 1;
    managed.messages[index] = this.withTiming(managed, index, message);
    if (!streaming) {
      this.emitUpsert(managed, index);
      return;
    }
    // 每次增量都下发整条消息：长回复的 IPC 体积与 renderer 重算随长度平方增长，按窗口合并
    if (managed.upsertTimer) {
      managed.upsertPending = index;
      return;
    }
    this.emitUpsert(managed, index);
    this.armUpsertWindow(managed);
  }

  private armUpsertWindow(managed: ManagedSession): void {
    managed.upsertTimer = setTimeout(() => {
      managed.upsertTimer = undefined;
      const index = managed.upsertPending;
      if (index === undefined) return;
      managed.upsertPending = undefined;
      if (this.sessions.get(managed.identity.sessionId) !== managed) return;
      this.emitUpsert(managed, index);
      this.armUpsertWindow(managed);
    }, STREAM_UPSERT_WINDOW_MS);
  }

  private flushStreamingUpsert(managed: ManagedSession): void {
    if (managed.upsertTimer) clearTimeout(managed.upsertTimer);
    managed.upsertTimer = undefined;
    const index = managed.upsertPending;
    managed.upsertPending = undefined;
    if (index !== undefined) this.emitUpsert(managed, index);
  }

  private emitUpsert(managed: ManagedSession, index: number): void {
    const message = managed.messages[index];
    if (!message) return;
    this.options.emit({
      type: 'message-upsert',
      identity: managed.identity,
      seq: ++managed.seq,
      index,
      message,
    });
  }

  /** 渲染层口径的完整记录：compaction 之前的历史 + pi 当前上下文 */
  private transcript(managed: ManagedSession): unknown[] {
    return buildSessionDisplayMessages(managed.session, managed.session.messages as unknown[]);
  }

  /**
   * 复盘旁路分叉注入：把源会话最近一次请求的消息快照写进新会话的 transcript 与 agent state，
   * 之后复盘会话的首条 prompt 就是源会话请求前缀的续写，命中同一份提示缓存。
   * 源会话不在、还没有任何请求留底、或换过模型时静默降级（调用方退回文本快照）。
   */
  private injectForkTranscript(identity: SessionIdentity, forkFrom: string): void {
    const managed = this.sessions.get(identity.sessionId);
    if (!managed || !isSameGeneration(managed.identity, identity)) return;
    const source = this.sessions.get(forkFrom);
    const base = source ? forkBaseOf(source) : undefined;
    if (!source || !base) return;
    // 模型必须与被分叉会话一致，否则请求前缀不同，注入了也吃不到缓存，反而污染上下文
    const model = managed.session.model;
    if (!model || model.id !== base.selection.id || model.provider !== base.selection.provider)
      return;
    const reply = base.reply;
    const settled =
      reply?.stopReason === 'stop' && !reply.content.some((part) => part.type === 'toolCall');
    const messages = settled ? [...base.messages, reply] : [...base.messages];
    if (messages.length === 0) return;
    try {
      for (const message of messages) {
        managed.session.sessionManager.appendMessage(message);
      }
      managed.session.agent.state.messages = [...messages];
      managed.forkBase = {
        model: base.model,
        messages: [...messages],
        ...(base.options ? { options: base.options } : {}),
        stream: base.stream,
        selection: base.selection,
      };
      this.reconcileMessages(managed, this.transcript(managed));
      managed.turnStartIndex = managed.messages.length;
    } catch {
      // 注入失败不阻断旁路：会话仍是空起步的普通旁路
    }
  }

  private reconcileMessages(managed: ManagedSession, rawMessages: unknown[]): void {
    const projected = rawMessages
      .map(projectMessage)
      .filter((message): message is ProjectedMessage => message !== null);
    projected.forEach((rawMessage, index) => {
      const known = managed.messages[index];
      const message = this.withTiming(managed, index, rawMessage);
      if (known && JSON.stringify(known) === JSON.stringify(message)) return;
      managed.messages[index] = message;
      this.options.emit({
        type: 'message-upsert',
        identity: managed.identity,
        seq: ++managed.seq,
        index,
        message,
      });
    });
    if (managed.messages.length > projected.length) {
      managed.messages.length = projected.length;
      managed.timings.length = projected.length;
      this.options.emit({
        type: 'messages-truncated',
        identity: managed.identity,
        seq: ++managed.seq,
        length: projected.length,
      });
    }
  }

  private rejectRewind(managed: ManagedSession, restoreFiles?: boolean): void {
    this.options.emit({
      type: 'rewind-done',
      identity: managed.identity,
      seq: ++managed.seq,
      ...(restoreFiles ? { filesRestored: false } : {}),
    });
    // 先清除乐观回退，再恢复权威投影。
    this.options.emit({
      type: 'snapshot',
      partial: true,
      sessionId: managed.identity.sessionId,
      sessions: this.snapshotSessions().filter((session) => session.identity === managed.identity),
    });
  }

  /** 纯回退是严格前缀：先裁投影，UI 不必等 navigateTree / 文件还原。 */
  private truncateProjectionForRewind(managed: ManagedSession, anchor: string | number): void {
    if (typeof anchor === 'number' && (!Number.isInteger(anchor) || anchor < 0)) return;
    const users: number[] = [];
    for (let i = 0; i < managed.messages.length; i++) {
      if (managed.messages[i]?.role === 'user') users.push(i);
    }
    const keep =
      typeof anchor === 'string'
        ? managed.messages.findIndex(
            (message) => message.role === 'user' && message.entryId === anchor
          )
        : users[users.length - 1 - anchor];
    if (keep === undefined || keep < 0 || keep >= managed.messages.length) return;
    managed.messages.length = keep;
    managed.timings.length = keep;
    this.options.emit({
      type: 'messages-truncated',
      identity: managed.identity,
      seq: ++managed.seq,
      length: keep,
    });
  }

  /** 回退后只对齐长度，不把前缀逐条 upsert 回去。 */
  private replaceMessagesAfterRewind(managed: ManagedSession): void {
    const projected = this.transcript(managed)
      .map(projectMessage)
      .filter((message): message is ProjectedMessage => message !== null)
      .map((rawMessage, index) => this.withTiming(managed, index, rawMessage));
    const previousLength = managed.messages.length;
    if (projected.length < previousLength) {
      // navigateTree 后的 LLM 上下文可能短于完整投影；再 truncated 会砍掉前缀。
      return;
    }
    managed.messages = projected;
    managed.timings.length = projected.length;
  }

  /** 重试倒计时中则打断并等待本轮收尾；返回是否发生了打断（用户输入接管重试） */
  private async interruptRetryIfAny(managed: ManagedSession): Promise<boolean> {
    if (!this.cancelRetry(managed)) return false;
    await managed.session.waitForIdle();
    return true;
  }

  /**
   * 取消重试即放弃这一轮，auto_retry_end(false) 按失败收口。pi 取消重试后见到排队消息会在同一轮
   * 续跑，所以先撤回排进来的 prompt。返回是否真的取消了重试。
   */
  private cancelRetry(managed: ManagedSession): boolean {
    if (!managed.session.isRetrying) return false;
    this.withdrawQueuedPrompts(managed);
    managed.session.abortRetry();
    return true;
  }

  private promptFresh(
    managed: ManagedSession,
    text: string,
    images?: { type: 'image'; data: string; mimeType: string }[],
    deliveryId?: string,
    /** 带新消息的续跑：先按断点重试移出未完成的最后一条 assistant 再 prompt（正在流式时照常插话） */
    resume?: true
  ): void {
    this.flushPendingMcpTools(managed);
    this.flushPendingBuiltinTools(managed);
    // pi 在 input hook 之后才判忙，先看 isStreaming 再 prompt 永远有竞态：一律带 followUp，
    // 活轮里由 pi 排到本轮之后，不会抛 already processing 把会话打成 error
    if (resume && !managed.session.isStreaming) editUnfinishedAssistantForResume(managed.session);
    const previousTurnId = managed.currentTurnId;
    managed.currentTurnId = randomUUID();
    managed.turnAborted = false;
    ensureAssistantUsage(managed.session.messages as unknown[]);
    const body = consumeRole(managed, text);
    const options = {
      ...(images ? { images } : {}),
      streamingBehavior: 'followUp' as const,
      preflightResult: (disposition: PromptDisposition) => {
        if (disposition === 'queued') this.noteQueuedPrompt(managed, deliveryId);
      },
    };
    const state: PromptDeliveryState = { dispatched: false, queued: false };
    const submit = () => this.promptTracked(managed, body, options, deliveryId, state);
    // 没开出新轮（被拒收或排进活轮）就把轮次号还给正在跑的那一轮
    const restoreTurn = () => {
      if (!state.dispatched || state.queued) managed.currentTurnId = previousTurnId;
    };
    // 拒收回执必须最后发：消费者收到回执就让出会话，之后才到的失败终态会被记到下一条投递头上。
    // 活轮还在时这条本该排在它后面，被拒只回执，不能把活轮打成失败
    const reject = (error: string) => {
      if (previousTurnId === undefined && !managed.session.isStreaming)
        this.failTurn(managed, error);
      else restoreTurn();
      if (!state.dispatched) this.emitDeliveryRejected(managed, deliveryId);
    };
    void submit()
      .then(restoreTurn)
      .catch(async (error: unknown) => {
        const message = toErrorMessage(error);
        // 竞态拒收：worker 的真实状态是还在跑，改用 followUp 重投，绝不当成失败
        if (isAlreadyProcessing(message)) {
          try {
            await submit();
            restoreTurn();
            return;
          } catch {
            if (!state.dispatched) this.emitDeliveryRejected(managed, deliveryId);
            restoreTurn();
            return;
          }
        }
        // 续跑撞上刚启动的压缩：等压完再投一次，不要把会话打成 error
        if (
          message.includes('Cannot submit a prompt while compaction is in progress') &&
          (await waitPromptable(
            managed.session,
            ZOMBIE_TURN_WAIT_MS,
            () => managed.status === 'running'
          ))
        ) {
          try {
            await submit();
            restoreTurn();
            return;
          } catch (retryError) {
            reject(toErrorMessage(retryError));
            return;
          }
        }
        reject(message);
      });
  }

  /**
   * pi 先投递新 prompt 自身的 user 消息，再投递滞留的 steer；每条 user 消息按此顺序领取回执。
   * 所有注入 user 消息的调用都必须经这两个入口，否则队列错位。
   *
   * pi 0.99 起 `preflightResult` 只在 prompt 被接受后回调 disposition（`handled` / `queued` /
   * `started`），被拒绝时不回调而是直接抛错。因此「抛错且从未回调」即为 preflight 拒收，
   * 此时消息尚未提交，允许渲染层撤回乐观气泡；回调之后再抛错则不能视为未送达。
   */
  private promptTracked(
    managed: ManagedSession,
    text: string,
    options?: Parameters<AgentSession['prompt']>[1],
    deliveryId?: string,
    state?: PromptDeliveryState
  ): Promise<void> {
    const slot = { id: deliveryId ?? null };
    managed.promptDelivery = slot;
    const trackedOptions = deliveryId
      ? {
          ...options,
          preflightResult: (disposition: PromptDisposition) => {
            if (state) {
              state.dispatched = true;
              if (disposition === 'queued') state.queued = true;
            }
            options?.preflightResult?.(disposition);
          },
        }
      : options;
    return managed.session
      .prompt(withPendingPlanNote(managed, this.withTaskWrapUp(managed, text)), trackedOptions)
      .finally(() => {
        if (managed.promptDelivery === slot) managed.promptDelivery = undefined;
      });
  }

  /** 投递被拒收：交回执让上游重排，不把会话标成失败 */
  private emitDeliveryRejected(
    managed: ManagedSession,
    deliveryId?: string,
    reason?: 'turn-stuck'
  ): void {
    if (!deliveryId) return;
    this.options.emit({
      type: 'delivery-rejected',
      identity: managed.identity,
      seq: ++managed.seq,
      deliveryId,
      ...(reason ? { reason } : {}),
    });
  }

  /** pi 刚把这条 prompt 排进 followUp 队列，队尾就是它；已被 pi 取走的记录顺手丢掉 */
  private noteQueuedPrompt(managed: ManagedSession, deliveryId?: string): void {
    const labels = managed.session.getFollowUpMessages();
    const text = labels.at(-1);
    if (text === undefined) return;
    managed.queuedPrompts = [
      ...stillQueued(managed.queuedPrompts ?? [], labels.slice(0, -1)),
      { text, ...(deliveryId ? { deliveryId } : {}) },
    ];
  }

  /**
   * 用户叫停时排进活轮的 prompt 不会再跑：pi 的 abort 不清 followUp 队列，留着就夹在下一次 prompt
   * 后面送达。撤出队列，按 deliveryId 回执；回执不是终态，原轮照常由 agent_settled 收口。
   */
  private withdrawQueuedPrompts(managed: ManagedSession): void {
    const withdrawn = stillQueued(managed.queuedPrompts ?? [], withdrawFollowUps(managed.session));
    managed.queuedPrompts = undefined;
    for (const { deliveryId } of withdrawn) this.emitDeliveryRejected(managed, deliveryId);
  }

  private async steerActive(
    managed: ManagedSession,
    text: string,
    images: AttachedImage[] | undefined,
    deliveryId: string
  ): Promise<void> {
    const emit = (type: 'delivery-deferred' | 'delivery-rejected' | 'delivery-settled') =>
      this.options.emit({ type, identity: managed.identity, seq: ++managed.seq, deliveryId });
    if (!managed.session.isStreaming || managed.session.isRetrying) {
      emit('delivery-deferred');
      return;
    }
    managed.plan?.supersede();
    const slot: NonNullable<ManagedSession['steerDeliveries']>[number] = { id: deliveryId };
    managed.steerDeliveries ??= [];
    managed.steerDeliveries.push(slot);
    try {
      const disposition = await steerActiveSession(
        managed.session,
        text,
        images?.map((image) => ({ type: 'image' as const, ...image })),
        (detach) => {
          slot.detach = detach;
        },
        (input) => withPendingPlanNote(managed, this.withTaskWrapUp(managed, input))
      );
      if (disposition === 'queued') {
        this.bgTasks.backgroundAllForeground(managed.identity.sessionId, 'steer');
      } else {
        managed.steerDeliveries = managed.steerDeliveries?.filter((item) => item !== slot);
        emit(disposition === 'handled' ? 'delivery-settled' : 'delivery-deferred');
      }
    } catch {
      managed.steerDeliveries = managed.steerDeliveries?.filter((item) => item !== slot);
      emit('delivery-rejected');
    }
  }

  private steerTracked(
    managed: ManagedSession,
    text: string,
    images?: { type: 'image'; data: string; mimeType: string }[],
    deliveryId?: string
  ): Promise<void> {
    const slot: NonNullable<ManagedSession['steerDeliveries']>[number] = { id: deliveryId ?? null };
    managed.steerDeliveries ??= [];
    managed.steerDeliveries.push(slot);
    return steerDetachable(
      managed.session,
      withPendingPlanNote(managed, this.withTaskWrapUp(managed, text)),
      images,
      (detach) => {
        slot.withdraw = detach;
      }
    )
      .then((disposition) => {
        // Pi 可在 input hook 中消费输入，而不向队列添加 user 消息，因此不能保留对应投递标记。
        if (disposition === 'handled') {
          managed.steerDeliveries = managed.steerDeliveries?.filter((item) => item !== slot);
        }
      })
      .catch((error: unknown) => {
        managed.steerDeliveries = managed.steerDeliveries?.filter((item) => item !== slot);
        throw error;
      });
  }

  private takeDelivery(managed: ManagedSession): string | null {
    const slot = managed.promptDelivery ?? managed.steerDeliveries?.shift();
    managed.promptDelivery = undefined;
    return slot?.id ?? null;
  }

  /** 子代理预算 Run 每完成一次模型请求记一笔：到软预算提示一次，到 1.5 倍中止并强制交出。 */
  private noteBudgetRequest(managed: ManagedSession, message: ProjectedMessage): void {
    // 不带工具调用的正常收尾就是最终回答：哪怕正好踩线也不打断
    const final =
      message.stopReason === 'stop' && !message.content.some((part) => part.type === 'toolCall');
    const action = managed.requestBudget?.observe(final);
    if (action === 'notice') managed.requestBudget?.queueNotice();
    else if (action === 'stop' || action === 'hard') {
      // observe() 已切阶段；abort 结束后 agent_settled 按阶段决定是补交报告还是收口
      void managed.session.abort().catch(() => {});
    }
  }

  private emitRetrySkipped(managed: ManagedSession, reason: RetrySkippedReason): void {
    this.options.emit({
      type: 'retry-skipped',
      identity: managed.identity,
      seq: ++managed.seq,
      reason,
    });
  }

  private failTurn(managed: ManagedSession, error: string, retryExhausted = false): void {
    const quiet = this.exitingRun(managed);
    const turnId = managed.currentTurnId ?? managed.abortedTurnId ?? randomUUID();
    const aborted = managed.turnAborted === true;
    const run = managed.agentRun;
    const continues = run && run.id !== turnId ? run.id : undefined;
    this.releaseRun(managed);
    if (!quiet && managed.identity.sessionId.includes('::'))
      this.reminders.cancelAll(managed.identity.sessionId);
    managed.currentTurnId = undefined;
    managed.abortedTurnId = undefined;
    managed.turnRetried = false;
    managed.turnAborted = false;
    managed.settlePending = false;
    managed.requestBudget?.disarm();
    managed.contextUsage.setPendingSnapshot(undefined);
    managed.status = 'failed';
    this.flushPendingBuiltinTools(managed);
    // 失败轮不总结，但下一轮的起点仍要往前推，否则失败轮的消息会混进下一轮摘要
    managed.turnStartIndex = managed.messages.length;
    // 轮失败时放弃排队压缩（通常是 queued；running 压缩与 failTurn 时序上不可达）
    // abandoned：清进度但不重钉「压缩完成」锚点；不带 error，避免假 toast
    managed.pendingCompact = undefined;
    if (managed.compaction) {
      managed.compaction = undefined;
      this.options.emit({
        type: 'compaction',
        identity: managed.identity,
        seq: ++managed.seq,
        state: 'end',
        abandoned: true,
      });
    }
    this.emitStatus(managed, error);
    this.workspaceClaims.release(managed.identity.sessionId);
    if (!quiet)
      this.options.emit({
        type: 'turn-failed',
        identity: managed.identity,
        seq: ++managed.seq,
        turnId,
        error,
        ...(retryExhausted ? { retryExhausted: true } : {}),
        ...(aborted ? { aborted: true as const } : {}),
        ...(continues ? { continues } : {}),
        ...(managed.session.model?.provider ? { provider: managed.session.model.provider } : {}),
      });
    this.flushPendingReminders(managed);
    this.fireDueReminders(managed);
  }

  private emitStatus(managed: ManagedSession, error?: string): void {
    this.flushStreamingUpsert(managed);
    this.options.emit({
      type: 'status',
      identity: managed.identity,
      seq: ++managed.seq,
      status: managed.status,
      ...(error ? { error } : {}),
      // 回合 id 只在 running 有意义：Main 退出记录据此把中断归到具体一轮
      ...(managed.status === 'running' && managed.currentTurnId
        ? { turnId: managed.currentTurnId }
        : {}),
    });
    if (managed.status !== 'running') this.settleRound(managed);
    this.scheduleRestartCheck();
  }

  /**
   * 轮次终态收口(idle/failed/abort/销毁统一经此):coworker 记下本轮摘要供 report/wait,
   * 唤醒所有等待者。与触发来源(主 agent send / 用户 tab / 重试耗尽)无关。
   */
  private settleRound(managed: ManagedSession): void {
    // 注册时的首次 emitStatus 也走到这里:没跑过任何轮(无 assistant 消息且未失败)不记摘要
    const ran =
      managed.status === 'failed' ||
      (managed.session.messages as { role?: string }[]).some((m) => m.role === 'assistant');
    if (managed.coworkerName && ran) {
      managed.lastRoundSummary = this.roundBaseSummary(managed);
      const schema = managed.pendingYieldSchema;
      managed.pendingYieldSchema = undefined;
      if (schema && typeof schema === 'object') {
        const parsed = parseJsonFromAssistant(lastAssistantText(managed.session));
        if (parsed !== undefined && validateAgainstSchema(parsed, schema).ok) {
          managed.lastRoundSummary = appendYieldJson(managed.lastRoundSummary, parsed);
        }
      }
    }
    managed.roundPending = false;
    const waiters = [...managed.roundWaiters];
    managed.roundWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  /** 下一次 settleRound 时 resolve;签号 abort 也 resolve(只提前返回,不杀 coworker) */
  private waitRoundEnd(managed: ManagedSession, signal?: AbortSignal): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const done = () => {
      managed.roundWaiters.delete(done);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    managed.roundWaiters.add(done);
    signal?.addEventListener('abort', done, { once: true });
    return promise;
  }

  /** 执行一次手动压缩。进度/收束由 pi 的 compaction_start / compaction_end 事件推给渲染层；
   *  这里只兵底 compact() 直接抛错（未走到 compaction_end）的情况，否则 UI 会卡在「压缩中」。 */
  private async runCompaction(managed: ManagedSession, instructions?: string): Promise<void> {
    // 先标 running：compact() 同步抛错时 compaction 仍是 undefined，catch 才能区分「没走过 end」
    managed.compaction = 'running';
    try {
      await managed.session.compact(instructions);
    } catch (error) {
      console.error('[compact] failed:', toErrorMessage(error));
      // compaction_end 已把进度清掉并上报过：再 emit 会叠两条「压缩失败」toast
      if (managed.compaction === undefined) return;
      // 未走到 compaction_end：不清的话快照会让手机永远卡在「压缩中」
      managed.compaction = undefined;
      this.options.emit({
        type: 'compaction',
        identity: managed.identity,
        seq: ++managed.seq,
        state: 'end',
        error: toErrorMessage(error),
      });
    }
  }

  private estimateSessionMessage(message: unknown): number {
    return estimateConversationTokens(message);
  }

  /** 打包后 stdout 不可见：取消原因落到数据目录，事后可查 */
  private logCompactCancel(managed: ManagedSession, cancel: CompactCancel): void {
    if (!this.options.dataDir) return;
    appendCappedLog(
      path.join(this.options.dataDir, AGENT_COMPACTION_LOG),
      `compact-cancel session=${managed.identity.sessionId} ${JSON.stringify(cancel)}`
    );
  }

  private occupancyInputs(managed: ManagedSession) {
    const loader = managed.session.resourceLoader as {
      getAgentsFiles?: () => { agentsFiles?: ReadonlyArray<{ path: string; content: string }> };
      getSkills?: () => { skills?: OccupancySkill[] };
    };
    const sessionManager = managed.session.sessionManager as {
      buildSessionContext?: () => { messages?: unknown[] };
      getBranch?: () => OccupancyBranchEntry[];
    };
    return {
      systemPrompt: managed.session.systemPrompt ?? '',
      agentsFiles: loader.getAgentsFiles?.().agentsFiles ?? [],
      skills: loader.getSkills?.().skills ?? [],
      tools: typeof managed.session.getAllTools === 'function' ? managed.session.getAllTools() : [],
      contextMessages: sessionManager.buildSessionContext?.().messages ?? [],
      branch: sessionManager.getBranch?.() ?? [],
      pendingTaskReminders: managed.pendingTaskReminders,
    };
  }

  private currentNonMessageTokens(managed: ManagedSession): {
    current: number;
    category: number;
    compactionIndex: number;
  } {
    const occupancy = occupancyFromManaged(managed, undefined, (message) =>
      this.estimateSessionMessage(message)
    );
    const buckets = occupancy.buckets;
    const category =
      buckets.system +
      buckets.instructions +
      buckets.skills +
      buckets.tools +
      buckets.projectMemory +
      buckets.reminders;
    const compactionIndex = occupancy.compactionEntryId
      ? this.occupancyInputs(managed).branch.findIndex(
          (entry) => entry.id === occupancy.compactionEntryId
        )
      : -1;
    return { current: category + buckets.compaction, category, compactionIndex };
  }

  private breakdownMessages(managed: ManagedSession) {
    const inputs = this.occupancyInputs(managed);
    return contextBreakdownMessages(
      inputs.contextMessages,
      inputs.branch,
      (message) => this.estimateSessionMessage(message),
      managed.contextUsage
    );
  }

  private armPendingContextUsage(managed: ManagedSession): void {
    const nonMessage = this.currentNonMessageTokens(managed);
    const messages = this.breakdownMessages(managed);
    const breakdown = managed.contextUsage.getBreakdown({
      ...messages,
      compactionIndex: nonMessage.compactionIndex,
      currentNonMessageTokens: nonMessage.current,
      categoryNonMessageTokens: nonMessage.category,
    });
    managed.contextUsage.setPendingSnapshot({
      promptTokens: breakdown.usedTokens,
      nonMessageTokens: nonMessage.current,
      cutoffCount: messages.activeMessages.length,
    });
  }

  private rebaseContextUsage(managed: ManagedSession): void {
    const nonMessage = this.currentNonMessageTokens(managed);
    const contextMessages = this.occupancyInputs(managed).contextMessages;
    const estimate = (message: unknown) => this.estimateSessionMessage(message);
    const used =
      nonMessage.current +
      contextMessages.reduce((sum: number, message) => sum + Math.max(0, estimate(message)), 0);
    managed.contextUsage.rebaseAfterCompaction({
      promptTokens: used,
      nonMessageTokens: nonMessage.current,
      cutoffCount: contextMessages.length,
    });
  }

  private stampContextSnapshot(managed: ManagedSession, raw: unknown): void {
    const nonMessage = this.currentNonMessageTokens(managed);
    managed.contextUsage.stampSettledAnchor(toAnchorMessage(raw), nonMessage.current);
  }

  private emitPlanState(managed: ManagedSession): void {
    if (!managed.plan) return;
    this.options.emit({
      type: 'plan-state',
      identity: managed.identity,
      seq: ++managed.seq,
      state: managed.plan.state(),
    });
  }

  private emitSessionMeta(managed: ManagedSession): void {
    const contextWindow = positiveContextWindow(limitsModelOf(managed.session));
    let occupancy: ReturnType<typeof collectContextOccupancy> | undefined;
    try {
      const baseline = occupancyFromManaged(managed, contextWindow, (message) =>
        this.estimateSessionMessage(message)
      );
      occupancy = baseline;
      const nonMessage = this.currentNonMessageTokens(managed);
      const breakdown = managed.contextUsage.getBreakdown({
        contextWindow,
        ...this.breakdownMessages(managed),
        compactionIndex: nonMessage.compactionIndex,
        currentNonMessageTokens: nonMessage.current,
        categoryNonMessageTokens: nonMessage.category,
      });
      occupancy = {
        ...baseline,
        used: breakdown.usedTokens,
        estimated: !breakdown.anchored,
        buckets: {
          ...baseline.buckets,
          conversation: Math.max(
            0,
            breakdown.usedTokens - (baseline.used - baseline.buckets.conversation)
          ),
        },
        ...(contextWindow !== undefined
          ? { percent: Math.min(100, Math.round((breakdown.usedTokens / contextWindow) * 100)) }
          : {}),
      };
    } catch {
      occupancy = undefined;
    }
    let parts: ContextPart[] | undefined;
    if (occupancy) {
      try {
        const inputs = this.occupancyInputs(managed);
        parts = buildContextParts({
          buckets: contextUsagePayload(occupancy, managed.messages).buckets,
          agentsFiles: inputs.agentsFiles,
          skills: inputs.skills,
          tools: inputs.tools,
          reminders: inputs.pendingTaskReminders ?? [],
          messages: inputs.contextMessages,
          estimate: (message) => this.estimateSessionMessage(message),
        }).parts;
      } catch {
        // 拆分失败只少了条目，分类合计照发
      }
    }
    this.options.emit({
      type: 'session-meta',
      identity: managed.identity,
      seq: ++managed.seq,
      sessionFile: managed.session.sessionFile,
      ...(occupancy ? { occupancy: { ...occupancy, ...(parts ? { parts } : {}) } } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      // 渲染层冷会话不留正文、手机只持尾窗：按 worker 的完整记录算好随占用下发
      usageTotals: toUsageTotals(computeStats(managed.messages)),
    });
    if (occupancy && managed.pluginEvents?.plan.observe.includes('context_usage')) {
      managed.pluginEvents.notify(
        'context_usage',
        contextUsagePayload({ ...occupancy, ...(parts ? { parts } : {}) }, managed.messages)
      );
    }
  }

  private snapshotSessions(): SessionSnapshot[] {
    return Array.from(this.sessions.values()).map((managed) => {
      const backgroundTasks = this.bgTasks.snapshot(managed.identity.sessionId);
      return {
        identity: managed.identity,
        status: managed.status,
        messages: managed.messages,
        commands: managed.commands,
        ...(managed.requestBody ? { requestBody: managed.requestBody } : {}),
        ...(managed.gate.snapshot().length > 0
          ? { pendingApprovals: managed.gate.snapshot() }
          : {}),
        ...(managed.asks.snapshot().length > 0 ? { pendingAsks: managed.asks.snapshot() } : {}),
        // 切会话/重连靠快照整段重建 TaskBar；不带它会把还在跑的后台任务条清空，等下一次 update 才回来
        ...(backgroundTasks.length > 0 ? { backgroundTasks } : {}),
        ...(managed.childMetadata ? { child: managed.childMetadata } : {}),
        ...(managed.customEntries.length > 0 ? { customEntries: managed.customEntries } : {}),
        ...(managed.compaction ? { compaction: managed.compaction } : {}),
        ...(managed.compactionNoticeAt !== undefined
          ? { compactionNoticeAt: managed.compactionNoticeAt }
          : {}),
        ...(managed.plan ? { planState: managed.plan.state() } : {}),
      };
    });
  }

  private must(identity: SessionIdentity): ManagedSession {
    const managed = this.sessions.get(identity.sessionId);
    if (!managed || !isSameGeneration(managed.identity, identity)) {
      throw new Error(`${STALE_SESSION_ERROR}: ${identity.sessionId}`);
    }
    return managed;
  }

  private mustCurrent(sessionId: string): ManagedSession {
    const managed = this.sessions.get(sessionId);
    if (!managed) throw new Error(`unknown session: ${sessionId}`);
    return managed;
  }

  /** worker 退出前 fail-closed 清理挂起 capability，并断开 MCP 子进程。 */
  /**
   * 优雅重启的唯一提交点：每个会话都在安全点（空闲，或父会话停在工具批之后、下一次模型请求之前），
   * 才把断点写到 dataDir/restart-checkpoint.json 并回 graceful-restart-ready；否则回一次推迟原因。
   */
  private checkRestart(): void {
    const restart = this.restart;
    if (!restart || restart.committed) return;
    const entries: RestartCheckpointEntry[] = [];
    const deferred: Extract<AgentWorkerEvent, { type: 'graceful-restart-deferred' }>['sessions'] =
      [];
    // 去抖中的完成通知先投递：闲会话被唤起（回合在跑），停在边界的会话进持久化待投递队列
    for (const sessionId of this.sessions.keys()) this.notifier.flush(sessionId);
    for (const managed of this.sessions.values()) {
      // 重启时父会话若正停在阻塞等待（如 subagent wait），主动解除等待而不打断子代理：
      // 父会话随即到 model-request 安全点，子会话也不再被父会话的 toolStartAt 挡住
      this.bgTasks.detachBlockingWaits(managed.identity.sessionId, 'restart');
      // 停在边界后用户又插话 / 排了 follow-up：pi 要等 prepareNextTurn 返回后才把它写进会话文件，
      // 这时落断点新进程就丢了这句话。放开挂起让 loop 先写入，回合接着跑，到下一个边界或空闲再判
      const queued = managed.session.pendingMessageCount > 0;
      if (queued) managed.restartHold?.();
      // 前台命令转后台只是工具先回执，进程还在跑：和在跑的工具一样等它结束。
      // 重启要求保留后台命令时，能脱离 worker 的交给下一代认回，只等脱离不了的
      const keep = restart.keepBackground === true;
      const blockingTasks = this.bgTasks.runningYielded(managed.identity.sessionId, {
        exceptDetachable: keep,
      });
      const toolsInFlight = [...managed.toolStartAt.keys(), ...blockingTasks];
      const gate = restartGate({
        toolsInFlight,
        atModelRequestBoundary: managed.restartHold !== undefined,
        turnActive:
          queued ||
          managed.status === 'running' ||
          managed.currentTurnId !== undefined ||
          managed.session.isStreaming ||
          managed.session.isRetrying ||
          !!managed.roundPending ||
          !!managed.compaction ||
          !!managed.pendingCompact,
      });
      if (!gate.ready) {
        deferred.push({
          identity: managed.identity,
          reason: gate.reason,
          toolsInFlight,
          ...(managed.toolNames.size > 0 ? { toolNames: [...managed.toolNames.values()] } : {}),
          ...(keep && blockingTasks.length > 0 ? { undetachableTasks: blockingTasks } : {}),
          ...(toolsInFlight.length === 0 && managed.replyProgress
            ? { reply: { ...managed.replyProgress } }
            : {}),
        });
        continue;
      }
      const sessionFile = managed.session.sessionFile;
      if (!sessionFile) continue;
      const abortedReply =
        gate.nextStep === 'await-user' &&
        managed.restartAbortedTurnId !== undefined &&
        endsWithAbortedReply(managed.session.agent.state.messages);
      const nextStep = abortedReply ? 'model-request' : gate.nextStep;
      entries.push({
        sessionId: managed.identity.sessionId,
        generation: managed.identity.generation,
        sessionFile,
        seq: managed.seq,
        nextStep,
        turnId: abortedReply
          ? (managed.restartAbortedTurnId ?? null)
          : gate.nextStep === 'model-request'
            ? (managed.currentTurnId ?? null)
            : null,
        lastCompletedToolCallId: managed.lastCompletedToolCallId ?? null,
        messageCount: managed.session.messages.length,
        toolsInFlight,
      });
      if (abortedReply)
        console.log(
          `[graceful-restart] ${managed.identity.sessionId.slice(0, 8)} 回复写到一半被重启中止，断点记成 model-request，新进程续跑`
        );
    }
    // 还没注册的会话正在 spawn：等它落定，否则新进程里没有它；报出来，超时日志与弹层才知道在等谁
    for (const identity of this.spawning.values()) {
      if (!this.sessions.has(identity.sessionId))
        deferred.push({ identity, reason: 'session-starting', toolsInFlight: [] });
    }
    // 只剩等人回答的提问 / 审批挡着：取消它们，会话停到下一次模型请求前，重启后模型看到结果再问
    if (deferred.length > 0 && deferred.every((entry) => this.waitsOnlyForHuman(entry.identity)))
      for (const entry of deferred) this.cancelHumanWaits(entry.identity);
    if (deferred.length > 0) {
      // 回复在写时每个 token 都会触发检查：出 token 时刻按秒去抖，Main 据此顺延等待
      const key = JSON.stringify(deferred, (field, value) =>
        field === 'lastOutputMs' ? Math.floor(value / RESTART_PROGRESS_REPORT_MS) : value
      );
      if (key !== restart.deferredKey) {
        restart.deferredKey = key;
        this.options.emit({ type: 'graceful-restart-deferred', sessions: deferred });
      }
      return;
    }
    if ([...this.pendingCommands.keys()].some((id) => !this.sessions.has(id))) return;
    const checkpoint = {
      version: 1 as const,
      pid: process.pid,
      writtenAt: Date.now(),
      sessions: entries,
    };
    writeRestartCheckpoint(path.join(this.restartDataDir(), RESTART_CHECKPOINT_FILE), checkpoint);
    restart.committed = true;
    this.options.emit({ type: 'graceful-restart-ready', checkpoint });
  }

  /**
   * 退出重启前（Main 在终止 worker 之前发）：把能脱离的后台命令交出去、写恢复清单，回执后 Main 才终止 worker，
   * shutdown 只会停掉留在本代的任务。
   */
  private detachBackgroundTasks(): void {
    const tasks = this.bgTasks.detachForRestart();
    const file = path.join(this.restartDataDir(), DETACHED_TASKS_FILE);
    try {
      writeDetachedTasksManifest(file, {
        version: 1,
        writtenAt: Date.now(),
        workerPid: process.pid,
        tasks,
      });
    } catch (error) {
      // 清单写不下：进程已交出，下一代认不回，至少别让它们留成孤儿
      console.warn('[graceful-restart] failed to write detached task manifest:', error);
      for (const task of tasks) killRunGroup(task.pid, 'SIGKILL');
    }
    this.options.emit({ type: 'background-tasks-detached', detached: tasks.length });
  }

  private scheduleRestartCheck(): void {
    const restart = this.restart;
    if (!restart || restart.committed || restart.checkScheduled) return;
    restart.checkScheduled = true;
    queueMicrotask(() => {
      restart.checkScheduled = false;
      this.checkRestart();
    });
  }

  private parentOf(managed: ManagedSession): string | undefined {
    return managed.parentId ?? managed.childIdentity?.parent.sessionId;
  }

  private releaseChildHolds(parentId: string): void {
    for (const managed of this.sessions.values())
      if (this.parentOf(managed) === parentId) managed.restartHold?.();
  }

  /** 会话在跑的工具都在等人（ask_user 提问、审批），没有转后台的命令 */
  private waitsOnlyForHuman(identity: SessionIdentity): boolean {
    const managed = this.sessions.get(identity.sessionId);
    if (!managed || managed.toolStartAt.size === 0) return false;
    const waiting = managed.asks.snapshot().length + managed.gate.snapshot().length;
    return (
      waiting >= managed.toolStartAt.size &&
      this.bgTasks.runningYielded(identity.sessionId, {
        exceptDetachable: this.restart?.keepBackground === true,
      }).length === 0
    );
  }

  private cancelHumanWaits(identity: SessionIdentity): void {
    const managed = this.sessions.get(identity.sessionId);
    managed?.asks.cancelAll(RESTART_ASK_CANCELLED);
    managed?.gate.cancelAll();
  }

  /**
   * pi 在每次模型请求前调 prepareRequest：新一轮的首个请求（用户消息已写进 jsonl），或工具批全部返回、
   * 插话也已写入之后。有重启请求时会话停在这里，新消息、通知、goal 续跑都只落盘不出请求，新进程接着发。
   * 子会话在父会话有工具在跑时不停（父会话的 subagent / send 可能正等它）。
   */
  private installRestartBoundary(managed: ManagedSession): void {
    const agent = managed.session.agent as AgentSession['agent'] | undefined;
    if (!agent) return;
    const next = agent.prepareRequest;
    agent.prepareRequest = async (request, signal) => {
      await this.holdForRestart(managed);
      return (await next?.call(agent, request, signal)) ?? undefined;
    };
  }

  private holdForRestart(managed: ManagedSession): Promise<void> {
    const restart = this.restart;
    const parentId = this.parentOf(managed);
    if (
      !restart ||
      restart.committed ||
      managed.session.pendingMessageCount > 0 ||
      this.sessions.get(managed.identity.sessionId) !== managed ||
      (parentId !== undefined && (this.sessions.get(parentId)?.toolStartAt.size ?? 0) > 0)
    )
      return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    managed.restartHold = () => {
      managed.restartHold = undefined;
      resolve();
    };
    this.checkRestart();
    return promise;
  }

  /** 断点说下一步是模型请求：接着同一轮（同一个 turnId）续跑，不重放刚完成的工具 */
  private continueAfterRestart(managed: ManagedSession): void {
    const entry = managed.restartResume;
    managed.restartResume = undefined;
    if (entry?.nextStep !== 'model-request') return;
    // 上一代收尾时中止了写到一半的回复：先把它移出模型上下文（jsonl 原条目保留），再从它之前续跑
    const abortedEntryId = abortedReplyEntryId(managed.session);
    const abortedReply =
      endsWithAbortedReply(managed.session.agent.state.messages) &&
      editUnfinishedAssistantForResume(managed.session);
    const tail = managed.session.agent.state.messages.at(-1)?.role;
    if (tail === undefined || tail === 'assistant') {
      console.warn(
        `[graceful-restart] ${entry.sessionId.slice(0, 8)} 会话文件停在回复上，不续跑，等用户下一条`
      );
      return;
    }
    if (abortedReply) {
      console.log(`[graceful-restart] ${entry.sessionId.slice(0, 8)} 续跑被重启中止的回复`);
      // 展示上把半截回复折叠成一行：记一条 custom entry（重载时据此打标），并把已下发的那条改掉
      if (abortedEntryId) {
        markRestartResumedReply(managed.session, abortedEntryId);
        this.reconcileMessages(managed, this.transcript(managed));
      }
    }
    managed.currentTurnId = entry.turnId ?? randomUUID();
    if (entry.lastCompletedToolCallId)
      managed.lastCompletedToolCallId = entry.lastCompletedToolCallId;
    void continueSessionActivity(managed.session).catch((error) =>
      this.failTurn(managed, toErrorMessage(error))
    );
  }

  private claimRestartResume(
    identity: SessionIdentity,
    sessionFile: string
  ): RestartCheckpointEntry | undefined {
    const entry = this.restartResume.get(identity.sessionId);
    if (
      !entry ||
      entry.generation !== identity.generation ||
      path.resolve(entry.sessionFile) !== path.resolve(sessionFile)
    )
      return undefined;
    this.restartResume.delete(identity.sessionId);
    return entry;
  }

  async shutdown(): Promise<void> {
    clearInterval(this.evictionTimer);
    this.reminders.dispose();
    this.workspaceSwitch.clear();
    this.recordInterruptedTasks();
    this.bgTasks.stopAll();
    // 还在等安全点（等转后台的命令时被强制退出 / 超时）：给刚停掉的命令一点时间收口，
    // 完成通知进持久化队列、停在边界的会话落下断点，Main 据此补写恢复清单
    const restartPending = this.restart !== undefined && !this.restart.committed;
    if (restartPending) await this.settleYieldedTasks(1_000);
    // 还没到安全点的会话里，正在写回复（没有工具在跑）的根会话记下这一轮：
    // 中止后断点记成同一轮的模型请求，冷启动续跑，而不是只留一句 This operation was aborted
    if (restartPending)
      for (const managed of this.sessions.values()) this.markRestartAbort(managed);
    this.exiting = true;
    const aborts: Promise<unknown>[] = [];
    for (const managed of this.sessions.values()) {
      cancelContinuousMemory(managed.session.sessionManager);
      managed.browser?.cancelAll('Enso worker shutdown');
      managed.memory?.cancelAll('Enso worker shutdown');
      managed.delegation?.cancelAll('Enso worker shutdown');
      managed.secretary?.cancelAll('Enso worker shutdown');
      managed.agentControl?.close('Enso worker shutdown');
      managed.currentTurnId = undefined;
      managed.computer?.cancelAll('Enso worker shutdown');
      managed.pluginTools?.cancelAll('Enso worker shutdown');
      managed.pluginEvents?.cancelAll();
      // pi 的 bash 是 detached 进程组，只在中断信号上 killProcessTree；SDK 未导出退出清理，
      // 这里同步触发中断（不等 waitForIdle），否则 worker 退出后命令成孤儿进程。
      // 优雅重启已落断点时没有工具在跑，也不能再中断：被挂起的 loop 一放行就会写进会话文件
      if (!this.restart?.committed) aborts.push(managed.session.abort().catch(() => {}));
    }
    if (restartPending) {
      // 等中止落进会话文件再落断点（上限内），Main 据此补写恢复清单
      await Promise.race([
        Promise.allSettled(aborts),
        new Promise((resolve) => setTimeout(resolve, RESTART_ABORT_SETTLE_MS).unref()),
      ]);
      this.checkRestart();
    }
    return this.mcp.closeAll();
  }

  /**
   * 收尾会停掉所有还在跑的后台任务（空闲会话的也是）：先记进台账，新一代通知所属会话一次。
   * 写不下就退回本代照常发完成通知（多半丢在退出路上，但不会重复）
   */
  private recordInterruptedTasks(): void {
    // 断点已落盘时，持有 Run 的子代理重启后会被续跑：它的任务记给它本身
    const records = this.bgTasks.interruptedOnShutdown(
      Date.now(),
      (sessionId) =>
        this.restart?.committed === true && this.sessions.get(sessionId)?.agentRun !== undefined
    );
    if (records.length === 0) return;
    try {
      appendInterruptedTasks(path.join(this.restartDataDir(), INTERRUPTED_TASKS_FILE), records);
      this.bgTasks.handOverNotices(records.map((record) => record.taskId));
      console.log(
        `[graceful-restart] 收尾停掉 ${records.length} 个后台任务，记入台账待新进程通知：${records
          .map((record) => `${record.sessionId.slice(0, 8)}/${record.taskId}`)
          .join(' ')}`
      );
    } catch (error) {
      console.warn('[graceful-restart] failed to record interrupted background tasks:', error);
    }
  }

  private markRestartAbort(managed: ManagedSession): void {
    const turnActive =
      managed.status === 'running' ||
      managed.currentTurnId !== undefined ||
      managed.session.isStreaming ||
      managed.session.isRetrying;
    if (
      !turnActive ||
      managed.childIdentity ||
      managed.parentId ||
      managed.toolStartAt.size > 0 ||
      this.bgTasks.runningYielded(managed.identity.sessionId).length > 0
    )
      return;
    managed.restartAbortedTurnId = managed.currentTurnId ?? randomUUID();
  }

  private async settleYieldedTasks(limitMs: number): Promise<void> {
    const deadline = Date.now() + limitMs;
    const running = () =>
      [...this.sessions.keys()].some((id) => this.bgTasks.runningYielded(id).length > 0);
    while (running() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    this.checkRestart();
  }

  private getRuntime(): Promise<ModelRuntime> {
    // 共享 ModelRuntime（M0 验证项 2 已实测双会话共享可行）
    this.runtimePromise ??= (async () => {
      const runtime = await ModelRuntime.create({
        authPath: path.join(this.options.agentDir, 'auth.json'),
        modelsPath: null,
        refreshOnCreate: false,
      });
      await initializeWorkerRuntime(runtime);
      installPrivacyMasking(runtime, (report, model) =>
        this.options.emit({
          type: 'privacy-mask-ledger',
          record: {
            at: Date.now(),
            provider: model.provider,
            model: model.id,
            source: 'aux',
            report,
          },
        })
      );
      installOauthPoolSelector(runtime, this.selectOauthPool);
      installStreamGuard(runtime);
      installStableToolOrder(runtime);
      installLongCacheRetention(runtime, this.isLongCacheRetention);
      return runtime;
    })();
    return this.runtimePromise;
  }

  /**
   * goal_complete 的独立核验：用会话当前模型、无工具，只凭本 goal 的对话尾部判断。
   * 返回驳回理由；找不到 goal、核验失败或超时时放行（不比没有核验更糟），用户中断则中断工具。
   */
  private async verifyGoalCompletion(
    managed: ManagedSession,
    summary: string,
    signal: AbortSignal | undefined
  ): Promise<string | undefined> {
    const model = managed.session.model;
    const request = buildGoalVerifierRequest({
      messages: managed.session.messages as unknown as Parameters<
        typeof buildGoalVerifierRequest
      >[0]['messages'],
      summary,
    });
    if (!model || !request) return undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GOAL_VERIFIER_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const runtime = await this.getRuntime();
      const message = await runtime.completeSimple(
        model,
        {
          systemPrompt: GOAL_VERIFIER_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: request, timestamp: Date.now() }],
        },
        { signal: controller.signal }
      );
      const raw = Array.isArray(message.content)
        ? message.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
        : '';
      const verdict = parseGoalVerdict(raw);
      return verdict?.decision === 'reject'
        ? verdict.reason || 'The transcript does not prove the goal is complete.'
        : undefined;
    } catch (error) {
      if (signal?.aborted) throw error;
      return undefined;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async reviewApproval(
    info: import('@shared/types/agent').ApprovalRequestInfo,
    signal: AbortSignal | undefined
  ): Promise<ApprovalReviewResult> {
    const source = this.approvalReviewer;
    if (!source) {
      return { decision: 'ask_user', rationale: 'No approval reviewer model is configured.' };
    }
    if ('classifier' in source) {
      return this.classifyApproval(source, info, signal);
    }
    const reviewer = source.model;
    const actionHash = computeApprovalActionHash({
      version: 1,
      kind: 'enso_tool_permission_review',
      tool: info.tool,
      approvalKind: info.kind,
      summary: info.summary,
    });
    const runtime = await this.getRuntime();
    const model = await resolveBaseModelOrRefresh(runtime, reviewer);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), APPROVAL_REVIEW_TIMEOUT_MS);
    const onParentAbort = () => controller.abort();
    signal?.addEventListener('abort', onParentAbort, { once: true });
    try {
      if (signal?.aborted) {
        const error = new Error('Aborted');
        error.name = 'AbortError';
        throw error;
      }
      const recentMessages = recentReviewMessages(
        [...this.sessions.values()].find((session) =>
          session.gate.snapshot().some((item) => item.requestId === info.requestId)
        )?.messages ?? []
      );
      const message = await runtime.completeSimple(
        model,
        {
          systemPrompt: buildApprovalReviewSystemPrompt(),
          messages: [
            {
              role: 'user',
              content: buildApprovalReviewUserPrompt({
                actionHash,
                tool: info.tool,
                kind: info.kind,
                summary: info.summary,
                recentMessages,
              }),
              timestamp: Date.now(),
            },
          ],
        },
        { signal: controller.signal }
      );
      const raw = Array.isArray((message as { content?: unknown }).content)
        ? ((message as { content: Array<{ type?: string; text?: string }> }).content ?? [])
            .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
            .join('')
        : '';
      return normalizeReviewDecision(raw, actionHash);
    } catch {
      return { decision: 'ask_user', rationale: 'Auto-review failed.' };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onParentAbort);
    }
  }

  /**
   * 分类器代审：只问三选一；超时、出错、缺概率都交人工。结果由 gate 按 requestId 闭包绑定。
   * 托管：allow 达阈值放行，其余只拒这一条并交回模型；判定无效时退回人工并标明原因。
   */
  private async classifyApproval(
    source: Extract<ApprovalReviewerSource, { classifier: unknown }>,
    info: import('@shared/types/agent').ApprovalRequestInfo,
    signal: AbortSignal | undefined
  ): Promise<ApprovalReviewResult> {
    const { classifier: credentials, allowThreshold } = source;
    const managed = source.managed === true;
    const timeout = AbortSignal.timeout(APPROVAL_REVIEW_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const runtime = await this.getRuntime();
      const model = resolveClassifierModel(runtime, credentials);
      const recentMessages = recentReviewMessages(
        [...this.sessions.values()].find((session) =>
          session.gate.snapshot().some((item) => item.requestId === info.requestId)
        )?.messages ?? []
      );
      const result = await runWithProviderProxy(credentials.proxy, () =>
        runtime.classify(
          model,
          buildApprovalClassifierRequest(
            { tool: info.tool, kind: info.kind, summary: info.summary, recentMessages },
            { managed }
          ),
          { signal: combined, ...(credentials.apiKey ? { apiKey: credentials.apiKey } : {}) }
        )
      );
      if (result.stopReason !== 'stop') {
        return {
          decision: 'ask_user',
          rationale: 'Auto-review failed.',
          ...(managed ? { fallback: timeout.aborted ? 'timeout' : 'error' } : {}),
        };
      }
      return managed
        ? decideManagedApproval(result.answers, credentials.modelId, allowThreshold)
        : decideFromApprovalClassifier(result.answers.decision, allowThreshold);
    } catch {
      return {
        decision: 'ask_user',
        rationale: 'Auto-review failed.',
        ...(managed ? { fallback: timeout.aborted ? 'timeout' : 'error' } : {}),
      };
    }
  }

  /**
   * 通用一次性文本补全（记忆蒸馏 / btw）：与 summarizeTitle 同样的候选链，但不对输出做形状判定，
   * 原文回 Main 由调用方容错解析。每个候选共用同一上限超时。
   * stream 时走 streamSimple 并推 text-delta；记忆蒸馏不设 stream，行为不变。
   */
  private async completeText(
    command: Extract<AgentCommand, { type: 'complete-text' }>
  ): Promise<void> {
    if (this.completeTextPendingAborts.delete(command.requestId)) {
      this.options.emit({ type: 'text-failed', requestId: command.requestId, error: 'aborted' });
      return;
    }
    const userAbort = new AbortController();
    this.completeTextAborts.set(command.requestId, userAbort);
    try {
      const runtime = await this.getRuntime();
      const context = {
        systemPrompt: command.systemPrompt,
        messages: [{ role: 'user' as const, content: command.userText, timestamp: Date.now() }],
      };
      let lastError = 'no candidates';
      let streamed = false;
      for (const candidate of command.candidates) {
        if (userAbort.signal.aborted) break;
        if (command.stream && streamed) {
          this.options.emit({ type: 'text-delta', requestId: command.requestId, text: '' });
          streamed = false;
        }
        const label = describeTitleModel(candidate);
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        userAbort.signal.addEventListener('abort', onAbort);
        const timer = setTimeout(() => controller.abort(), command.timeoutMs);
        try {
          const model = await resolveBaseModelOrRefresh(runtime, candidate);
          // 没显式给档位（或给的是 off）时按模型推理配置补：off 会让强制推理的模型断流
          const requested = command.reasoning;
          const reasoning =
            requested && requested !== 'off' ? requested : auxiliaryReasoning(candidate);
          const options = {
            signal: controller.signal,
            ...(command.maxTokens !== undefined ? { maxTokens: command.maxTokens } : {}),
            ...(reasoning ? { reasoning } : {}),
          };
          const message = command.stream
            ? await this.readSimpleStream(
                runtime,
                model,
                context,
                options,
                command.requestId,
                () => {
                  streamed = true;
                }
              )
            : await runtime.completeSimple(model, context, options);
          if (message.stopReason === 'aborted') {
            if (userAbort.signal.aborted) break;
            lastError = `${label}: timed out after ${Math.round(command.timeoutMs / 1000)}s`;
            continue;
          }
          if (message.stopReason === 'error') {
            lastError = `${label}: ${message.errorMessage?.trim() || 'model error'}`;
            continue;
          }
          const text = message.content
            .map((part) => (part.type === 'text' ? part.text : ''))
            .join('');
          if (!text.trim()) {
            // 连通性探测只判「模型是否响应」：输出预算被思维链用尽（length）或只回了思考内容，
            // 都说明模型与配置是通的；判成不可用会连带把这条投递整轮拦下。
            if (command.probe) {
              this.options.emit({ type: 'text-completed', requestId: command.requestId, text });
              return;
            }
            lastError = `${label}: empty completion`;
            continue;
          }
          this.options.emit({ type: 'text-completed', requestId: command.requestId, text });
          return;
        } catch (error) {
          lastError = `${label}: ${toErrorMessage(error)}`;
        } finally {
          userAbort.signal.removeEventListener('abort', onAbort);
          clearTimeout(timer);
        }
      }
      if (userAbort.signal.aborted) {
        this.options.emit({ type: 'text-failed', requestId: command.requestId, error: 'aborted' });
        return;
      }
      this.options.emit({ type: 'text-failed', requestId: command.requestId, error: lastError });
    } finally {
      this.completeTextAborts.delete(command.requestId);
      this.completeTextPendingAborts.delete(command.requestId);
    }
  }

  /** 一次性 pi 分类器 choice 问题（群聊智能选人）：只回概率，选人与阈值由 Main 决定 */
  private async classifyChoice(
    command: Extract<AgentCommand, { type: 'classify-choice' }>
  ): Promise<void> {
    const { requestId } = command;
    if (this.classifyPendingAborts.delete(requestId)) {
      this.options.emit({ type: 'choice-failed', requestId, error: 'aborted' });
      return;
    }
    const userAbort = new AbortController();
    this.classifyAborts.set(requestId, userAbort);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), command.timeoutMs);
    const fail = (error: string) =>
      this.options.emit({
        type: 'choice-failed',
        requestId,
        error: userAbort.signal.aborted
          ? 'aborted'
          : timeout.signal.aborted
            ? `timed out after ${command.timeoutMs}ms`
            : error,
      });
    try {
      const runtime = await this.getRuntime();
      const model = resolveClassifierModel(runtime, command.classifier);
      const result = await runWithProviderProxy(command.classifier.proxy, () =>
        runtime.classify(
          model,
          {
            state: command.state as never,
            questions: {
              choice: {
                type: 'choice',
                instructions: command.instructions,
                criteria: command.criteria,
              },
            },
          },
          {
            signal: AbortSignal.any([userAbort.signal, timeout.signal]),
            ...(command.classifier.apiKey ? { apiKey: command.classifier.apiKey } : {}),
          }
        )
      );
      const answer = result.answers.choice;
      if (result.stopReason !== 'stop' || answer?.type !== 'choice') {
        fail(result.errorMessage?.trim() || `classifier ${result.stopReason}`);
        return;
      }
      this.options.emit({
        type: 'choice-classified',
        requestId,
        probabilities: Object.fromEntries(
          Object.entries(answer.probabilities).filter(
            (entry): entry is [string, number] =>
              typeof entry[1] === 'number' && Number.isFinite(entry[1])
          )
        ),
      });
    } catch (error) {
      fail(toErrorMessage(error) || 'classify failed');
    } finally {
      clearTimeout(timer);
      this.classifyAborts.delete(requestId);
      this.classifyPendingAborts.delete(requestId);
    }
  }

  private async readSimpleStream(
    runtime: ModelRuntime,
    model: Awaited<ReturnType<typeof resolveBaseModelOrRefresh>>,
    context: {
      systemPrompt: string;
      messages: Array<{ role: 'user'; content: string; timestamp: number }>;
    },
    options: { signal: AbortSignal; maxTokens?: number; reasoning?: ThinkingLevel },
    requestId: string,
    markStreamed: () => void
  ) {
    const stream = runtime.streamSimple(model, context, options);
    for await (const event of stream) {
      if (options.signal.aborted) break;
      if (!event || typeof event !== 'object') continue;
      const type = (event as { type?: unknown }).type;
      if (
        type !== 'text_delta' &&
        type !== 'thinking_delta' &&
        type !== 'text_start' &&
        type !== 'thinking_start' &&
        type !== 'text_end' &&
        type !== 'thinking_end'
      ) {
        continue;
      }
      const live = liveCompletionText((event as { partial?: unknown }).partial);
      markStreamed();
      this.options.emit({
        type: 'text-delta',
        requestId,
        text: live.text,
        ...(live.thinking ? { thinking: live.thinking } : {}),
      });
    }
    return stream.result();
  }

  /**
   * 会话标题总结：一次性补全，不建 AgentSession、不落盘。按 candidates 依次尝试（超时 60/120/180s 递增），
   * 任一候选产出合法标题即回 title-generated 并停止；全部失败回 title-failed，error 为最后一次失败原因。
   * 同一模型不重试：真机实测“模型不听 prompt”重试三次结果一样，换模型才有效。
   */
  private async summarizeTitle(
    command: Extract<AgentCommand, { type: 'summarize-title' }>
  ): Promise<void> {
    const runtime = await this.getRuntime();
    const rolling = command.input.kind === 'rolling';
    const context = {
      systemPrompt: rolling ? ROLLING_TITLE_SYSTEM_PROMPT : TITLE_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user' as const,
          content:
            command.input.kind === 'rolling'
              ? buildRollingTitleUserText(command.input)
              : buildInitialTitleUserText(command.input.text),
          timestamp: Date.now(),
        },
      ],
    };
    let lastError = 'no candidates';
    for (const [index, candidate] of command.candidates.entries()) {
      const label = describeTitleModel(candidate);
      const timeoutMs = titleSummaryTimeoutMs(index);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const model = await resolveBaseModelOrRefresh(runtime, candidate);
        const reasoning = auxiliaryReasoning(candidate);
        const message = await runtime.completeSimple(model, context, {
          signal: controller.signal,
          ...(reasoning ? { reasoning } : {}),
        });
        if (message.stopReason === 'aborted') {
          lastError = `${label}: timed out after ${Math.round(timeoutMs / 1000)}s`;
          continue;
        }
        if (message.stopReason === 'error') {
          lastError = `${label}: ${message.errorMessage?.trim() || 'model error'}`;
          continue;
        }
        const title = extractTitle(message);
        const reject = titleRejectReason(title);
        if (reject) {
          lastError = `${label}: ${reject}`;
          continue;
        }
        this.options.emit({
          type: 'title-generated',
          conversationId: command.conversationId,
          title,
        });
        return;
      } catch (error) {
        lastError = `${label}: ${toErrorMessage(error)}`;
      } finally {
        clearTimeout(timer);
      }
    }
    this.options.emit({
      type: 'title-failed',
      conversationId: command.conversationId,
      error: lastError,
    });
  }
}

/** 投影 idle 但 pi 仍 streaming 时，等它真正空闲的上限；超时视为僵尸轮 */
const ZOMBIE_TURN_WAIT_MS = 5_000;
/** 子代理 Run 等自己后台任务的时限，从第一次持有起算 */
export const AGENT_RUN_HOLD_LIMIT_MS = 10 * 60_000;
/** 流式增量下发间隔：约 20 帧/秒，肉眼连贯，长回复的 IPC 与 markdown 重算降一个量级 */
const STREAM_UPSERT_WINDOW_MS = 50;
/** 重启等安全点时回复在写：出 token 时刻按这个粒度重报给 Main（空闲阈值 20s，误差可忽略） */
const RESTART_PROGRESS_REPORT_MS = 1_000;
/** 重启时取消只剩等人回答的提问：告诉模型是重启打断的，不是用户拒绝 */
const RESTART_ASK_CANCELLED =
  'The app restarted before the user answered this question. Ask again if you still need the answer.';
/** 重启收尾中止回复后等它落进会话文件的上限：加上等转后台命令的 1s 仍在 Main 终止 worker 的 3s 内 */
const RESTART_ABORT_SETTLE_MS = 1_500;

/** 会话停在被中止的回复上（重启收尾中止模型请求后 pi 写下的 stopReason=aborted） */
function endsWithAbortedReply(messages: readonly unknown[]): boolean {
  const last = messages.at(-1) as { role?: unknown; stopReason?: unknown } | undefined;
  return last?.role === 'assistant' && last.stopReason === 'aborted';
}

/** 限时等 pi 空闲；true = 已空闲，false = 超时仍在跑 */
export function waitIdleBounded(
  session: Pick<AgentSession, 'waitForIdle'>,
  ms: number
): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    session.waitForIdle().then(done, done);
  });
}

/**
 * 等 pi 可以起新轮；false = 僵尸轮超时。压缩不计入僵尸时限。记忆扩展在 agent_settled 后
 * 下一个宏任务才启动压缩，等过之后须让一拍再复查，否则新轮先起、随即被压缩的 abort 打断。
 * stillLive：本窗超时后轮次仍在产出（或投影已是 running）。静默挂死才算僵尸。
 */
export async function waitPromptable(
  session: Pick<AgentSession, 'waitForIdle' | 'isStreaming' | 'isCompacting'>,
  zombieMs: number,
  stillLive?: () => boolean
): Promise<boolean> {
  let waited = false;
  for (;;) {
    if (session.isCompacting) {
      await session.waitForIdle();
    } else if (session.isStreaming) {
      const idle = await waitIdleBounded(session, zombieMs);
      // 计时器可能先于空闲回调；已经不在流式就继续复查，不能当成僵尸失败。
      if (!idle && session.isStreaming && !session.isCompacting && !stillLive?.()) return false;
    } else if (waited) {
      waited = false;
      await new Promise((resolve) => setTimeout(resolve, 0));
      continue;
    } else {
      return true;
    }
    waited = true;
  }
}
/** 异步通知里的摘要上限;全文经 coworker report 取 */
const NOTIFY_SUMMARY_LIMIT = 1500;
/** 一轮结束回父的摘要尾句：阻塞/非阻塞两条路径共用，按验收结果决定是否继续 */
const COWORKER_FOLLOW_UP_HINT =
  '(assess the report against the goal; send only for a concrete gap or needed follow-up; if the goal is met, dismiss the coworker and finish)';

/** gate 验收:在会话 cwd 跑命令,退出码即结论(比再叫一个模型评审便宜且诚实)。
 * 远程会话传 executor,命令改在远端 cwd 执行 */
export function runGateCommand(cwd: string, gate: string, executor?: SshExecutor): Promise<string> {
  if (executor) {
    return executor.exec(gate, { cwd, timeoutMs: 300_000 }).then((result) => {
      if (result.code === 0) return `GATE PASSED: \`${gate}\``;
      const tail = `${result.stdout}\n${result.stderr}`.trim().slice(-1500);
      return `GATE FAILED \`${gate}\` (${result.code ?? 'timeout'}):\n${tail}`;
    });
  }
  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      ['-c', gate],
      { cwd, timeout: 300_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(`GATE PASSED: \`${gate}\``);
          return;
        }
        const tail = `${stdout}\n${stderr}`.trim().slice(-1500);
        resolve(`GATE FAILED \`${gate}\` (${error.code ?? 'timeout'}):\n${tail}`);
      }
    );
  });
}

/** 回退回填输入框：去掉 Plan 提示前缀；批准消息不回填，修改意见只回填意见原文 */
function planFreeEditorText(text: string): string {
  const rest = splitTurnNotes(text).rest;
  const message = parsePlanMessage(rest);
  return message ? (message.kind === 'feedback' ? message.feedback : '') : rest;
}

/** Plan / 无人值守状态变化后的一次性提示，随下一条进入模型的用户消息前置 */
function withPendingPlanNote(
  managed: { plan?: PlanController; unattendedNote?: string },
  text: string
): string {
  text = consumeUnattendedNote(managed, text);
  const note = managed.plan?.takeNote();
  return note ? prependTurnNote(note, text) : text;
}

/** coworker 首条消息前缀注入角色提示,消费一次 */
function consumeRole(managed: { pendingRole?: string }, text: string): string {
  if (!managed.pendingRole) return text;
  const role = managed.pendingRole;
  managed.pendingRole = undefined;
  return `<role>\n${role}\n</role>\n\n${text}`;
}

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** 一次 prompt 投递的去向：pi 是否受理（回调过 disposition）、是否只是排进活轮 */
interface PromptDeliveryState {
  dispatched: boolean;
  queued: boolean;
}

/** pi 在活轮里拒收不带 streamingBehavior 的 prompt：会话仍在跑，不是失败 */
function isAlreadyProcessing(message: string): boolean {
  return message.includes('Agent is already processing');
}

/** 记录里仍在 pi 队列中的那些。pi 从队首取，同文本从队尾往前对账 */
function stillQueued<T extends { text: string }>(
  entries: readonly T[],
  labels: readonly string[]
): T[] {
  const left = [...labels];
  const kept: T[] = [];
  for (const entry of [...entries].reverse()) {
    const index = left.lastIndexOf(entry.text);
    if (index < 0) continue;
    left.splice(index, 1);
    kept.unshift(entry);
  }
  return kept;
}

/** 回复里的可见正文，不含 thinking 与工具调用 */
/** 会话最近一次请求还对得上当前模型时才能分叉；换过模型就前缀不同，退回快照 */
function forkBaseOf(parent: ManagedSession): ForkBase | undefined {
  const base = parent.forkBase;
  const model = parent.session.model;
  if (!base || model?.id !== base.selection.id || model.provider !== base.selection.provider)
    return;
  return base;
}

/**
 * 从会话最近一次请求分叉：系统提示、工具声明、消息原样照搬，请求选项也照搬，
 * 这样第一轮就是会话请求的前缀续写，能读到会话的提示缓存。
 * 只有 read/grep/find/ls（及只读 codemode）真正可执行，用只读子会话的实现；其余工具保留声明、调用时拒绝。
 */
function forkAgent(
  base: ForkBase,
  child: AgentSession,
  thinkingLevel: Agent['state']['thinkingLevel']
): Agent & { runnable: Set<string> } {
  const allowed = forkRunnable(child);
  const runnable = new Map(
    child.agent.state.tools.filter((tool) => allowed.has(tool.name)).map((t) => [t.name, t])
  );
  const tools: AgentTool[] = getCurrentTools(base.messages).map((decl) => {
    const impl = runnable.get(decl.name);
    return {
      ...decl,
      label: impl?.label ?? decl.name,
      ...(impl?.prepareArguments ? { prepareArguments: impl.prepareArguments } : {}),
      execute: impl
        ? impl.execute.bind(impl)
        : async () => {
            throw new Error(`只读分叉里不能用 ${decl.name}`);
          },
    };
  });
  const reply = base.reply;
  const settled =
    reply?.stopReason === 'stop' && !reply.content.some((part) => part.type === 'toolCall');
  const agent = new Agent({
    initialState: {
      model: base.model,
      thinkingLevel,
      tools,
      messages: settled ? [...base.messages, reply] : [...base.messages],
    },
    streamFn: (_model, context, options) =>
      base.stream(base.model, context, { ...base.options, signal: options?.signal }),
    ...(base.options?.sessionId ? { sessionId: base.options.sessionId } : {}),
    beforeToolCall: async ({ toolCall, assistantMessage, args }) => {
      if (!runnable.has(toolCall.name))
        return {
          block: true,
          reason: `只读分叉里不能用 ${toolCall.name}，只能用 ${[...runnable.keys()].join(' / ')}`,
        };
      if (toolCall.name !== CODEMODE_TOOL_NAME) return undefined;
      // 直接执行绕过了子会话的 tool_call 钩子，这里补上同样的预检；
      // 嵌套调用走子会话的工具管线，要能从子会话里找到发起这次调用的回复
      const blocked = prepareCodemodeInput(args as Record<string, unknown>);
      if (blocked) return blocked;
      child.agent.state.messages = [...child.agent.state.messages, assistantMessage];
      return undefined;
    },
  });
  return Object.assign(agent, { runnable: new Set(runnable.keys()) });
}

/** 子会话能真正执行的只读工具；codemode 只在脚本里能调的也全是只读工具时放行（脚本禁用的工具不算） */
export function forkRunnable(
  child: Pick<AgentSession, 'agent' | 'getCallableToolNames'>
): Set<string> {
  const names = new Set(child.agent.state.tools.map((tool) => tool.name));
  const allowed = new Set([...FORK_TOOLS].filter((name) => names.has(name)));
  if (
    names.has(CODEMODE_TOOL_NAME) &&
    child
      .getCallableToolNames()
      .every((name) => FORK_TOOLS.has(name) || CODEMODE_FORBIDDEN_TOOLS.has(name))
  )
    allowed.add(CODEMODE_TOOL_NAME);
  return allowed;
}

function pluginAgentText(message: { content?: unknown }): string {
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        typeof part === 'object' && part !== null && part.type === 'text'
    )
    .map((part) => part.text)
    .join('')
    .trim();
}

/** 工具结果的文本部分，截到上限；图片等非文本部分忽略 */
function pluginAgentToolOutput(result: unknown): string {
  const text =
    typeof result === 'string'
      ? result
      : result && typeof result === 'object'
        ? pluginAgentText(result as { content?: unknown })
        : '';
  return text.length > PLUGIN_AGENT_OUTPUT_MAX_CHARS
    ? `${text.slice(0, PLUGIN_AGENT_OUTPUT_MAX_CHARS - 1)}…`
    : text;
}

function liveCompletionText(partial: unknown): { text: string; thinking: string } {
  if (!partial || typeof partial !== 'object') return { text: '', thinking: '' };
  const content = (partial as { content?: unknown }).content;
  if (!Array.isArray(content)) return { text: '', thinking: '' };
  let text = '';
  let thinking = '';
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const type = (part as { type?: unknown }).type;
    const value = (part as { text?: unknown }).text;
    const piece = typeof value === 'string' ? value : '';
    if (type === 'text') text += piece;
    else if (type === 'thinking') thinking += piece;
  }
  return { text, thinking };
}

/**
 * worker 的 ModelRuntime 按进程常驻，订阅清单只在首次建 runtime 时联网拉一次。之后用户
 * 才登录 / 后端上新（如 `gemini-3.8-flash-tiered` 这种不在兜底表里的 wire id），Main 侧
 * 已能选到，worker 这边仍是旧清单 → 未命中时对基础 provider 补一次联网刷新再重试。
 */
export async function resolveBaseModelOrRefresh(runtime: ModelRuntime, model: SpawnModelConfig) {
  let resolved: ReturnType<typeof resolveBaseModel>;
  try {
    resolved = resolveBaseModel(runtime, model);
  } catch (error) {
    if (!model.oauthAccountKey) throw error;
    // Cursor 无 force 只踢后台任务并立刻返回兜底清单（没有 claude-fable-5-1 这类新 id）
    await refreshWorkerProviderModels(runtime, providerIdOfAccountKey(model.oauthAccountKey), {
      force: true,
    });
    resolved = resolveBaseModel(runtime, model);
  }
  return resolved;
}

/** 会话主模型：虚拟配置先逐成员解析并注册 pi 虚拟模型，其余同 resolveBaseModelOrRefresh。 */
export async function resolveSessionModel(runtime: ModelRuntime, model: SpawnModelConfig) {
  if (!model.virtual) return resolveBaseModelOrRefresh(runtime, model);
  const classifier = model.virtual.classifier;
  const judge =
    classifier?.source === 'judge' && classifier.model
      ? await resolveBaseModelOrRefresh(runtime, classifier.model).catch((error) => {
          console.warn('[virtual-model] judge model unavailable:', error);
          return undefined;
        })
      : undefined;
  const chooser = classifier ? createVirtualChooser(runtime, classifier, judge) : undefined;
  const registration = await registerVirtualModel(
    runtime,
    model,
    (member) => resolveBaseModelOrRefresh(runtime, member),
    chooser,
    supportsAdaptiveThinking
  );
  return registration.model;
}

/** 上下文上限按最近一次实际响应的模型；虚拟模型首个响应前用其声明的上限。 */
function limitsModelOf(session: AgentSession) {
  return session.routedModel?.model ?? session.model;
}

type CatalogModel = ReturnType<ModelRuntime['getModels']>[number];

/**
 * 按同厂模板克隆的订阅模型（pi 目录没有）补进所在 provider 的目录：会话直连拿模型对象就能流，
 * 但虚拟模型路由按目录重新取成员，查不到会被当成不可路由而静默丢弃。
 */
function listCatalogClone(runtime: ModelRuntime, model: CatalogModel): CatalogModel {
  const listed = runtime.getModel(model.provider, model.id);
  if (listed) return listed;
  const base = runtime.getProvider(model.provider);
  if (!base) return model;
  const withClone = <T extends { id: string }>(models: readonly T[]): T[] =>
    models.some((entry) => entry.id === model.id) ? [...models] : [...models, model as never];
  runtime.registerNativeProvider(
    Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
      getModels: () => withClone(base.getModels()),
      getAllModels: () => withClone(base.getAllModels?.() ?? base.getModels()),
    })
  );
  return runtime.getModel(model.provider, model.id) ?? model;
}

/**
 * 解析 spawn 模型：oauth 直取 pi 内置 catalog（凭证由 runtime 从共享 auth.json 解析，
 * 不注册自定义 provider、不覆盖 UA、不读行覆盖——订阅端点保持 pi 原生标识）；
 * apiKey 注册自定义 provider：行覆盖 > 精确 catalog id > 乐观默认。
 */
export function resolveBaseModel(runtime: ModelRuntime, model: SpawnModelConfig) {
  if (model.virtual) throw new Error('virtual model config must go through resolveSessionModel');
  if (model.api === 'typesafe-system-one' || isClassifierOnlyProvider(model))
    throw new Error('This provider is for classification only, not chat.');
  if (model.oauthAccountPool !== undefined && !isOauthAccountPool(model))
    throw new Error('Invalid ChatGPT OAuth pool configuration.');
  if (isOauthAccountPool(model)) return resolveOauthPoolModel(runtime, model);
  if (model.oauthAccountKey) {
    // worker 与 Main 是两个 ModelRuntime 实例，只共用 auth.json。合成 id（第 2+ 个账号）
    // 的克隆 provider 必须在本进程也注册一遍，否则 getModel 取不到
    ensureAccountProvider(runtime, model.oauthAccountKey);
    const providerId = providerIdOfAccountKey(model.oauthAccountKey);
    const devModels = modelsDevModelsFromEnv();
    const exact = runtime.getModel(model.oauthAccountKey, model.modelId);
    const oauthModel =
      exact ??
      resolveOauthCatalogModel(
        providerId,
        model.modelId,
        runtime.getModels(model.oauthAccountKey),
        undefined
      ) ??
      cloneModelsDevOauthModel(
        providerId,
        model.modelId,
        runtime.getModels(model.oauthAccountKey),
        devModels
      );
    if (!oauthModel) {
      throw new Error(`oauth model not found: ${model.oauthAccountKey}/${model.modelId}`);
    }
    const registered = exact ?? listCatalogClone(runtime, oauthModel);
    const dev = findModelsDevModel(devModels, model.modelId, providerId);
    if (dev) {
      try {
        if (dev.contextWindow) registered.contextWindow = dev.contextWindow;
        if (dev.maxTokens) registered.maxTokens = dev.maxTokens;
      } catch {
        // 冻结的 catalog 对象保持原窗口
      }
    }
    const provider = runtime.getProvider(registered.provider);
    if (!provider) throw new Error(`oauth provider not found: ${registered.provider}`);
    runtime.registerNativeProvider(withRequestBodyBudget(provider));
    return registered;
  }
  const providerId = providerKeyFor(model);
  const entry: ModelEntry = { id: model.modelId };
  if (model.reasoning !== undefined) entry.reasoning = model.reasoning;
  if (model.thinkingLevel !== undefined) entry.thinkingLevel = model.thinkingLevel;
  if (model.contextWindow !== undefined) entry.contextWindow = model.contextWindow;
  if (model.maxTokens !== undefined) entry.maxTokens = model.maxTokens;
  // registerProvider 整体替换 models：同一端点+key 的多个模型要累积，否则虚拟模型的同 provider
  // 成员会互相挤出目录（pi 路由时按目录重新取模型）。同 id 仍覆盖，保持 spawn 重解析。
  registerCustomProviderModels(
    runtime,
    {
      api: model.api,
      baseUrl: model.baseUrl,
      apiKey: model.apiKey,
      ...(model.headers ? { headers: model.headers } : {}),
      ...(model.proxy ? { proxy: model.proxy } : {}),
    },
    [entry]
  );
  const registered = runtime.getModel(providerId, model.modelId);
  if (!registered) throw new Error(`model not found after register: ${model.modelId}`);
  return registered;
}

/**
 * adaptive thinking（output_config.effort）的判定：乐观默认支持——未来新模型都支持，
 * 白名单会过时而这个黑名单是封闭集合（不支持的只有历史老世代，不会再新增）。
 * 漏网的靠运行时自愈：撞到 "adaptive thinking is not supported" 会记入 runtimeAdaptiveBlocklist
 * 并自动降级重试（见 tryAdaptiveDowngrade）。
 */
const ADAPTIVE_UNSUPPORTED = /claude-(3|opus-4-[0-6]|sonnet-4-[0-6]|haiku-4-[0-6])/i;
/** 运行时学到的不支持 adaptive 的模型（进程内记忆） */
const runtimeAdaptiveBlocklist = new Set<string>();

export function supportsAdaptiveThinking(modelId: string): boolean {
  return !ADAPTIVE_UNSUPPORTED.test(modelId) && !runtimeAdaptiveBlocklist.has(modelId);
}

function occupancyFromManaged(
  managed: ManagedSession,
  contextWindow: number | undefined,
  estimateMessageTokens?: (message: unknown) => number
): ReturnType<typeof collectContextOccupancy> {
  const loader = managed.session.resourceLoader as {
    getAgentsFiles?: () => { agentsFiles?: ReadonlyArray<{ path: string; content: string }> };
    getSkills?: () => { skills?: OccupancySkill[] };
  };
  const sessionManager = managed.session.sessionManager as {
    buildSessionContext?: () => { messages?: unknown[] };
    getBranch?: () => OccupancyBranchEntry[];
  };
  const branch = sessionManager.getBranch?.() ?? [];
  return collectContextOccupancy({
    systemPrompt: managed.session.systemPrompt ?? '',
    agentsFiles: loader.getAgentsFiles?.().agentsFiles ?? [],
    skills: loader.getSkills?.().skills ?? [],
    tools: typeof managed.session.getAllTools === 'function' ? managed.session.getAllTools() : [],
    contextMessages: sessionManager.buildSessionContext?.().messages ?? [],
    branch,
    currentModelFamily: modelFamilyOf(limitsModelOf(managed.session)?.id ?? managed.modelId),
    compactionModelFamily: compactionModelFamilyOf(branch),
    contextWindow,
    pendingTaskReminders: managed.pendingTaskReminders,
    estimateMessageTokens: estimateMessageTokens ?? estimateConversationTokens,
  });
}

function compactionModelFamilyOf(
  branch: ReadonlyArray<{ type: string; modelId?: string; provider?: string }>
): string | undefined {
  let lastModel: string | undefined;
  for (const entry of branch) {
    // 虚拟模型的选择记录是条目 id，无法对应模型族：视为未知
    if (entry.type === 'model_change' && typeof entry.modelId === 'string')
      lastModel = entry.provider === VIRTUAL_PROVIDER_ID ? undefined : entry.modelId;
    if (entry.type === 'compaction') return lastModel ? modelFamilyOf(lastModel) : undefined;
  }
  return undefined;
}

function modelFamilyOf(modelId: string): string {
  const id = modelId.toLowerCase();
  if (id.includes('claude')) return 'claude';
  if (id.includes('gpt') || id.includes('o1') || id.includes('o3') || id.includes('o4'))
    return 'gpt';
  if (id.includes('gemini')) return 'gemini';
  const vendor = id.split(/[-/_]/)[0];
  return vendor || id;
}

/** 换模型后已有上下文吃掉了新窗口的压缩预留：立即压缩，免得下一轮直接超窗 */
export function shouldCompactAfterModelSwitch(
  usage: { tokens: number | null; contextWindow: number } | undefined,
  settings: { enabled: boolean; reserveTokens: number }
): boolean {
  if (!settings.enabled || !usage || usage.tokens === null) return false;
  return usage.tokens > usage.contextWindow - settings.reserveTokens;
}

/**
 * 按 reasoning 开关就地定制 model：关 → reasoning:false（pi 不发 thinking）；
 * 开 → reasoning:true + adaptive 模型加 forceAdaptiveThinking。返回同一个 model（就地改）。
 */
function applyReasoningToModel<T extends { reasoning?: boolean; compat?: unknown }>(
  model: T,
  enabled: boolean,
  modelId: string
): T {
  model.reasoning = enabled;
  const adaptive = enabled && supportsAdaptiveThinking(modelId);
  const compat = (model.compat ?? {}) as { forceAdaptiveThinking?: boolean };
  compat.forceAdaptiveThinking = adaptive ? true : undefined;
  model.compat = compat;
  return model;
}

/** 从 pi 的资源加载器收集可用斜杠命令：skills（/skill:name）与 prompt templates（/name） */
function collectSlashCommands(session: AgentSession): SlashCommand[] {
  const commands: SlashCommand[] = [];
  try {
    const loader = session.resourceLoader;
    for (const skill of loader.getSkills().skills) {
      commands.push({ name: `/skill:${skill.name}`, description: skill.description });
    }
    for (const prompt of loader.getPrompts().prompts) {
      commands.push({ name: `/${prompt.name}`, description: prompt.description });
    }
  } catch {
    // 资源加载失败不阻塞会话，命令列表为空即可
  }
  return commands;
}

type ApprovalReviewerSource =
  | { model: SpawnModelConfig }
  | {
      classifier: VirtualClassifierCredentials;
      managed?: boolean;
      allowThreshold?: ApprovalAllowThreshold;
    };

function approvalReviewerSource(
  model: SpawnModelConfig | undefined,
  classifier: VirtualClassifierCredentials | undefined,
  managed: boolean | undefined,
  allowThreshold: ApprovalAllowThreshold | undefined
): ApprovalReviewerSource | undefined {
  if (model) return { model };
  if (!classifier) return undefined;
  return {
    classifier,
    ...(managed ? { managed: true } : {}),
    ...(allowThreshold === undefined ? {} : { allowThreshold }),
  };
}
