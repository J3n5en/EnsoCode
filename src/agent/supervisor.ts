import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  type AgentSession,
  createAgentSession,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createSyntheticSourceInfo,
  createWriteToolDefinition,
  DefaultResourceLoader,
  type InlineExtension,
  ModelRuntime,
  type PromptTemplate,
  type ResourceDiagnostic,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import {
  type ChildSessionIdentity,
  ENSO_LOCKED_PROFILE,
  isSameChildSessionIdentity,
  type SessionIdentity,
} from '@shared/builtinAgents';
import { type CompactStrategy, resolveCompactStrategy } from '@shared/compactStrategy';
import { DEFAULT_MAX_ACTIVE_COWORKERS } from '@shared/maxActiveCoworkers';
import {
  findCatalogModelById,
  positiveContextWindow,
  resolveCustomModelCapabilities,
} from '@shared/modelCatalog';
import { resolveOauthCatalogModel } from '@shared/oauthCatalog';
import { ensureAccountProvider } from '@shared/piAccounts';
import {
  EMPTY_PLAN_STATE,
  PLAN_ENTRY_TYPE,
  parsePlanMessage,
  splitPlanPrefix,
  withPlanNote,
} from '@shared/planMode';
import { resolvePiProviderBaseUrl } from '@shared/providerCatalog';
import { ANTIGRAVITY_PROVIDER_ID, antigravityProviderConfig } from '@shared/providers/antigravity';
import { installCodexLinkedRefresh } from '@shared/providers/codexAuth';
import { DEVIN_PROVIDER_ID, devinProviderConfig } from '@shared/providers/devin';
import { computeStats, toUsageTotals } from '@shared/sessionStats';
import type { SmartCompactMode } from '@shared/smartCompactMode';
import { buildSshShellCommand, shellQuote } from '@shared/ssh';
import { DEFAULT_SSH_TIMEOUT_SECONDS } from '@shared/sshTimeout';
import { replacePersonaParagraph } from '@shared/systemPrompt';
import type {
  AgentCommand,
  AgentRemoteConfig,
  AgentSessionCustomEntry,
  AgentTypeSpawnConfig,
  AgentWorkerEvent,
  ApprovalMode,
  ChildConversationMetadata,
  CoworkerInfo,
  McpServerSpawnConfig,
  MessageTiming,
  ModelRef,
  NodeStatus,
  ProjectedMessage,
  ResolvedAgentTypeSpawnConfig,
  SessionSnapshot,
  SlashCommand,
  SpawnModelConfig,
  SubagentModelOption,
  ThinkingLevel,
} from '@shared/types/agent';
import { parseAgentSessionCustomEntry, STALE_SESSION_ERROR } from '@shared/types/agent';
import { type EditMode, resolveEditMode } from '@shared/types/editMode';
import { providerIdOfAccountKey } from '@shared/types/oauthProviders';
import type { PluginCommandSpawn, PluginHookSpawn } from '@shared/types/plugins';
import type { WindowsLocalShell } from '@shared/windowsLocalShell';
import { version } from '../../package.json';
import { AgentControlInvoker } from './agentControl';
import {
  createApplyPatchTool,
  createRemoteApplyPatchIo,
  validateApplyPatchTargets,
} from './applyPatch';
import { applyPatchResultExtension } from './applyPatchResultExtension';
import { ApprovalGate, withApproval } from './approval';
import {
  APPROVAL_REVIEW_TIMEOUT_MS,
  buildApprovalReviewSystemPrompt,
  buildApprovalReviewUserPrompt,
  computeApprovalActionHash,
  normalizeReviewDecision,
  recentReviewMessages,
} from './approvalReview';
import { AskManager, createAskTool } from './ask';
import { ensureAssistantUsage } from './assistantUsage';
import {
  BackgroundTaskManager,
  createTaskTools,
  foregroundCommandTimeoutMs,
  withBackground,
} from './backgroundTasks';
import { CheckpointManager, withCheckpoint } from './checkpoint/manager';
import { createRemoteCheckpointHost } from './checkpoint/remoteHost';
import {
  type ChildThinkingLevel,
  pickChildReasoningOverride,
  resolveChildReasoning,
} from './childReasoning';
import { createClaudeHooksExtension } from './claudeHooks';
import {
  collectContextOccupancy,
  estimateConversationTokens,
  type OccupancyBranchEntry,
  type OccupancySkill,
} from './contextOccupancy';
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
import { attachCursorBridgeToSession, isCursorModel } from './cursor/sessionBridge';
import { resolveCustomModelCompat, selectCatalogEntryForCompat } from './customModelCompat';
import { createNormalizedEditTool } from './editTool';
import { ENSO_SYSTEM_PROMPT } from './ensoPrompt';
import { EnsoSafeJournal } from './ensoSafeJournal';
import { createExploreFoldState, createExploreFoldTools } from './exploreFold';
import { OperationGate } from './gate';
import { createGoalTools } from './goal';
import { readHarnessRuleFiles, resolveHarnessSkillRoots } from './harnessAssets';
import { type ContextMessage, sanitizeContextMessages } from './imageContext';
import { createIsolatedSandboxTool } from './isolatedSandbox';
import { McpManager } from './mcp';
import { createMcpProxyTool, isDeferredMcp } from './mcpProxy';
import { createMessageCoworkerTool } from './messageCoworker';
import { createMessageMainTool } from './messageMain';
import { ParentNotifier } from './notify';
import { withOpenAIResponsesRouting } from './openaiResponsesRouting';
import { createSubmitPlanTool, PlanController, withPlanGate } from './planMode';
import { createProjectSettingsManager } from './projectCode';
import { projectMessage } from './projection';
import { applyWorkerProxyEnv } from './proxyEnv';
import { withReadTruncationMeta } from './readTruncation';
import { projectMessages, projectResumeTail } from './resumeSnapshots';
import { withRtkOptimization } from './rtk';
import { RunawayGuard } from './runawayGuard';
import {
  buildSessionDisplayMessages,
  editLatestAssistantForRetry,
  silentTurnRecoveryExtension,
} from './sessionAdapter';
import {
  EVICTION_SWEEP_INTERVAL_MS,
  type EvictionCandidate,
  selectEvictable,
} from './sessionEviction';
import { branchSessionFromPersistedFile, resolveForkLeafId } from './sessionFork';
import { createSessionCommandTool } from './sessionShell';
import { type SilentTurnKind, silentTurnKind } from './silentTurn';
import { providerKeyFor, smartCompactInlineExtension } from './smartCompact';
import {
  createSshExecutor,
  resolveSshControlPath,
  type SshExecutor,
  sshPasswordEnv,
} from './ssh/executor';
import { rewriteRemoteWorkingDirectoryPrompt } from './ssh/posixPath';
import { createRemoteGrepToolDefinition } from './ssh/remoteGrep';
import { createRemoteOperations } from './ssh/remoteOperations';
import {
  appendYieldJson,
  parseJsonFromAssistant,
  validateAgainstSchema,
  withAgentRead,
} from './structuredYield';
import { CoworkerIdleReminder, createUnifiedSubagentTool, lastAssistantText } from './subagent';
import { SystemReminderRegistry } from './systemReminder';
import {
  buildInitialTitleUserText,
  buildRollingTitleUserText,
  buildTurnDigest,
  describeTitleModel,
  extractTitle,
  ROLLING_TITLE_SYSTEM_PROMPT,
  TITLE_SYSTEM_PROMPT,
  titleRejectReason,
  titleSummaryTimeoutMs,
} from './titleSummary';
import { createTodoTool, TodoStaleReminder } from './todo';
import { decorateSessionTools } from './toolDecorators';
import { ToolOutputBudget } from './toolOutputBudget';
import { BrowserInvoker, createBrowserTools, withNavigateApproval } from './tools/browser';
import { createEnsoAppTool, EnsoAppInvoker } from './tools/ensoApp';
import { createEnsoCapabilitiesTool } from './tools/ensoCapabilities';
import { createMemoryTools, MemoryInvoker } from './tools/memory';
import { createWebTools } from './tools/web';
import { createWorkflowTool, WORKFLOW_STOPPED_BY_USER } from './workflow';
import { listWorkflowPresets, loadWorkflowPreset, workflowPresetRoots } from './workflowPresets';
import { WorkspaceSwitchGate, workspaceBranchContextExtension } from './workspaceSwitch';
import { withWritePreflight, withWriteScope } from './writeScope';

/** 子会话产物：实际 session、模型与精确工具集合。 */
interface ChildSessionResult {
  session: AgentSession;
  modelId: string;
  modelRef: { providerId: string; modelId: string };
  toolIds: string[];
  proofToolIds: string[];
  ensoApp?: EnsoAppInvoker;
  safeJournal?: EnsoSafeJournal;
  runawayGuard?: RunawayGuard;
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
    askManager?: AskManager;
    resumeFile?: string;
    extraTools?: unknown[];
  }): Promise<ChildSessionResult>;
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
  safeJournal?: EnsoSafeJournal;
  currentTurnId?: string;
  /** 上一轮结束时 messages.length：本轮消息从这里开始，供 agent_end 切本轮摘要 */
  turnStartIndex: number;
  promptedRequestIds: Set<string>;
  ensoApp?: EnsoAppInvoker;
  browser?: BrowserInvoker;
  memory?: MemoryInvoker;
  agentControl?: AgentControlInvoker;
  adaptiveDowngraded: boolean;
  /** 最近一次 auto_retry_start 携带的原始错误（取消重试时的终态错误文案） */
  lastRetryError?: string;
  /** 已见终态 agent_end、待 agent_settled 收口；failTurn 等提前收口时清掉，settled 不再重复收 */
  settlePending?: boolean;
  /** 当前用户轮已做过一次空回复自动续跑 */
  silentTurnNudgeUsed: boolean;
  /** 本次空回复恢复的类型；post-tool 第二次仍空则失败 */
  silentTurnKind?: SilentTurnKind;
  runawayGuard?: RunawayGuard;
  timings: (MessageTiming | undefined)[];
  /** 最近一次 turn_start 时刻；pi 在发起每次模型请求前触发，下一条 assistant message_start 消费 */
  requestStartMs?: number;
  toolStartAt: Map<string, number>;
  toolDurations: Map<string, number>;
  /** 流式增量合并窗口：窗口内只记下待发下标，窗口结束或遇到其他事件时发最新正文 */
  upsertTimer?: ReturnType<typeof setTimeout>;
  upsertPending?: number;
  gate: ApprovalGate;
  asks: AskManager;
  pendingTaskReminders: string[];
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
  /** 仅父会话：Plan 模式状态机（设置里关闭时缺省） */
  plan?: PlanController;
  /** 下一条 prompt 产生的 user 消息的投递回执；id 为 null 表示该投递无乐观回显 */
  promptDelivery?: { id: string | null };
  /** 已入 pi steer 队列、尚未上屏的投递回执，与 pi 队列同序 */
  steerDeliveries?: { id: string | null }[];
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
  contextUsage: ContextUsageTracker;
  unsubscribe: () => void;
}

export interface SupervisorOptions {
  emit(event: AgentWorkerEvent): void;
  /** pi 全局目录（auth/models/settings），指到 app userData 下以隔离用户的 ~/.pi */
  agentDir: string;
  /** 会话 jsonl 目录 */
  sessionDir: string;
  /** 设置页新增的工作流预设目录（Main 写入，worker 只读） */
  workflowDir?: string;
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
  /** Claude 插件命令：作为 `/plugin:command` 提示词模板加入 */
  pluginCommands?: readonly PluginCommandSpawn[];
  /** Claude 插件 hooks 及其运行角色 */
  pluginHooks?: {
    hooks: readonly PluginHookSpawn[];
    role: Parameters<typeof createClaudeHooksExtension>[0]['role'];
    resumed?: boolean;
  };
  exploreFold?: ReturnType<typeof createExploreFoldState>;
  /** 仅父会话：互斥压缩策略。 */
  compactStrategy?: CompactStrategy;
  smartCompactSummaryModel?: SpawnModelConfig;
  smartCompactMode?: SmartCompactMode;
  /** 仅普通 parent：替换 pi 默认提示词开头的角色段落。 */
  persona?: string;
}): DefaultResourceLoader {
  const harness = options.loadHarnessAssets && !options.remoteAgentsFiles;
  const skillPaths = harness
    ? [...options.skillPaths, ...resolveHarnessSkillRoots(options.cwd)]
    : options.skillPaths;
  const persona = options.persona;
  const pluginCommands = options.pluginCommands ?? [];
  const pluginHooks = options.pluginHooks;
  return new DefaultResourceLoader({
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
    ...(pluginCommands.length > 0
      ? { promptsOverride: (base) => withPluginPrompts(base, pluginCommands) }
      : {}),
    // noExtensions 只挡磁盘上的项目/全局扩展；inline factory 不受影响，图片修剪对所有会话生效
    extensionFactories: [
      ...(persona
        ? [
            {
              name: 'custom-persona',
              hidden: true,
              factory: (pi) => {
                pi.on('before_agent_start', (event) => ({
                  systemPrompt: replacePersonaParagraph(event.systemPrompt, persona),
                }));
              },
            } satisfies InlineExtension,
          ]
        : []),
      options.branchContext,
      applyPatchResultExtension,
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
      ...(options.exploreFold
        ? [
            {
              name: 'explore-fold',
              hidden: true,
              factory: (pi) => {
                pi.on('context', (event) => ({
                  messages: options.exploreFold!.apply(
                    event.messages as never
                  ) as typeof event.messages,
                }));
              },
            } satisfies InlineExtension,
          ]
        : []),
      ...(options.remoteSsh
        ? [
            {
              name: 'ssh-cwd-prompt',
              hidden: true,
              factory: (pi) => {
                pi.on('before_agent_start', (event) => ({
                  systemPrompt: rewriteRemoteWorkingDirectoryPrompt(
                    event.systemPrompt,
                    options.cwd,
                    options.remoteSsh!.host
                  ),
                }));
              },
            } satisfies InlineExtension,
          ]
        : []),
      ...(!options.noExtensions && options.compactStrategy === 'continuous-memory'
        ? [
            continuousMemoryInlineExtension({
              model: options.smartCompactSummaryModel,
              mode: options.smartCompactMode,
            }),
          ]
        : !options.noExtensions &&
            (options.compactStrategy === 'smart' || options.compactStrategy === 'codex-native')
          ? [
              smartCompactInlineExtension(
                {
                  summaryModel: options.smartCompactSummaryModel,
                  mode: options.smartCompactMode,
                },
                options.compactStrategy === 'codex-native'
              ),
            ]
          : []),
      ...(pluginHooks && pluginHooks.hooks.length > 0
        ? [
            createClaudeHooksExtension({
              hooks: pluginHooks.hooks,
              cwd: options.cwd,
              role: pluginHooks.role,
              resumed: pluginHooks.resumed,
              onNotice: (text) => console.warn(`[claude-hooks] ${text}`),
            }),
          ]
        : []),
      options.silentTurnRecovery,
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
}

/** Enso 不走 pi 的会话切换流程，session_shutdown 要自己发（Claude 插件的 SessionEnd hook 靠它） */
async function emitSessionShutdown(session: AgentSession): Promise<void> {
  try {
    const runner = session.extensionRunner;
    if (runner.hasHandlers('session_shutdown')) {
      await runner.emit({ type: 'session_shutdown', reason: 'quit' });
    }
  } catch {}
}

/** 插件命令追加为提示词模板；与已有模板同名时让位 */
function withPluginPrompts(
  base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] },
  commands: readonly PluginCommandSpawn[]
): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
  const names = new Set(base.prompts.map((prompt) => prompt.name));
  const extra = commands
    .filter((command) => !names.has(command.name))
    .map(
      (command): PromptTemplate => ({
        name: command.name,
        description: command.description,
        ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
        content: command.content,
        filePath: command.filePath,
        sourceInfo: createSyntheticSourceInfo(command.filePath, { source: 'claude-plugin' }),
      })
    );
  return { prompts: [...base.prompts, ...extra], diagnostics: base.diagnostics };
}

/** Enso 不发现任何宿主或项目资源；cwd 只供 pi 的会话文件元数据使用。 */
function createEnsoResourceLoader(
  cwd: string,
  agentDir: string,
  branchContext: InlineExtension,
  silentTurnRecovery: InlineExtension
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd,
    agentDir,
    // noExtensions 挡不住项目包解析（缺包会自动安装），同样用未信任的 settings
    settingsManager: createProjectSettingsManager(cwd, agentDir, []).settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [branchContext, applyPatchResultExtension, silentTurnRecovery],
    systemPrompt: ENSO_SYSTEM_PROMPT,
    skillsOverride: () => ({ skills: [], diagnostics: [] }),
    promptsOverride: () => ({ prompts: [], diagnostics: [] }),

    themesOverride: () => ({ themes: [], diagnostics: [] }),
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    appendSystemPromptOverride: () => [],
  });
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
  await loadCursorProvider(runtime);
  // 已关联 Codex 的账号也可能在 worker 里触发刷新，必须同样接管；须在按需注册克隆之前
  installCodexLinkedRefresh(runtime);
  // registerProvider 只触发 allowNetwork:false 的 refresh，拿到的是兜底清单；Main 侧界面
  // 展示的却是联网发现结果。必须拆成两次并各自吞错，避免一个 provider 的发现服务异常
  // 连带另一个拿不到清单；失败方只回退自己的兜底，worker 仍能启动。
  // await 而非 fire-and-forget：resolveBaseModel 紧接着就要用这份清单。
  await refreshWorkerProviderModels(runtime, ANTIGRAVITY_PROVIDER_ID);
  await refreshWorkerProviderModels(runtime, DEVIN_PROVIDER_ID);
  await refreshWorkerProviderModels(runtime, CURSOR_PROVIDER_ID);
  return runtime;
}

/** 故障域 A：本进程持有全部活会话。同一会话的命令串行，不同会话并行。 */
export class SessionSupervisor {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly gate = new OperationGate();
  private readonly workspaceSwitch = new WorkspaceSwitchGate(this.sessions);
  private readonly pendingCommands = new Map<string, number>();
  private readonly mcp = new McpManager({ emit: (event) => this.options.emit(event) });
  private readonly bgTasks: BackgroundTaskManager;
  private runtimePromise: Promise<ModelRuntime> | null = null;
  /** 不可回收的会话（桌面正在查看 / 手机订阅），由 Main 全量下发 */
  private pinned: ReadonlySet<string> = new Set();
  private readonly evictionTimer: ReturnType<typeof setInterval>;
  private approvalReviewer: SpawnModelConfig | undefined;
  private maxActiveCoworkers = DEFAULT_MAX_ACTIVE_COWORKERS;
  private disabledWorkflowPresets: string[] = [];
  /** 父会话通知(合并投递):闲则注入合成提示唤醒,忙则挂 pending 搭下次工具结果 */
  private readonly notifier = new ParentNotifier((sessionId, text) => {
    this.deliverNotification(sessionId, text);
  });
  private readonly completeTextAborts = new Map<string, AbortController>();
  private readonly completeTextPendingAborts = new Set<string>();

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

  private deliverNotification(sessionId: string, text: string): void {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;
    if (this.workspaceSwitch.defer(sessionId, () => this.deliverNotification(sessionId, text)))
      return;
    if (managed.status === 'idle') {
      managed.roundPending = true;
      void managed.session
        .prompt(`<agent-notification>\n${text}\n</agent-notification>`)
        .finally(() => {
          if (managed.status !== 'running') managed.roundPending = false;
        })
        .catch(() => {
          // status 是我们的投影,pi loop 可能仍在收尾拒绝 prompt——退回 pending 待搭车/轮末重投,绝不静默丢
          managed.pendingTaskReminders.push(text);
        });
    } else {
      managed.pendingTaskReminders.push(text);
    }
  }

  constructor(private readonly options: SupervisorOptions) {
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
        onOutput: (sessionId, taskId, tail, status) => {
          const managed = this.sessions.get(sessionId);
          if (managed) {
            this.options.emit({
              type: 'task-output',
              identity: managed.identity,
              seq: ++managed.seq,
              taskId,
              tail,
              status,
            });
          }
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
        },
        // 完成通知走合并投递:多任务同时完成合并成一条,失败在 manager 文本里自带标注
        onCompletionNotify: (sessionId, text) => {
          this.notifier.notify(sessionId, text);
        },
      },
      path.join(options.agentDir, 'task-logs')
    );
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
        managed.pendingBranch !== undefined ||
        !!managed.pendingVerifications ||
        managed.currentTurnId !== undefined ||
        managed.gate.snapshot().length > 0 ||
        managed.asks.snapshot().length > 0 ||
        (managed.ensoApp?.pendingCount ?? 0) > 0 ||
        (managed.browser?.pendingCount ?? 0) > 0 ||
        (managed.memory?.pendingCount ?? 0) > 0 ||
        (managed.agentControl?.pendingCount ?? 0) > 0 ||
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
    // 先收掉整棵子会话（coworker/child 都以 `${parentId}::` 为键前缀）
    for (const [id, child] of [...this.sessions]) {
      if (!id.startsWith(`${parentId}::`)) continue;
      child.gate.cancelAll();
      child.asks.cancelAll();
      cancelContinuousMemory(child.session.sessionManager);
      child.ensoApp?.cancelAll('Parent released');
      try {
        await child.session.abort();
      } catch {}
      child.unsubscribe();
      try {
        child.session.dispose();
      } catch {}
      this.sessions.delete(id);
      this.settleRound(child);
    }
    managed.coworkers.clear();
    for (const controller of managed.workflowRuns?.values() ?? []) controller.abort();
    managed.workflowRuns?.clear();
    managed.gate.cancelAll();
    managed.asks.cancelAll();
    cancelContinuousMemory(managed.session.sessionManager);
    managed.ensoApp?.cancelAll('Session released');
    managed.browser?.cancelAll('Session released');
    managed.memory?.cancelAll('Session released');
    managed.agentControl?.close('Session released');
    try {
      await managed.session.abort();
    } catch {}
    await emitSessionShutdown(managed.session);
    managed.unsubscribe();
    try {
      managed.session.dispose();
    } catch {}
    this.sessions.delete(parentId);
    this.options.emit({
      type: 'parent-ended',
      identity: managed.identity,
      seq: managed.seq + 1,
      reason,
    });
  }

  handleCommand(command: AgentCommand): void {
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
                (managed.ensoApp?.pendingCount ?? 0) > 0 ||
                (managed.browser?.pendingCount ?? 0) > 0 ||
                (managed.agentControl?.pendingCount ?? 0) > 0 ||
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
      return;
    }
    if (command.type === 'warm-mcp') {
      const deferred = command.servers.filter(isDeferredMcp);
      for (const server of deferred) this.mcp.refresh(server);
      void this.mcp.toolsFor(command.servers.filter((server) => !isDeferredMcp(server)));
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
    if (command.type === 'set-proxy-env') {
      applyWorkerProxyEnv(command.env);
      return;
    }
    if (command.type === 'set-approval-reviewer') {
      this.approvalReviewer = command.model;
      return;
    }
    if (command.type === 'set-max-active-coworkers') {
      this.maxActiveCoworkers = command.limit;
      return;
    }
    if (command.type === 'set-disabled-workflow-presets') {
      this.disabledWorkflowPresets = command.ids;
      return;
    }
    const identity =
      command.type === 'capability-result'
        ? command.child
        : command.type === 'browser-result' || command.type === 'memory-result'
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
        console.error('[abort] failed:', toErrorMessage(error));
      });
      return;
    }
    this.pendingCommands.set(scopeId, (this.pendingCommands.get(scopeId) ?? 0) + 1);
    void this.gate
      .run(identity.sessionId, () => this.execute(command))
      .finally(() => {
        const count = (this.pendingCommands.get(scopeId) ?? 1) - 1;
        if (count) this.pendingCommands.set(scopeId, count);
        else this.pendingCommands.delete(scopeId);
      })
      .catch((error) => {
        const message = toErrorMessage(error);
        if (command.type === 'spawn-parent') {
          this.options.emit({
            type: 'parent-rejected',
            identity: command.identity,
            seq: 0,
            reason: message,
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
        const managed = this.sessions.get(identity.sessionId);
        if (!managed || !isSameGeneration(managed.identity, identity)) {
          // 会话已不在 worker（驱逐 / 释放 / 换代）而 renderer 仍认为 started：静默丢弃会让
          // 后续每次发送都绕过 spawn 直发到空会话。按拒绝回流，让 renderer 清 started 并报错。
          if (command.type === 'prompt' || command.type === 'steer') {
            // 命令类型声明为 SessionIdentity，但 coworker tab 发来的是完整 ChildSessionIdentity
            const target = command.identity as SessionIdentity | ChildSessionIdentity;
            this.options.emit(
              'parent' in target
                ? { type: 'child-rejected', identity: target, seq: 0, reason: message }
                : { type: 'parent-rejected', identity: target, seq: 0, reason: message }
            );
          }
          return;
        }
        managed.status = 'failed';
        this.emitStatus(managed, message);
      });
  }

  private async execute(
    command: Exclude<AgentCommand, { type: 'snapshot' | 'reload-session' }>
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
          command.approvalReviewer,
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
          command.rtkEnabled,
          command.planMode,
          command.trustedProjectCode,
          command.pluginCommands,
          command.pluginHooks
        );
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
        const child = this.must(command.child);
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
        managed.safeJournal?.appendUserText(command.task.text);
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
        const images = command.images?.map((image) => ({ type: 'image' as const, ...image }));
        if (await this.interruptRetryIfAny(managed)) {
          this.promptFresh(managed, command.text, images, command.deliveryId);
          return;
        }
        if (managed.status === 'running') {
          await this.steerTracked(managed, command.text, images, command.deliveryId);
          this.bgTasks.backgroundAllForeground(managed.identity.sessionId, 'steer');
          return;
        }
        // 投影已 idle 但 pi 仍忙：压缩中（pi 拒收 prompt）不限时等压完；仍 streaming 要么
        // agent_end 尚未回流，要么是 abort 后工具不响应信号的僵尸轮——steer 进僵尸轮永远
        // 无人投递，故限时等空闲后走新轮；超时按失败收口，绝不静默。
        if (!(await waitPromptable(managed.session, ZOMBIE_TURN_WAIT_MS))) {
          this.failTurn(
            managed,
            'The previous turn is still running and could not be interrupted. Please retry, or reopen the conversation to reset the session.',
            true
          );
          return;
        }
        this.promptFresh(managed, command.text, images, command.deliveryId);
        return;
      }
      case 'steer': {
        const managed = this.must(command.identity);
        managed.plan?.supersede();
        const images = command.images?.map((image) => ({ type: 'image' as const, ...image }));
        // 重试倒计时期间 renderer 看到的仍是 running 会发 steer：此时没有活轮可插，
        // 语义是用户接管——打断重试，改为新轮 prompt
        if (await this.interruptRetryIfAny(managed)) {
          this.promptFresh(managed, command.text, images, command.deliveryId);
          return;
        }
        await this.steerTracked(managed, command.text, images, command.deliveryId);
        // 用户插话时长命令不阻塞投递：前台命令转后台（不杀），让 pi 在工具返回后读到插话
        this.bgTasks.backgroundAllForeground(managed.identity.sessionId, 'steer');
        return;
      }
      case 'abort-retry':
        this.must(command.identity).session.abortRetry();
        return;
      case 'retry': {
        const managed = this.must(command.identity);
        if (managed.session.isStreaming || managed.status === 'running') return;
        const agent = managed.session.agent;
        editLatestAssistantForRetry(managed.session);
        if (agent.state.messages.at(-1)?.role === 'assistant') return;
        ensureAssistantUsage(agent.state.messages as unknown[]);
        managed.currentTurnId = randomUUID();
        // 裸 agent.continue 绕过 pi 的 _runAgentPrompt，不会发 agent_settled，需自行补发收口
        void agent.continue().then(
          () => this.onSessionEvent(managed, { type: 'agent_settled' }),
          (error) => this.failTurn(managed, toErrorMessage(error))
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
        const base = await resolveBaseModelOrRefresh(runtime, command.model);
        const next = applyReasoningToModel(
          { ...base, compat: base.compat ? { ...base.compat } : undefined },
          managed.session.model ? Boolean(managed.session.model.reasoning) : false,
          command.model.modelId
        );
        await managed.session.setModel(next);
        ensureAssistantUsage(managed.session.messages as unknown[]);
        managed.modelId = command.model.modelId;
        // 必须回报：Main 的 agentSessionIndex 只认 parent-ready 与本事件，
        // 不回报就会让后续派发的 selection 校验永远对不上（issue #30）。
        this.options.emit({
          type: 'model-changed',
          identity: managed.identity,
          seq: ++managed.seq,
          model: settingsModelRef(command.model),
        });
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
      case 'set-approval-mode':
        this.must(command.identity).gate.mode = command.mode;
        return;
      case 'set-plan-mode':
        this.must(command.identity).plan?.setActive(command.active);
        return;
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
        this.approvalReviewer = command.model;
        return;
      case 'ask-respond':
        this.must(command.identity).asks.respond(command.requestId, command.answer);
        return;
      case 'capability-result': {
        const managed = this.must(command.child);
        if (
          !managed.childIdentity ||
          !isSameChildSessionIdentity(command.child, managed.childIdentity) ||
          managed.currentTurnId !== command.turnId
        ) {
          return;
        }
        managed.safeJournal?.appendCapabilityResult(command.requestId, command.envelope);
        managed.ensoApp?.resolve(command.turnId, command.requestId, command.envelope);
        return;
      }
      case 'browser-result': {
        const managed = this.must(command.identity);
        if (!managed.browser?.resolve(command)) {
          console.warn(`[browser] dropped result for unknown request ${command.requestId}`);
        }
        return;
      }
      case 'memory-result': {
        const managed = this.must(command.identity);
        if (!managed.memory?.resolve(command)) {
          console.warn(`[memory] dropped result for unknown request ${command.requestId}`);
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
      case 'task-stop':
        this.must(command.identity);
        this.bgTasks.stop(command.taskId);
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
            : { userIndexFromEnd: command.userIndexFromEnd ?? 0 }
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
        if (managed.status !== 'idle') {
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
        managed.gate.cancelAll();
        managed.asks.cancelAll();
        cancelContinuousMemory(managed.session.sessionManager);
        managed.ensoApp?.cancelAll('Enso capability invocation aborted');
        managed.browser?.cancelAll('Browser action aborted');
        managed.memory?.cancelAll('Memory action aborted');
        managed.currentTurnId = undefined;
        // 立即收口投影：不 await session.abort()（内部 waitForIdle 会一直等到工具/流
        // 真正结束，工具不响应 signal 时永远等不到，UI 就卡在 running 上）。
        // 中断信号发出即视为本轮终止，后续 agent_end 回流由 status 守卫幂等吸收。
        if (retrying) {
          this.failTurn(managed, managed.lastRetryError ?? 'Auto-retry cancelled.');
        } else {
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
    approvalReviewer?: SpawnModelConfig,
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
    rtkEnabled = true,
    planMode?: boolean,
    trustedProjectCode: readonly string[] = [],
    pluginCommands: readonly PluginCommandSpawn[] = [],
    pluginHooks: readonly PluginHookSpawn[] = []
  ): Promise<void> {
    const sessionId = identity.sessionId;
    const sessionEditMode = resolveEditMode(requestedEditMode, hashlineEditEnabled);
    const toolEnabled = (id: string) => !disabledTools.includes(id);
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (!isSameGeneration(existing.identity, identity) || existing.childIdentity) {
        throw new Error('Parent session identity is already reserved by another generation.');
      }
      this.options.emit({
        type: 'parent-ready',
        identity,
        seq: ++existing.seq,
        sessionFile: requiredSessionFile(existing.session),
        model: settingsModelRef(model),
      });
      return;
    }
    const spawnStart = Date.now();
    const runtime = await this.getRuntime();
    const baseModel = await resolveBaseModelOrRefresh(runtime, model);
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
    if (smartCompactSummaryModel) {
      await resolveBaseModelOrRefresh(runtime, smartCompactSummaryModel);
    }
    const resourceLoader = createSessionResourceLoader({
      branchContext: this.branchContextExtension(() => managedRef),
      silentTurnRecovery: silentTurnRecoveryExtension((kind) => {
        if (!managedRef) return;
        managedRef.silentTurnNudgeUsed = true;
        managedRef.silentTurnKind = kind;
      }),
      cwd,
      agentDir: this.options.agentDir,
      noSkills: loadLocalSkills === false,
      skillPaths,
      instruction,
      remoteAgentsFiles,
      ...(remote ? { remoteSsh: { host: remote.host } } : {}),
      loadHarnessAssets,
      trustedProjectCode,
      pluginCommands,
      pluginHooks: { hooks: pluginHooks, role: { kind: 'parent' }, resumed: Boolean(resumeFile) },
      exploreFold,
      persona: systemPrompt,
      ...(compactStrategy !== 'standard'
        ? {
            compactStrategy,
            smartCompactSummaryModel,
            smartCompactMode,
          }
        : {}),
    });
    const toolsStart = Date.now();
    const deferredMcp = mcpServers.filter(isDeferredMcp);
    const directMcp = mcpServers.filter((server) => !isDeferredMcp(server));
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
    const takePendingReminders = () => managedRef?.pendingTaskReminders.splice(0) ?? [];
    const reminders = new SystemReminderRegistry();
    reminders.register('background-task', () => {
      const pending = takePendingReminders();
      return pending.map((text) => `<background-task-update>\n${text}\n</background-task-update>`);
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
    const wrapRead = (definition: Def): Def =>
      withReadTruncationMeta(withAgentRead(definition, () => structuredById));
    const readOnlyTools = (): Def[] => {
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
              read: wrapRead(createReadToolDefinition(cwd) as unknown as Def),
              grep: createGrepToolDefinition(cwd) as unknown as Def,
            };
      const { read, grep } = stock;
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
            createFindToolDefinition(cwd) as unknown as Def,
            createLsToolDefinition(cwd) as unknown as Def,
          ];
    };
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
      writeScope?: readonly string[]
    ): Def[] => {
      const guarded = (definition: Def): Def => (cp ? withCheckpoint(definition, cp) : definition);
      // scope 与完整只读预检都在审批之外；checkpoint 仅在批准后触发。
      const scoped = (
        kind: 'file-edit' | 'file-write',
        definition: Def,
        preflight?: (params: unknown, signal: AbortSignal | undefined) => Promise<unknown>
      ): Def => {
        const approved = withApproval(toolGate, kind, guarded(definition));
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
                createApplyPatchTool({
                  cwd,
                  ...(patchIo ? { io: patchIo } : {}),
                }) as unknown as Def,
                (params: unknown, signal: AbortSignal | undefined) =>
                  validateApplyPatchTargets(cwd, params, patchIo, signal)
              ),
            ]
          : [scoped('file-edit', stockEdit), scoped('file-write', stockWrite)];
      return [
        ...readOnlyTools(),
        withApproval(
          toolGate,
          'command',
          guarded(
            withBackground(
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
              sessionId,
              cwd,
              backgroundTransform
            )
          )
        ),
        ...mutations,
      ];
    };
    const wrapMcpTools = (toolGate: ApprovalGate): Def[] => [
      ...mcpTools.map((tool) => withApproval(toolGate, 'mcp', tool)),
      ...(deferredMcp.length > 0
        ? [
            createMcpProxyTool({
              servers: deferredMcp,
              resolve: (server) => this.mcp.resolve(server),
              wrap: (tool) => withApproval(toolGate, 'mcp', tool),
            }),
          ]
        : []),
    ];
    const buildCoreTools = (): Def[] => [
      ...buildBaseTools(gate, checkpoints),
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
        askManager,
        resumeFile: childResume,
        extraTools = [],
      }) => {
        const selectedModel = modelOverride ?? resolved?.model ?? agentType?.model ?? model;
        const base = await resolveBaseModelOrRefresh(runtime, selectedModel);
        // 派发 thinking > 类型预设 > 模型条目预设 > 父会话
        const childReasoning = resolveChildReasoning(
          pickChildReasoningOverride(thinkingOverride, agentType, selectedModel),
          reasoningEnabled,
          thinkingLevel
        );
        const subModel = applyReasoningToModel(
          { ...base, compat: base.compat ? { ...base.compat } : undefined },
          childReasoning.enabled,
          selectedModel.modelId
        );
        const isLockedEnso = resolved?.tools === 'enso-locked';
        if (isLockedEnso && (!childIdentity || !askManager)) {
          throw new Error('Locked Enso child requires exact identity and ask manager.');
        }
        const selectedMcp = resolved?.mcpServers ?? agentType?.mcpServers ?? [];
        const mcpToolGroups =
          !isLockedEnso && selectedMcp.length > 0
            ? await Promise.all(selectedMcp.map((server) => this.mcp.toolsFor([server], 3000)))
            : [];
        if (mcpToolGroups.some((tools) => tools.length === 0)) {
          throw new Error('Agent profile MCP resource failed to establish.');
        }
        const typeMcpTools = mcpToolGroups
          .flat()
          .map((tool) => withApproval(childGate, 'mcp', tool));
        const ensoApp =
          isLockedEnso && childIdentity && askManager
            ? new EnsoAppInvoker(
                childIdentity,
                () => this.sessions.get(childIdentity.sessionId)?.currentTurnId,
                (request) => {
                  const managed = this.sessions.get(childIdentity.sessionId);
                  if (
                    !managed?.childIdentity ||
                    !isSameChildSessionIdentity(childIdentity, managed.childIdentity)
                  ) {
                    throw new Error('Enso child generation is no longer current.');
                  }
                  managed.safeJournal?.append({
                    type: 'enso-operation',
                    operationId: request.requestId,
                    capabilityId: request.capabilityId,
                    toolCallId: request.requestId,
                    at: Date.now(),
                  });
                  this.options.emit({
                    type: 'capability-invoke',
                    child: request.child,
                    seq: ++managed.seq,
                    turnId: request.turnId,
                    requestId: request.requestId,
                    capabilityId: request.capabilityId,
                    params: request.params,
                  });
                }
              )
            : undefined;
        const childExploreFold =
          !isLockedEnso && exploreFoldEnabled ? createExploreFoldState() : undefined;
        const childSandboxCatalog: { current: Def[] } = { current: [] };
        const childTools = isLockedEnso
          ? [createEnsoCapabilitiesTool(), createEnsoAppTool(ensoApp!), createAskTool(askManager!)]
          : [
              ...(resolved?.tools === 'readonly' || agentType?.tools === 'readonly'
                ? readOnlyTools()
                : buildBaseTools(childGate, undefined, agentType?.writeScope)),
              ...(resolved || agentType ? typeMcpTools : wrapMcpTools(childGate)),
              ...(extraTools as Def[]),
              ...(childExploreFold ? createExploreFoldTools(childExploreFold) : []),
            ];
        childSandboxCatalog.current = childTools;
        const childRunaway = new RunawayGuard();
        const childReminders = new SystemReminderRegistry();
        const childBudget = new ToolOutputBudget({
          rootDir: path.join(
            this.options.sessionDir,
            'tool-output',
            childIdentity?.sessionId ?? `${sessionId}-child`
          ),
        });
        const rawSubTools = isLockedEnso
          ? childTools
          : [
              ...childTools,
              ...(toolEnabled('isolated_sandbox')
                ? [
                    createIsolatedSandboxTool({
                      getTools: () => childSandboxCatalog.current,
                      store: new Map(),
                    }),
                  ]
                : []),
            ];
        const subTools = isLockedEnso
          ? rawSubTools
          : decorateSessionTools(rawSubTools, {
              reminders: childReminders,
              runaway: childRunaway,
              budget: childBudget,
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
        const subLoader = isLockedEnso
          ? createEnsoResourceLoader(cwd, this.options.agentDir, branchContext, silentTurnRecovery)
          : createSessionResourceLoader({
              branchContext,
              silentTurnRecovery,
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
              pluginHooks: {
                hooks: pluginHooks,
                role: {
                  kind: 'subagent',
                  agentType: resolved?.displayName ?? agentType?.name ?? 'general',
                },
                resumed: Boolean(childResume),
              },
              ...(childExploreFold ? { exploreFold: childExploreFold } : {}),
            });
        await subLoader.reload();
        const safeJournal =
          isLockedEnso && childIdentity
            ? new EnsoSafeJournal(this.options.sessionDir, childIdentity, cwd, childResume)
            : undefined;
        const sessionManager = safeJournal
          ? SessionManager.inMemory(cwd)
          : childResume
            ? SessionManager.open(childResume, this.options.sessionDir, cwd)
            : SessionManager.create(cwd, this.options.sessionDir);
        if (safeJournal && childResume) {
          for (const record of (await EnsoSafeJournal.restore(childResume)).records) {
            if (record.type === 'safe-user-text') {
              sessionManager.appendMessage({
                role: 'user',
                content: [{ type: 'text', text: record.text }],
                timestamp: record.at,
              });
            }
          }
        }
        const { session } = await createAgentSession({
          cwd,
          agentDir: this.options.agentDir,
          modelRuntime: runtime,
          model: subModel,
          thinkingLevel: childReasoning.level,
          noTools: 'builtin',
          customTools: subTools,
          resourceLoader: subLoader,
          sessionManager,
        });
        if (isCursorModel(subModel)) attachCursorBridgeToSession(session, subTools, cwd);
        return {
          session,
          modelId: selectedModel.modelId,
          ...(safeJournal ? { safeJournal } : {}),
          modelRef: settingsModelRef(selectedModel),
          toolIds: subTools.map((tool) => tool.name),
          // Decorators clone tools; exclude MCP by identity before decoration.
          proofToolIds: rawSubTools
            .filter((tool) => !typeMcpTools.includes(tool))
            .map((tool) => tool.name),
          ...(ensoApp ? { ensoApp } : {}),
          ...(isLockedEnso ? {} : { runawayGuard: childRunaway }),
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
      invoke: async (request, signal) => {
        const response = await agentControl.invoke(request, signal);
        coworkerIdle.observe(request, response);
        return response;
      },
    });
    const askManager = this.createAskManager(identity);
    // 内嵌浏览器：页面活在 Main，worker 只发 browser-invoke 事件。每个父会话一张挂起表。
    const browser = toolEnabled('browser')
      ? new BrowserInvoker(identity, (request) => {
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
        })
      : undefined;
    // 记忆库活在 Main（better-sqlite3），worker 只发 memory-invoke 事件，同 browser 桥。
    const memory = toolEnabled('memory')
      ? new MemoryInvoker(identity, (request) => {
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
        })
      : undefined;
    const catalogRef: { current: Def[] } = { current: [] };
    const sandboxStore = new Map<string, unknown>();
    const workflowRoots = workflowPresetRoots(remote ? undefined : cwd, {
      customDir: this.options.workflowDir,
    });
    const workflowRuns = new Map<string, AbortController>();
    const sessionTools = [
      ...buildCoreTools(),
      ...(browser
        ? createBrowserTools(browser).map((tool) => withNavigateApproval(gate, tool))
        : []),
      ...(memory ? createMemoryTools(memory, { language: memoryLanguage }) : []),
      ...(toolEnabled('web') ? createWebTools() : []),
      ...(toolEnabled('todo') ? [createTodoTool((todos) => todoReminder.update(todos))] : []),
      ...(toolEnabled('ask_user') ? [createAskTool(askManager)] : []),
      ...(toolEnabled('subagent') ? [unifiedSubagentTool] : []),
      ...(toolEnabled('workflow') && toolEnabled('subagent')
        ? [
            createWorkflowTool({
              invoke: (request, signal) => agentControl.invoke(request, signal),
              // 远程会话的 cwd 在远端，本地只读设置、全局与内置预设（与 Main 列表口径一致）
              loadPreset: (id) =>
                loadWorkflowPreset(id, workflowRoots, this.disabledWorkflowPresets),
              presets: listWorkflowPresets(workflowRoots, this.disabledWorkflowPresets),
              models: subagentModels,
              agentTypes,
              activeRuns: workflowRuns,
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
          ]
        : []),
      ...(exploreFold ? createExploreFoldTools(exploreFold) : []),
      ...(toolEnabled('background_tasks') ? createTaskTools(this.bgTasks) : []),
      ...(toolEnabled('goal')
        ? createGoalTools((kind, note) => {
            const managed = managedRef ?? this.sessions.get(sessionId);
            if (!managed) return;
            this.options.emit({
              type: 'goal-signal',
              identity: managed.identity,
              seq: ++managed.seq,
              kind,
              note,
            });
          })
        : []),
    ];
    // Plan 工具门包在父会话工具最外层（exec 沙盒经 catalog 调用同样受限）；目录跨模式不变
    const planRef: { current?: PlanController } = {};
    const planHost = {
      state: () => planRef.current?.state() ?? EMPTY_PLAN_STATE,
      submit: (doc: Parameters<PlanController['submit']>[0]) => planRef.current?.submit(doc),
    };
    const readonlyAgentTypes = new Set(
      agentTypes.filter((type) => type.tools === 'readonly').map((type) => type.name)
    );
    const catalogTools = toolEnabled('plan')
      ? sessionTools.map((tool) => withPlanGate(tool, { host: planHost, readonlyAgentTypes }))
      : sessionTools;
    catalogRef.current = catalogTools;
    const customTools = decorateSessionTools(
      [
        ...catalogTools,
        ...(toolEnabled('plan') ? [createSubmitPlanTool(planHost, randomUUID)] : []),
        ...(toolEnabled('isolated_sandbox')
          ? [
              createIsolatedSandboxTool({
                getTools: () => catalogRef.current,
                store: sandboxStore,
              }),
            ]
          : []),
      ],
      { reminders, runaway, budget }
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
    if (isCursorModel(piModel)) attachCursorBridgeToSession(session, customTools, cwd);
    else ensureAssistantUsage(session.messages as unknown[]);
    console.log(
      `[spawn] ${sessionId.slice(0, 8)} total ${Date.now() - spawnStart}ms` +
        ` (tools ${toolsMs}ms, mcp ${mcpTools.length} tools + ${deferredMcp.length} deferred servers, cwd ${cwd})`
    );

    managedRef = this.registerManagedSession(identity, session, gate, model.modelId, {
      resumeFile,
      asks: askManager,
      factory,
      toolIds: customTools.map((tool) => tool.name),
      checkpoints,
      runawayGuard: runaway,
    });
    managedRef.agentControl = agentControl;
    managedRef.workflowRuns = workflowRuns;
    if (rolePrompt && !resumeFile) managedRef.pendingRole = rolePrompt;
    managedRef.browser = browser;
    managedRef.memory = memory;
    if (toolEnabled('plan')) {
      const managed = managedRef;
      const plan = new PlanController(
        {
          branch: () => session.sessionManager.getBranch(),
          append: (entry) => session.sessionManager.appendCustomEntry(PLAN_ENTRY_TYPE, entry),
        },
        () => this.emitPlanState(managed)
      );
      planRef.current = plan;
      managed.plan = plan;
      if (planMode !== undefined) plan.setActive(planMode);
      else this.emitPlanState(managed);
    }
    this.options.emit({
      type: 'parent-ready',
      identity,
      seq: ++managedRef.seq,
      sessionFile: requiredSessionFile(session),
      model: settingsModelRef(model),
    });
    checkpoints?.cleanupOldSessions();
  }

  private createAskManager(identity: SessionIdentity): AskManager {
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
      (requestId) => {
        const managed = this.sessions.get(identity.sessionId);
        if (managed && isSameGeneration(managed.identity, identity)) {
          this.options.emit({
            type: 'ask-resolved',
            identity: managed.identity,
            seq: ++managed.seq,
            requestId,
          });
        }
      }
    );
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
      ensoApp?: EnsoAppInvoker;
      toolIds?: string[];
      proofToolIds?: string[];
      safeJournal?: EnsoSafeJournal;
      runawayGuard?: RunawayGuard;
    } = {}
  ): ManagedSession {
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
      seq: 0,
      messages: [],
      turnStartIndex: 0,
      customEntries,
      commands: collectSlashCommands(session),
      modelId,
      toolIds: opts.toolIds ?? [],
      proofToolIds: opts.proofToolIds ?? opts.toolIds ?? [],
      promptedRequestIds: new Set(),
      ...(opts.ensoApp ? { ensoApp: opts.ensoApp } : {}),
      ...(opts.safeJournal ? { safeJournal: opts.safeJournal } : {}),
      adaptiveDowngraded: false,
      silentTurnNudgeUsed: false,
      ...(opts.runawayGuard ? { runawayGuard: opts.runawayGuard } : {}),
      timings: [],
      toolStartAt: new Map(),
      toolDurations: new Map(),
      gate,
      asks: opts.asks ?? this.createAskManager(identity),
      pendingTaskReminders: [],
      roundWaiters: new Set(),
      coworkers: new Map(),
      lastActivityAt: Date.now(),
      contextUsage: new UsageTracker(),
      ...(opts.factory ? { factory: opts.factory } : {}),
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
      ...(opts.coworkerName ? { coworkerName: opts.coworkerName } : {}),
      ...(opts.checkpoints ? { checkpoints: opts.checkpoints } : {}),
      unsubscribe: () => {},
    };
    managed.unsubscribe = session.subscribe((event) => {
      this.onSessionEvent(managed, event);
    });
    this.sessions.set(identity.sessionId, managed);
    if (opts.resumeFile) {
      const raw = this.transcript(managed);
      const { immediate, deferFull } = projectResumeTail(raw);
      const emitResumeSnapshot = (payload: { messages: ProjectedMessage[]; baseIndex: number }) => {
        this.options.emit({
          type: 'snapshot',
          partial: true,
          sessions: [
            {
              identity,
              status: managed.status,
              messages: payload.messages,
              ...(payload.baseIndex > 0 ? { baseIndex: payload.baseIndex } : {}),
              commands: managed.commands,
              ...(managed.childMetadata ? { child: managed.childMetadata } : {}),
              ...(managed.customEntries.length > 0 ? { customEntries: managed.customEntries } : {}),
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
          emitResumeSnapshot(full);
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
    const isLockedEnso = identity.typeKey === ENSO_LOCKED_PROFILE.typeKey;
    if (
      isLockedEnso !== (config.tools === 'enso-locked') ||
      identity.profileId !== config.lockedProfileId ||
      (isLockedEnso &&
        (identity.profileId !== ENSO_LOCKED_PROFILE.profileId ||
          config.skillPaths.length !== 0 ||
          config.mcpServers.length !== 0))
    ) {
      throw new Error('Child locked profile does not match the reserved identity.');
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
        sessionFile: existing.safeJournal?.sessionFile ?? requiredSessionFile(existing.session),
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
      }
    );
    const askManager = this.createAskManager(identity);
    const result = await factory.createChildSession({
      resolved: config,
      identity,
      gate,
      askManager,
      resumeFile,
      ...(isLockedEnso
        ? {}
        : {
            extraTools: [
              createMessageMainTool(
                (text, urgent) => this.notifier.notify(identity.parent.sessionId, text, { urgent }),
                identity.instanceName
              ),
              this.createPeerMessageTool(identity.parent.sessionId, identity.instanceName),
            ],
          }),
    });
    const metadata: ChildConversationMetadata = {
      parentId: identity.parent.sessionId,
      childGeneration: identity.generation,
      agentTypeKey: identity.typeKey,
      agentInstanceId: identity.instanceId,
      agentInstanceName: identity.instanceName,
      dispatchOrigin: 'typed-mention',
      ...(identity.profileId ? { lockedProfileId: identity.profileId } : {}),
    };
    const info: CoworkerInfo = {
      id: identity.sessionId,
      child: metadata,
      name: identity.instanceName,
      agentType: identity.typeKey,
      status: 'idle',
      modelId: result.modelId,
      sessionFile: result.safeJournal?.sessionFile ?? result.session.sessionFile,
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
      ensoApp: result.ensoApp,
      toolIds: result.toolIds,
      proofToolIds: result.proofToolIds,
      safeJournal: result.safeJournal,
      ...(result.runawayGuard ? { runawayGuard: result.runawayGuard } : {}),
    });
    if (!resumeFile) managedRef.pendingRole = config.systemPrompt;
    this.options.emit({
      type: 'child-ready',
      identity,
      seq: ++managedRef.seq,
      sessionFile: result.safeJournal?.sessionFile ?? requiredSessionFile(result.session),
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
      }
    );
    const askManager = this.createAskManager(identity);
    const { session, modelId, toolIds, runawayGuard } = await factory.createChildSession({
      agentType,
      modelOverride,
      thinkingOverride: thinking,
      gate,
      resumeFile,
      extraTools: [
        createAskTool(askManager),
        createMessageMainTool(
          (text, urgent) => this.notifier.notify(parentId, text, { urgent }),
          name,
          () => this.sessions.get(coworkerId)?.parentWaiting === true
        ),
        this.createPeerMessageTool(parentId, name),
      ],
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
    });
    // 角色提示在首条消息前缀注入(无论来自主 agent send 还是用户 tab);resume 时 jsonl 已有
    if (!resumeFile && agentType?.systemPrompt) {
      managed.pendingRole = agentType.systemPrompt;
    }
    parent.coworkers.set(name, info);
    return info;
  }

  /** 解雇 coworker：中断并销毁会话,jsonl 留盘。返回解雇名(通知/事件用) */
  private async dismissCoworker(parentId: string, coworkerId: string): Promise<string> {
    const parent = this.mustCurrent(parentId);
    const managed = this.sessions.get(coworkerId);
    if (managed) {
      managed.gate.cancelAll();
      managed.asks.cancelAll();
      cancelContinuousMemory(managed.session.sessionManager);
      managed.ensoApp?.cancelAll('Child dismissed');
      try {
        await managed.session.abort();
      } catch {}
      managed.unsubscribe();
      try {
        managed.session.dispose();
      } catch {}
      this.sessions.delete(coworkerId);
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
        void this.promptTracked(managed, consumeRole(managed, text))
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
    const window = positiveContextWindow(managed.session.model);
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

  private onSessionEvent(
    managed: ManagedSession,
    event: Parameters<Parameters<AgentSession['subscribe']>[0]>[0]
  ): void {
    managed.lastActivityAt = Date.now();
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
        return;
      case 'message_start': {
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
        this.stampContextSnapshot(managed, event.message);
        const projected = projectMessage(event.message);
        this.replaceLastMessage(managed, projected);
        if (projected?.role === 'assistant') {
          const text = projected.content
            .filter(
              (part): part is Extract<(typeof projected.content)[number], { type: 'text' }> =>
                part.type === 'text'
            )
            .map((part) => part.text)
            .join('\\n');
          if (text) managed.safeJournal?.appendAssistantText(text);
        }
        this.emitSessionMeta(managed);
        return;
      }
      case 'auto_retry_start':
        managed.lastRetryError = event.errorMessage || 'Unknown error';
        this.options.emit({
          type: 'turn-retry',
          identity: managed.identity,
          seq: ++managed.seq,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
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
        // 耗时只从真正开始执行算：同轮后发工具不能把前面 bash 的排队算进去
        if (!managed.toolStartAt.has(event.toolCallId)) {
          const startedAt = Date.now();
          managed.toolStartAt.set(event.toolCallId, startedAt);
          const timeoutMs = foregroundCommandTimeoutMs(event.toolName, event.args);
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
        const start = managed.toolStartAt.get(event.toolCallId);
        managed.toolStartAt.delete(event.toolCallId);
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
      case 'compaction_end':
        // 自动压缩在 agent_end 之后异步完成：context 视图换了形，重新按完整记录对齐（历史不丢，summary 行入列）
        this.reconcileMessages(managed, this.transcript(managed));
        this.rebaseContextUsage(managed);
        managed.compaction = undefined;
        // 锚点必须在对齐之后取：否则摘要消息未入列，与 guest 事件口径 maxIndex+1 差 1
        if (!event.errorMessage) {
          managed.compactionNoticeAt = managed.messages.length;
          managed.plan?.compacted();
        }
        this.emitSessionMeta(managed);
        this.options.emit({
          type: 'compaction',
          identity: managed.identity,
          seq: ++managed.seq,
          state: 'end',
          ...(event.errorMessage ? { error: event.errorMessage } : {}),
        });
        return;
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
        if (!managed.settlePending) return;
        managed.settlePending = false;
        this.reconcileMessages(managed, this.transcript(managed));
        if (this.tryAdaptiveDowngrade(managed)) return;
        // 终态错误轮（重试耗尽或不可重试）按失败收口，不再误报「回复完成」
        const lastAssistant = [...managed.messages]
          .reverse()
          .find((message) => message.role === 'assistant');
        if (lastAssistant?.stopReason === 'error') {
          this.failTurn(managed, lastAssistant.errorMessage ?? 'Turn failed.');
          return;
        }
        if (this.trySilentTurnRecovery(managed)) return;
        const turnId = managed.currentTurnId ?? randomUUID();
        managed.currentTurnId = undefined;
        managed.status = 'idle';
        this.emitStatus(managed);
        managed.plan?.turnSettled();
        managed.contextUsage.setPendingSnapshot(undefined);
        this.emitSessionMeta(managed);
        // 本轮摘要随 turn-completed 下发：renderer 冷会话没有正文，只能由 worker 切
        const digest = buildTurnDigest(managed.messages, managed.turnStartIndex);
        managed.turnStartIndex = managed.messages.length;
        this.options.emit({
          type: 'turn-completed',
          identity: managed.identity,
          seq: ++managed.seq,
          turnId,
          ...(digest ? { digest } : {}),
        });
        if (managed.pendingCompact) {
          const queued = managed.pendingCompact;
          managed.pendingCompact = undefined;
          void this.runCompaction(managed, queued.instructions);
        }
        if (managed.pendingTaskReminders.length > 0) {
          setTimeout(() => {
            if (managed.status !== 'idle' || managed.pendingTaskReminders.length === 0) return;
            const texts = managed.pendingTaskReminders.splice(0);
            this.deliverNotification(managed.identity.sessionId, texts.join('\\n\\n---\\n\\n'));
          }, 150);
        }
        return;
      }
      default:
        return;
    }
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

  private trySilentTurnRecovery(managed: ManagedSession): boolean {
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
    if (managed.adaptiveDowngraded) return false;
    const lastError = managed.messages.at(-1)?.errorMessage ?? '';
    if (!lastError.includes('adaptive thinking is not supported')) return false;
    managed.adaptiveDowngraded = true;
    runtimeAdaptiveBlocklist.add(managed.modelId);
    const compat = managed.session.model?.compat as { forceAdaptiveThinking?: boolean } | undefined;
    if (compat) compat.forceAdaptiveThinking = undefined;
    const lastUser = [...managed.messages].reverse().find((message) => message.role === 'user');
    const text = lastUser?.content.find((part) => part.type === 'text')?.text;
    if (!text) return false;
    // 重发同一请求：本轮摘要从重发点起算，避免失败的首次尝试重复计入
    managed.turnStartIndex = managed.messages.length;
    void this.promptTracked(managed, text).catch((error) => {
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
    // Clear the optimistic rewind before restoring the authoritative projection.
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
    if (!managed.session.isRetrying) return false;
    managed.session.abortRetry();
    await managed.session.waitForIdle();
    return true;
  }

  private promptFresh(
    managed: ManagedSession,
    text: string,
    images?: { type: 'image'; data: string; mimeType: string }[],
    deliveryId?: string
  ): void {
    if (managed.session.isStreaming) {
      void this.steerTracked(managed, text, images, deliveryId).catch((error) => {
        this.failTurn(managed, toErrorMessage(error));
      });
      return;
    }
    managed.currentTurnId = randomUUID();
    ensureAssistantUsage(managed.session.messages as unknown[]);
    void this.promptTracked(
      managed,
      consumeRole(managed, text),
      images ? { images } : undefined,
      deliveryId
    ).catch((error) => {
      this.failTurn(managed, toErrorMessage(error));
    });
  }

  /**
   * pi 先投递新 prompt 自身的 user 消息，再投递滞留的 steer；每条 user 消息按此顺序领取回执。
   * 所有注入 user 消息的调用都必须经这两个入口，否则队列错位。
   */
  private promptTracked(
    managed: ManagedSession,
    text: string,
    options?: Parameters<AgentSession['prompt']>[1],
    deliveryId?: string
  ): Promise<void> {
    const slot = { id: deliveryId ?? null };
    managed.promptDelivery = slot;
    const trackedOptions = deliveryId
      ? {
          ...options,
          preflightResult: (accepted: boolean) => {
            if (!accepted && managed.promptDelivery === slot) {
              this.options.emit({
                type: 'delivery-rejected',
                identity: managed.identity,
                seq: ++managed.seq,
                deliveryId,
              });
            }
            options?.preflightResult?.(accepted);
          },
        }
      : options;
    return managed.session
      .prompt(withPendingPlanNote(managed, text), trackedOptions)
      .finally(() => {
        if (managed.promptDelivery === slot) managed.promptDelivery = undefined;
      });
  }

  private steerTracked(
    managed: ManagedSession,
    text: string,
    images?: { type: 'image'; data: string; mimeType: string }[],
    deliveryId?: string
  ): Promise<void> {
    const slot = { id: deliveryId ?? null };
    managed.steerDeliveries ??= [];
    managed.steerDeliveries.push(slot);
    return managed.session
      .steer(withPendingPlanNote(managed, text), images)
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

  private failTurn(managed: ManagedSession, error: string, undelivered = false): void {
    const turnId = managed.currentTurnId ?? randomUUID();
    managed.currentTurnId = undefined;
    managed.settlePending = false;
    managed.contextUsage.setPendingSnapshot(undefined);
    managed.status = 'failed';
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
    this.options.emit({
      type: 'turn-failed',
      identity: managed.identity,
      seq: ++managed.seq,
      turnId,
      error,
      ...(undelivered ? { undelivered: true } : {}),
    });
  }

  private emitStatus(managed: ManagedSession, error?: string): void {
    this.flushStreamingUpsert(managed);
    this.options.emit({
      type: 'status',
      identity: managed.identity,
      seq: ++managed.seq,
      status: managed.status,
      ...(error ? { error } : {}),
    });
    if (managed.status !== 'running') this.settleRound(managed);
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
    const contextWindow = positiveContextWindow(managed.session.model);
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
    this.options.emit({
      type: 'session-meta',
      identity: managed.identity,
      seq: ++managed.seq,
      sessionFile: managed.session.sessionFile,
      ...(occupancy ? { occupancy } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      // 渲染层冷会话不留正文、手机只持尾窗：按 worker 的完整记录算好随占用下发
      usageTotals: toUsageTotals(computeStats(managed.messages)),
    });
  }

  private snapshotSessions(): SessionSnapshot[] {
    return Array.from(this.sessions.values()).map((managed) => {
      const backgroundTasks = this.bgTasks.snapshot(managed.identity.sessionId);
      return {
        identity: managed.identity,
        status: managed.status,
        messages: managed.messages,
        commands: managed.commands,
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
  shutdown(): Promise<void> {
    clearInterval(this.evictionTimer);
    this.workspaceSwitch.clear();
    this.bgTasks.stopAll();
    for (const managed of this.sessions.values()) {
      cancelContinuousMemory(managed.session.sessionManager);
      managed.ensoApp?.cancelAll('Enso worker shutdown');
      managed.browser?.cancelAll('Enso worker shutdown');
      managed.memory?.cancelAll('Enso worker shutdown');
      managed.agentControl?.close('Enso worker shutdown');
      managed.currentTurnId = undefined;
      // pi 的 bash 是 detached 进程组，只在中断信号上 killProcessTree；SDK 未导出退出清理，
      // 这里同步触发中断（不等 waitForIdle），否则 worker 退出后命令成孤儿进程
      void managed.session.abort().catch(() => {});
    }
    return this.mcp.closeAll();
  }

  private getRuntime(): Promise<ModelRuntime> {
    // 共享 ModelRuntime（M0 验证项 2 已实测双会话共享可行）
    this.runtimePromise ??= (async () => {
      const runtime = await ModelRuntime.create({
        authPath: path.join(this.options.agentDir, 'auth.json'),
        modelsPath: null,
        refreshOnCreate: false,
      });
      return initializeWorkerRuntime(runtime);
    })();
    return this.runtimePromise;
  }

  private async reviewApproval(
    info: import('@shared/types/agent').ApprovalRequestInfo,
    signal: AbortSignal | undefined
  ): Promise<{ decision: 'auto_allow' | 'ask_user' | 'block'; rationale?: string }> {
    const reviewer = this.approvalReviewer;
    if (!reviewer) {
      return { decision: 'ask_user', rationale: 'No approval reviewer model is configured.' };
    }
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
          const options = {
            signal: controller.signal,
            ...(command.maxTokens !== undefined ? { maxTokens: command.maxTokens } : {}),
            ...(command.reasoning && command.reasoning !== 'off'
              ? { reasoning: command.reasoning }
              : {}),
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
        const message = await runtime.completeSimple(model, context, {
          signal: controller.signal,
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
/** 流式增量下发间隔：约 20 帧/秒，肉眼连贯，长回复的 IPC 与 markdown 重算降一个量级 */
const STREAM_UPSERT_WINDOW_MS = 50;

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
 */
export async function waitPromptable(
  session: Pick<AgentSession, 'waitForIdle' | 'isStreaming' | 'isCompacting'>,
  zombieMs: number
): Promise<boolean> {
  let waited = false;
  for (;;) {
    if (session.isCompacting) {
      await session.waitForIdle();
    } else if (session.isStreaming) {
      if (!(await waitIdleBounded(session, zombieMs)) && !session.isCompacting) return false;
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
  const rest = splitPlanPrefix(text).rest;
  const message = parsePlanMessage(rest);
  return message ? (message.kind === 'feedback' ? message.feedback : '') : rest;
}

/** Plan 状态变化后的一次性提示，随下一条进入模型的用户消息前置 */
function withPendingPlanNote(managed: { plan?: PlanController }, text: string): string {
  const note = managed.plan?.takeNote();
  return note ? withPlanNote(note, text) : text;
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
  try {
    return resolveBaseModel(runtime, model);
  } catch (error) {
    if (!model.oauthAccountKey) throw error;
    // Cursor 无 force 只踢后台任务并立刻返回兜底清单（没有 claude-fable-5-1 这类新 id）
    await refreshWorkerProviderModels(runtime, providerIdOfAccountKey(model.oauthAccountKey), {
      force: true,
    });
    return resolveBaseModel(runtime, model);
  }
}

/**
 * 解析 spawn 模型：oauth 直取 pi 内置 catalog（凭证由 runtime 从共享 auth.json 解析，
 * 不注册自定义 provider、不覆盖 UA、不读行覆盖——订阅端点保持 pi 原生标识）；
 * apiKey 注册自定义 provider：行覆盖 > 精确 catalog id > 乐观默认。
 */
export function resolveBaseModel(runtime: ModelRuntime, model: SpawnModelConfig) {
  if (model.oauthAccountKey) {
    // worker 与 Main 是两个 ModelRuntime 实例，只共用 auth.json。合成 id（第 2+ 个账号）
    // 的克隆 provider 必须在本进程也注册一遍，否则 getModel 取不到
    ensureAccountProvider(runtime, model.oauthAccountKey);
    const exact = runtime.getModel(model.oauthAccountKey, model.modelId);
    const oauthModel =
      exact ??
      resolveOauthCatalogModel(
        providerIdOfAccountKey(model.oauthAccountKey),
        model.modelId,
        runtime.getModels(model.oauthAccountKey),
        undefined
      );
    if (!oauthModel) {
      throw new Error(`oauth model not found: ${model.oauthAccountKey}/${model.modelId}`);
    }
    return oauthModel;
  }
  const providerId = providerKeyFor(model);
  const models = runtime.getModels();
  const catalog = findCatalogModelById(models, model.modelId);
  const resolved = resolveCustomModelCapabilities(catalog, model);
  const contextWindow = resolved.contextWindow ?? 128_000;
  const maxTokens = resolved.maxTokens ?? 32_000;
  const piBaseUrl = resolvePiProviderBaseUrl(model.api, model.baseUrl);
  const compat = resolveCustomModelCompat(
    model.api,
    piBaseUrl,
    selectCatalogEntryForCompat(models, model.api, piBaseUrl, model.modelId)
  );
  runtime.registerProvider(providerId, {
    baseUrl: piBaseUrl,
    api: model.api,
    apiKey: model.apiKey,
    // 统一伪装为 enso-code 客户端（覆盖 pi 默认的 "pi (darwin ...)"）
    headers: { 'User-Agent': ENSO_USER_AGENT },
    models: [
      {
        id: model.modelId,
        name: model.modelId,
        reasoning: resolved.reasoning,
        ...(resolved.thinkingLevelMap ? { thinkingLevelMap: resolved.thinkingLevelMap } : {}),
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        // applyExtension 原样展开定义，不填默认值；缺 contextWindow 时 pi 会把 max_tokens 钳成 NaN
        contextWindow,
        // 太小会把 high/max 的思考预算压扁（预算被限制在 maxTokens-1024 内）
        maxTokens,
        ...(compat ? { compat } : {}),
      },
    ],
  });
  if (model.api === 'openai-responses') {
    const provider = runtime.getProvider(providerId);
    if (!provider) throw new Error(`provider not found after register: ${providerId}`);
    // 保留鉴权与 raw/simple 两条流；注册为 native provider 后 runtime.refresh 仍保留适配。
    runtime.registerNativeProvider(withOpenAIResponsesRouting(provider));
  }
  const registered = runtime.getModel(providerId, model.modelId);
  if (!registered) throw new Error(`model not found after register: ${model.modelId}`);
  return registered;
}

/** 统一的客户端标识，格式对齐 pi-coding-agent 的 getPiUserAgent（<name>/<ver> (<platform>; <runtime>; <arch>)） */
const ENSO_USER_AGENT = `enso-code/${version} (${process.platform}; node/${process.version}; ${process.arch})`;

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
    currentModelFamily: modelFamilyOf(managed.session.model?.id ?? managed.modelId),
    compactionModelFamily: compactionModelFamilyOf(branch),
    contextWindow,
    pendingTaskReminders: managed.pendingTaskReminders,
    estimateMessageTokens: estimateMessageTokens ?? estimateConversationTokens,
  });
}

function compactionModelFamilyOf(
  branch: ReadonlyArray<{ type: string; modelId?: string }>
): string | undefined {
  let lastModel: string | undefined;
  for (const entry of branch) {
    if (entry.type === 'model_change' && typeof entry.modelId === 'string')
      lastModel = entry.modelId;
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
