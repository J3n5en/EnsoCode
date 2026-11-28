import {
  APPROVAL_REVIEW_FALLBACKS,
  type ApprovalAllowThreshold,
  type ApprovalReviewFallback,
  type ApprovalReviewRecord,
  isApprovalAllowThreshold,
  parseApprovalReviewRecord,
} from '../approvalReviewRecord';
import { parseAutoRetryLimit } from '../autoRetry';
import {
  type AgentTypeKey,
  type ChildSessionIdentity,
  isSameChildSessionIdentity,
  isUuid,
  isValidLegacyProfile,
  LEGACY_ENSO_TYPE_KEY,
  type LegacyEnsoProfileId,
  parseAgentTypeKey,
  parseChildSessionIdentity,
  parseSessionIdentity,
  type SessionIdentity,
} from '../builtinAgents';
import {
  type CapabilityReceipt,
  type CapabilityResult,
  parseCapabilityReceipt,
  parseCapabilityResult,
} from '../capabilities/types';
import { type CompactStrategy, parseCompactStrategy } from '../compactStrategy';
import { isDcgRuleId } from '../dcgRuleMemory';
import type { DefaultModelRef } from '../defaultModel';
import type { ExitKind } from '../exitInterrupt';
import { parsePluginArtifactInfo } from '../extensionPlugins/artifacts';
import {
  AGENT_END_TEXT_MAX,
  BEFORE_AGENT_START_PROMPT_MAX,
  CONTEXT_PART_ITEMS,
  CONTEXT_PART_KINDS,
  CONTEXT_USAGE_BUCKETS,
  type ContextPart,
  type InterceptPayload,
  isChildInterceptEvent,
  isInterceptEvent,
  PLUGIN_EVENTS,
  PLUGIN_INTERCEPT_EVENTS,
  type PluginEventName,
  type PluginInterceptEvent,
} from '../extensionPlugins/events';
import {
  PLUGIN_AGENT_MAX_TIMEOUT_MS,
  PLUGIN_AGENT_PROMPT_MAX_CHARS,
  PLUGIN_AGENT_SYSTEM_MAX_CHARS,
  PLUGIN_INJECT_WIRE_MAX_CHARS,
  PLUGIN_PROGRESS_MAX_CHARS,
  type PluginAgentRunEvent,
  type PluginAgentSource,
  type PluginArtifactInfo,
  type PluginInjectImage,
  type PluginInjectOrigin,
  type PluginInjectSender,
  type PluginMessageSource,
  parsePluginAgentRunEvent,
  parsePluginAgentSource,
  parsePluginInjectImages,
  parsePluginInjectOrigin,
  parsePluginInjectSender,
  parsePluginMessageSource,
} from '../extensionPlugins/protocol';
import { parsePluginToolName } from '../extensionPlugins/toolName';
import type { PluginEventPlan, PluginToolDescriptor } from '../extensionPlugins/types';
import { type ImageGenerationConfig, parseImageGenerationConfig } from '../imageGeneration';
import { parseGeneratedImagePaths } from '../imageGenerationResults';
import { parseMaxActiveCoworkers } from '../maxActiveCoworkers';
import {
  isCodexAccountKey,
  type OauthPoolFailure,
  parseOauthAccountPool,
  parseOauthPoolFailure,
} from '../oauthAccountPool';
import {
  PLAN_FEEDBACK_MAX,
  PLAN_RESPOND_ACTIONS,
  type PlanRespondAction,
  type PlanState,
  parsePlanState,
} from '../planMode';
import {
  type MaskReport,
  type PrivacyMaskRecord,
  parseMaskReport,
  parsePrivacyMaskRecord,
} from '../privacyMask/report';
import { type PrivacyMaskSettings, parsePrivacyMaskSettings } from '../privacyMask/settings';
import { PRODUCT_SURFACE_INVENTORY, type ProductSurfaceId } from '../productSurfaces';
import { parseProviderHeaders } from '../providers/providerHeaders';
import { type ProviderProxyConfig, parseProviderProxy } from '../providers/providerProxy';
import type { SessionReminderSummary } from '../reminders';
import { parseRequestBodyUsage, type RequestBodyUsage } from '../requestBodyUsage';
import { parseRtkToolStats, type RtkToolStats } from '../rtk';
import { parseSecretaryToolDescriptors } from '../secretary/customTools';
import { type GoalResult, parseGoalResult } from '../secretary/goalResult';
import { SECRETARY_INTERNAL_OPS, SECRETARY_OPS, type SecretaryInvokeOp } from '../secretary/tools';
import { resolveShellLimits, type ShellLimits } from '../shellLimits';
import { parseSmartCompactMode, type SmartCompactMode } from '../smartCompactMode';
import { parseSshTimeoutSeconds } from '../sshTimeout';
import { parseToolBatchDigest, type ToolBatchDigest } from '../toolBatchLabel';
import {
  isWebSearchChainEntry,
  WEB_SEARCH_CHAIN_MAX,
  type WebSearchChainEntry,
} from '../webSearchChain';
import { WINDOWS_LOCAL_SHELLS, type WindowsLocalShell } from '../windowsLocalShell';
import {
  APPROVAL_MODES,
  type ApprovalMode,
  THINKING_LEVELS,
  type ThinkingLevel,
  TURN_REPORT_MAX_CHARS,
} from './agentConstants';
import { type DcgGuardHit, type DcgWarning, isDcgGuardHit, isDcgWarning } from './dcg';
import { type EditMode, isEditMode } from './editMode';
import {
  PROJECTED_APPLY_PATCH_PATH_COUNT_LIMIT,
  PROJECTED_APPLY_PATCH_PATH_TEXT_LIMIT,
  PROJECTED_FILE_CHANGE_LIMIT,
  PROJECTED_FILE_TEXT_LIMIT,
  type ProjectedApplyPatchOutcome,
  type ProjectedFileChange,
} from './fileChanges';
import type { RestartCheckpoint, RestartDeferReason } from './gracefulRestart';
import {
  MODEL_API_KINDS,
  MODEL_REASONING_OVERRIDES,
  MODEL_THINKING_LEVEL_OVERRIDES,
  type ModelApiKind,
  type ModelCapabilityOverrides,
  type ModelEntry,
  type ModelReasoningOverride,
  type ModelThinkingLevelOverride,
} from './llm';
import { type AgentDispatchTask, parseAgentDispatchTask } from './mentions';
import type { SecretaryToolDescriptor } from './secretary';
import { isWorkflowPresetId, parseWorkflowRunSnapshot, type WorkflowRunSnapshot } from './workflow';

export type { ChildSessionIdentity, SessionIdentity } from '../builtinAgents';
export { parseChildSessionIdentity, parseSessionIdentity } from '../builtinAgents';
export {
  APPROVAL_MODES,
  type ApprovalMode,
  THINKING_LEVELS,
  type ThinkingLevel,
  TURN_REPORT_MAX_CHARS,
};

/**
 * Main → worker 的自定义 provider 注册信息。api 在 shared 侧保持 string，
 * worker 再用 MODEL_API_KINDS 收窄。
 */
export interface WorkerCustomProvider {
  settingsId: string;
  name: string;
  api: string;
  baseUrl: string;
  apiKey: string;
  models: ModelEntry[];
  headers?: Record<string, string>;
  proxy?: ProviderProxyConfig;
}

/** 会话状态。waiting/done 属权限门与 subagent 刀，M1 不引入 */
export type NodeStatus = 'idle' | 'running' | 'failed';

/** 一轮结束时 worker 切出的压缩摘要；三段均已在 worker 侧按上限截断 */
export interface TurnDigest {
  /** 会话首条 user 文本（清洗后截头）：滚动总结的主旨锚点，防止单轮动作劫持标题；无 user 时为空串 */
  firstUserText: string;
  /** 本轮全部 user 文本（清洗后 '\n' 拼接，截头） */
  userText: string;
  /** 本轮最后一条含 text 的 assistant 文本（截尾）；整轮只有工具调用时为空串 */
  assistantText: string;
  /**
   * 整轮没有任何文字回复时的最后一个工具：秘书据此把静默收工当成异常。
   * 有文字结论时不带，避免把正常收工误报成卡住。
   */
  lastTool?: { name: string; ok: boolean };
}

/** 本轮最后一条 assistant 结论原文，worker 侧截尾到 TURN_REPORT_MAX_CHARS；秘书终态回传用 */
export interface TurnReport {
  text: string;
  /** 截尾时丢掉的开头字数 */
  omitted?: number;
}

/** 标题总结输入：initial = 首条消息即时总结；rolling = 每轮结束后的滚动刷新 */
export type TitleSummaryInput =
  | { kind: 'initial'; text: string }
  | {
      kind: 'rolling';
      currentTitle: string;
      /** 会话首条请求，作为主旨锚点；允许空串（冷会话拿不到） */
      firstUserText: string;
      userText: string;
      assistantText: string;
    };

/** 标题总结回退链最多候选数：标题模型 → 全局默认 → 会话模型 */
export const TITLE_SUMMARY_MAX_CANDIDATES = 3;

/** spawn 下发的模型配置。apiKey 只在 Main → worker 方向出现，事件类型不给 auth 位置 */
export interface SpawnModelConfig extends ModelCapabilityOverrides {
  api: ModelApiKind;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  /**
   * settings 里的 provider 条目 id。parent-ready / child-ready 必须用它回报模型身份
   * （见 supervisor.settingsModelRef 与 agentHost.modelRefForSpawnConfig，缺失即抛错），
   * 因此它是 spawn 命令的必填字段，解析器同样强制要求。
   */
  settingsProviderId: string;
  /**
   * 订阅账号 key（= 合成 provider id，见 shared/types/oauthProviders.ts）。
   * 存在时 worker 直取该 key 对应的 provider 与模型，凭证由 pi runtime 从 auth.json 解析。
   */
  oauthAccountKey?: string;
  /**
   * 虚拟模型：settingsProviderId 为 `enso-virtual`、modelId 为条目 id，顶层其余字段沿用主模型
   * 只作占位；worker 必须先看这里，按成员逐个解析后注册 pi 虚拟模型。
   */
  virtual?: VirtualSpawnConfig;
  /**
   * Main 校验后下发的顺序池配置；仅用于路由身份，实时成员和游标仍以 Main 为权威。
   */
  oauthAccountPool?: { accountKeys: string[] };
  /** 该供应商的额外 HTTP 请求头。空表不下发。 */
  headers?: Record<string, string>;
  /** API Key 供应商的独立代理；缺省跟随全局代理。 */
  proxy?: ProviderProxyConfig;
}

/** pi catalog 里的分类器 provider/model 与凭证 */
export interface VirtualClassifierCredentials {
  provider: string;
  modelId: string;
  apiKey?: string;
  /** System One 兼容网关地址；缺省用 pi catalog 内置地址 */
  baseUrl?: string;
  /** API Key 供应商的独立代理；缺省跟随全局代理 */
  proxy?: ProviderProxyConfig;
}

export interface VirtualSpawnClassifier {
  source: 'judge' | 'pi-classifier';
  timeoutMs: number;
  /** judge：裁判聊天模型 */
  model?: SpawnModelConfig;
  /** pi-classifier：pi catalog 里的分类器 provider/model 与凭证 */
  classifier?: VirtualClassifierCredentials;
}

export interface VirtualSpawnConfig {
  name: string;
  primary: SpawnModelConfig;
  fast?: SpawnModelConfig;
  fallbacks: SpawnModelConfig[];
  classifier?: VirtualSpawnClassifier;
}

/** 审批请求的操作类别 */
export type ApprovalKind = 'command' | 'file-edit' | 'file-write' | 'mcp';

/** 受保护动作类别：底线开启时无视审批档位强制真人确认 */
export const PROTECTED_ACTION_CATEGORIES = [
  'external-send',
  'delete',
  'payment',
  'deploy',
  'secret',
  'destructive',
] as const;
export type ProtectedActionCategory = (typeof PROTECTED_ACTION_CATEGORIES)[number];

/** 内嵌浏览器操作闭集：worker 只能发这些，raw CDP 永不进协议。 */
export const BROWSER_OPS = [
  'navigate',
  'snapshot',
  'click',
  'type',
  'fill',
  'press_key',
  'scroll',
  'select_option',
  'click_xy',
  'drag',
  'highlight',
  'bounding_box',
  'screenshot',
  'tabs',
  'lock',
  'close',
  'cdp',
] as const;
export type BrowserOp = (typeof BROWSER_OPS)[number];

/** 记忆库活在 Main（better-sqlite3），worker 只发 memory-invoke 事件；op 闭集在这里冻结 */
export const MEMORY_OPS = ['search', 'capture', 'crystallize', 'delete'] as const;
export type MemoryOp = (typeof MEMORY_OPS)[number];

/** 桌面 computer 活在 Main，worker 只发 computer-invoke；guest JS 一次 run。 */
export const COMPUTER_OPS = ['run'] as const;
export type ComputerOp = (typeof COMPUTER_OPS)[number];

/** 待审批请求（worker → 渲染层） */
export interface ApprovalRequestInfo {
  requestId: string;
  tool: string;
  kind: ApprovalKind;
  /** 命令全文 / 文件路径 / 参数预览 */
  summary: string;
  /** Worker 从已解析工具参数提取的全部写目标；不得由模型单独声明。 */
  filePaths?: string[];
  /** 对应 toolCall.id，代审中徽章挂到时间线该行 */
  toolCallId?: string;
  /** reviewing = 代审模型评审中（不弹真人按钮）；缺省 = 等人决策 */
  phase?: 'reviewing';
  /** 命中受保护动作底线的类别；此类审批只能单次放行 */
  protected?: ProtectedActionCategory;
  /** 每次都要真人：不走代审、不随切档放行、不记「本会话总是允许」 */
  mandatory?: boolean;
  /** 等人处理的截止时间（ms）；到期由 Main 按超时拒绝 */
  expiresAt?: number;
  /** 托管判定无效（超时 / 出错 / 缺字段）退回人工的原因 */
  reviewFallback?: ApprovalReviewFallback;
  /** dcg 命令守卫命中的规则与原因；decision=warn 时只是提示 */
  guard?: DcgGuardHit;
}

/** 提问是谁收的尾：用户在原会话里直接答、秘书代答、超时兜底 */
export const ASK_ANSWER_BY = ['user', 'relay', 'timeout'] as const;
export type AskAnswerBy = (typeof ASK_ANSWER_BY)[number];

/** 秘书转问派出会话结果里的 needsUser：用户答复后宿主据此把那条记为已答复 */
export interface AskRelatesTo {
  conversationId: string;
  /** needsUser 列表里从 0 开始的位置；缺省表示这一问覆盖全部条目 */
  needsUserIndex?: number;
}

/** 序号给了但不合法时整段作废：丢掉序号会被当成「覆盖全部条目」 */
export function parseAskRelatesTo(raw: unknown): AskRelatesTo | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { conversationId, needsUserIndex } = raw as Record<string, unknown>;
  if (typeof conversationId !== 'string' || !conversationId.trim()) return undefined;
  if (needsUserIndex === undefined || needsUserIndex === null)
    return { conversationId: conversationId.trim() };
  const index =
    typeof needsUserIndex === 'string' && needsUserIndex.trim()
      ? Number(needsUserIndex)
      : needsUserIndex;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return undefined;
  return { conversationId: conversationId.trim(), needsUserIndex: index };
}

/** ask-resolved 的关联字段坏了只剥掉它，提问照常收尾；关联与提问时间必须成对 */
function withAskLink(value: Record<string, unknown>): Record<string, unknown> {
  if (value.relatesTo === undefined && value.askedAt === undefined) return value;
  const { relatesTo, askedAt, ...rest } = value;
  const link = parseAskRelatesTo(relatesTo);
  return link && typeof askedAt === 'number' && Number.isFinite(askedAt)
    ? { ...rest, relatesTo: link, askedAt }
    : rest;
}

/** agent 向用户的提问（ask_user 工具,阻塞等答复） */
export interface AskRequestInfo {
  requestId: string;
  question: string;
  /** 可选快捷选项（用户也可自由输入） */
  options?: string[];
  /** 推荐项：ask_user 的 default_option 恰为某个选项时才有 */
  recommended?: string;
  /** 等人回答的截止时间（ms）；到期由 Main 按未回答处理 */
  expiresAt?: number;
  /** 已转给秘书：原会话不弹给用户，只留一行「已转给 X」，用户仍可直接回答 */
  relay?: { name: string };
  /** 秘书在替这条派出会话的 needsUser 问用户 */
  relatesTo?: AskRelatesTo;
  /** 渲染层投影：提问已收尾，用来在原会话里留一行状态；worker 不下发 */
  answered?: { by: AskAnswerBy; name?: string; answer?: string };
}

/** 审批决策：revise 打回换更安全的命令；review 把这一条交给助手代审 */
export const APPROVAL_DECISIONS = ['allow', 'allowSession', 'deny', 'revise', 'review'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return (APPROVAL_DECISIONS as readonly unknown[]).includes(value);
}

/** 后台任务状态（渲染层胶囊/面板与 snapshot 共用） */
export interface BackgroundTaskInfo {
  taskId: string;
  command: string;
  status: 'running' | 'done' | 'failed';
  /** 输出尾部快照（覆盖式,≤8KB） */
  tail: string;
  /** 任务累计写出的输出字节数（含重启前、已滚出 tail 的）；0 = 确实还没输出。缺省表示未知 */
  outputBytes?: number;
  startedAt: number;
  exitCode?: number;
  /** 模型显式 timeout 的绝对截止（ms）。没有则不会因超时被看门狗收口 */
  deadlineAt?: number;
  /** false：直接子进程已不在。缺省表示还没探测 */
  alive?: boolean;
  /** 疑似闲置（只提示，不自动停）：since = 最后一次输出的时刻，ports = 进程树监听的端口 */
  idle?: { since: number; ports: number[] };
  /** 留下运行：agent 收尾表态或用户手动保留；at 起 1 小时内不参与闲置判定，之后重新检查 */
  keep?: BackgroundTaskKeep;
  /** 上一代 worker 收尾时被停掉（应用重启 / 退出）：status 是 failed，任务表标「因重启中断」 */
  interrupted?: 'restart';
}

/** 手动保留理由上限 */
export const TASK_KEEP_REASON_MAX = 200;

export interface BackgroundTaskKeep {
  by: 'agent' | 'user';
  reason?: string;
  at: number;
}

export { SHELL_QUIET_MS } from '../shellLimits';

/** 命令结果的结构化失败分类（工具结果 details.shellFailure；渲染层徽章与模型提示同源） */
export const SHELL_FAILURE_KINDS = [
  'exit_nonzero',
  'deadline',
  'stopped_by_user',
  'tty_required',
  'auth_required',
  'not_found',
  'not_executable',
  'binary_output',
  'output_truncated',
] as const;

export type ShellFailureKind = (typeof SHELL_FAILURE_KINDS)[number];

export interface ShellFailure {
  kind: ShellFailureKind;
  /** false：原样重跑不会有不同结果（需要终端 / 认证 / 用户已停止） */
  retryable: boolean;
  exitCode?: number;
}

/** bash / powershell 工具结果 details 中由本应用写入的可选字段 */
export interface ShellDetails {
  backgroundTaskId?: string;
  shellFailure?: ShellFailure;
  dcgWarning?: DcgWarning;
}

export function parseShellFailure(value: unknown): ShellFailure | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!(SHELL_FAILURE_KINDS as readonly unknown[]).includes(record.kind)) return null;
  if (typeof record.retryable !== 'boolean') return null;
  if (
    record.exitCode !== undefined &&
    !(typeof record.exitCode === 'number' && Number.isInteger(record.exitCode))
  ) {
    return null;
  }
  return {
    kind: record.kind as ShellFailureKind,
    retryable: record.retryable,
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode as number }),
  };
}

/** 下发 worker 的 subagent 类型配置（model 由 main 补全 apiKey） */
export interface AgentTypeSpawnConfig {
  name: string;
  description: string;
  systemPrompt: string;
  tools: 'all' | 'readonly';
  /** 可写路径 glob 白名单；缺省不限 */
  writeScope?: string[];
  /** 精选注入的 skill 目录（main 已按 id 解析） */
  skillPaths?: string[];
  /** 精选注入的 MCP server（main 已按 id 解析） */
  mcpServers?: McpServerSpawnConfig[];
  /** 绑定模型；缺省 = 跟随父会话 */
  model?: SpawnModelConfig;
  /** true = agent_pick：主 agent 必须传 model，禁止继承；false/缺省 = 固定模型或跟随会话，不允许自选覆盖 */
  allowModelOverride?: boolean;
  /** 类型级推理覆盖：赢过模型条目预设，输给派发 thinking；缺省 = 跟随 */
  reasoning?: ModelReasoningOverride;
  thinkingLevel?: ModelThinkingLevelOverride;
}

/**
 * 下发 worker 的子代理可选模型（设置页集中配置，main 已解析凭证）。
 * name 是给 LLM 看的唯一键：物理为 `{provider.name}/{modelId}`，虚拟为条目 name，不是 `enso-virtual/{id}`；冲突时追加 #n。
 * description 是用户写的选型依据，注入工具参数说明。
 */
export interface SubagentModelOption {
  name: string;
  config: SpawnModelConfig;
  description?: string;
}

export type SubagentActivity =
  | {
      id: string;
      type: 'assistant';
      /** 仅可见 text part，不含 thinking */
      text: string;
      streaming: boolean;
    }
  | {
      id: string;
      type: 'tool';
      toolName: string;
      argumentsText: string;
      outputText?: string;
      status: 'running' | 'done' | 'failed' | 'aborted';
    };

/** 子代理状态（渲染层状态行与 snapshot 共用） */
export interface SubagentInfo {
  id: string;
  description: string;
  status: 'running' | 'done' | 'failed';
  /** assistant step 数 */
  steps: number;
  /** 当前动作摘要（工具名+参数 / writing…） */
  currentActivity: string;
  /** 活动历史（工具调用与阶段性文本,capped） */
  activityLog?: string[];
  /** 有界的可见正文与工具执行详情，不含 thinking */
  activities?: SubagentActivity[];
  /** 较早的过程详情已按会话预算清理；最终报告仍保留 */
  detailsPruned?: boolean;
  /** 完成后的最终产出（markdown） */
  resultText?: string;
  /** 使用的模型 */
  modelId?: string;
  /** 命中的 agent 类型（缺省 general） */
  agentType?: string;
  /** 累计输出 token */
  outputTokens?: number;
  startedAt: number;
}

/** coworker 元数据（worker → 渲染层,覆盖式 upsert;dismissed 表示已解雇） */
export interface CoworkerInfo {
  /** `${parentId}::cw-${slug}` */
  id: string;
  /** 雇佣时的名字,coworker 工具按名寻址 */
  /** typed mention child 的安全 identity/registry metadata */
  child?: ChildConversationMetadata;
  name: string;
  /** agent 类型名（缺省 general） */
  agentType?: string;
  status: NodeStatus | 'dismissed';
  modelId?: string;
  /** coworker 自己的 jsonl,渲染层持久化 resume 用 */
  sessionFile?: string;
  createdAt: number;
}

export type AgentMode = 'task' | 'coworker';
export type AgentDelivery = 'auto' | 'steer' | 'next';
export type AgentControlThinkingLevel = ThinkingLevel | 'off';
export type AgentInstanceStatus = 'creating' | 'ready' | 'active' | 'parked' | 'closed';
export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_input'
  | 'validating'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface AgentOwnerIdentity {
  ownerId: string;
  projectId: string;
  kind: 'chatSession';
}

export type AgentActorIdentity =
  | {
      kind: 'user';
      actorId: string;
      ownerId: string;
      projectId: string;
    }
  | {
      kind: 'agent';
      actorId: string;
      ownerId: string;
      projectId: string;
      identity: SessionIdentity | ChildSessionIdentity;
    };
export interface AgentControlContext {
  actor: AgentActorIdentity;
  owner: AgentOwnerIdentity;
}

/** 子代理 spawn 首轮上下文种子策略；默认 none 保持空白起步 */
export const SUBAGENT_SEED_CONTEXTS = ['none', 'prior_reads', 'fork_compact', 'fork'] as const;
export type SubagentSeedContext = (typeof SUBAGENT_SEED_CONTEXTS)[number];

export function isSubagentSeedContext(value: unknown): value is SubagentSeedContext {
  return typeof value === 'string' && SUBAGENT_SEED_CONTEXTS.includes(value as SubagentSeedContext);
}

/** Main 授权的验收命令 id。模型不能提交 argv；未知 id 在 Main 拒绝，不会执行。 */
export type AgentRunGate = { commandRef: string };

export interface AgentControlSpawnRequest {
  context: AgentControlContext;
  requestId: string;
  mode?: AgentMode;
  name?: string;
  description: string;
  prompt: string;
  agentType?: string;
  model?: string;
  thinking?: AgentControlThinkingLevel;
  seedContext?: SubagentSeedContext;
  schema?: unknown;
  gate?: AgentRunGate;
}

export interface AgentControlSendRequest {
  context: AgentControlContext;
  requestId: string;
  agentId: string;
  message: string;
  delivery?: AgentDelivery;
  expectedRunId?: string;
  schema?: unknown;
  gate?: AgentRunGate;
}

export interface AgentControlRunTargetRequest {
  context: AgentControlContext;
  requestId: string;
  runId: string;
}

export interface AgentControlDismissRequest {
  context: AgentControlContext;
  requestId: string;
  agentId: string;
}

/** 续跑被中断（parked）的 task：重开原会话文件，接着未完成的回合跑，不追加新 prompt */
export type AgentControlResumeRequest = AgentControlDismissRequest;

export interface AgentControlWaitRequest {
  context: AgentControlContext;
  requestId: string;
  runIds: string[];
  until?: 'all' | 'any';
  timeoutMs?: number;
}

/** 子代理阻塞等待：不写时限按默认，写了也不超过上限。完成会自动通知，等待只用于下一步离不开结果时 */
export const AGENT_WAIT_DEFAULT_MS = 30 * 1000;
export const AGENT_WAIT_MAX_MS = 5 * 60 * 1000;
/** 每个 task 最多 resume 几次：反复被打断多半不是瞬态问题，再续只是空耗请求 */
export const AGENT_TASK_MAX_RESUMES = 3;

export interface AgentControlListRequest {
  context: AgentControlContext;
  requestId: string;
  status?: AgentInstanceStatus;
  cursor?: string;
  limit?: number;
}

export interface AgentControlMessageRequest {
  context: AgentControlContext;
  requestId: string;
  to: string;
  text: string;
}

export interface AgentRunSnapshot {
  owner: AgentOwnerIdentity;
  agentId: string;
  runId: string;
  mode: AgentMode;
  status: AgentRunStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** 因请求预算强制停止：status 仍是 succeeded，但结果是被截断的部分输出 */
  requestBudgetStop?: true;
  /** 预算停止时已有的部分输出，让 wait 也能直接看到，不必再查 report */
  text?: string;
}

export interface AgentSpawnReceipt {
  agentId: string;
  runId: string;
  mode: AgentMode;
  status: 'queued' | 'running';
}

export interface AgentSendReceipt {
  agentId: string;
  runId: string;
  delivery: 'steer' | 'next';
  status: 'queued' | 'running';
}

export interface AgentRunReport {
  run: AgentRunSnapshot;
  text?: string;
  value?: unknown;
  error?: string;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}

export interface AgentWaitReceipt {
  runs: AgentRunSnapshot[];
  timedOut: boolean;
  interrupted: boolean;
  /** 超时或被打断时仍在跑的 Run 进度；Run 不会因此停止 */
  pending?: AgentRunProgress[];
}

/** 未结束 Run 的进度：给模型的超时回执与界面等待行共用 */
export interface AgentRunProgress {
  agentId: string;
  runId: string;
  title?: string;
  status: AgentRunStatus;
  elapsedMs: number;
  /** 子代理此刻在做的事：在跑的工具或正在写回复 */
  activity?: AgentRunActivity;
  /** 最近一条回复的末尾（仅界面预览；给模型的回执不带） */
  text?: string;
  /** 因上游瞬态/配额故障正在等待自动恢复：Run 没收口，恢复后会自动续跑 */
  upstreamWaiting?: {
    provider: string;
    errorKind: 'transient' | 'quota';
    /** 下一次自动探测的时间（epoch ms） */
    nextAt: number;
    lastError: string;
  };
}

export type AgentRunActivity =
  | { phase: 'thinking' | 'writing' }
  | { phase: 'tool'; tool: string; detail?: string };

export interface AgentListItem {
  agentId: string;
  mode: AgentMode;
  status: AgentInstanceStatus;
  activeRunId?: string;
  latestRun?: AgentRunSnapshot;
}

export interface AgentListReceipt {
  agents: AgentListItem[];
  nextCursor?: string;
}

export type AgentServiceErrorCode =
  | 'invalid-context'
  | 'forbidden'
  | 'mode-disabled'
  | 'not-found'
  /** id 属于 Main 重启前：内存里的 Run / Agent 记录已丢 */
  | 'restart-lost'
  /** id 属于别的会话或别的 agent */
  | 'other-owner'
  | 'invalid-state'
  | 'run-mismatch'
  | 'runtime-unavailable';

export type AgentServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: AgentServiceErrorCode; error: string };

export type AgentControlToolRequest =
  | {
      operation: 'spawn';
      mode: AgentMode;
      name?: string;
      description: string;
      prompt: string;
      agentType?: string;
      model?: string;
      thinking?: AgentControlThinkingLevel;
      seedContext?: SubagentSeedContext;
      wait: boolean;
      schema?: unknown;
      gate?: AgentRunGate;
    }
  | {
      operation: 'send';
      agentId: string;
      message: string;
      delivery: AgentDelivery;
      expectedRunId?: string;
      wait: boolean;
      schema?: unknown;
      gate?: AgentRunGate;
    }
  | {
      operation: 'wait';
      runIds: string[];
      until: 'all' | 'any';
      timeoutMs?: number;
    }
  | { operation: 'report'; runId: string }
  | { operation: 'list'; status?: AgentInstanceStatus; cursor?: string; limit: number }
  | { operation: 'message'; to: string; text: string }
  | { operation: 'stop'; runId: string }
  | { operation: 'dismiss'; agentId: string }
  | { operation: 'resume'; agentId: string };

export type AgentControlToolResponse =
  | { ok: true; value: unknown }
  | { ok: false; code: AgentServiceErrorCode; error: string };

type ClosedParser<R> = (value: Record<string, unknown>) => R | null;

function parseClosed<T extends string, R>(
  table: Record<T, (value: Record<string, unknown>) => R>,
  type: string,
  value: Record<string, unknown>
): R | null {
  if (!Object.hasOwn(table, type)) return null;
  return table[type as T](value);
}

function requireEventIdentity(
  kind: 'any' | 'parent' | 'child',
  parse: ClosedParser<AgentWorkerEvent>
): ClosedParser<AgentWorkerEvent> {
  return (value) => {
    const identity =
      kind === 'child'
        ? parseChildSessionIdentity(value.identity)
        : kind === 'parent'
          ? parseSessionIdentity(value.identity)
          : parseAnySessionIdentity(value.identity);
    if (!identity || !isSequence(value.seq)) return null;
    return parse(value);
  };
}

export function parseAgentControlToolRequest(value: unknown): AgentControlToolRequest | null {
  if (!isRecord(value) || typeof value.operation !== 'string') return null;
  const nonEmpty = (input: unknown): input is string =>
    typeof input === 'string' && input.trim().length > 0;
  const optionalString = (input: unknown): input is string | undefined =>
    input === undefined || nonEmpty(input);
  const schemaValid = value.schema === undefined || isRecord(value.schema);
  const gateValid = (gate: unknown): gate is AgentRunGate => {
    if (!isRecord(gate)) return false;
    return hasExactKeys(gate, ['commandRef']) && nonEmpty(gate.commandRef);
  };
  const optionalGate = value.gate === undefined || gateValid(value.gate);

  const parseRunIdOperation = (value: Record<string, unknown>): AgentControlToolRequest | null => {
    return hasExactKeys(value, ['operation', 'runId']) && nonEmpty(value.runId)
      ? (value as unknown as AgentControlToolRequest)
      : null;
  };

  const parseAgentIdOperation = (
    value: Record<string, unknown>
  ): AgentControlToolRequest | null => {
    return hasExactKeys(value, ['operation', 'agentId']) && nonEmpty(value.agentId)
      ? (value as unknown as AgentControlToolRequest)
      : null;
  };
  const parsers = {
    spawn: (value: Record<string, unknown>): AgentControlToolRequest | null => {
      return hasOnlyKeys(value, [
        'operation',
        'mode',
        'name',
        'description',
        'prompt',
        'agentType',
        'model',
        'thinking',
        'seedContext',
        'wait',
        'schema',
        'gate',
      ]) &&
        (value.mode === 'task' || value.mode === 'coworker') &&
        optionalString(value.name) &&
        nonEmpty(value.description) &&
        nonEmpty(value.prompt) &&
        optionalString(value.agentType) &&
        optionalString(value.model) &&
        (value.thinking === undefined ||
          value.thinking === 'off' ||
          THINKING_LEVELS.includes(value.thinking as ThinkingLevel)) &&
        (value.seedContext === undefined || isSubagentSeedContext(value.seedContext)) &&
        typeof value.wait === 'boolean' &&
        schemaValid &&
        optionalGate
        ? (value as unknown as AgentControlToolRequest)
        : null;
    },
    send: (value: Record<string, unknown>): AgentControlToolRequest | null => {
      return hasOnlyKeys(value, [
        'operation',
        'agentId',
        'message',
        'delivery',
        'expectedRunId',
        'wait',
        'schema',
        'gate',
      ]) &&
        nonEmpty(value.agentId) &&
        nonEmpty(value.message) &&
        (value.delivery === 'auto' || value.delivery === 'steer' || value.delivery === 'next') &&
        optionalString(value.expectedRunId) &&
        typeof value.wait === 'boolean' &&
        schemaValid &&
        optionalGate
        ? (value as unknown as AgentControlToolRequest)
        : null;
    },
    wait: (value: Record<string, unknown>): AgentControlToolRequest | null => {
      return hasOnlyKeys(value, ['operation', 'runIds', 'until', 'timeoutMs']) &&
        Array.isArray(value.runIds) &&
        value.runIds.length > 0 &&
        value.runIds.every((runId) => nonEmpty(runId)) &&
        new Set(value.runIds).size === value.runIds.length &&
        (value.until === 'all' || value.until === 'any') &&
        (value.timeoutMs === undefined ||
          (Number.isInteger(value.timeoutMs) &&
            (value.timeoutMs as number) >= 0 &&
            (value.timeoutMs as number) <= AGENT_WAIT_MAX_MS))
        ? (value as unknown as AgentControlToolRequest)
        : null;
    },
    report: parseRunIdOperation,
    stop: parseRunIdOperation,
    list: (value: Record<string, unknown>): AgentControlToolRequest | null => {
      return hasOnlyKeys(value, ['operation', 'status', 'cursor', 'limit']) &&
        (value.status === undefined ||
          ['creating', 'ready', 'active', 'parked', 'closed'].includes(value.status as string)) &&
        optionalString(value.cursor) &&
        Number.isInteger(value.limit) &&
        (value.limit as number) >= 1 &&
        (value.limit as number) <= 100
        ? (value as unknown as AgentControlToolRequest)
        : null;
    },
    message: (value: Record<string, unknown>): AgentControlToolRequest | null => {
      return hasExactKeys(value, ['operation', 'to', 'text']) &&
        nonEmpty(value.to) &&
        nonEmpty(value.text)
        ? (value as unknown as AgentControlToolRequest)
        : null;
    },
    dismiss: parseAgentIdOperation,
    resume: parseAgentIdOperation,
  } satisfies Record<AgentControlToolRequest['operation'], ClosedParser<AgentControlToolRequest>>;
  return parseClosed(parsers, value.operation, value);
}

function parseAgentControlToolResponse(value: unknown): AgentControlToolResponse | null {
  if (!isRecord(value)) return null;
  if (value.ok === true) {
    return hasExactKeys(value, ['ok', 'value'])
      ? (value as unknown as AgentControlToolResponse)
      : null;
  }
  const codes: readonly AgentServiceErrorCode[] = [
    'invalid-context',
    'forbidden',
    'mode-disabled',
    'not-found',
    'restart-lost',
    'other-owner',
    'invalid-state',
    'run-mismatch',
    'runtime-unavailable',
  ];
  return value.ok === false &&
    hasExactKeys(value, ['ok', 'code', 'error']) &&
    codes.includes(value.code as AgentServiceErrorCode) &&
    typeof value.error === 'string'
    ? (value as unknown as AgentControlToolResponse)
    : null;
}

/** MCP OAuth 凭据（只在 Main 加密持有；refresh 也只在 Main 做） */
export interface McpOAuthTokens {
  access_token: string;
  token_type?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

/** 下发 worker 的 MCP 访问凭据：只有 access token，refresh_token 与 client 信息不出 Main */
export interface McpOAuthAccess {
  access_token: string;
  /** 绝对过期时间（ms）；worker 据此提前向 Main 续期 */
  expires_at?: number;
}

/** Main 续期结果：unauthorized = 需要用户重新授权；否则为临时故障，凭据保留 */
export type McpOAuthRefreshResult =
  | { ok: true; access: McpOAuthAccess }
  | { ok: false; unauthorized: boolean; error: string };

/** MCP 连接状态：unauthorized = 需要用户在设置页完成 OAuth 授权；idle = 已授权待连接 */
export const MCP_CONNECTION_STATES = [
  'connecting',
  'ready',
  'unauthorized',
  'error',
  'idle',
] as const;

export type McpConnectionState = (typeof MCP_CONNECTION_STATES)[number];

/** spawn 下发的 MCP server 配置（McpServerEntry 的运行子集，不带 source） */
export interface McpServerSpawnConfig {
  /** 对应 McpServerEntry.id：状态回报与 token 归属的关联键 */
  id?: string;
  name: string;
  description?: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  /** http/sse 请求头 */
  headers?: Record<string, string>;
  /** 已授权的 OAuth 凭据（http/sse 远程 server） */
  oauth?: McpOAuthAccess;
  /** 连接 + listTools；缺省 10s */
  connectTimeoutMs?: number;
  /** 单次 callTool；缺省 120s */
  callTimeoutMs?: number;
  /** 仅会话级配置携带；deferred 经 `mcp` 代理工具按需连接 */
  loadMode?: 'deferred';
  /** deferred 目录用的工具名缓存（可能过期，以实时连接为准） */
  toolNames?: string[];
}

export interface ModelRef {
  providerId: string;
  modelId: string;
}

/**
 * bot-home：Bot 成员 / 群独立工作区的隐藏项目，只由 Main 创建，不投影给 renderer。
 * scratch：临时会话的隐藏项目，Main 登记，会投影给 renderer，但不能由 renderer 创建或删除。
 * secretary：秘书会话的隐藏项目，同 scratch，但不参与任何项目列表与手机目录。
 */
export type ProjectKind = 'local' | 'ssh' | 'bot-home' | 'scratch' | 'secretary';

export interface ProjectAuthority {
  projectId: string;
  /** ssh 项目时为远端绝对路径 */
  canonicalPath: string;
  /** 缺省 local（存量数据无此字段） */
  kind?: ProjectKind;
  /** ssh config 别名或 user@host；kind==='ssh' 时必有，否则禁止 */
  sshHost?: string;
  /** 设置里的连接档案；kind==='ssh' 时必有 */
  sshConnectionId?: string;
  sshConnectionName?: string;
  state: 'active' | 'removed';
  version: number;
}

export type ProjectAuthorityProjection = ProjectAuthority;

export const CONTEXT_OCCUPANCY_BUCKETS = [
  'system',
  'instructions',
  'skills',
  'tools',
  'conversation',
  'compaction',
  // 为已持久化的上下文占用快照保留；项目记忆功能已移除。
  'projectMemory',
  'reminders',
] as const;

export type ContextOccupancyBucketId = (typeof CONTEXT_OCCUPANCY_BUCKETS)[number];

export type ContextOccupancyBuckets = Record<ContextOccupancyBucketId, number>;

export type { ContextPart };

export interface ContextOccupancy {
  buckets: ContextOccupancyBuckets;
  used: number;
  estimated: boolean;
  compactedMessageCount: number;
  compactionModelMismatch: boolean;
  contextWindow?: number;
  percent?: number;
  compactionEntryId?: string;
  /** 最近一次压缩刚结束时的估算用量（固定开销 + 摘要 + 保留消息）；没压缩过缺省 */
  compactionTokensAfter?: number;
  /** 七类拆分条目（系统、工具、技能、指令、读入文件、工具输出、会话）；缺省时面板只显示分桶 */
  parts?: ContextPart[];
}

/** worker 按完整消息记录算的会话用量（手机只持有尾窗消息，靠它显示全量） */
export interface SessionUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheHitPercent?: number;
  ttftAvgMs?: number;
  tokensPerSecond?: number;
}

export interface ConversationForkOrigin {
  conversationId: string;
  entryId: string;
}

/** Bot 会话归属：只由 Main 写入；chatId 为 null 表示委派会话 */
export interface ConversationBotBinding {
  botId: string;
  chatId: string | null;
  delegationId?: string;
}

export interface ConversationAuthority {
  conversationId: string;
  projectId: string;
  kind: 'root';
  lifecycle: 'draft' | 'ready' | 'ended';
  version: number;
  sessionFile?: string;
  selection?: DefaultModelRef & { revision: number };
  forkedFrom?: ConversationForkOrigin;
  bot?: ConversationBotBinding;
}

export type ConversationAuthorityProjection = ConversationAuthority;

export interface SourceAuthorityProjection {
  projects: readonly ProjectAuthorityProjection[];
  conversations: readonly ConversationAuthorityProjection[];
}

export interface CreateProjectAuthorityRequest {
  requestId: string;
  path: string;
  kind?: ProjectKind;
  sshConnectionId?: string;
}

export interface SelectProjectAuthorityRequest {
  requestId: string;
  projectId: string;
  version: number;
}

export interface RemoveProjectAuthorityRequest {
  requestId: string;
  projectId: string;
  version: number;
}

export interface CreateConversationAuthorityRequest {
  requestId: string;
  projectId: string;
  projectVersion: number;
  /** 手机配对等已有 id：登记为 root，不再由 Main 另发 UUID */
  conversationId?: string;
  forkedFrom?: ConversationForkOrigin;
}

export interface ConversationAuthorityRequest {
  requestId: string;
  conversationId: string;
  version: number;
  /** 渲染层切换序号。更小的迟到 select 不得改写 Main 当前选中。 */
  selectionEpoch?: number;
  /**
   * 渲染进程这一轮的启动 id。重载或热替换会换新 id，Main 用它丢掉上一轮的迟到回写。
   * 同一个 id 内仍按 selectionEpoch 排序。
   */
  selectionBootId?: string;
}

export interface UpdateConversationSelectionRequest extends ConversationAuthorityRequest {
  selection: DefaultModelRef;
}

export type AuthorityMutationResult<T> =
  | { accepted: true; value: T }
  | { accepted: false; error: string };

export interface ResolvedAgentTypeSpawnConfig {
  typeKey: AgentTypeKey;
  displayName: string;
  description: string;
  spawnSpecId: string;
  systemPrompt: string;
  model: SpawnModelConfig;
  tools: 'all' | 'readonly';
  /**
   * 类型级推理预设（子代理类型上配置的档位）：优先级 派发 thinking > 类型预设 >
   * 模型条目预设 > 父会话。缺省 = 跟随模型条目/父会话。与 AgentTypeSpawnConfig 同语义。
   */
  reasoning?: ModelReasoningOverride;
  thinkingLevel?: ModelThinkingLevelOverride;
  /** Main 授权的 node/profile 精确交集；缺省时沿用 profile 的工具集。 */
  allowedToolIds?: readonly string[];
  skillPaths: readonly string[];
  skillBindingIds: readonly string[];
  mcpServers: readonly McpServerSpawnConfig[];
  mcpBindingIds: readonly string[];
  systemPromptHash: string;
}

export interface ResolvedChildProfileProof {
  spawnSpecId: string;
  typeKey: AgentTypeKey;
  model: ModelRef;
  toolIds: readonly string[];
  loadedSkillBindingIds: readonly string[];
  loadedMcpBindingIds: readonly string[];
  systemPromptHash: string;
}

export interface ChildConversationMetadata {
  parentId: string;
  childGeneration: string;
  agentTypeKey: AgentTypeKey;
  agentInstanceId: string;
  agentInstanceName: string;
  dispatchOrigin: 'typed-mention' | 'manual' | 'agent-tool';
  mode?: AgentMode;
  /** 仅历史 Enso child 的元数据带此值（读兼容） */
  lockedProfileId?: LegacyEnsoProfileId;
}

export interface SafeChildRef {
  sessionId: string;
  generation: string;
  instanceId: string;
  instanceName: string;
  typeKey: AgentTypeKey;
}

export type AgentSessionCustomEntry =
  | {
      kind: 'oauth-account-selected';
      accountKey: string;
      previousAccountKey?: string;
      /** 真实请求的池路由身份；旧历史缺省时不能用于额度展示。 */
      settingsProviderId?: string;
      modelId?: string;
      at: number;
    }
  | { kind: 'agent-dispatch'; child: SafeChildRef; at: number }
  | {
      kind: 'agent-completed';
      child: SafeChildRef;
      receiptSummary?: string;
      at: number;
    }
  | {
      kind: 'agent-failed';
      child: SafeChildRef;
      errorCode: string;
      message: string;
      at: number;
    }
  | { kind: 'capability-receipt'; receipt: CapabilityReceipt }
  /** 工具批次一句话标签：callId 为批次首个工具调用 id，时间线工具组头据此显示 */
  | { kind: 'tool-batch-label'; callId: string; label: string; at: number }
  /** 回合收尾时还有 count 个后台任务没表态：时间线一行灰色提醒 */
  | { kind: 'task-wrap-up-nudge'; count: number; at: number };

export type SafeJournalRecord =
  | { type: 'safe-user-text'; text: string; at: number }
  | { type: 'safe-assistant-text'; text: string; at: number }
  | {
      type: 'enso-operation';
      operationId: string;
      capabilityId: ProductSurfaceId;
      toolCallId: string;
      at: number;
    }
  | {
      type: 'safe-model-result';
      toolCallId: string;
      modelResult: CapabilityResult;
      at: number;
    }
  | { type: 'capability-receipt'; receipt: CapabilityReceipt; at: number };

export interface SafeJournalProjection {
  records: readonly SafeJournalRecord[];
  partial: boolean;
}

/** 已结束 child 的只读历史读取结果。失败一律给结构化码，渲染层据此决定是否重试。 */
export type ChildHistoryResult =
  | { ok: true; projection: SafeJournalProjection }
  | { ok: false; code: 'not-found' | 'unavailable'; error: string };

/**
 * 手动「重新读取会话」结果。来源由 Main 决定：会话在 worker 内存活着 → live 快照（带事件 seq 水位）；
 * 否则走 safe journal 只读投影（history）。失败一律给原因，渲染层保留旧内容并提示。
 */
export type ConversationReloadResult =
  | { ok: true; source: 'live'; snapshot: SessionSnapshot; seq: number }
  | { ok: true; source: 'history'; projection: SafeJournalProjection }
  /** 根会话不在 worker 里：pi jsonl 尾窗（baseIndex 为绝对起点，与上滑翻页契约一致） */
  | { ok: true; source: 'tail'; messages: ProjectedMessage[]; baseIndex: number }
  | { ok: false; error: string };

export type ParentHistoryTailResult =
  | { ok: true; messages: ProjectedMessage[]; baseIndex: number; projectId?: string }
  | { ok: false; code: 'not-found' | 'unavailable'; error: string };

export interface ChildRunSummary {
  childId: string;
  name: string;
  /** 任务标题。旧记录没有，界面退回去掉哈希的实例名 */
  title?: string;
  agentType?: string;
  startedAt: number;
  live: boolean;
  available: boolean;
}

export type ChildRunListResult =
  | { ok: true; items: ChildRunSummary[] }
  | { ok: false; code: 'invalid'; error: string };

export type DispatchProgressPhase =
  | 'received'
  | 'source-bound'
  | 'capacity-reserved'
  | 'parent-spawning'
  | 'parent-ready'
  | 'child-spawning'
  | 'child-ready'
  | 'task-dispatched'
  | 'running'
  | 'waiting-user'
  | 'waiting-approval';

export type DispatchTerminal = 'completed' | 'failed' | 'cancelled';

export type DispatchMainEvent =
  | {
      dispatchId: string;
      child: ChildSessionIdentity;
      mainSeq: number;
      phase: DispatchProgressPhase;
    }
  | {
      dispatchId: string;
      child: ChildSessionIdentity;
      mainSeq: number;
      phase: 'terminal';
      terminal: DispatchTerminal;
      receiptSummary?: string;
    };

/** Main → worker。所有 session 控制均携 exact generation。 */
export type AgentCommand =
  | {
      type: 'oauth-pool-result';
      requestId: string;
      accountKey?: string;
      selectionReceipt?: string;
      error?: string;
    }
  | { type: 'lock-workspace'; requestId: string; conversationIds: string[] }
  | { type: 'mcp-oauth-refresh-result'; requestId: string; result: McpOAuthRefreshResult }
  | { type: 'unlock-workspace'; requestId: string; conversationIds: string[]; branch?: string }
  | {
      type: 'spawn-parent';
      identity: SessionIdentity;
      cwd: string;
      model: SpawnModelConfig;
      resumeFile?: string;
      reasoningEnabled?: boolean;
      thinkingLevel?: ThinkingLevel;
      loadLocalSkills?: boolean;
      /** 同时加载项目内 .claude/.codex/.cursor 的 skills 与规则文件（.cursorrules、.cursor/rules） */
      loadHarnessAssets?: boolean;
      /** 用户已信任的项目代码来源（.pi/extensions、项目包等）；有未在此列的来源时整个项目的代码都不加载 */
      trustedProjectCode?: string[];
      /** 探后折叠工具 + context 折叠 */
      exploreFoldEnabled?: boolean;
      /** 文件编辑工具模式；缺省 apply_patch */
      editMode?: EditMode;
      /** @deprecated 仅用于读取旧 Main 命令；新代码发送 editMode。 */
      hashlineEditEnabled?: boolean;
      /** 上下文压缩策略；缺省 standard。与旧 smartCompactEnabled 过渡兼容。 */
      compactStrategy?: CompactStrategy;
      /** @deprecated 仅用于读取旧 Main 命令；新代码发送 compactStrategy。 */
      smartCompactEnabled?: boolean;
      /** 独立摘要模型；缺省跟随当前会话模型 */
      smartCompactSummaryModel?: SpawnModelConfig;
      /** 验证式压缩档位；缺省 auto（按占用跳档） */
      smartCompactMode?: import('../smartCompactMode').SmartCompactMode;
      /** 记忆存储语言（settings.memoryLanguage）；写进 memory_search 描述，让模型用对语言查 */
      memoryLanguage?: string;
      skillPaths?: string[];
      mcpServers?: McpServerSpawnConfig[];
      /** 已启用 Enso 插件的 agent 工具；执行经 plugin-tool-invoke 回到 Main */
      pluginTools?: PluginToolDescriptor[];
      /** 秘书自造工具；名字、描述与参数结构由 Main 下发，执行经 secretary-invoke 回到 Main */
      secretaryTools?: SecretaryToolDescriptor[];
      /** 已启用 Enso 插件的 workflow 预设文件（绝对路径，已按插件预设圈定） */
      workflowPresetFiles?: string[];
      /** 已启用插件的事件订阅；Bot 会话不下发 */
      pluginEvents?: PluginEventPlan;
      instruction?: { path: string; content: string };
      approvalMode?: ApprovalMode;
      /** 无人值守：需要人工确认的动作直接拒绝，不等真人 */
      autoRejectApprovals?: boolean;
      /** 秘书派出/跟踪的会话：ask_user 先转给秘书，名字用于原会话里的「已转给 X」 */
      askRelay?: { name: string };
      /** 助手代审模型；仅 approvalMode=assistant 时有意义 */
      approvalReviewer?: SpawnModelConfig;
      /** 代审改用分类器（System One）；与 approvalReviewer 互斥 */
      approvalReviewerClassifier?: VirtualClassifierCredentials;
      /** 分类器代审托管；只随 approvalReviewerClassifier 下发 */
      approvalReviewerManaged?: true;
      /** 分类器代审放行阈值（0.85 / 0.95）；缺省 0.9，只随 approvalReviewerClassifier 下发 */
      approvalReviewerAllowThreshold?: ApprovalAllowThreshold;
      agentTypes?: AgentTypeSpawnConfig[];
      subagentModels?: SubagentModelOption[];
      disabledTools?: string[];
      /** Windows 本地命令壳偏好；缺省 auto。远程会话忽略。 */
      windowsLocalShell?: WindowsLocalShell;
      /** 内置 RTK；未设置时默认启用。 */
      rtkEnabled?: boolean;
      /** dcg 命令守卫二进制；Main 仅在启用且已安装时下发 */
      dcgPath?: string;
      /** 用户按规则记忆豁免的 dcg rule_id（仅当前 dcg 版本有效） */
      dcgExemptRules?: string[];
      /** 额外启用的 dcg pack（如 system.processes）；仅 0.17.2+ 二进制可识别，由 Main 按版本门控下发 */
      dcgExtraPacks?: string[];
      /** ssh 项目：工具执行切到远端。Main 从项目权威派生，不信任 renderer。 */
      remote?: AgentRemoteConfig;
      /** 旁路会话：首条 prompt 前缀注入，消费一次 */
      rolePrompt?: string;
      /** 复盘旁路：从该父会话分叉消息序列（注入其最近一次请求的消息快照，命中同一份提示缓存）。
       *  源会话不存在、已换模型或还没有任何请求时静默降级为普通旁路。 */
      forkFrom?: string;
      /** 仅普通 parent：替换 pi 默认提示词开头的角色段落，其余运行时内容保留 */
      systemPrompt?: string;
      /** skills/cwd 之后的真尾段 */
      systemPromptAppend?: string;
      /** 真尾之后的短覆盖块 */
      systemPromptBoost?: string;
      /** 推脱时内部补发的那一句；缺省不重试 */
      refusalRetryPrompt?: string;
      botMode?: boolean;
      /** Bot 群聊成员会话：挂 group_tasks / group_history 工具（私聊 / 委派子会话不挂） */
      botGroupTasks?: boolean;
      /**
       * Bot 讨论模式（实验性）开启：群聊成员会话的 delegate 说明加讨论接力句。只能与 botMode + botGroupTasks
       * 同时为 true；缺省 / false 时文案与 main 一致。worker 与 Main 同包发布，不存在跨版本组合。
       */
      botDiscussMode?: boolean;
      /**
       * Main 给这次 spawn 出的实例分配的号（UUID，目前只有 Bot 宿主传）。worker 存在会话上，parent-ended 回显它；
       * 同代会话仍在而短路回 parent-ready 时改绑成这个号。与 generation 正交，不参与授权键。
       */
      instanceId?: string;
      /** Bot 私聊 / 群聊成员会话（非委派）：挂 routine_propose / send_image 工具 */
      botRoutines?: boolean;
      /**
       * 秘书会话：worker 按名字做工具允许列表，插件、MCP、codemode、子代理一律不挂。
       * 由 Main 按项目 kind 决定，renderer 传不进来。
       */
      secretaryMode?: boolean;
      /** Bot 挂看板任务的委派会话：挂 report_blocked 工具 */
      botDelegationTask?: boolean;
      /** Bot 写成员：同工作区按文件占用、全局命令短独占；祖先会话（委派链）互不阻塞 */
      botWriteLock?: { label: string; ancestors: string[] };
      /** 受保护动作底线（Bot 会话恒开；Code 会话由设置项决定） */
      protectedActions?: boolean;
      /**
       * 仅秘书会话：秘书资料里 owner 标记信任的插件 id。完全放行档且本轮由 owner 亲手触发时，
       * 这些插件的非只读工具不再逐次确认，受保护动作底线照常生效。
       */
      secretaryTrustedPluginIds?: string[];
      /** 期望的 Plan 模式；与会话 jsonl 折叠结果不同时由 worker 追加切换条目 */
      planMode?: boolean;
    }
  | {
      type: 'spawn-child';
      identity: ChildSessionIdentity;
      cwd: string;
      config: ResolvedAgentTypeSpawnConfig;
      resumeFile?: string;
      seedContext?: SubagentSeedContext;
    }
  | {
      type: 'prompt-child';
      identity: ChildSessionIdentity;
      requestId: string;
      task: AgentDispatchTask;
      /** 子代理 Run：按请求软预算计数。Bot 成员等派发不带此标记，不计数。 */
      requestBudget?: true;
    }
  | {
      type: 'agent-control-result';
      identity: SessionIdentity | ChildSessionIdentity;
      requestId: string;
      response: AgentControlToolResponse;
    }
  | {
      type: 'dismiss-child';
      parent: SessionIdentity;
      child: ChildSessionIdentity;
      notify?: boolean;
    }
  | {
      /** 解雇 worker 直雇 coworker（普通身份，不在 Main sessions 索引）；
       * 双形状过渡命令，统一到 typed child 后可删 */
      type: 'dismiss-coworker';
      parent: SessionIdentity;
      coworkerId: string;
      notify?: boolean;
    }
  | {
      /** 重启后恢复 worker 直雇 coworker：name/agentType/resumeFile 全部由 Main
       * 从自己读的持久化取，渲染层不参与；双形状过渡命令 */
      type: 'resume-coworker';
      parent: SessionIdentity;
      coworkerId: string;
      name: string;
      agentType?: string;
      resumeFile: string;
    }
  | ({
      identity: SessionIdentity;
      text: string;
      images?: AttachedImage[];
      /** Bot 插话仅允许进入活轮；不再忙时交回 Main 重新准入。 */
      activeOnly?: true;
      /**
       * Main 认定这条是 owner 亲手输入（应用输入框、配对手机、秘书联系方式里绑定的本人），必须带 deliveryId。
       * 秘书会话据此判断「本轮由 owner 触发」：Main 自己的投递（会话回传、同事消息、触发器、定时）不带。
       */
      ownerInput?: true;
      /**
       * 仅 prompt：带新消息的断点续跑（委派续跑附说明 / 验收原因 / 群背景新增）。worker 在空闲会话上开新轮前
       * 先按 retry 的语义把未完成（error / aborted / 停在工具调用）的最后一条 assistant 移出模型上下文；
       * 会话仍在流式时照常插话。旧 worker 不认此字段会整条拒收；worker 由 Main 经 `?modulePath` 随同一次构建
       * 打进同一应用包、启动时 fork，随应用退出，不存在跨版本组合。
       */
      resume?: true;
      /**
       * 仅父会话：这条命令发往的实例号（见 spawn-parent.instanceId）。会话不在而被拒时 parent-rejected 原样回显，
       * Main 据此认出拒绝属于哪个实例。
       */
      instanceId?: string;
    } & (
      | {
          type: 'prompt';
          /** 投递标识：worker 在对应 user 消息上屏后以 delivery-settled 回执，没进 pi 时以 delivery-rejected 回执 */
          deliveryId: string;
        }
      | {
          type: 'steer';
          /** renderer 乐观回显的投递标识；worker 在对应 user 消息上屏后以 delivery-settled 回执 */
          deliveryId?: string;
        }
    ))
  | { type: 'set-model'; identity: SessionIdentity; model: SpawnModelConfig }
  | { type: 'set-thinking'; identity: SessionIdentity; level: ThinkingLevel }
  /** 仅带人设 spawn 的父会话（秘书）：就地换系统提示词，下一轮生效 */
  | { type: 'set-system-prompt'; identity: SessionIdentity; systemPrompt: string }
  | {
      type: 'set-reasoning';
      identity: SessionIdentity;
      enabled: boolean;
      level?: ThinkingLevel;
    }
  | {
      type: 'approval-respond';
      identity: SessionIdentity;
      requestId: string;
      decision: ApprovalDecision;
    }
  | {
      type: 'request-timeout';
      identity: SessionIdentity;
      kind: 'approval' | 'ask';
      requestId: string;
    }
  /** Main 记录的子代理 Run 结束且模型尚未知情：投给父会话（空闲唤醒、忙时搭车） */
  | { type: 'agent-notify'; identity: SessionIdentity; text: string; urgent: boolean }
  | {
      type: 'set-approval-mode';
      identity: SessionIdentity;
      mode: ApprovalMode;
      /** 省略表示不改动无人值守开关 */
      autoReject?: boolean;
    }
  /** 秘书派出/跟踪的会话：ask_user 先转给秘书；缺省 relay 表示恢复成直接问用户 */
  | { type: 'set-ask-relay'; identity: SessionIdentity; relay?: { name: string } }
  | { type: 'set-plan-mode'; identity: SessionIdentity; active: boolean }
  | {
      type: 'plan-respond';
      identity: SessionIdentity;
      planId: string;
      action: PlanRespondAction;
      feedback?: string;
    }
  | {
      type: 'set-approval-reviewer';
      model?: SpawnModelConfig;
      /** 与 model 互斥 */
      classifier?: VirtualClassifierCredentials;
      /** 托管：只随 classifier 下发 */
      managed?: true;
      /** 放行阈值；缺省 0.9，只随 classifier 下发 */
      allowThreshold?: ApprovalAllowThreshold;
    }
  /** 已打开会话的压缩摘要模型。缺省 model 表示改跟会话模型 */
  | { type: 'set-compact-route'; model?: SpawnModelConfig; mode?: SmartCompactMode }
  | { type: 'set-max-active-coworkers'; limit: number }
  /** 自动重试次数：0 关闭，-1 无限 */
  | { type: 'set-auto-retry-limit'; limit: number }
  /** 长缓存：会话请求对 Anthropic Messages 模型用 1h prompt cache，下一次请求生效 */
  | { type: 'set-long-cache-retention'; enabled: boolean }
  /** agy CLI：二进制路径、跳过权限、探测缓存的模型。空路径表示从 PATH 查找。 */
  | {
      type: 'set-agy-config';
      binaryPath: string;
      skipPermissions: boolean;
      models: { id: string; name: string }[];
    }
  /** 「记录应用日志」热切换：worker 的 agent.log / compaction.log 是否落盘 */
  | { type: 'set-app-logging'; enabled: boolean }
  /** 设置里禁用的内置预设：worker 执行与工具说明都按它过滤 */
  | { type: 'set-disabled-workflow-presets'; ids: string[] }
  /** 设置变更后 Main 按会话推送当前禁用的内置工具；worker 只增删已注册的可热切工具 */
  | { type: 'set-builtin-tools'; identity: SessionIdentity; disabledTools: string[] }
  | { type: 'set-web-search-config'; chain: WebSearchChainEntry[]; configured?: boolean }
  /** 专用生图模型；null 显式撤销旧配置。密钥只在 Main → worker 方向传递。 */
  | { type: 'set-image-generation-config'; config: ImageGenerationConfig | null; error?: string }
  /** 隐私脱敏配置：worker 全局生效，不重启会话 */
  | { type: 'set-privacy-masking'; settings: PrivacyMaskSettings }
  /** 全局 settings.shell 经 resolveShellLimits 规范化后的命令时限；worker 级后台任务管理器共用 */
  | { type: 'set-shell-limits'; limits: ShellLimits }
  /** 统一模型目录 + 自定义 provider 全量注册信息。载荷在 worker 内再收窄。 */
  | { type: 'set-model-directory'; snapshot: unknown; customProviders: unknown }
  | { type: 'compact'; identity: SessionIdentity; instructions?: string }
  | {
      type: 'ask-respond';
      identity: SessionIdentity;
      requestId: string;
      answer: string;
      /** 谁答的：缺省是用户亲手答；relay 是秘书代答（原会话据此显示「X 已回答」） */
      by?: 'user' | 'relay';
      /** 代答的秘书名字 */
      name?: string;
    }
  | {
      type: 'browser-result';
      identity: SessionIdentity | ChildSessionIdentity;
      requestId: string;
      ok: boolean;
      result?: unknown;
      error?: string;
    }
  | {
      type: 'memory-result' | 'delegation-result';
      identity: SessionIdentity | ChildSessionIdentity;
      requestId: string;
      ok: boolean;
      result?: unknown;
      error?: string;
    }
  | {
      type: 'secretary-result';
      identity: SessionIdentity;
      requestId: string;
      ok: boolean;
      result?: unknown;
      error?: string;
    }
  /** 按会话 id 寻址：会话不必已打开；worker 校验任务归属 */
  | { type: 'task-stop'; sessionId: string; taskId: string }
  /** 用户手动保留（可附理由）；reason 为 null 取消保留 */
  | { type: 'task-keep'; sessionId: string; taskId: string; reason: string | null }
  /** 按会话 id 寻址：把已到点的自定提醒交给会话；会话没打开就不动，打开时补发 */
  | { type: 'reminders-fire'; sessionId: string }
  /** 清掉根会话及其子会话的自定提醒与链计数（用户停止、删除、归档） */
  | { type: 'reminders-clear'; sessionId: string }
  | { type: 'tool-background'; identity: SessionIdentity; toolCallId: string }
  | { type: 'workflow-stop'; identity: SessionIdentity; runId: string }
  | { type: 'subagent-stop'; identity: SessionIdentity; agentId: string }
  | {
      type: 'computer-result';
      identity: SessionIdentity | ChildSessionIdentity;
      requestId: string;
      ok: boolean;
      result?: unknown;
      error?: string;
    }
  | {
      type: 'plugin-tool-result';
      identity: SessionIdentity;
      requestId: string;
      ok: boolean;
      result?: unknown;
      error?: string;
    }
  | {
      type: 'plugin-intercept-result';
      identity: SessionIdentity;
      requestId: string;
      ok: boolean;
      result?: unknown;
      error?: string;
    }
  | {
      type: 'plugin-tool-progress';
      identity: SessionIdentity;
      requestId: string;
      text: string;
    }
  | {
      type: 'plugin-inject';
      identity: SessionIdentity;
      pluginId: string;
      pluginName: string;
      text: string;
      images?: PluginInjectImage[];
      deliverAs: 'steer' | 'followUp' | 'nextTurn';
      triggerTurn: boolean;
      origin?: PluginInjectOrigin;
      sender?: PluginInjectSender;
      ownerConfirm?: boolean;
    }
  | {
      type: 'rewind';
      identity: SessionIdentity;
      entryId?: string;
      /** 仅供旧版手机客户端使用；桌面端回退使用持久化的 entryId。 */
      userIndexFromEnd?: number;
      restoreFiles?: boolean;
    }
  | {
      type: 'fork';
      identity: SessionIdentity;
      targetConversationId: string;
      entryId?: string;
      /** 轮次输入（用户消息或插件投递）从末尾数第几条 */
      turnIndexFromEnd?: number;
    }
  | { type: 'abort'; identity: SessionIdentity }
  | {
      /** 标题总结：一次性补全，不创建会话、不落盘；worker 按序尝试 candidates（递增超时），
       *  任一成功回 title-generated，全失败回 title-failed */
      type: 'summarize-title';
      conversationId: string;
      input: TitleSummaryInput;
      /** 回退链上全部可解析候选，按优先级排序；1–3 项 */
      candidates: SpawnModelConfig[];
    }
  | {
      /** 通用一次性文本补全（记忆蒸馏 / btw）：同 summarize-title 的候选链语义，结果经 text-completed / text-failed 按 requestId 回流 */
      type: 'complete-text';
      requestId: string;
      systemPrompt: string;
      userText: string;
      candidates: SpawnModelConfig[];
      timeoutMs: number;
      maxTokens?: number;
      /** 为 true 时额外推 text-delta；记忆蒸馏不设 */
      stream?: true;
      /** 透传 streamSimple/completeSimple 的思考档；off 表示关闭 */
      reasoning?: ThinkingLevel | 'off';
      /** 连通性探测：只判模型是否响应，被预算截断或只输出思考也算完成 */
      probe?: true;
    }
  | {
      /** 中止一次性文本补全（btw / 记忆蒸馏）；无会话身份，按 requestId 对准 */
      type: 'abort-complete-text';
      requestId: string;
    }
  | {
      /** 一次性 pi 分类器 choice 问题（群聊智能选人）；结果经 choice-classified / choice-failed 按 requestId 回流 */
      type: 'classify-choice';
      requestId: string;
      classifier: VirtualClassifierCredentials;
      state: Record<string, unknown>;
      instructions: string;
      criteria: Record<string, string>;
      timeoutMs: number;
    }
  | { type: 'abort-classify-choice'; requestId: string }
  | { type: 'abort-retry'; identity: SessionIdentity }
  /** 撤回模型尚未取用的插话；撤回成功以 delivery-rejected 回执，已取用则无事发生 */
  | { type: 'withdraw-steer'; identity: SessionIdentity; deliveryId: string }
  /** instanceId 同 prompt：会话不在而被拒时 parent-rejected 回显 */
  | {
      type: 'retry';
      identity: SessionIdentity;
      instanceId?: string;
      /** 只移出未完成（出错/中断/停在工具调用）的最后一条 assistant；已正常完成则回执 nothing-to-retry */
      unfinishedOnly?: true;
      /** 子代理续跑：沿用 Main 的 runId 作为本轮 turnId，并像 prompt-child 一样计请求预算 */
      turnId?: string;
      requestBudget?: true;
      /** 子代理续跑：之前各段已用的模型请求数，预算接着累计 */
      requestsUsed?: number;
    }
  /** 释放父会话：中断并销毁 worker 侧会话（含全部 coworker/child），jsonl 留盘可 resume。
   *  用于 Move to worktree 等需要换 cwd 重新 spawn 的场景。 */
  | { type: 'release-parent'; identity: SessionIdentity }
  | {
      type: 'append-session-custom-entry';
      identity: SessionIdentity;
      entry: AgentSessionCustomEntry;
    }
  | { type: 'snapshot'; sessionId?: string }
  | { type: 'reload-session'; requestId: string; sessionId: string }
  /** 不可被闲置回收的会话全集（桌面正在查看 + 手机订阅中），每次全量覆盖 */
  | { type: 'pin-sessions'; sessionIds: string[] }
  | { type: 'warm-mcp'; servers: McpServerSpawnConfig[] }
  /** 插件经 Main 列 / 调宿主 MCP 工具；服务配置由 Main 下发，凭据不经插件 */
  | { type: 'plugin-mcp-list'; requestId: string; servers: McpServerSpawnConfig[] }
  | {
      type: 'plugin-mcp-call';
      requestId: string;
      servers: McpServerSpawnConfig[];
      server: string;
      tool: string;
      args: Record<string, unknown>;
    }
  | { type: 'plugin-mcp-cancel'; requestId: string }
  /** 插件经 Main 在发起会话旁跑一个临时只读代理：用该会话的模型，不进会话记录 */
  | {
      type: 'plugin-agent-run';
      requestId: string;
      identity: SessionIdentity;
      prompt: string;
      systemPrompt?: string;
      context: 'conversation' | 'fork' | 'none';
      timeoutMs: number;
      /** 插件设置里选的模型；缺省跟随该会话 */
      model?: SpawnModelConfig;
    }
  | { type: 'plugin-agent-cancel'; requestId: string }
  /** 运行中同步代理 env；null 表示删除该键 */
  | { type: 'set-proxy-env'; env: Record<string, string | null> }
  /**
   * 优雅重启：等所有会话到安全点后落断点，回 graceful-restart-ready，由 Main 换新进程。
   * keepBackgroundTasks：应用会重新打开，能脱离 worker 的转后台命令交给下一代，安全点不等它们
   */
  | { type: 'graceful-restart'; keepBackgroundTasks?: true }
  /** 终止 worker 前：把能脱离的后台命令交出去、写恢复清单，回 background-tasks-detached */
  | { type: 'detach-background-tasks' };

/** 随消息附带的图片（base64）。id 只活在编辑器，发给 agent 前剥掉。 */
export interface AttachedImage {
  data: string;
  mimeType: string;
  id?: string;
}

/** 渲染层可见的消息内容片段。白名单投影，未识别的类型收敛为 unknown */
export type ProjectedPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'toolCall'; id: string; name: string; arguments?: unknown }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'unknown' };

/** assistant 消息的 token 用量（白名单投影自 pi 的 usage） */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** 一条 assistant step 的性能读数（hover 操作条显示；由渲染层从 timing 现算） */
export interface TurnPerf {
  /** 该 step 墙钟耗时（ms） */
  runMs: number;
  /**
   * 整轮活跃耗时（ms）：各模型请求 + 非交互工具执行，不含用户回答、审批及排队等待。
   * 仅多 step 轮次的末 step（已完结）带；单 step 轮次与 runMs 重复，不带。
   */
  turnMs?: number;
  /** 首 token 延迟（ms） */
  ttftMs?: number;
  /** 解码吞吐（tok/s） */
  tps?: number;
}

/** 单条 assistant step 的计时打点（worker 侧填，随 message-upsert 下发） */
export interface MessageTiming {
  /** step 开始：发起模型请求的 turn_start 时刻（缺省为 message_start） */
  stepStartMs: number;
  /** 首 token：首个 message_update 时刻 */
  firstTokenMs?: number;
  /** 思考结束：首个非 thinking 的可见输出（正文/工具调用）出现时刻 */
  thinkingEndMs?: number;
  /** step 完成：message_end 时刻 */
  completedMs?: number;
}

/** 重启等安全点时回复在写的会话：这次模型请求的发出 / 首 token / 最近一次出 token 时刻 */
export interface RestartReplyProgress {
  requestStartMs: number;
  firstTokenMs?: number;
  /** 正文、思考、工具参数的增量都算出 token */
  lastOutputMs?: number;
}

/** todo 工具的清单项（toolResult.details 透出，整表替换语义） */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** 跨进程边界收窄 todo 清单：每项都得是 TodoItem，否则整份拒绝 */
function isTodoList(value: unknown): value is TodoItem[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        typeof item.content === 'string' &&
        (item.status === 'pending' || item.status === 'in_progress' || item.status === 'completed')
    )
  );
}

/** 渲染层可见的消息投影：pi AgentMessage 的白名单克隆 */
export interface ProjectedCodemodeCall {
  name: string;
  ok: boolean;
  error?: string;
  summary?: string;
}

export interface ProjectedMessage {
  /** 已持久化的 user entry 标识；未确认的消息没有该字段。 */
  entryId?: string;
  /** 任意角色的 jsonl entry 标识；仅秘书只读链路按需附带，跨分页定位消息用 */
  messageId?: string;
  rtk?: RtkToolStats;
  /** 前台命令被移交为后台任务时的任务 id */
  backgroundTaskId?: string;
  /** bash / powershell 结果的结构化失败分类 */
  shellFailure?: ShellFailure;
  /** dcg warn 档命中：不拦，只提示 */
  dcgWarning?: DcgWarning;
  /** 插件工具写出的产出文件 */
  pluginArtifacts?: PluginArtifactInfo[];
  /** ImageGen 已落盘的本地图片，含 codemode 嵌套生成的产物。 */
  generatedImages?: string[];
  /** 插件注入的消息（role=custom）的来源 */
  pluginSource?: PluginMessageSource;
  role: string;
  content: ProjectedPart[];
  /** toolResult 消息附带 */
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
  usage?: TokenUsage;
  /** assistant 消息的模型 id，用于会话区每轮回复的身份头 */
  model?: string;
  /** pi-ai 在流上打的首 token 延迟（ms）；优先于本地 timing */
  ttft?: number;
  /** pi-ai 整次请求墙钟（ms，含 TTFT/思考） */
  duration?: number;
  /** 该 step 的计时打点（仅 assistant 消息带） */
  timing?: MessageTiming;
  /** 应用重启时写到一半被中止、新进程已在后面接着写的回复（仅 assistant）：时间线折叠成一行 */
  restartResumed?: boolean;
  /** todo 工具 toolResult 的清单快照 */
  todos?: TodoItem[];
  /** 工具执行耗时（仅 toolResult 消息带；worker 按 tool_execution_start/end 打点，不含排队） */
  toolDurationMs?: number;
  /** subagent 工具 toolResult 的执行元数据 */
  subagentMeta?: { modelId?: string; outputTokens?: number; steps?: number };
  /** Hashline edit 成功结果：补丁前后全文（不含 patch） */
  editDiff?: { oldText: string; newText: string };
  /** apply_patch toolResult 中已确实落盘的物理文件操作 */
  fileChanges?: ProjectedFileChange[];
  /** 托管代审判定记录（放行或拒绝） */
  approvalReview?: ApprovalReviewRecord;
  /** apply_patch 完整终态清单，不依赖普通 content 截断预算 */
  applyPatchOutcome?: ProjectedApplyPatchOutcome;
  /** codemode toolResult 的嵌套调用摘要（details.calls） */
  codemodeCalls?: ProjectedCodemodeCall[];
  /** compactionSummary 消息：压缩前的上下文 token 数 */
  tokensBefore?: number;
  /** 摘要来自 Enso compact hook，不是原生 summarizer */
  verified?: boolean;
  /** 产生这条 assistant 回复的请求的脱敏报告（不含原值） */
  privacyMask?: MaskReport;
  /** 摘要由持续记忆 ledger 渲染（非智能压缩兜底） */
  memory?: boolean;
}

export interface SessionSnapshot {
  identity: SessionIdentity;
  status: NodeStatus;
  messages: ProjectedMessage[];
  /**
   * messages 的绝对起始 index。尾窗快照（手机 pair / 桌面 resume 首包）会设置：
   * 长对话只发最近一段；全量快照缺省或 0。
   */
  baseIndex?: number;
  commands: SlashCommand[];
  requestBody?: RequestBodyUsage;
  pendingApprovals?: ApprovalRequestInfo[];
  pendingAsks?: AskRequestInfo[];
  backgroundTasks?: BackgroundTaskInfo[];
  subagents?: SubagentInfo[];
  child?: ChildConversationMetadata;
  customEntries?: AgentSessionCustomEntry[];
  safeJournal?: SafeJournalProjection;
  /** 压缩进度：重连/刷新后重建投影用（compaction 是瞬时事件，不重放） */
  compaction?: 'queued' | 'running';
  /** 仅父会话：Plan 模式折叠结果（jsonl 权威的投影） */
  planState?: PlanState;
  /** 压完提示的锚点，**绝对消息 index** 口径（压完那刻 messages.length），不随 baseIndex 平移 */
  compactionNoticeAt?: number;
}

/** 手动只读快照的水位仅用于重读，不改变自动 snapshot 的兼容契约。 */
export type SessionReloadResult =
  | { ok: true; snapshot: SessionSnapshot; seq: number }
  | { ok: false; error: string };

/** 会话可用的斜杠命令（pi 的 skills 与 prompt templates），name 含 / 前缀 */
export interface SlashCommand {
  name: string;
  description: string;
}

/** ssh 远程执行配置（spawn-parent 携带，worker 据此分流工具） */
export interface AgentRemoteConfig {
  /** ssh config 别名或 user@host */
  host: string;
  auth: 'key' | 'password';
  port?: number;
  /** 仅 password 认证、仅 spawn 内存,禁止落盘 */
  password?: string;
  /** 远端单次命令超时（设置项 sshTimeoutSeconds） */
  timeoutSeconds?: number;
}

/** 普通新会话 Renderer 请求；child 派发不复用此结构。 */
export interface AgentSpawnRequest {
  sessionId: string;
  providerId: string;
  modelId: string;
  cwd: string;
  resumeFile?: string;
  reasoningEnabled?: boolean;
  thinkingLevel?: ThinkingLevel;
  loadLocalSkills?: boolean;
  disabledTools?: string[];
  presetId?: string;
  approvalMode?: ApprovalMode;
  /** 无人值守：新会话一起带上该开关，避免恢复后悄悄变回「等人确认」 */
  autoRejectApprovals?: boolean;
  /** 秘书派出/跟踪的会话：ask_user 先转给秘书；恢复时一起带上，避免悄悄变回直接问用户 */
  askRelay?: { name: string };
  planMode?: boolean;
  /** 追加到系统提示词尾部的文本；headless run 等宿主注入场景提示用，不改动预设本身 */
  systemPromptAppend?: string;
}

export interface AgentActionResult {
  ok: boolean;
  error?: string;
}

/** worker 不持有该会话（闲置回收 / worker 重启 / 换代）时拒绝 prompt/steer 的原因前缀 */
export const STALE_SESSION_ERROR = 'unknown or stale session generation';

export type ParentLifecycleEvent =
  | {
      type: 'parent-ready';
      identity: SessionIdentity;
      seq: number;
      sessionFile: string;
      model: ModelRef;
      /** 当前模型是否接收图片输入；Main 据此决定转发的图是给图片块还是只给路径 */
      imageInput?: boolean;
    }
  | {
      /**
       * 已启动会话就地换模型成功。Main 必须据此更新 agentSessionIndex 的
       * 已启动模型，否则后续派发的 selection 校验会永远对不上（见 issue #30）。
       */
      type: 'model-changed';
      identity: SessionIdentity;
      seq: number;
      model: ModelRef;
      imageInput?: boolean;
    }
  | {
      type: 'parent-rejected';
      identity: SessionIdentity;
      seq: number;
      reason: string;
      /** 被拒命令自己带的实例号（spawn-parent / prompt / steer / retry）；命令没带则缺省 */
      instanceId?: string;
    }
  | {
      type: 'parent-ended';
      identity: SessionIdentity;
      seq: number;
      reason: string;
      /** 被结束实例最近一次 spawn-parent 绑定的实例号；没绑过则缺省 */
      instanceId?: string;
    };

export type ChildLifecycleEvent =
  | {
      type: 'child-reserved';
      identity: ChildSessionIdentity;
      seq: number;
      requestId: string;
      metadata: ChildConversationMetadata;
    }
  | {
      type: 'child-ready';
      identity: ChildSessionIdentity;
      seq: number;
      sessionFile: string;
      proof: ResolvedChildProfileProof;
    }
  | {
      type: 'child-rejected';
      identity: ChildSessionIdentity;
      seq: number;
      reason: string;
    }
  | { type: 'child-ended'; identity: ChildSessionIdentity; seq: number; reason: string };

export type RendererChildLifecycleEvent =
  | Exclude<ChildLifecycleEvent, { type: 'child-ready' }>
  | Omit<Extract<ChildLifecycleEvent, { type: 'child-ready' }>, 'proof'>;

/** Renderer 收到统一普通+child事件流；exact profile proof 只在 worker→Main 边界。 */
export type RendererAgentEvent =
  | Exclude<
      AgentWorkerEvent,
      | ChildLifecycleEvent
      | McpWorkerEvent
      | WorkspaceLockEvent
      | PluginMcpResultEvent
      | PluginAgentWorkerEvent
      | { type: 'oauth-pool-select' }
      | { type: 'privacy-mask-ledger' }
      | { type: 'tool-batch-completed' }
      | { type: 'graceful-restart-deferred' }
      | { type: 'graceful-restart-ready' }
      | { type: 'background-tasks-detached' }
      | { type: 'session-wake-requested' }
      | { type: 'session-reminder-due' }
      | { type: 'session-reminders-changed' }
      | Extract<
          AgentWorkerEvent,
          {
            type:
              | 'agent-control-invoke'
              | 'agent-control-cancel'
              | 'computer-invoke'
              | 'computer-cancel'
              | 'plugin-tool-invoke'
              | 'plugin-tool-cancel'
              | 'plugin-event'
              | 'plugin-intercept';
          }
        >
      | { type: 'session-reloaded' }
    >
  | RendererChildLifecycleEvent
  | WorkerExitedEvent;

/** detail：Main 汇总的退出原因（退出码 / worker 致命异常首行） */
export type WorkerExitedEvent = { type: 'worker-exited'; detail?: string };

/** 优雅重启换代（Main 不退）：旧 worker 已按断点退出，会话由下一代接着跑；只给 Main 内部，不进会话广播 */
export type WorkerSwappedEvent = { type: 'worker-swapped' };

export function workspaceBranchChangedNote(branch: string): string {
  return `<workspace-branch-changed>\nThe current workspace is now on Git branch ${JSON.stringify(branch)}. The directory is unchanged, but file contents may differ. Re-read relevant files before relying on earlier observations or edits. This is background information only, not a task or goal.\n</workspace-branch-changed>`;
}

/** worker 等待 Main 回复的插件事件；载荷类型按事件绑定 */
export type PluginInterceptRequest =
  | { event: 'before_compact'; payload: { reason: string } }
  | {
      [E in PluginInterceptEvent]: { event: E; payload: InterceptPayload[E] };
    }[PluginInterceptEvent];

export type WorkspaceLockEvent =
  | { type: 'workspace-lock-result'; requestId: string; ok: boolean; error?: string }
  | { type: 'workspace-unlock-result'; requestId: string; ok: boolean; error?: string };

export type PluginMcpResultEvent =
  | { type: 'plugin-mcp-result'; requestId: string; ok: true; value: unknown }
  | { type: 'plugin-mcp-result'; requestId: string; ok: false; error: string };

export type PluginAgentWorkerEvent = {
  type: 'plugin-agent-event';
  requestId: string;
  event: PluginAgentRunEvent;
};

/** retry-skipped 的原因：busy = 会话不空闲；nothing-to-retry = 最后一条仍是已完成的 assistant */
export const RETRY_SKIPPED_REASONS = ['busy', 'nothing-to-retry'] as const;
export type RetrySkippedReason = (typeof RETRY_SKIPPED_REASONS)[number];

export type AgentWorkerEvent =
  /** 会话外（辅助补全 / compaction）的脱敏记录，Main 写 ledger */
  | { type: 'privacy-mask-ledger'; record: PrivacyMaskRecord }
  | {
      type: 'oauth-pool-select';
      requestId: string;
      settingsProviderId: string;
      modelId: string;
      failed?: OauthPoolFailure;
      excludedAccountKeys?: string[];
    }
  | WorkspaceLockEvent
  | PluginMcpResultEvent
  | PluginAgentWorkerEvent
  | ParentLifecycleEvent
  | ChildLifecycleEvent
  | {
      type: 'workspace-branch-context-consumed';
      identity: SessionIdentity;
      seq: number;
      requestId: string;
    }
  | { type: 'delivery-settled'; identity: SessionIdentity; seq: number; deliveryId: string }
  | {
      type: 'delivery-rejected';
      identity: SessionIdentity;
      seq: number;
      deliveryId: string;
      /** 上一轮停不下来，限时内等不到空闲：重发多半还会撞上，要重开会话 */
      reason?: 'turn-stuck';
    }
  | { type: 'delivery-deferred'; identity: SessionIdentity; seq: number; deliveryId: string }
  | {
      type: 'status';
      identity: SessionIdentity;
      seq: number;
      status: NodeStatus;
      error?: string;
      /** running 时带上当前回合 id：Main 退出记录靠它把中断归到具体一轮 */
      turnId?: string;
    }
  | {
      type: 'message-upsert';
      identity: SessionIdentity;
      seq: number;
      index: number;
      message: ProjectedMessage;
    }
  | {
      type: 'turn-completed';
      identity: SessionIdentity;
      seq: number;
      turnId: string;
      /** worker 切出的本轮压缩摘要，供 renderer 决定是否滚动刷新标题；纯工具轮可缺省 */
      digest?: TurnDigest;
      /** 本轮结论原文（截尾）：提交号、测试数字通常在末尾，摘要的 1500 字装不下 */
      report?: TurnReport;
      /** 本轮被 abort 命令中断：不自动泵队列、不续跑目标（发起中断的未必是本窗口） */
      aborted?: true;
      /** 子代理因请求预算被强制停止：已有部分输出随本次收口交回，不当作失败 */
      requestBudgetStop?: true;
      /** 预算停止后补报告那一轮出错：错误随结果交回，不丢已有输出 */
      requestBudgetError?: string;
      /** 秘书对本轮系统回传调用了 silence_turn（或旧静默标记）：不弹通知 */
      silent?: true;
      /** 子代理被后台任务唤醒的这一轮接续的 Run（被持有的那一轮的 turnId） */
      continues?: string;
      /** 子代理还有自己起的、在跑、没表态的后台任务：Run 继续持有，等任务完成唤醒它 */
      awaitingTasks?: true;
      /** 根会话还挂着自定提醒：在等自己定的时间点，goal 先不续跑 */
      awaitingReminder?: true;
      /** 根会话还有没表态的在跑后台任务或没交付的完成通知：headless run 据此保持进程等唤醒 */
      awaitingBackground?: true;
      /** 本轮实际使用的 provider id，供上游健康闸门判断恢复 */
      provider?: string;
    }
  | {
      type: 'turn-failed';
      identity: SessionIdentity;
      seq: number;
      turnId: string;
      error: string;
      /** pi 回合内自动重试已用尽、最终仍是它判定的瞬态错误（网络 / 限流 / 5xx） */
      retryExhausted?: true;
      /** 应用退出窗口内的断流/断连：不是会话失败，按 interrupted 收口（Main 判定） */
      interrupted?: { at: number; kind: ExitKind };
      /** 本轮被 abort 命令中断（如重试倒计时中停止） */
      aborted?: true;
      /** 同 turn-completed：失败也结束被持有的 Run */
      continues?: string;
      /** 本轮实际使用的 provider id，供上游健康闸门按 provider 聚合退避 */
      provider?: string;
    }
  | {
      /** 瞬态错误后 pi 将自动重试：非终态，不 settle 轮次；下一个 status/turn-* 事件清除 */
      type: 'turn-retry';
      identity: SessionIdentity;
      seq: number;
      attempt: number;
      /** 0 表示无限重试 */
      maxAttempts: number;
      delayMs: number;
      error: string;
    }
  | {
      /**
       * retry 命令没有开出新轮的明确回执：会话忙（压缩 / 分支摘要等非空闲状态）或最后一条仍是
       * 已完成的 assistant（没有可重试的）。Main 据此结算等着这次续跑的轮次，不再靠计时器猜。
       * worker 与 Main 同包发布，不存在「旧 worker 不发回执」的版本错配。
       */
      type: 'retry-skipped';
      identity: SessionIdentity;
      seq: number;
      reason: RetrySkippedReason;
    }
  /** 工具执行中的输出快照（pi tool_execution_update 节流下发）：工具行运行中即可展开查看 */
  | {
      type: 'tool-output';
      identity: SessionIdentity;
      seq: number;
      toolCallId: string;
      output: string;
      /** 该工具真正开始执行的 wall clock；后续增量覆盖不改 */
      startedAt?: number;
      /** 前台命令的超时截止 wall clock：无输出巡检在此之前不把静默当卡死 */
      deadlineAt?: number;
      /**
       * pi tool_execution_end 时带上：工具已收口（output 为结果正文）。toolResult 消息可能晚到
       * （agy / Cursor 在整段回复结束才落盘、pi 并行工具按源序补发），卡片先据此转完成 / 失败。
       */
      ended?: 'ok' | 'error';
      /** 随 ended 带上：todo 工具 result.details 投影的清单，toolResult 落地前清单行 / 固定待办条据此显示 */
      todos?: TodoItem[];
    }
  | { type: 'messages-truncated'; identity: SessionIdentity; seq: number; length: number }
  | {
      type: 'rewind-done';
      identity: SessionIdentity;
      seq: number;
      editorText?: string;
      editorImages?: AttachedImage[];
      filesRestored?: boolean;
    }
  | {
      type: 'fork-done';
      identity: SessionIdentity;
      seq: number;
      targetConversationId: string;
      sessionFile?: string;
      entryId?: string;
      error?: string;
    }
  /** 上下文压缩进度（手动 /compact 与自动压缩共用）。queued = 忙碌中已排队，待本轮收束后执行 */
  | {
      type: 'compaction';
      identity: SessionIdentity;
      seq: number;
      state: 'queued' | 'start' | 'end';
      error?: string;
      /** 放弃排队压缩（非真正压完）：清进度但不重钉 compactionNoticeAt */
      abandoned?: true;
    }
  | { type: 'commands'; identity: SessionIdentity; seq: number; commands: SlashCommand[] }
  | { type: 'request-body'; identity: SessionIdentity; seq: number; usage: RequestBodyUsage }
  | {
      type: 'session-meta';
      identity: SessionIdentity;
      seq: number;
      sessionFile?: string;
      contextWindow?: number;
      occupancy?: ContextOccupancy;
      usageTotals?: SessionUsageTotals;
    }
  | {
      type: 'approval-request';
      identity: SessionIdentity;
      seq: number;
      request: ApprovalRequestInfo;
    }
  | {
      type: 'approval-resolved';
      identity: SessionIdentity;
      seq: number;
      requestId: string;
    }
  | { type: 'ask-request'; identity: SessionIdentity; seq: number; ask: AskRequestInfo }
  | {
      type: 'ask-resolved';
      identity: SessionIdentity;
      seq: number;
      requestId: string;
      /** 谁收的尾；缺省表示取消（abort/dismiss），不是回答 */
      by?: AskAnswerBy;
      answer?: string;
      /** 秘书代答时的名字 */
      name?: string;
      /** 提问带的 needsUser 关联，原样带回 */
      relatesTo?: AskRelatesTo;
      /** 带关联时提问发出的时间：晚于它的新结果不认这次答复 */
      askedAt?: number;
    }
  | { type: 'subagent-update'; identity: SessionIdentity; seq: number; agent: SubagentInfo }
  | {
      type: 'coworker-update';
      identity: SessionIdentity;
      seq: number;
      coworker: CoworkerInfo;
      /** 工具直雇 coworker 自身的会话身份(无 ChildSessionIdentity),Main 据此入索引供用户 tab 直接 prompt */
      coworkerIdentity?: SessionIdentity;
    }
  | {
      type: 'browser-invoke';
      identity: SessionIdentity | ChildSessionIdentity;
      seq: number;
      requestId: string;
      op: BrowserOp;
      params: unknown;
    }
  | {
      type: 'memory-invoke';
      identity: SessionIdentity | ChildSessionIdentity;
      seq: number;
      requestId: string;
      op: MemoryOp;
      params: unknown;
    }
  | {
      type: 'delegation-invoke';
      identity: SessionIdentity;
      seq: number;
      requestId: string;
      op:
        | 'delegate'
        | 'check_delegation'
        | 'retry_delegation'
        | 'group_tasks'
        | 'group_history'
        | 'routine_propose'
        | 'send_image'
        | 'report_blocked';
      params: unknown;
    }
  | {
      type: 'secretary-invoke';
      identity: SessionIdentity;
      seq: number;
      requestId: string;
      op: SecretaryInvokeOp;
      params: unknown;
    }
  | {
      type: 'agent-control-invoke';
      identity: SessionIdentity | ChildSessionIdentity;
      seq: number;
      requestId: string;
      request: AgentControlToolRequest;
    }
  | {
      type: 'agent-control-cancel';
      identity: SessionIdentity | ChildSessionIdentity;
      seq: number;
      requestId: string;
      /** abort：本轮中止，worker 丢弃回执；detach：只结束等待，回执照常交给模型 */
      kind: 'abort' | 'detach';
    }
  | {
      type: 'goal-signal';
      identity: SessionIdentity;
      seq: number;
      kind: 'complete' | 'blocked' | 'wait';
      note: string;
      /** goal_complete 的结构化结果；非法值在解析时丢掉，不拒事件 */
      result?: GoalResult;
    }
  | { type: 'plan-state'; identity: SessionIdentity; seq: number; state: PlanState }
  | {
      type: 'workflow-status';
      identity: SessionIdentity | ChildSessionIdentity;
      seq: number;
      run: WorkflowRunSnapshot;
    }
  | {
      type: 'computer-invoke';
      identity: SessionIdentity | ChildSessionIdentity;
      seq: number;
      requestId: string;
      op: ComputerOp;
      params: unknown;
    }
  | {
      type: 'computer-cancel';
      identity: SessionIdentity | ChildSessionIdentity;
      seq: number;
      requestId: string;
    }
  | {
      type: 'plugin-tool-invoke';
      identity: SessionIdentity;
      seq: number;
      requestId: string;
      toolName: string;
      args: unknown;
      /** 子会话发起时的来源；主会话不带 */
      agent?: PluginAgentSource;
    }
  | { type: 'plugin-tool-cancel'; identity: SessionIdentity; seq: number; requestId: string }
  | {
      type: 'plugin-event';
      identity: SessionIdentity;
      seq: number;
      event: PluginEventName;
      data: unknown;
      /** 子会话事件的来源；子会话只通知，before_compact 也走这里且不等待 */
      agent?: PluginAgentSource;
    }
  | ({
      type: 'plugin-intercept';
      identity: SessionIdentity;
      seq: number;
      requestId: string;
      /** 子会话的拦截来源；只允许 tool_call，Main 按子会话预算处理 */
      agent?: PluginAgentSource;
    } & PluginInterceptRequest)
  | { type: 'task-started'; identity: SessionIdentity; seq: number; task: BackgroundTaskInfo }
  | {
      /** 标题总结完成：无 identity/seq（不属于任何 worker 会话），渲染层按 conversationId 写回 */
      type: 'title-generated';
      conversationId: string;
      title: string;
    }
  | {
      /** 父会话一个工具批次结束：Main 旁路消费生成标签，不进渲染层事件流、不占 seq */
      type: 'tool-batch-completed';
      identity: SessionIdentity;
      digest: ToolBatchDigest;
    }
  | {
      /** 优雅重启被推迟：列出还没到安全点的会话。Main 旁路消费，不进渲染层 */
      type: 'graceful-restart-deferred';
      sessions: {
        identity: SessionIdentity;
        reason: RestartDeferReason;
        toolsInFlight: string[];
        /** 在跑的工具调用名（不含转后台的命令），供弹层与超时日志说清在等什么 */
        toolNames?: string[];
        /** 要求保留后台命令时仍要等的转后台命令（没法脱离 worker，如走管道的远程命令） */
        undetachableTasks?: string[];
        /** 回复在写（没有工具在跑）：Main 按出 token 的时刻决定还等不等 */
        reply?: RestartReplyProgress;
      }[];
    }
  | {
      /** 断点已落盘，worker 不再推进任何会话，等 Main 换新进程。Main 旁路消费 */
      type: 'graceful-restart-ready';
      checkpoint: RestartCheckpoint;
    }
  | {
      /** 能脱离的后台命令已交出（恢复清单已写）：Main 收到后才终止 worker。旁路消费 */
      type: 'background-tasks-detached';
      detached: number;
    }
  | {
      /**
       * 重启认回的后台命令在没打开的空闲根会话里结束（或重启收尾期间结束、只存了盘）：
       * 请 Main 按恢复清单打开它，worker 打开后把完成通知交给新一轮。旁路消费
       */
      type: 'session-wake-requested';
      sessionId: string;
    }
  | {
      /** 根会话的自定提醒到点：Main 判定会话还在（未删除、未归档）后回 reminders-fire，冷会话先打开。旁路消费 */
      type: 'session-reminder-due';
      sessionId: string;
    }
  | {
      /** 根会话（含子会话）未到点提醒快照变更：Main 转发给渲染层并刷新秘书看板。旁路消费 */
      type: 'session-reminders-changed';
      sessionId: string;
      reminders: SessionReminderSummary[];
    }
  | {
      /**
       * 没打开的会话（重启认回的命令所在会话不会自动打开）的后台任务全量（REPLACE 语义）。
       * 不带 identity / seq：渲染层只据此画任务条，不当会话已打开
       */
      type: 'unopened-background-tasks';
      sessionId: string;
      tasks: BackgroundTaskInfo[];
    }
  | {
      /** 标题总结全部候选均失败：同为旁路事件；error 为人可读的最后一次失败原因（含模型标识） */
      type: 'title-failed';
      conversationId: string;
      error: string;
    }
  | { type: 'text-completed'; requestId: string; text: string }
  | { type: 'text-failed'; requestId: string; error: string }
  | { type: 'choice-classified'; requestId: string; probabilities: Record<string, number> }
  | { type: 'choice-failed'; requestId: string; error: string }
  | { type: 'text-delta'; requestId: string; text: string; thinking?: string }
  | {
      type: 'task-output';
      identity: SessionIdentity;
      seq: number;
      taskId: string;
      tail: string;
      status: BackgroundTaskInfo['status'];
      outputBytes?: number;
    }
  | {
      type: 'task-ended';
      identity: SessionIdentity;
      seq: number;
      taskId: string;
      status: BackgroundTaskInfo['status'];
      exitCode?: number;
    }
  | {
      /** 该会话后台任务全量快照（REPLACE 语义）：消费者整体替换，edge 事件丢了也能收敛 */
      type: 'background-tasks-level';
      identity: SessionIdentity;
      seq: number;
      tasks: BackgroundTaskInfo[];
    }
  | {
      type: 'session-custom-entry';
      identity: SessionIdentity;
      seq: number;
      entry: AgentSessionCustomEntry;
    }
  | McpWorkerEvent
  /**
   * sessionId：targeted 快照回带请求目标；sessions 为空时 renderer 据此收回 started。
   * resumeFull：resume 尾窗之后补发的全量（远端裁成尾窗后与前一份相同即可跳过）
   */
  | {
      type: 'snapshot';
      sessions: SessionSnapshot[];
      partial?: boolean;
      sessionId?: string;
      resumeFull?: boolean;
    }
  | { type: 'session-reloaded'; requestId: string; result: SessionReloadResult };

/** MCP 连接旁路事件：无 identity/seq，不属于任何会话，Main 走独立 IPC 通道转发 */
export type McpWorkerEvent =
  | {
      type: 'mcp-status';
      /** 与 McpServerEntry.id 对应；旧配置缺省时按 serverName 关联 */
      serverId?: string;
      serverName: string;
      state: McpConnectionState;
      /** state=ready 时的工具数 */
      toolCount?: number;
      error?: string;
      /** 服务器要求更多 scope（insufficient_scope）：重新授权时在已授予 scope 上追加 */
      scopeChallenge?: McpScopeChallenge;
    }
  /** access token 临期或被拒（rejected = 其指纹）：请 Main 续期，结果经 mcp-oauth-refresh-result 回来 */
  | { type: 'mcp-oauth-refresh'; requestId: string; serverId: string; rejected?: string };

export interface McpScopeChallenge {
  scope?: string;
  resourceMetadataUrl?: string;
}

export type McpStatusEvent = Extract<McpWorkerEvent, { type: 'mcp-status' }>;

/** Main → 渲染层的 MCP 状态推送：cleared 用于 worker 退出后清残留 */
export type McpStatusPush = McpStatusEvent | { type: 'mcp-status-cleared' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/** 乐观回显投递标识（renderer 生成的 UUID）；IPC 与 worker 协议共用同一边界 */
export const isDeliveryId = (value: unknown): value is string =>
  isNonEmptyString(value) && value.length <= 128;

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

const PLUGIN_INJECT_KEYS = [
  'type',
  'identity',
  'pluginId',
  'pluginName',
  'text',
  'deliverAs',
  'triggerTurn',
] as const;
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && hasOnlyKeys(value, keys);

function isPluginToolList(value: unknown): value is PluginToolDescriptor[] {
  if (!Array.isArray(value) || value.length > 200) return false;
  const names = new Set<string>();
  for (const tool of value) {
    if (
      !isRecord(tool) ||
      !hasOnlyKeys(tool, [
        'name',
        'description',
        'parameters',
        'pluginId',
        'timeoutMs',
        'readOnly',
      ]) ||
      tool.name === undefined ||
      tool.description === undefined ||
      tool.parameters === undefined ||
      tool.pluginId === undefined ||
      typeof tool.name !== 'string' ||
      typeof tool.description !== 'string' ||
      tool.description.length > 1024 ||
      !isRecord(tool.parameters) ||
      (tool.timeoutMs !== undefined && !isPluginToolTimeout(tool.timeoutMs)) ||
      (tool.readOnly !== undefined && typeof tool.readOnly !== 'boolean') ||
      parsePluginToolName(tool.name)?.pluginId !== tool.pluginId ||
      names.has(tool.name)
    )
      return false;
    names.add(tool.name);
  }
  return true;
}

const isPluginToolTimeout = (value: unknown): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1000 && value <= 600_000;

const isBoundedText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max;

function isPluginEventPlan(value: unknown): value is PluginEventPlan {
  if (!isRecord(value) || !hasExactKeys(value, ['observe', 'intercept', 'inject'])) return false;
  if (typeof value.inject !== 'boolean' || !Array.isArray(value.observe)) return false;
  if (value.observe.length > PLUGIN_EVENTS.length) return false;
  if (
    !value.observe.every(
      (event) => typeof event === 'string' && (PLUGIN_EVENTS as readonly string[]).includes(event)
    )
  )
    return false;
  if (new Set(value.observe).size !== value.observe.length) return false;
  if (!Array.isArray(value.intercept) || value.intercept.length > PLUGIN_INTERCEPT_EVENTS.length)
    return false;
  const events = new Set<string>();
  for (const item of value.intercept) {
    if (!isRecord(item) || !hasOnlyKeys(item, ['event', 'tools']) || typeof item.event !== 'string')
      return false;
    if (!isInterceptEvent(item.event) || events.has(item.event)) return false;
    events.add(item.event);
    if (item.tools === undefined) continue;
    if (
      !Array.isArray(item.tools) ||
      item.tools.length > 64 ||
      !item.tools.every(
        (name) => typeof name === 'string' && name.length > 0 && name.length <= 256
      ) ||
      new Set(item.tools).size !== item.tools.length
    )
      return false;
  }
  return true;
}

/** 插件上行事件：固定字段之外只允许属于本子会话的 agent 来源 */
const hasPluginAgentKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  if (value.agent === undefined) return hasExactKeys(value, keys);
  const identity = value.identity as { sessionId?: unknown } | undefined;
  return (
    hasExactKeys(value, [...keys, 'agent']) &&
    typeof identity?.sessionId === 'string' &&
    parsePluginAgentSource(value.agent, identity.sessionId) !== null
  );
};

const isPluginObserveData = (event: string, data: unknown): boolean => {
  if (!isRecord(data)) return false;
  if (isInterceptEvent(event)) return isPluginInterceptPayload(event, data);
  if (event === 'agent_start') return hasExactKeys(data, []);
  if (event === 'agent_end')
    return (
      hasOnlyKeys(data, ['text', 'silent']) &&
      (data.silent === undefined || data.silent === true) &&
      (data.text === undefined ||
        (typeof data.text === 'string' && data.text.length <= AGENT_END_TEXT_MAX))
    );
  if (event === 'context_usage') return isContextUsagePayload(data);
  if (event === 'model_select') return isModelSelectPayload(data);
  return (
    (event === 'session_start' || event === 'session_end' || event === 'after_compact') &&
    hasExactKeys(data, ['reason']) &&
    isNonEmptyString(data.reason) &&
    data.reason.length <= 64
  );
};

const isTokenCount = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isModelRefPart = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256;

const isModelSelectPayload = (data: Record<string, unknown>): boolean => {
  if (!hasOnlyKeys(data, ['provider', 'modelId', 'previous', 'source'])) return false;
  if (!isModelRefPart(data.provider) || !isModelRefPart(data.modelId)) return false;
  if (data.source !== 'set' && data.source !== 'cycle' && data.source !== 'restore') return false;
  if (data.previous === undefined) return true;
  return (
    isRecord(data.previous) &&
    hasExactKeys(data.previous, ['provider', 'modelId']) &&
    isModelRefPart(data.previous.provider) &&
    isModelRefPart(data.previous.modelId)
  );
};

const isTokenRecord = (value: unknown, keys: readonly string[]): boolean =>
  isRecord(value) && hasExactKeys(value, keys) && keys.every((key) => isTokenCount(value[key]));

const isContextUsageReport = (value: unknown): boolean =>
  isRecord(value) &&
  hasOnlyKeys(value, ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoningTokens']) &&
  (['input', 'output', 'cacheRead', 'cacheWrite'] as const).every((key) =>
    isTokenCount(value[key])
  ) &&
  (value.reasoningTokens === undefined || isTokenCount(value.reasoningTokens));

const isContextUsagePayload = (data: Record<string, unknown>): boolean =>
  hasOnlyKeys(data, [
    'used',
    'estimated',
    'contextWindow',
    'percent',
    'buckets',
    'usage',
    'parts',
    'turns',
  ]) &&
  isTokenCount(data.used) &&
  typeof data.estimated === 'boolean' &&
  (data.contextWindow === undefined || isTokenCount(data.contextWindow)) &&
  (data.percent === undefined || isTokenCount(data.percent)) &&
  isTokenRecord(data.buckets, CONTEXT_USAGE_BUCKETS) &&
  (data.usage === undefined || isContextUsageReport(data.usage)) &&
  (data.turns === undefined || isSequence(data.turns)) &&
  (data.parts === undefined ||
    (Array.isArray(data.parts) &&
      data.parts.length <= CONTEXT_PART_KINDS.length &&
      data.parts.every(isContextPart)));

const isContextPartItem = (value: unknown): boolean =>
  isRecord(value) &&
  hasOnlyKeys(value, ['name', 'tag', 'n', 'tokens']) &&
  typeof value.name === 'string' &&
  value.name.length <= 1024 &&
  typeof value.tag === 'string' &&
  value.tag.length <= 32 &&
  (value.n === undefined || isSequence(value.n)) &&
  isTokenCount(value.tokens);

const isContextPart = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(value, ['kind', 'tokens', 'items']) &&
  (CONTEXT_PART_KINDS as readonly unknown[]).includes(value.kind) &&
  isTokenCount(value.tokens) &&
  Array.isArray(value.items) &&
  value.items.length <= CONTEXT_PART_ITEMS &&
  value.items.every(isContextPartItem);

const isPluginInterceptPayload = (event: string, payload: unknown): boolean => {
  if (!isRecord(payload)) return false;
  if (event === 'before_agent_start') {
    return (
      hasExactKeys(payload, ['prompt', 'kind']) &&
      isBoundedText(payload.prompt, BEFORE_AGENT_START_PROMPT_MAX) &&
      (payload.kind === 'user' || payload.kind === 'custom')
    );
  }
  if (event === 'before_compact') {
    return (
      hasExactKeys(payload, ['reason']) &&
      isNonEmptyString(payload.reason) &&
      payload.reason.length <= 64
    );
  }
  const isOptionalParentToolCallId = (value: unknown): boolean =>
    value === undefined || (isNonEmptyString(value) && value.length <= 512);
  if (event === 'tool_call') {
    return (
      hasOnlyKeys(payload, ['toolCallId', 'parentToolCallId', 'toolName', 'input']) &&
      isNonEmptyString(payload.toolCallId) &&
      payload.toolCallId.length <= 512 &&
      isOptionalParentToolCallId(payload.parentToolCallId) &&
      isNonEmptyString(payload.toolName) &&
      payload.toolName.length <= 256 &&
      isRecord(payload.input)
    );
  }
  if (event === 'tool_result') {
    return (
      hasOnlyKeys(payload, [
        'toolCallId',
        'parentToolCallId',
        'toolName',
        'input',
        'content',
        'isError',
      ]) &&
      isNonEmptyString(payload.toolCallId) &&
      payload.toolCallId.length <= 512 &&
      isOptionalParentToolCallId(payload.parentToolCallId) &&
      isNonEmptyString(payload.toolName) &&
      payload.toolName.length <= 256 &&
      isRecord(payload.input) &&
      typeof payload.content === 'string' &&
      typeof payload.isError === 'boolean'
    );
  }
  return (
    event === 'input' &&
    hasExactKeys(payload, ['text', 'source']) &&
    typeof payload.text === 'string' &&
    isNonEmptyString(payload.source) &&
    payload.source.length <= 32
  );
};

const isMcpScopeChallenge = (value: unknown): value is McpScopeChallenge =>
  isRecord(value) &&
  hasOnlyKeys(value, ['scope', 'resourceMetadataUrl']) &&
  (value.scope === undefined || (typeof value.scope === 'string' && value.scope.length <= 2048)) &&
  (value.resourceMetadataUrl === undefined ||
    (typeof value.resourceMetadataUrl === 'string' && URL.canParse(value.resourceMetadataUrl)));

const isSequence = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0;

function parseProjectedFileChanges(value: unknown): ProjectedFileChange[] | null {
  if (!Array.isArray(value) || value.length > PROJECTED_FILE_CHANGE_LIMIT) return null;
  for (const item of value) {
    if (
      !isRecord(item) ||
      !hasOnlyKeys(item, ['path', 'oldText', 'newText', 'type', 'truncated']) ||
      !isNonEmptyString(item.path) ||
      item.path.length > PROJECTED_APPLY_PATCH_PATH_TEXT_LIMIT ||
      typeof item.oldText !== 'string' ||
      typeof item.newText !== 'string' ||
      (item.type !== 'add' && item.type !== 'update' && item.type !== 'delete') ||
      (item.truncated !== undefined && item.truncated !== true) ||
      item.oldText.length > PROJECTED_FILE_TEXT_LIMIT + (item.truncated === true ? 2 : 0) ||
      item.newText.length > PROJECTED_FILE_TEXT_LIMIT + (item.truncated === true ? 2 : 0) ||
      (item.truncated === true && !item.oldText.endsWith('\n…') && !item.newText.endsWith('\n…'))
    ) {
      return null;
    }
  }
  return value as ProjectedFileChange[];
}

function parseProjectedApplyPatchOutcome(value: unknown): ProjectedApplyPatchOutcome | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'status',
      'applied',
      'failed',
      'unattempted',
      'uncertain',
      'error',
      'errorTruncated',
      'input',
      'inputTruncated',
    ]) ||
    (value.status !== 'success' && value.status !== 'partial' && value.status !== 'failed')
  ) {
    return null;
  }
  const lists = [value.applied, value.failed, value.unattempted, value.uncertain];
  if (
    lists.some(
      (list) =>
        !Array.isArray(list) ||
        list.some(
          (path) => !isNonEmptyString(path) || path.length > PROJECTED_APPLY_PATCH_PATH_TEXT_LIMIT
        )
    )
  ) {
    return null;
  }
  const [applied, failed, unattempted, uncertain] = lists as string[][];
  const allPaths = [...applied, ...failed, ...unattempted, ...uncertain];
  const error = typeof value.error === 'string' && value.error.length > 0 ? value.error : null;
  const input = typeof value.input === 'string' && value.input.length > 0 ? value.input : null;
  if (
    allPaths.length > PROJECTED_APPLY_PATCH_PATH_COUNT_LIMIT ||
    new Set(allPaths).size !== allPaths.length ||
    (value.error !== undefined && error === null) ||
    (value.errorTruncated !== undefined && value.errorTruncated !== true) ||
    (value.errorTruncated === true &&
      (error === null || error.length > PROJECTED_FILE_TEXT_LIMIT + 2 || !error.endsWith('\n…'))) ||
    (value.errorTruncated !== true && error !== null && error.length > PROJECTED_FILE_TEXT_LIMIT) ||
    (value.input !== undefined && input === null) ||
    (value.inputTruncated !== undefined && value.inputTruncated !== true) ||
    (value.inputTruncated === true &&
      (input === null || input.length > PROJECTED_FILE_TEXT_LIMIT + 2 || !input.endsWith('\n…'))) ||
    (value.inputTruncated !== true && input !== null && input.length > PROJECTED_FILE_TEXT_LIMIT) ||
    (value.status === 'success' &&
      (error !== null ||
        input !== null ||
        failed.length > 0 ||
        unattempted.length > 0 ||
        uncertain.length > 0)) ||
    (value.status === 'partial' && (applied.length === 0 || error === null)) ||
    (value.status === 'failed' && (applied.length > 0 || error === null))
  ) {
    return null;
  }
  return value as unknown as ProjectedApplyPatchOutcome;
}

/** 后台任务 id 形如 task-<n>-<base36>，渲染层只拿它做展示 */
export function isBackgroundTaskId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function isProjectedCodemodeCalls(value: unknown): value is ProjectedCodemodeCall[] {
  return (
    Array.isArray(value) &&
    value.every(
      (call) =>
        isRecord(call) &&
        isNonEmptyString(call.name) &&
        typeof call.ok === 'boolean' &&
        (call.error === undefined || typeof call.error === 'string') &&
        (call.summary === undefined || typeof call.summary === 'string')
    )
  );
}

function hasValidProjectedMetadata(value: Record<string, unknown>): boolean {
  if (value.generatedImages !== undefined && !parseGeneratedImagePaths(value.generatedImages))
    return false;
  if (value.rtk !== undefined && !parseRtkToolStats(value.rtk)) return false;
  if (value.approvalReview !== undefined && !parseApprovalReviewRecord(value.approvalReview))
    return false;
  if (value.privacyMask !== undefined && !parseMaskReport(value.privacyMask)) return false;
  if (value.codemodeCalls !== undefined && !isProjectedCodemodeCalls(value.codemodeCalls)) {
    return false;
  }
  if (value.backgroundTaskId !== undefined && !isBackgroundTaskId(value.backgroundTaskId)) {
    return false;
  }
  if (value.shellFailure !== undefined && !parseShellFailure(value.shellFailure)) return false;
  if (value.dcgWarning !== undefined && !isDcgWarning(value.dcgWarning)) return false;
  if (value.pluginSource !== undefined && !parsePluginMessageSource(value.pluginSource))
    return false;
  if (
    value.pluginArtifacts !== undefined &&
    (!Array.isArray(value.pluginArtifacts) ||
      !value.pluginArtifacts.every((item) => parsePluginArtifactInfo(item) !== null))
  ) {
    return false;
  }
  const fileChanges =
    value.fileChanges === undefined ? undefined : parseProjectedFileChanges(value.fileChanges);
  if (fileChanges === null) return false;
  if (value.applyPatchOutcome === undefined) return true;
  const outcome = parseProjectedApplyPatchOutcome(value.applyPatchOutcome);
  return (
    outcome !== null &&
    fileChanges !== undefined &&
    outcome.applied.length === fileChanges.length &&
    outcome.applied.every((path, index) => path === fileChanges[index]?.path)
  );
}

const isMcpOAuthAccess = (value: unknown): boolean =>
  isRecord(value) &&
  hasOnlyKeys(value, ['access_token', 'expires_at']) &&
  isNonEmptyString(value.access_token) &&
  (value.expires_at === undefined ||
    (typeof value.expires_at === 'number' && Number.isFinite(value.expires_at)));

const isMcpOAuthRefreshResult = (value: unknown): boolean =>
  isRecord(value) &&
  (value.ok === true
    ? hasOnlyKeys(value, ['ok', 'access']) && isMcpOAuthAccess(value.access)
    : value.ok === false &&
      hasOnlyKeys(value, ['ok', 'unauthorized', 'error']) &&
      typeof value.unauthorized === 'boolean' &&
      typeof value.error === 'string');

/** turn-completed.digest 的形状校验：三段必须是字符串（允许空），不允许多余键 */
export function parseTurnDigest(value: unknown): TurnDigest | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['firstUserText', 'userText', 'assistantText', 'lastTool'])
  ) {
    return null;
  }
  if (
    typeof value.firstUserText !== 'string' ||
    typeof value.userText !== 'string' ||
    typeof value.assistantText !== 'string'
  ) {
    return null;
  }
  const digest: TurnDigest = {
    firstUserText: value.firstUserText,
    userText: value.userText,
    assistantText: value.assistantText,
  };
  if (value.lastTool !== undefined) {
    if (
      !isRecord(value.lastTool) ||
      !hasExactKeys(value.lastTool, ['name', 'ok']) ||
      typeof value.lastTool.name !== 'string' ||
      value.lastTool.name.trim().length === 0 ||
      typeof value.lastTool.ok !== 'boolean'
    ) {
      return null;
    }
    digest.lastTool = { name: value.lastTool.name, ok: value.lastTool.ok };
  }
  return digest;
}

export function parseTurnReport(value: unknown): TurnReport | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['text', 'omitted'])) return null;
  if (!isNonEmptyString(value.text) || value.text.length > TURN_REPORT_MAX_CHARS) return null;
  if (
    value.omitted !== undefined &&
    !(typeof value.omitted === 'number' && Number.isSafeInteger(value.omitted) && value.omitted > 0)
  )
    return null;
  return value as unknown as TurnReport;
}

/** 标题总结输入校验：initial 要求 text 非空；rolling 要求 currentTitle 非空、firstUserText 为字符串（可空）且本轮两段至少一段非空 */
export function parseTitleSummaryInput(value: unknown): TitleSummaryInput | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'initial') {
    return hasExactKeys(value, ['kind', 'text']) &&
      typeof value.text === 'string' &&
      value.text.trim().length > 0
      ? (value as unknown as TitleSummaryInput)
      : null;
  }
  if (value.kind === 'rolling') {
    return hasExactKeys(value, [
      'kind',
      'currentTitle',
      'firstUserText',
      'userText',
      'assistantText',
    ]) &&
      isNonEmptyString(value.currentTitle) &&
      typeof value.firstUserText === 'string' &&
      typeof value.userText === 'string' &&
      typeof value.assistantText === 'string' &&
      (value.userText.trim().length > 0 || value.assistantText.trim().length > 0)
      ? (value as unknown as TitleSummaryInput)
      : null;
  }
  return null;
}

export function parseContextOccupancy(value: unknown): ContextOccupancy | null {
  if (!isRecord(value) || !isRecord(value.buckets) || typeof value.estimated !== 'boolean')
    return null;
  const buckets = {} as ContextOccupancyBuckets;
  for (const id of CONTEXT_OCCUPANCY_BUCKETS) {
    const tokens = value.buckets[id];
    if (!isSequence(tokens)) return null;
    buckets[id] = tokens;
  }
  const parts = value.parts === undefined ? undefined : parseContextParts(value.parts);
  if (value.parts !== undefined && !parts) return null;
  if (
    !isSequence(value.used) ||
    !isSequence(value.compactedMessageCount) ||
    typeof value.compactionModelMismatch !== 'boolean' ||
    (value.contextWindow !== undefined &&
      !(typeof value.contextWindow === 'number' && value.contextWindow > 0)) ||
    (value.percent !== undefined && !isSequence(value.percent)) ||
    (value.compactionEntryId !== undefined && !isNonEmptyString(value.compactionEntryId)) ||
    (value.compactionTokensAfter !== undefined && !isSequence(value.compactionTokensAfter))
  ) {
    return null;
  }
  return { ...(value as unknown as ContextOccupancy), ...(parts ? { parts } : {}) };
}

function parseContextParts(value: unknown): ContextPart[] | null {
  if (!Array.isArray(value) || value.length > CONTEXT_PART_KINDS.length) return null;
  const seen = new Set<string>();
  for (const part of value) {
    if (
      !isRecord(part) ||
      !CONTEXT_PART_KINDS.includes(part.kind as (typeof CONTEXT_PART_KINDS)[number]) ||
      seen.has(part.kind as string) ||
      !isSequence(part.tokens) ||
      !Array.isArray(part.items) ||
      part.items.length > CONTEXT_PART_ITEMS
    ) {
      return null;
    }
    seen.add(part.kind as string);
    for (const item of part.items) {
      if (
        !isRecord(item) ||
        !isNonEmptyString(item.name) ||
        typeof item.tag !== 'string' ||
        item.tag.length > 32 ||
        !isSequence(item.tokens) ||
        (item.n !== undefined && (!isSequence(item.n) || item.n < 1))
      ) {
        return null;
      }
    }
  }
  return value as ContextPart[];
}

const isNonNegativeNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** 统计只是展示用：脏值返回 undefined 由调用方丢弃该字段，不连累所在事件/条目 */
export function parseSessionUsageTotals(value: unknown): SessionUsageTotals | undefined {
  if (!isRecord(value) || !isSequence(value.inputTokens) || !isSequence(value.outputTokens)) {
    return undefined;
  }
  const out: SessionUsageTotals = {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
  };
  for (const key of ['cacheHitPercent', 'ttftAvgMs', 'tokensPerSecond'] as const) {
    const field = value[key];
    if (field === undefined) continue;
    if (!isNonNegativeNumber(field)) return undefined;
    out[key] = field;
  }
  return out;
}

const isProductSurfaceId = (value: unknown): value is ProductSurfaceId =>
  typeof value === 'string' && Object.hasOwn(PRODUCT_SURFACE_INVENTORY, value);

function parseAttachedImages(value: unknown): AttachedImage[] | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (!isRecord(item) || !hasOnlyKeys(item, ['data', 'mimeType', 'id'])) return null;
    if (!isNonEmptyString(item.data) || !isNonEmptyString(item.mimeType)) return null;
    if (item.id !== undefined && !isNonEmptyString(item.id)) return null;
  }
  return value as AttachedImage[];
}

const parseAnySessionIdentity = (value: unknown): SessionIdentity | ChildSessionIdentity | null =>
  parseChildSessionIdentity(value) ?? parseSessionIdentity(value);

function parseVirtualSpawnClassifier(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ['source', 'timeoutMs', 'model', 'classifier'])) {
    return false;
  }
  if (typeof value.timeoutMs !== 'number' || !(value.timeoutMs > 0)) return false;
  if (value.source === 'judge') {
    return value.classifier === undefined && parsePhysicalSpawnModelConfig(value.model) !== null;
  }
  if (value.source !== 'pi-classifier' || value.model !== undefined) return false;
  return parseClassifierCredentials(value.classifier);
}

function parseClassifierCredentials(value: unknown): value is VirtualClassifierCredentials {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['provider', 'modelId', 'apiKey', 'baseUrl', 'proxy']) &&
    isNonEmptyString(value.provider) &&
    isNonEmptyString(value.modelId) &&
    (value.apiKey === undefined || typeof value.apiKey === 'string') &&
    (value.baseUrl === undefined || isNonEmptyString(value.baseUrl)) &&
    (value.proxy === undefined || Boolean(parseProviderProxy(value.proxy)))
  );
}

function parseVirtualSpawnConfig(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['name', 'primary', 'fast', 'fallbacks', 'classifier'])
  )
    return false;
  return (
    isNonEmptyString(value.name) &&
    parsePhysicalSpawnModelConfig(value.primary) !== null &&
    (value.fast === undefined || parsePhysicalSpawnModelConfig(value.fast) !== null) &&
    Array.isArray(value.fallbacks) &&
    value.fallbacks.every((item) => parsePhysicalSpawnModelConfig(item) !== null) &&
    (value.classifier === undefined || parseVirtualSpawnClassifier(value.classifier))
  );
}

/** 只有会话主模型（spawn-parent / set-model / 子会话继承 / 子代理模型目录）接受虚拟配置；其余用途一律真实模型。 */
function parseSessionModelConfig(value: unknown): SpawnModelConfig | null {
  if (!isRecord(value)) return null;
  if (value.virtual === undefined) return parsePhysicalSpawnModelConfig(value);
  const { virtual, ...physical } = value;
  return parseVirtualSpawnConfig(virtual) && parsePhysicalSpawnModelConfig(physical)
    ? (value as unknown as SpawnModelConfig)
    : null;
}

const parseSpawnModelConfig = (value: unknown): SpawnModelConfig | null =>
  parsePhysicalSpawnModelConfig(value);

function parsePhysicalSpawnModelConfig(value: unknown): SpawnModelConfig | null {
  if (!isRecord(value)) return null;
  if (
    !hasOnlyKeys(value, [
      'api',
      'baseUrl',
      'apiKey',
      'modelId',
      'settingsProviderId',
      'oauthAccountKey',
      'oauthAccountPool',
      'reasoning',
      'thinkingLevel',
      'contextWindow',
      'maxTokens',
      'headers',
      'proxy',
    ]) ||
    !MODEL_API_KINDS.includes(value.api as ModelApiKind) ||
    typeof value.baseUrl !== 'string' ||
    typeof value.apiKey !== 'string' ||
    !isNonEmptyString(value.modelId) ||
    !isNonEmptyString(value.settingsProviderId) ||
    (value.oauthAccountKey !== undefined && !isNonEmptyString(value.oauthAccountKey)) ||
    (value.oauthAccountPool !== undefined &&
      (!parseOauthAccountPool(value.oauthAccountPool) ||
        !isCodexAccountKey(value.oauthAccountKey) ||
        value.apiKey !== '')) ||
    (value.proxy !== undefined &&
      (value.oauthAccountKey !== undefined || !parseProviderProxy(value.proxy)))
  ) {
    return null;
  }
  if (value.proxy !== undefined) value.proxy = parseProviderProxy(value.proxy);
  if (value.headers !== undefined) {
    const headers = parseProviderHeaders(value.headers);
    if (headers) value.headers = headers;
    else delete value.headers;
  }
  return value as unknown as SpawnModelConfig;
}

function parseSubagentModelOption(value: unknown): SubagentModelOption | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['name', 'config', 'description']) ||
    !isNonEmptyString(value.name) ||
    !parseSessionModelConfig(value.config) ||
    (value.description !== undefined && typeof value.description !== 'string')
  ) {
    return null;
  }
  return value as unknown as SubagentModelOption;
}

function parseModelRef(value: unknown): ModelRef | null {
  if (!isRecord(value) || !hasExactKeys(value, ['providerId', 'modelId'])) return null;
  return isNonEmptyString(value.providerId) && isNonEmptyString(value.modelId)
    ? { providerId: value.providerId, modelId: value.modelId }
    : null;
}

/** ssh 必带 host+connectionId；非 ssh 禁止这两个字段 */
function isValidProjectRemoteFields(value: Record<string, unknown>): boolean {
  if (value.kind === 'ssh') {
    return isNonEmptyString(value.sshHost) && isUuid(value.sshConnectionId);
  }
  if (value.kind === 'local' || value.kind === undefined) {
    return value.sshHost === undefined && value.sshConnectionId === undefined;
  }
  if (value.kind === 'bot-home') {
    return value.sshHost === undefined && value.sshConnectionId === undefined;
  }
  if (value.kind === 'scratch') {
    return value.sshHost === undefined && value.sshConnectionId === undefined;
  }
  if (value.kind === 'secretary') {
    return value.sshHost === undefined && value.sshConnectionId === undefined;
  }
  return false;
}

function isValidCreateProjectRemoteFields(value: Record<string, unknown>): boolean {
  if (value.kind === 'ssh') return isUuid(value.sshConnectionId) && value.sshHost === undefined;
  if (value.kind === 'local' || value.kind === undefined) {
    return value.sshHost === undefined && value.sshConnectionId === undefined;
  }
  return false;
}

export function parseAgentRemoteConfig(value: unknown): AgentRemoteConfig | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['host', 'auth', 'port', 'password', 'timeoutSeconds']) ||
    !isNonEmptyString(value.host) ||
    (value.auth !== 'key' && value.auth !== 'password')
  ) {
    return null;
  }
  if (value.timeoutSeconds !== undefined && parseSshTimeoutSeconds(value.timeoutSeconds) === null) {
    return null;
  }
  if (
    value.port !== undefined &&
    (!Number.isInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65535)
  ) {
    return null;
  }
  if (value.auth === 'password') {
    if (!isNonEmptyString(value.password)) return null;
  } else if (value.password !== undefined) {
    return null;
  }
  return value as unknown as AgentRemoteConfig;
}

export function parseProjectAuthority(value: unknown): ProjectAuthority | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'projectId',
      'canonicalPath',
      'kind',
      'sshHost',
      'sshConnectionId',
      'state',
      'version',
    ]) ||
    !isUuid(value.projectId) ||
    !isNonEmptyString(value.canonicalPath) ||
    !isValidProjectRemoteFields(value) ||
    (value.state !== 'active' && value.state !== 'removed') ||
    !isSequence(value.version)
  ) {
    return null;
  }
  return value as unknown as ProjectAuthority;
}

export function parseConversationAuthority(value: unknown): ConversationAuthority | null {
  if (!isRecord(value)) return null;
  if (
    !hasOnlyKeys(value, [
      'conversationId',
      'projectId',
      'kind',
      'lifecycle',
      'version',
      'sessionFile',
      'selection',
      'forkedFrom',
      'bot',
    ]) ||
    !isUuid(value.conversationId) ||
    !isUuid(value.projectId) ||
    value.kind !== 'root' ||
    (value.lifecycle !== 'draft' && value.lifecycle !== 'ready' && value.lifecycle !== 'ended') ||
    !isSequence(value.version) ||
    (value.sessionFile !== undefined && !isNonEmptyString(value.sessionFile))
  ) {
    return null;
  }
  if (value.selection !== undefined) {
    if (!isRecord(value.selection)) return null;
    if (
      !hasExactKeys(value.selection, ['providerId', 'modelId', 'revision']) ||
      !isNonEmptyString(value.selection.providerId) ||
      !isNonEmptyString(value.selection.modelId) ||
      !isSequence(value.selection.revision)
    ) {
      return null;
    }
  }
  if (value.forkedFrom !== undefined) {
    if (
      !isRecord(value.forkedFrom) ||
      !hasExactKeys(value.forkedFrom, ['conversationId', 'entryId']) ||
      !isUuid(value.forkedFrom.conversationId) ||
      !isNonEmptyString(value.forkedFrom.entryId)
    ) {
      return null;
    }
  }
  if (value.bot !== undefined && !isConversationBotBinding(value.bot)) return null;
  return value as unknown as ConversationAuthority;
}

function isConversationBotBinding(value: unknown): value is ConversationBotBinding {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['botId', 'chatId', 'delegationId']) &&
    isUuid(value.botId) &&
    (value.chatId === null || isUuid(value.chatId)) &&
    (value.delegationId === undefined || isNonEmptyString(value.delegationId))
  );
}

export function parseSourceAuthorityProjection(value: unknown): SourceAuthorityProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['projects', 'conversations']) ||
    !Array.isArray(value.projects) ||
    value.projects.some((project) => parseProjectAuthority(project) === null) ||
    !Array.isArray(value.conversations) ||
    value.conversations.some((conversation) => parseConversationAuthority(conversation) === null)
  ) {
    return null;
  }
  return value as unknown as SourceAuthorityProjection;
}

export function parseCreateProjectAuthorityRequest(
  value: unknown
): CreateProjectAuthorityRequest | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['requestId', 'path', 'kind', 'sshConnectionId'])) {
    return null;
  }
  return isNonEmptyString(value.requestId) &&
    isNonEmptyString(value.path) &&
    isValidCreateProjectRemoteFields(value)
    ? (value as unknown as CreateProjectAuthorityRequest)
    : null;
}

export function parseSelectProjectAuthorityRequest(
  value: unknown
): SelectProjectAuthorityRequest | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['requestId', 'projectId', 'version']) ||
    !isNonEmptyString(value.requestId) ||
    !isUuid(value.projectId) ||
    !isSequence(value.version)
  ) {
    return null;
  }
  return value as unknown as SelectProjectAuthorityRequest;
}

export function parseRemoveProjectAuthorityRequest(
  value: unknown
): RemoveProjectAuthorityRequest | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['requestId', 'projectId', 'version']) ||
    !isNonEmptyString(value.requestId) ||
    !isUuid(value.projectId) ||
    !isSequence(value.version)
  ) {
    return null;
  }
  return value as unknown as RemoveProjectAuthorityRequest;
}

export function parseCreateConversationAuthorityRequest(
  value: unknown
): CreateConversationAuthorityRequest | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'requestId',
      'projectId',
      'projectVersion',
      'conversationId',
      'forkedFrom',
    ]) ||
    !isNonEmptyString(value.requestId) ||
    !isUuid(value.projectId) ||
    !isSequence(value.projectVersion) ||
    (value.conversationId !== undefined && !isUuid(value.conversationId))
  ) {
    return null;
  }
  if (value.forkedFrom !== undefined) {
    if (
      !isRecord(value.forkedFrom) ||
      !hasExactKeys(value.forkedFrom, ['conversationId', 'entryId']) ||
      !isUuid(value.forkedFrom.conversationId) ||
      !isNonEmptyString(value.forkedFrom.entryId)
    ) {
      return null;
    }
  }
  return value as unknown as CreateConversationAuthorityRequest;
}

export function parseConversationAuthorityRequest(
  value: unknown
): ConversationAuthorityRequest | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'requestId',
      'conversationId',
      'version',
      'selectionEpoch',
      'selectionBootId',
    ]) ||
    !isNonEmptyString(value.requestId) ||
    !isUuid(value.conversationId) ||
    !isSequence(value.version) ||
    (value.selectionEpoch !== undefined && !isSequence(value.selectionEpoch)) ||
    (value.selectionBootId !== undefined &&
      (!isNonEmptyString(value.selectionBootId) || value.selectionBootId.length > 128))
  ) {
    return null;
  }
  return value as unknown as ConversationAuthorityRequest;
}

export function parseUpdateConversationSelectionRequest(
  value: unknown
): UpdateConversationSelectionRequest | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['requestId', 'conversationId', 'version', 'selection']) ||
    !parseConversationAuthorityRequest({
      requestId: value.requestId,
      conversationId: value.conversationId,
      version: value.version,
    }) ||
    !parseModelRef(value.selection)
  ) {
    return null;
  }
  return value as unknown as UpdateConversationSelectionRequest;
}

export function parseChildConversationMetadata(value: unknown): ChildConversationMetadata | null {
  if (!isRecord(value)) return null;
  if (
    !hasOnlyKeys(value, [
      'parentId',
      'childGeneration',
      'agentTypeKey',
      'agentInstanceId',
      'agentInstanceName',
      'dispatchOrigin',
      'mode',
      'lockedProfileId',
    ]) ||
    Object.keys(value).length < 6
  ) {
    return null;
  }
  const typeKey = parseAgentTypeKey(value.agentTypeKey);
  if (
    !isNonEmptyString(value.parentId) ||
    !isUuid(value.childGeneration) ||
    !typeKey ||
    !isUuid(value.agentInstanceId) ||
    !isNonEmptyString(value.agentInstanceName) ||
    (value.dispatchOrigin !== 'typed-mention' &&
      value.dispatchOrigin !== 'manual' &&
      value.dispatchOrigin !== 'agent-tool') ||
    (value.mode !== undefined && value.mode !== 'task' && value.mode !== 'coworker') ||
    !isValidLegacyProfile(typeKey, value.lockedProfileId)
  ) {
    return null;
  }
  return value as unknown as ChildConversationMetadata;
}

function parseSafeChildRef(value: unknown): SafeChildRef | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['sessionId', 'generation', 'instanceId', 'instanceName', 'typeKey'])
  ) {
    return null;
  }
  const typeKey = parseAgentTypeKey(value.typeKey);
  return isNonEmptyString(value.sessionId) &&
    isUuid(value.generation) &&
    isUuid(value.instanceId) &&
    isNonEmptyString(value.instanceName) &&
    typeKey
    ? (value as unknown as SafeChildRef)
    : null;
}

const agentSessionCustomEntryParsers = {
  'oauth-account-selected': (value: Record<string, unknown>): AgentSessionCustomEntry | null => {
    return hasOnlyKeys(value, [
      'kind',
      'accountKey',
      'previousAccountKey',
      'settingsProviderId',
      'modelId',
      'at',
    ]) &&
      isCodexAccountKey(value.accountKey) &&
      (value.previousAccountKey === undefined || isCodexAccountKey(value.previousAccountKey)) &&
      ((value.settingsProviderId === undefined && value.modelId === undefined) ||
        (isNonEmptyString(value.settingsProviderId) && isNonEmptyString(value.modelId))) &&
      typeof value.at === 'number' &&
      Number.isFinite(value.at)
      ? (value as unknown as AgentSessionCustomEntry)
      : null;
  },
  'capability-receipt': (value: Record<string, unknown>): AgentSessionCustomEntry | null => {
    if (!hasExactKeys(value, ['kind', 'receipt'])) return null;
    const receipt = parseCapabilityReceipt(value.receipt);
    return receipt ? { kind: 'capability-receipt', receipt } : null;
  },
  'task-wrap-up-nudge': (value: Record<string, unknown>): AgentSessionCustomEntry | null => {
    return hasExactKeys(value, ['kind', 'count', 'at']) &&
      Number.isInteger(value.count) &&
      (value.count as number) > 0 &&
      typeof value.at === 'number' &&
      Number.isFinite(value.at)
      ? (value as unknown as AgentSessionCustomEntry)
      : null;
  },
  'tool-batch-label': (value: Record<string, unknown>): AgentSessionCustomEntry | null => {
    return hasExactKeys(value, ['kind', 'callId', 'label', 'at']) &&
      isNonEmptyString(value.callId) &&
      isNonEmptyString(value.label) &&
      value.label.length <= 200 &&
      typeof value.at === 'number' &&
      Number.isFinite(value.at)
      ? (value as unknown as AgentSessionCustomEntry)
      : null;
  },
  'agent-dispatch': (value: Record<string, unknown>): AgentSessionCustomEntry | null => {
    const child = parseSafeChildRef(value.child);
    if (!child || typeof value.at !== 'number' || !Number.isFinite(value.at)) return null;
    return hasExactKeys(value, ['kind', 'child', 'at'])
      ? (value as unknown as AgentSessionCustomEntry)
      : null;
  },
  'agent-completed': (value: Record<string, unknown>): AgentSessionCustomEntry | null => {
    const child = parseSafeChildRef(value.child);
    if (!child || typeof value.at !== 'number' || !Number.isFinite(value.at)) return null;
    return hasOnlyKeys(value, ['kind', 'child', 'receiptSummary', 'at']) &&
      (value.receiptSummary === undefined || typeof value.receiptSummary === 'string')
      ? (value as unknown as AgentSessionCustomEntry)
      : null;
  },
  'agent-failed': (value: Record<string, unknown>): AgentSessionCustomEntry | null => {
    const child = parseSafeChildRef(value.child);
    if (!child || typeof value.at !== 'number' || !Number.isFinite(value.at)) return null;
    return hasExactKeys(value, ['kind', 'child', 'errorCode', 'message', 'at']) &&
      isNonEmptyString(value.errorCode) &&
      isNonEmptyString(value.message)
      ? (value as unknown as AgentSessionCustomEntry)
      : null;
  },
} satisfies Record<AgentSessionCustomEntry['kind'], ClosedParser<AgentSessionCustomEntry>>;

export function parseAgentSessionCustomEntry(value: unknown): AgentSessionCustomEntry | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  return parseClosed(agentSessionCustomEntryParsers, value.kind, value);
}

export function parseResolvedChildProfileProof(value: unknown): ResolvedChildProfileProof | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'spawnSpecId',
      'typeKey',
      'model',
      'toolIds',
      'loadedSkillBindingIds',
      'loadedMcpBindingIds',
      'systemPromptHash',
    ]) ||
    !isUuid(value.spawnSpecId) ||
    !parseAgentTypeKey(value.typeKey) ||
    !parseModelRef(value.model) ||
    !Array.isArray(value.toolIds) ||
    !value.toolIds.every(isNonEmptyString) ||
    !Array.isArray(value.loadedSkillBindingIds) ||
    !value.loadedSkillBindingIds.every(isNonEmptyString) ||
    !Array.isArray(value.loadedMcpBindingIds) ||
    !value.loadedMcpBindingIds.every(isNonEmptyString) ||
    !isNonEmptyString(value.systemPromptHash)
  ) {
    return null;
  }
  return value as unknown as ResolvedChildProfileProof;
}

const parseSafeTextRecord = (value: Record<string, unknown>): SafeJournalRecord | null => {
  return hasExactKeys(value, ['type', 'text', 'at']) && typeof value.text === 'string'
    ? (value as unknown as SafeJournalRecord)
    : null;
};
const safeJournalRecordParsers = {
  'safe-user-text': parseSafeTextRecord,
  'safe-assistant-text': parseSafeTextRecord,
  'enso-operation': (value: Record<string, unknown>): SafeJournalRecord | null => {
    return hasExactKeys(value, ['type', 'operationId', 'capabilityId', 'toolCallId', 'at']) &&
      isNonEmptyString(value.operationId) &&
      isProductSurfaceId(value.capabilityId) &&
      isNonEmptyString(value.toolCallId)
      ? (value as unknown as SafeJournalRecord)
      : null;
  },
  'safe-model-result': (value: Record<string, unknown>): SafeJournalRecord | null => {
    return hasExactKeys(value, ['type', 'toolCallId', 'modelResult', 'at']) &&
      isNonEmptyString(value.toolCallId) &&
      parseCapabilityResult(value.modelResult)
      ? (value as unknown as SafeJournalRecord)
      : null;
  },
  'capability-receipt': (value: Record<string, unknown>): SafeJournalRecord | null => {
    return hasExactKeys(value, ['type', 'receipt', 'at']) && parseCapabilityReceipt(value.receipt)
      ? (value as unknown as SafeJournalRecord)
      : null;
  },
} satisfies Record<SafeJournalRecord['type'], ClosedParser<SafeJournalRecord>>;

export function parseSafeJournalRecord(value: unknown): SafeJournalRecord | null {
  if (!isRecord(value) || typeof value.at !== 'number' || !Number.isFinite(value.at)) return null;
  if (typeof value.type !== 'string') return null;
  return parseClosed(safeJournalRecordParsers, value.type, value);
}

export function parseSafeJournalProjection(value: unknown): SafeJournalProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['records', 'partial']) ||
    !Array.isArray(value.records) ||
    value.records.some((record) => parseSafeJournalRecord(record) === null) ||
    typeof value.partial !== 'boolean'
  ) {
    return null;
  }
  return value as unknown as SafeJournalProjection;
}

export function parseDispatchMainEvent(value: unknown): DispatchMainEvent | null {
  if (
    !isRecord(value) ||
    !isUuid(value.dispatchId) ||
    !parseChildSessionIdentity(value.child) ||
    !isSequence(value.mainSeq)
  ) {
    return null;
  }
  if (value.phase === 'terminal') {
    return hasOnlyKeys(value, [
      'dispatchId',
      'child',
      'mainSeq',
      'phase',
      'terminal',
      'receiptSummary',
    ]) &&
      (value.terminal === 'completed' ||
        value.terminal === 'failed' ||
        value.terminal === 'cancelled') &&
      (value.receiptSummary === undefined || typeof value.receiptSummary === 'string')
      ? (value as unknown as DispatchMainEvent)
      : null;
  }
  const phases: readonly DispatchProgressPhase[] = [
    'received',
    'source-bound',
    'capacity-reserved',
    'parent-spawning',
    'parent-ready',
    'child-spawning',
    'child-ready',
    'task-dispatched',
    'running',
    'waiting-user',
    'waiting-approval',
  ];
  return hasExactKeys(value, ['dispatchId', 'child', 'mainSeq', 'phase']) &&
    phases.includes(value.phase as DispatchProgressPhase)
    ? (value as unknown as DispatchMainEvent)
    : null;
}

export function shouldApplyDispatchMainEvent(
  current: DispatchMainEvent | null,
  next: DispatchMainEvent
): boolean {
  if (!current) return true;
  return (
    current.dispatchId === next.dispatchId &&
    isSameChildSessionIdentity(current.child, next.child) &&
    current.phase !== 'terminal' &&
    next.mainSeq > current.mainSeq
  );
}

function parseResolvedAgentTypeSpawnConfig(value: unknown): ResolvedAgentTypeSpawnConfig | null {
  if (!isRecord(value)) return null;
  if (
    !hasOnlyKeys(value, [
      'typeKey',
      'displayName',
      'description',
      'spawnSpecId',
      'systemPrompt',
      'model',
      'tools',
      'reasoning',
      'thinkingLevel',
      'allowedToolIds',
      'skillPaths',
      'skillBindingIds',
      'mcpServers',
      'mcpBindingIds',
      'systemPromptHash',
    ]) ||
    Object.keys(value).length < 12
  ) {
    return null;
  }
  const typeKey = parseAgentTypeKey(value.typeKey);
  const model = parseSessionModelConfig(value.model);
  const skillPaths = Array.isArray(value.skillPaths) ? value.skillPaths : null;
  const mcpServers = Array.isArray(value.mcpServers) ? value.mcpServers : null;
  const skillBindingIds = Array.isArray(value.skillBindingIds) ? value.skillBindingIds : null;
  const mcpBindingIds = Array.isArray(value.mcpBindingIds) ? value.mcpBindingIds : null;
  if (
    !typeKey ||
    typeKey === LEGACY_ENSO_TYPE_KEY ||
    !model ||
    !isUuid(value.spawnSpecId) ||
    !isNonEmptyString(value.displayName) ||
    typeof value.description !== 'string' ||
    typeof value.systemPrompt !== 'string' ||
    (value.tools !== 'all' && value.tools !== 'readonly') ||
    (value.allowedToolIds !== undefined &&
      (!Array.isArray(value.allowedToolIds) || !value.allowedToolIds.every(isNonEmptyString))) ||
    !skillPaths ||
    !skillPaths.every(isNonEmptyString) ||
    !skillBindingIds ||
    !skillBindingIds.every(isNonEmptyString) ||
    !mcpServers ||
    !mcpServers.every(isRecord) ||
    !mcpBindingIds ||
    !mcpBindingIds.every(isNonEmptyString) ||
    skillBindingIds.length !== skillPaths.length ||
    mcpBindingIds.length !== mcpServers.length ||
    !isNonEmptyString(value.systemPromptHash)
  ) {
    return null;
  }
  // 类型级推理预设：白名单取值，非法一律拒收（Main→worker 信任边界）
  if (
    (value.reasoning !== undefined &&
      !MODEL_REASONING_OVERRIDES.includes(value.reasoning as ModelReasoningOverride)) ||
    (value.thinkingLevel !== undefined &&
      !MODEL_THINKING_LEVEL_OVERRIDES.includes(value.thinkingLevel as ModelThinkingLevelOverride))
  ) {
    return null;
  }
  return value as unknown as ResolvedAgentTypeSpawnConfig;
}

export function parseSessionSnapshot(value: unknown): SessionSnapshot | null {
  if (!isRecord(value)) return null;
  if (
    !hasOnlyKeys(value, [
      'identity',
      'status',
      'messages',
      'baseIndex',
      'commands',
      'pendingApprovals',
      'pendingAsks',
      'backgroundTasks',
      'subagents',
      'safeJournal',
      'child',
      'customEntries',
      'compaction',
      'compactionNoticeAt',
      'planState',
      'requestBody',
    ]) ||
    !parseAnySessionIdentity(value.identity) ||
    (value.status !== 'idle' && value.status !== 'running' && value.status !== 'failed') ||
    !Array.isArray(value.messages) ||
    value.messages.some((message) => !isRecord(message) || !hasValidProjectedMetadata(message)) ||
    !Array.isArray(value.commands) ||
    value.commands.some(
      (command) =>
        !isRecord(command) ||
        !isNonEmptyString(command.name) ||
        typeof command.description !== 'string'
    ) ||
    (value.child !== undefined && parseChildConversationMetadata(value.child) === null) ||
    (value.planState !== undefined && parsePlanState(value.planState) === null) ||
    (value.requestBody !== undefined && parseRequestBodyUsage(value.requestBody) === null) ||
    (value.safeJournal !== undefined && parseSafeJournalProjection(value.safeJournal) === null) ||
    (value.customEntries !== undefined &&
      (!Array.isArray(value.customEntries) ||
        value.customEntries.some((entry) => parseAgentSessionCustomEntry(entry) === null))) ||
    (value.baseIndex !== undefined &&
      (typeof value.baseIndex !== 'number' ||
        !Number.isInteger(value.baseIndex) ||
        value.baseIndex < 0))
  ) {
    return null;
  }
  return value as unknown as SessionSnapshot;
}

const parseWorkspaceLockCommand = (value: Record<string, unknown>): AgentCommand | null => {
  return hasOnlyKeys(
    value,
    value.type === 'lock-workspace'
      ? ['type', 'requestId', 'conversationIds']
      : ['type', 'requestId', 'conversationIds', 'branch']
  ) &&
    isNonEmptyString(value.requestId) &&
    Array.isArray(value.conversationIds) &&
    value.conversationIds.length > 0 &&
    value.conversationIds.every(isNonEmptyString) &&
    new Set(value.conversationIds).size === value.conversationIds.length &&
    (value.branch === undefined || isNonEmptyString(value.branch))
    ? (value as unknown as AgentCommand)
    : null;
};

const parsePromptOrSteer = (value: Record<string, unknown>): AgentCommand | null => {
  const images = value.images === undefined ? [] : parseAttachedImages(value.images);
  return hasOnlyKeys(value, [
    'type',
    'identity',
    'text',
    'images',
    'deliveryId',
    'activeOnly',
    'resume',
    'ownerInput',
    'instanceId',
  ]) &&
    parseAnySessionIdentity(value.identity) &&
    typeof value.text === 'string' &&
    images !== null &&
    (value.text.length > 0 || images.length > 0) &&
    (value.activeOnly === undefined ||
      (value.type === 'steer' && value.activeOnly === true && isDeliveryId(value.deliveryId))) &&
    (value.resume === undefined || (value.type === 'prompt' && value.resume === true)) &&
    (value.ownerInput === undefined ||
      (value.ownerInput === true && isDeliveryId(value.deliveryId))) &&
    ((value.type === 'steer' && value.deliveryId === undefined) ||
      isDeliveryId(value.deliveryId)) &&
    (value.instanceId === undefined ||
      (isUuid(value.instanceId) && parseSessionIdentity(value.identity) !== null))
    ? (value as unknown as AgentCommand)
    : null;
};

const parseHostResultCommand = (value: Record<string, unknown>): AgentCommand | null => {
  if (
    !hasOnlyKeys(value, ['type', 'identity', 'requestId', 'ok', 'result', 'error']) ||
    !parseAnySessionIdentity(value.identity) ||
    !isNonEmptyString(value.requestId) ||
    typeof value.ok !== 'boolean'
  ) {
    return null;
  }
  const shapeOk = value.ok
    ? value.error === undefined
    : isNonEmptyString(value.error) && value.result === undefined;
  return shapeOk ? (value as unknown as AgentCommand) : null;
};

const parseIdentityOnlyCommand = (value: Record<string, unknown>): AgentCommand | null => {
  return hasExactKeys(value, ['type', 'identity']) && parseAnySessionIdentity(value.identity)
    ? (value as unknown as AgentCommand)
    : null;
};
const agentCommandParsers = {
  'oauth-pool-result': (value: Record<string, unknown>): AgentCommand | null => {
    return hasOnlyKeys(value, ['type', 'requestId', 'accountKey', 'selectionReceipt', 'error']) &&
      isNonEmptyString(value.requestId) &&
      ((isCodexAccountKey(value.accountKey) &&
        value.error === undefined &&
        (value.selectionReceipt === undefined || isUuid(value.selectionReceipt))) ||
        (value.accountKey === undefined &&
          value.selectionReceipt === undefined &&
          isNonEmptyString(value.error)))
      ? (value as unknown as AgentCommand)
      : null;
  },
  'mcp-oauth-refresh-result': (value: Record<string, unknown>): AgentCommand | null => {
    return hasOnlyKeys(value, ['type', 'requestId', 'result']) &&
      isNonEmptyString(value.requestId) &&
      isMcpOAuthRefreshResult(value.result)
      ? (value as unknown as AgentCommand)
      : null;
  },
  'lock-workspace': parseWorkspaceLockCommand,
  'unlock-workspace': parseWorkspaceLockCommand,
  'spawn-parent': (value: Record<string, unknown>): AgentCommand | null => {
    if (
      !hasOnlyKeys(value, [
        'type',
        'identity',
        'cwd',
        'model',
        'resumeFile',
        'reasoningEnabled',
        'thinkingLevel',
        'loadLocalSkills',
        'loadHarnessAssets',
        'trustedProjectCode',
        'exploreFoldEnabled',
        'editMode',
        'hashlineEditEnabled',
        'compactStrategy',
        'smartCompactEnabled',
        'smartCompactSummaryModel',
        'smartCompactMode',
        'memoryLanguage',
        'skillPaths',
        'mcpServers',
        'pluginTools',
        'secretaryTools',
        'workflowPresetFiles',
        'pluginEvents',
        'instruction',
        'approvalMode',
        'autoRejectApprovals',
        'askRelay',
        'approvalReviewer',
        'approvalReviewerClassifier',
        'approvalReviewerManaged',
        'approvalReviewerAllowThreshold',
        'agentTypes',
        'subagentModels',
        'disabledTools',
        'windowsLocalShell',
        'rtkEnabled',
        'dcgPath',
        'dcgExemptRules',
        'dcgExtraPacks',
        'remote',
        'rolePrompt',
        'systemPrompt',
        'systemPromptAppend',
        'systemPromptBoost',
        'refusalRetryPrompt',
        'botMode',
        'botGroupTasks',
        'botDiscussMode',
        'botRoutines',
        'secretaryMode',
        'botDelegationTask',
        'botWriteLock',
        'protectedActions',
        'secretaryTrustedPluginIds',
        'planMode',
        'instanceId',
        'forkFrom',
      ]) ||
      !parseSessionIdentity(value.identity) ||
      typeof value.cwd !== 'string' ||
      !parseSessionModelConfig(value.model) ||
      (value.resumeFile !== undefined && !isNonEmptyString(value.resumeFile)) ||
      (value.loadHarnessAssets !== undefined && typeof value.loadHarnessAssets !== 'boolean') ||
      (value.trustedProjectCode !== undefined &&
        !(
          Array.isArray(value.trustedProjectCode) &&
          value.trustedProjectCode.length <= 500 &&
          value.trustedProjectCode.every(
            (entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 1024
          )
        )) ||
      (value.pluginTools !== undefined && !isPluginToolList(value.pluginTools)) ||
      (value.secretaryTools !== undefined &&
        parseSecretaryToolDescriptors(value.secretaryTools) === null) ||
      (value.workflowPresetFiles !== undefined &&
        !(
          Array.isArray(value.workflowPresetFiles) &&
          value.workflowPresetFiles.length <= 500 &&
          value.workflowPresetFiles.every(
            (entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 1024
          )
        )) ||
      (value.pluginEvents !== undefined && !isPluginEventPlan(value.pluginEvents)) ||
      (value.rtkEnabled !== undefined && typeof value.rtkEnabled !== 'boolean') ||
      (value.dcgPath !== undefined && !isNonEmptyString(value.dcgPath)) ||
      (value.dcgExemptRules !== undefined &&
        !(
          Array.isArray(value.dcgExemptRules) &&
          value.dcgExemptRules.length <= 500 &&
          value.dcgExemptRules.every(isDcgRuleId)
        )) ||
      (value.dcgExtraPacks !== undefined &&
        !(
          Array.isArray(value.dcgExtraPacks) &&
          value.dcgExtraPacks.length <= 32 &&
          value.dcgExtraPacks.every(
            (entry) => typeof entry === 'string' && /^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/.test(entry)
          )
        )) ||
      (value.planMode !== undefined && typeof value.planMode !== 'boolean') ||
      (value.windowsLocalShell !== undefined &&
        !(WINDOWS_LOCAL_SHELLS as readonly string[]).includes(value.windowsLocalShell as string)) ||
      (value.exploreFoldEnabled !== undefined && typeof value.exploreFoldEnabled !== 'boolean') ||
      (value.editMode !== undefined && !isEditMode(value.editMode)) ||
      (value.hashlineEditEnabled !== undefined && typeof value.hashlineEditEnabled !== 'boolean') ||
      (value.compactStrategy !== undefined &&
        parseCompactStrategy(value.compactStrategy) === null) ||
      (value.smartCompactEnabled !== undefined && typeof value.smartCompactEnabled !== 'boolean') ||
      (value.smartCompactSummaryModel !== undefined &&
        parseSpawnModelConfig(value.smartCompactSummaryModel) === null) ||
      (value.smartCompactMode !== undefined &&
        parseSmartCompactMode(value.smartCompactMode) === null) ||
      (value.memoryLanguage !== undefined && typeof value.memoryLanguage !== 'string') ||
      (value.remote !== undefined && parseAgentRemoteConfig(value.remote) === null) ||
      (value.subagentModels !== undefined &&
        (!Array.isArray(value.subagentModels) ||
          value.subagentModels.some((entry) => parseSubagentModelOption(entry) === null))) ||
      (value.approvalReviewer !== undefined &&
        parseSpawnModelConfig(value.approvalReviewer) === null) ||
      (value.askRelay !== undefined &&
        (!isRecord(value.askRelay) || !isNonEmptyString(value.askRelay.name))) ||
      (value.approvalReviewerAllowThreshold !== undefined &&
        (!isApprovalAllowThreshold(value.approvalReviewerAllowThreshold) ||
          value.approvalReviewerClassifier === undefined)) ||
      (value.approvalReviewerManaged !== undefined &&
        (value.approvalReviewerManaged !== true ||
          value.approvalReviewerClassifier === undefined)) ||
      (value.approvalReviewerClassifier !== undefined &&
        (value.approvalReviewer !== undefined ||
          !parseClassifierCredentials(value.approvalReviewerClassifier))) ||
      (value.rolePrompt !== undefined && !isNonEmptyString(value.rolePrompt)) ||
      (value.systemPrompt !== undefined && !isNonEmptyString(value.systemPrompt)) ||
      (value.systemPromptAppend !== undefined && !isNonEmptyString(value.systemPromptAppend)) ||
      (value.systemPromptBoost !== undefined && !isNonEmptyString(value.systemPromptBoost)) ||
      (value.refusalRetryPrompt !== undefined && !isNonEmptyString(value.refusalRetryPrompt)) ||
      (value.botMode !== undefined && typeof value.botMode !== 'boolean') ||
      (value.botGroupTasks !== undefined && typeof value.botGroupTasks !== 'boolean') ||
      (value.botDiscussMode !== undefined && typeof value.botDiscussMode !== 'boolean') ||
      (value.botDiscussMode === true && (value.botMode !== true || value.botGroupTasks !== true)) ||
      (value.botRoutines !== undefined && typeof value.botRoutines !== 'boolean') ||
      (value.secretaryMode !== undefined && typeof value.secretaryMode !== 'boolean') ||
      (value.botDelegationTask !== undefined && typeof value.botDelegationTask !== 'boolean') ||
      (value.botWriteLock !== undefined &&
        (!isRecord(value.botWriteLock) ||
          !isNonEmptyString(value.botWriteLock.label) ||
          !Array.isArray(value.botWriteLock.ancestors) ||
          !value.botWriteLock.ancestors.every(isNonEmptyString))) ||
      (value.protectedActions !== undefined && typeof value.protectedActions !== 'boolean') ||
      (value.secretaryTrustedPluginIds !== undefined &&
        !(
          value.secretaryMode === true &&
          Array.isArray(value.secretaryTrustedPluginIds) &&
          value.secretaryTrustedPluginIds.length <= 500 &&
          value.secretaryTrustedPluginIds.every(
            (entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 256
          )
        )) ||
      (value.instanceId !== undefined && !isUuid(value.instanceId)) ||
      (value.forkFrom !== undefined && !isNonEmptyString(value.forkFrom))
    ) {
      return null;
    }
    return value as unknown as AgentCommand;
  },
  'spawn-child': (value: Record<string, unknown>): AgentCommand | null => {
    return hasOnlyKeys(value, ['type', 'identity', 'cwd', 'config', 'resumeFile', 'seedContext']) &&
      parseChildSessionIdentity(value.identity) &&
      typeof value.cwd === 'string' &&
      parseResolvedAgentTypeSpawnConfig(value.config) &&
      (value.resumeFile === undefined || isNonEmptyString(value.resumeFile)) &&
      (value.seedContext === undefined || isSubagentSeedContext(value.seedContext))
      ? (value as unknown as AgentCommand)
      : null;
  },
  'prompt-child': (value: Record<string, unknown>): AgentCommand | null => {
    return hasOnlyKeys(value, ['type', 'identity', 'requestId', 'task', 'requestBudget']) &&
      parseChildSessionIdentity(value.identity) &&
      isNonEmptyString(value.requestId) &&
      parseAgentDispatchTask(value.task) &&
      (value.requestBudget === undefined || value.requestBudget === true)
      ? (value as unknown as AgentCommand)
      : null;
  },
  'agent-control-result': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'identity', 'requestId', 'response']) &&
      parseAnySessionIdentity(value.identity) &&
      isNonEmptyString(value.requestId) &&
      parseAgentControlToolResponse(value.response)
      ? (value as unknown as AgentCommand)
      : null;
  },
  'dismiss-child': (value: Record<string, unknown>): AgentCommand | null => {
    const parent = parseSessionIdentity(value.parent);
    const child = parseChildSessionIdentity(value.child);
    return hasOnlyKeys(value, ['type', 'parent', 'child', 'notify']) &&
      parent &&
      child &&
      child.parent.sessionId === parent.sessionId &&
      child.parent.generation === parent.generation &&
      (value.notify === undefined || typeof value.notify === 'boolean')
      ? (value as unknown as AgentCommand)
      : null;
  },
  'dismiss-coworker': (value: Record<string, unknown>): AgentCommand | null => {
    const parent = parseSessionIdentity(value.parent);
    return hasOnlyKeys(value, ['type', 'parent', 'coworkerId', 'notify']) &&
      parent &&
      isNonEmptyString(value.coworkerId) &&
      // 归属校验：coworker id 恒为 `父id::cw-…`，防跨会话误解雇
      value.coworkerId.startsWith(`${parent.sessionId}::cw-`) &&
      (value.notify === undefined || typeof value.notify === 'boolean')
      ? (value as unknown as AgentCommand)
      : null;
  },
  'resume-coworker': (value: Record<string, unknown>): AgentCommand | null => {
    const parent = parseSessionIdentity(value.parent);
    return hasOnlyKeys(value, [
      'type',
      'parent',
      'coworkerId',
      'name',
      'agentType',
      'resumeFile',
    ]) &&
      parent &&
      isNonEmptyString(value.coworkerId) &&
      value.coworkerId.startsWith(`${parent.sessionId}::cw-`) &&
      isNonEmptyString(value.name) &&
      (value.agentType === undefined || isNonEmptyString(value.agentType)) &&
      isNonEmptyString(value.resumeFile)
      ? (value as unknown as AgentCommand)
      : null;
  },
  'complete-text': (value: Record<string, unknown>): AgentCommand | null => {
    return hasOnlyKeys(value, [
      'type',
      'requestId',
      'systemPrompt',
      'userText',
      'candidates',
      'timeoutMs',
      'maxTokens',
      'stream',
      'reasoning',
      'probe',
    ]) &&
      isNonEmptyString(value.requestId) &&
      typeof value.systemPrompt === 'string' &&
      typeof value.userText === 'string' &&
      typeof value.timeoutMs === 'number' &&
      Number.isFinite(value.timeoutMs) &&
      value.timeoutMs > 0 &&
      (value.maxTokens === undefined ||
        (typeof value.maxTokens === 'number' &&
          Number.isInteger(value.maxTokens) &&
          value.maxTokens > 0)) &&
      (value.stream === undefined || value.stream === true) &&
      (value.reasoning === undefined ||
        value.reasoning === 'off' ||
        THINKING_LEVELS.includes(value.reasoning as ThinkingLevel)) &&
      (value.probe === undefined || value.probe === true) &&
      Array.isArray(value.candidates) &&
      value.candidates.length >= 1 &&
      value.candidates.length <= TITLE_SUMMARY_MAX_CANDIDATES &&
      value.candidates.every((candidate) => parseSpawnModelConfig(candidate))
      ? (value as unknown as AgentCommand)
      : null;
  },
  'abort-complete-text': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'requestId']) && isNonEmptyString(value.requestId)
      ? (value as unknown as AgentCommand)
      : null;
  },
  'classify-choice': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, [
      'type',
      'requestId',
      'classifier',
      'state',
      'instructions',
      'criteria',
      'timeoutMs',
    ]) &&
      isNonEmptyString(value.requestId) &&
      parseClassifierCredentials(value.classifier) &&
      isRecord(value.state) &&
      isNonEmptyString(value.instructions) &&
      isRecord(value.criteria) &&
      Object.keys(value.criteria).length > 0 &&
      Object.values(value.criteria).every(isNonEmptyString) &&
      typeof value.timeoutMs === 'number' &&
      Number.isFinite(value.timeoutMs) &&
      value.timeoutMs > 0
      ? (value as unknown as AgentCommand)
      : null;
  },
  'abort-classify-choice': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'requestId']) && isNonEmptyString(value.requestId)
      ? (value as unknown as AgentCommand)
      : null;
  },
  'summarize-title': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'conversationId', 'input', 'candidates']) &&
      isNonEmptyString(value.conversationId) &&
      parseTitleSummaryInput(value.input) &&
      Array.isArray(value.candidates) &&
      value.candidates.length >= 1 &&
      value.candidates.length <= TITLE_SUMMARY_MAX_CANDIDATES &&
      value.candidates.every((candidate) => parseSpawnModelConfig(candidate))
      ? (value as unknown as AgentCommand)
      : null;
  },
  prompt: parsePromptOrSteer,
  steer: parsePromptOrSteer,
  'set-model': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'identity', 'model']) &&
      parseAnySessionIdentity(value.identity) &&
      parseSessionModelConfig(value.model)
      ? (value as unknown as AgentCommand)
      : null;
  },
  'set-thinking': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'identity', 'level']) &&
      parseAnySessionIdentity(value.identity) &&
      THINKING_LEVELS.includes(value.level as ThinkingLevel)
      ? (value as unknown as AgentCommand)
      : null;
  },
  'set-system-prompt': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'identity', 'systemPrompt']) &&
      parseSessionIdentity(value.identity) &&
      isNonEmptyString(value.systemPrompt)
      ? (value as unknown as AgentCommand)
      : null;
  },
  'set-reasoning': (value: Record<string, unknown>): AgentCommand | null => {
    return hasOnlyKeys(value, ['type', 'identity', 'enabled', 'level']) &&
      parseAnySessionIdentity(value.identity) &&
      typeof value.enabled === 'boolean' &&
      (value.level === undefined || THINKING_LEVELS.includes(value.level as ThinkingLevel))
      ? (value as unknown as AgentCommand)
      : null;
  },
  'approval-respond': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'identity', 'requestId', 'decision']) &&
      parseAnySessionIdentity(value.identity) &&
      isNonEmptyString(value.requestId) &&
      isApprovalDecision(value.decision)
      ? (value as unknown as AgentCommand)
      : null;
  },
  'request-timeout': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'identity', 'kind', 'requestId']) &&
      parseAnySessionIdentity(value.identity) &&
      (value.kind === 'approval' || value.kind === 'ask') &&
      isNonEmptyString(value.requestId)
      ? (value as unknown as AgentCommand)
      : null;
  },
  'agent-notify': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'identity', 'text', 'urgent']) &&
      parseSessionIdentity(value.identity) &&
      isNonEmptyString(value.text) &&
      typeof value.urgent === 'boolean'
      ? (value as unknown as AgentCommand)
      : null;
  },
  'set-approval-mode': (value: Record<string, unknown>): AgentCommand | null => {
    return hasOnlyKeys(value, ['type', 'identity', 'mode', 'autoReject']) &&
      parseAnySessionIdentity(value.identity) &&
      APPROVAL_MODES.includes(value.mode as ApprovalMode) &&
      (value.autoReject === undefined || typeof value.autoReject === 'boolean')
      ? (value as unknown as AgentCommand)
      : null;
  },
  'set-ask-relay': (value: Record<string, unknown>): AgentCommand | null => {
    return hasOnlyKeys(value, ['type', 'identity', 'relay']) &&
      parseAnySessionIdentity(value.identity) &&
      (value.relay === undefined || (isRecord(value.relay) && isNonEmptyString(value.relay.name)))
      ? (value as unknown as AgentCommand)
      : null;
  },
  'set-plan-mode': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'identity', 'active']) &&
      parseSessionIdentity(value.identity) &&
      typeof value.active === 'boolean'
      ? (value as unknown as AgentCommand)
      : null;
  },
  'plan-respond': (value: Record<string, unknown>): AgentCommand | null => {
    return hasOnlyKeys(value, ['type', 'identity', 'planId', 'action', 'feedback']) &&
      parseSessionIdentity(value.identity) &&
      isNonEmptyString(value.planId) &&
      PLAN_RESPOND_ACTIONS.includes(value.action as PlanRespondAction) &&
      (value.feedback === undefined ||
        (typeof value.feedback === 'string' && value.feedback.length <= PLAN_FEEDBACK_MAX))
      ? (value as unknown as AgentCommand)
      : null;
  },
  'set-approval-reviewer': (value: Record<string, unknown>): AgentCommand | null => {
    return hasOnlyKeys(value, ['type', 'model', 'classifier', 'managed', 'allowThreshold']) &&
      (value.allowThreshold === undefined ||
        (isApprovalAllowThreshold(value.allowThreshold) && value.classifier !== undefined)) &&
      (value.model === undefined || parseSpawnModelConfig(value.model)) &&
      (value.classifier === undefined ||
        (value.model === undefined && parseClassifierCredentials(value.classifier))) &&
      (value.managed === undefined || (value.managed === true && value.classifier !== undefined))
      ? (value as unknown as AgentCommand)
      : null;
  },
  'set-compact-route': (value: Record<string, unknown>): AgentCommand | null => {
    return hasOnlyKeys(value, ['type', 'model', 'mode']) &&
      (value.model === undefined || parseSpawnModelConfig(value.model) !== null) &&
      (value.mode === undefined || parseSmartCompactMode(value.mode) !== null)
      ? (value as unknown as AgentCommand)
      : null;
  },
  'set-max-active-coworkers': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'limit']) && parseMaxActiveCoworkers(value.limit) !== null
      ? (value as unknown as AgentCommand)
      : null;
  },
  'set-auto-retry-limit': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'limit']) && parseAutoRetryLimit(value.limit) !== null
      ? (value as unknown as AgentCommand)
      : null;
  },
  'set-long-cache-retention': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'enabled']) && typeof value.enabled === 'boolean'
      ? (value as unknown as AgentCommand)
      : null;
  },
  'set-agy-config': (value: Record<string, unknown>): AgentCommand | null => {
    if (
      !hasExactKeys(value, ['type', 'binaryPath', 'skipPermissions', 'models']) ||
      typeof value.binaryPath !== 'string' ||
      typeof value.skipPermissions !== 'boolean' ||
      !Array.isArray(value.models)
    ) {
      return null;
    }
    const models = [];
    for (const item of value.models) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const row = item as { id?: unknown; name?: unknown };
      if (typeof row.id !== 'string' || !row.id || typeof row.name !== 'string' || !row.name) {
        return null;
      }
      models.push({ id: row.id, name: row.name });
    }
    value.models = models;
    return value as unknown as AgentCommand;
  },
  'set-app-logging': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'enabled']) && typeof value.enabled === 'boolean'
      ? (value as unknown as AgentCommand)
      : null;
  },
  'set-shell-limits': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'limits']) &&
      isRecord(value.limits) &&
      JSON.stringify(resolveShellLimits(value.limits)) === JSON.stringify(value.limits)
      ? (value as unknown as AgentCommand)
      : null;
  },
  'set-privacy-masking': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'settings']) &&
      JSON.stringify(parsePrivacyMaskSettings(value.settings)) === JSON.stringify(value.settings)
      ? (value as unknown as AgentCommand)
      : null;
  },
  'set-image-generation-config': (value: Record<string, unknown>): AgentCommand | null => {
    return hasOnlyKeys(value, ['type', 'config', 'error']) &&
      (value.config === null || parseImageGenerationConfig(value.config) !== null) &&
      (value.error === undefined || (typeof value.error === 'string' && value.error.length <= 1024))
      ? (value as unknown as AgentCommand)
      : null;
  },
  'set-web-search-config': (value: Record<string, unknown>): AgentCommand | null => {
    return hasOnlyKeys(value, ['type', 'chain', 'configured']) &&
      (value.configured === undefined || typeof value.configured === 'boolean') &&
      Array.isArray(value.chain) &&
      value.chain.length <= WEB_SEARCH_CHAIN_MAX &&
      value.chain.every(isWebSearchChainEntry)
      ? (value as unknown as AgentCommand)
      : null;
  },
  'set-disabled-workflow-presets': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'ids']) &&
      Array.isArray(value.ids) &&
      value.ids.length <= 64 &&
      value.ids.every((id) => typeof id === 'string' && isWorkflowPresetId(id))
      ? (value as unknown as AgentCommand)
      : null;
  },
  'set-builtin-tools': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'identity', 'disabledTools']) &&
      parseSessionIdentity(value.identity) &&
      Array.isArray(value.disabledTools) &&
      value.disabledTools.length <= 64 &&
      value.disabledTools.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 64)
      ? (value as unknown as AgentCommand)
      : null;
  },
  'set-model-directory': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'snapshot', 'customProviders'])
      ? (value as unknown as AgentCommand)
      : null;
  },
  'ask-respond': (value: Record<string, unknown>): AgentCommand | null => {
    return hasOnlyKeys(value, ['type', 'identity', 'requestId', 'answer', 'by', 'name']) &&
      parseAnySessionIdentity(value.identity) &&
      isNonEmptyString(value.requestId) &&
      isNonEmptyString(value.answer) &&
      (value.by === undefined || value.by === 'user' || value.by === 'relay') &&
      (value.name === undefined || isNonEmptyString(value.name))
      ? (value as unknown as AgentCommand)
      : null;
  },
  'browser-result': parseHostResultCommand,
  'memory-result': parseHostResultCommand,
  'delegation-result': parseHostResultCommand,
  'computer-result': parseHostResultCommand,
  'plugin-tool-result': parseHostResultCommand,
  'secretary-result': (value: Record<string, unknown>): AgentCommand | null => {
    if (
      !hasOnlyKeys(value, ['type', 'identity', 'requestId', 'ok', 'result', 'error']) ||
      !parseSessionIdentity(value.identity) ||
      !isNonEmptyString(value.requestId) ||
      typeof value.ok !== 'boolean'
    ) {
      return null;
    }
    const shapeOk = value.ok
      ? value.error === undefined
      : isNonEmptyString(value.error) && value.result === undefined;
    return shapeOk ? (value as unknown as AgentCommand) : null;
  },
  'plugin-intercept-result': (value: Record<string, unknown>): AgentCommand | null => {
    if (
      !hasOnlyKeys(value, ['type', 'identity', 'requestId', 'ok', 'result', 'error']) ||
      !parseSessionIdentity(value.identity) ||
      !isNonEmptyString(value.requestId) ||
      typeof value.ok !== 'boolean'
    ) {
      return null;
    }
    const shapeOk = value.ok
      ? value.error === undefined
      : isNonEmptyString(value.error) && value.result === undefined;
    return shapeOk ? (value as unknown as AgentCommand) : null;
  },
  'plugin-tool-progress': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'identity', 'requestId', 'text']) &&
      parseSessionIdentity(value.identity) &&
      isNonEmptyString(value.requestId) &&
      isBoundedText(value.text, PLUGIN_PROGRESS_MAX_CHARS)
      ? (value as unknown as AgentCommand)
      : null;
  },
  'plugin-inject': (value: Record<string, unknown>): AgentCommand | null => {
    const sender = value.sender === undefined ? undefined : parsePluginInjectSender(value.sender);
    if (value.sender !== undefined && !sender) return null;
    const origin = value.origin === undefined ? undefined : parsePluginInjectOrigin(value.origin);
    if (value.origin !== undefined && !origin) return null;
    if (value.ownerConfirm !== undefined && typeof value.ownerConfirm !== 'boolean') return null;
    if (
      !(
        hasOnlyKeys(value, [...PLUGIN_INJECT_KEYS, 'images', 'origin', 'sender', 'ownerConfirm']) &&
        PLUGIN_INJECT_KEYS.every((key) => key in value) &&
        parsePluginInjectImages(value.images) !== null &&
        parseSessionIdentity(value.identity) &&
        isNonEmptyString(value.pluginId) &&
        value.pluginId.length <= 128 &&
        isNonEmptyString(value.pluginName) &&
        value.pluginName.length <= 256 &&
        isNonEmptyString(value.text) &&
        isBoundedText(value.text, PLUGIN_INJECT_WIRE_MAX_CHARS) &&
        (value.deliverAs === 'steer' ||
          value.deliverAs === 'followUp' ||
          value.deliverAs === 'nextTurn') &&
        typeof value.triggerTurn === 'boolean'
      )
    )
      return null;
    if (!sender && !origin) return value as unknown as AgentCommand;
    return {
      ...(value as unknown as AgentCommand),
      ...(origin ? { origin } : {}),
      ...(sender ? { sender } : {}),
    };
  },
  'workflow-stop': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'identity', 'runId']) &&
      parseAnySessionIdentity(value.identity) &&
      isNonEmptyString(value.runId) &&
      value.runId.length <= 80
      ? (value as unknown as AgentCommand)
      : null;
  },
  'task-stop': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'sessionId', 'taskId']) &&
      isNonEmptyString(value.sessionId) &&
      isNonEmptyString(value.taskId)
      ? (value as unknown as AgentCommand)
      : null;
  },
  'task-keep': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'sessionId', 'taskId', 'reason']) &&
      isNonEmptyString(value.sessionId) &&
      isNonEmptyString(value.taskId) &&
      (value.reason === null ||
        (typeof value.reason === 'string' && value.reason.length <= TASK_KEEP_REASON_MAX))
      ? (value as unknown as AgentCommand)
      : null;
  },
  'reminders-fire': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'sessionId']) && isNonEmptyString(value.sessionId)
      ? (value as unknown as AgentCommand)
      : null;
  },
  'reminders-clear': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'sessionId']) && isNonEmptyString(value.sessionId)
      ? (value as unknown as AgentCommand)
      : null;
  },
  'tool-background': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'identity', 'toolCallId']) &&
      parseAnySessionIdentity(value.identity) &&
      isNonEmptyString(value.toolCallId) &&
      value.toolCallId.length <= 512
      ? (value as unknown as AgentCommand)
      : null;
  },
  'subagent-stop': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'identity', 'agentId']) &&
      parseAnySessionIdentity(value.identity) &&
      isNonEmptyString(value.agentId)
      ? (value as unknown as AgentCommand)
      : null;
  },
  compact: (value: Record<string, unknown>): AgentCommand | null => {
    return hasOnlyKeys(value, ['type', 'identity', 'instructions']) &&
      parseAnySessionIdentity(value.identity) &&
      (value.instructions === undefined || isNonEmptyString(value.instructions))
      ? (value as unknown as AgentCommand)
      : null;
  },
  rewind: (value: Record<string, unknown>): AgentCommand | null => {
    return hasOnlyKeys(value, [
      'type',
      'identity',
      'entryId',
      'userIndexFromEnd',
      'restoreFiles',
    ]) &&
      parseAnySessionIdentity(value.identity) &&
      (value.entryId !== undefined
        ? isNonEmptyString(value.entryId) &&
          value.entryId.trim().length > 0 &&
          value.userIndexFromEnd === undefined
        : isSequence(value.userIndexFromEnd)) &&
      (value.restoreFiles === undefined || typeof value.restoreFiles === 'boolean')
      ? (value as unknown as AgentCommand)
      : null;
  },
  fork: (value: Record<string, unknown>): AgentCommand | null => {
    const hasEntry = typeof value.entryId === 'string';
    const hasIndex = typeof value.turnIndexFromEnd === 'number';
    return hasOnlyKeys(value, [
      'type',
      'identity',
      'targetConversationId',
      'entryId',
      'turnIndexFromEnd',
    ]) &&
      parseAnySessionIdentity(value.identity) &&
      isUuid(value.targetConversationId) &&
      (hasEntry
        ? !hasIndex && isNonEmptyString(value.entryId)
        : hasIndex && isSequence(value.turnIndexFromEnd))
      ? (value as unknown as AgentCommand)
      : null;
  },
  abort: parseIdentityOnlyCommand,
  'abort-retry': parseIdentityOnlyCommand,
  'release-parent': parseIdentityOnlyCommand,
  'withdraw-steer': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'identity', 'deliveryId']) &&
      parseAnySessionIdentity(value.identity) &&
      isDeliveryId(value.deliveryId)
      ? (value as unknown as AgentCommand)
      : null;
  },
  retry: (value: Record<string, unknown>): AgentCommand | null => {
    return hasOnlyKeys(value, [
      'type',
      'identity',
      'instanceId',
      'unfinishedOnly',
      'turnId',
      'requestBudget',
      'requestsUsed',
    ]) &&
      parseAnySessionIdentity(value.identity) &&
      (value.unfinishedOnly === undefined || value.unfinishedOnly === true) &&
      (value.turnId === undefined || isNonEmptyString(value.turnId)) &&
      (value.requestBudget === undefined || value.requestBudget === true) &&
      (value.requestsUsed === undefined ||
        (Number.isInteger(value.requestsUsed) && (value.requestsUsed as number) >= 0)) &&
      (value.instanceId === undefined ||
        (isUuid(value.instanceId) && parseSessionIdentity(value.identity) !== null))
      ? (value as unknown as AgentCommand)
      : null;
  },
  'append-session-custom-entry': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'identity', 'entry']) &&
      parseAnySessionIdentity(value.identity) &&
      parseAgentSessionCustomEntry(value.entry)
      ? (value as unknown as AgentCommand)
      : null;
  },
  'reload-session': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'requestId', 'sessionId']) &&
      isNonEmptyString(value.requestId) &&
      isNonEmptyString(value.sessionId)
      ? (value as unknown as AgentCommand)
      : null;
  },
  snapshot: (value: Record<string, unknown>): AgentCommand | null => {
    if (hasExactKeys(value, ['type'])) return { type: 'snapshot' };
    return hasExactKeys(value, ['type', 'sessionId']) && isNonEmptyString(value.sessionId)
      ? { type: 'snapshot', sessionId: value.sessionId }
      : null;
  },
  'pin-sessions': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'sessionIds']) &&
      Array.isArray(value.sessionIds) &&
      value.sessionIds.every((id) => typeof id === 'string')
      ? { type: 'pin-sessions', sessionIds: value.sessionIds }
      : null;
  },
  'graceful-restart': (value: Record<string, unknown>): AgentCommand | null => {
    if (hasExactKeys(value, ['type'])) return { type: 'graceful-restart' };
    return hasExactKeys(value, ['type', 'keepBackgroundTasks']) &&
      value.keepBackgroundTasks === true
      ? { type: 'graceful-restart', keepBackgroundTasks: true }
      : null;
  },
  'detach-background-tasks': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type']) ? { type: 'detach-background-tasks' } : null;
  },
  'warm-mcp': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'servers']) && Array.isArray(value.servers)
      ? (value as unknown as AgentCommand)
      : null;
  },
  'plugin-mcp-list': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'requestId', 'servers']) &&
      isNonEmptyString(value.requestId) &&
      Array.isArray(value.servers)
      ? (value as unknown as AgentCommand)
      : null;
  },
  'plugin-mcp-call': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'requestId', 'servers', 'server', 'tool', 'args']) &&
      isNonEmptyString(value.requestId) &&
      Array.isArray(value.servers) &&
      isNonEmptyString(value.server) &&
      isNonEmptyString(value.tool) &&
      isRecord(value.args)
      ? (value as unknown as AgentCommand)
      : null;
  },
  'plugin-mcp-cancel': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'requestId']) && isNonEmptyString(value.requestId)
      ? { type: 'plugin-mcp-cancel', requestId: value.requestId }
      : null;
  },
  'plugin-agent-run': (value: Record<string, unknown>): AgentCommand | null => {
    return hasOnlyKeys(value, [
      'type',
      'requestId',
      'identity',
      'prompt',
      'systemPrompt',
      'context',
      'timeoutMs',
      'model',
    ]) &&
      isNonEmptyString(value.requestId) &&
      parseSessionIdentity(value.identity) &&
      isNonEmptyString(value.prompt) &&
      isBoundedText(value.prompt, PLUGIN_AGENT_PROMPT_MAX_CHARS) &&
      (value.systemPrompt === undefined ||
        (typeof value.systemPrompt === 'string' &&
          isBoundedText(value.systemPrompt, PLUGIN_AGENT_SYSTEM_MAX_CHARS))) &&
      (value.context === 'conversation' || value.context === 'fork' || value.context === 'none') &&
      Number.isInteger(value.timeoutMs) &&
      (value.timeoutMs as number) > 0 &&
      (value.timeoutMs as number) <= PLUGIN_AGENT_MAX_TIMEOUT_MS &&
      (value.model === undefined || parseSpawnModelConfig(value.model) !== null)
      ? (value as unknown as AgentCommand)
      : null;
  },
  'plugin-agent-cancel': (value: Record<string, unknown>): AgentCommand | null => {
    return hasExactKeys(value, ['type', 'requestId']) && isNonEmptyString(value.requestId)
      ? { type: 'plugin-agent-cancel', requestId: value.requestId }
      : null;
  },
  'set-proxy-env': (value: Record<string, unknown>): AgentCommand | null => {
    if (!hasExactKeys(value, ['type', 'env']) || !isRecord(value.env)) return null;
    for (const entry of Object.values(value.env)) {
      if (entry !== null && typeof entry !== 'string') return null;
    }
    return value as unknown as AgentCommand;
  },
} satisfies Record<AgentCommand['type'], ClosedParser<AgentCommand>>;

/** 收窄 Main → worker 命令。旧 global/builtin session shape 一律拒绝。 */
export function parseAgentCommand(value: unknown): AgentCommand | null {
  if (!isRecord(value) || !isNonEmptyString(value.type)) return null;
  return parseClosed(agentCommandParsers, value.type, value);
}

const isOptionalTimestamp = (value: unknown): boolean =>
  value === undefined || (typeof value === 'number' && Number.isFinite(value));

const DEFERRED_SESSION_KEYS = new Set([
  'identity',
  'reason',
  'toolsInFlight',
  'toolNames',
  'undetachableTasks',
  'reply',
]);

function isRestartReplyProgress(value: unknown): value is RestartReplyProgress {
  return (
    isRecord(value) &&
    Object.keys(value).every(
      (key) => key === 'requestStartMs' || key === 'firstTokenMs' || key === 'lastOutputMs'
    ) &&
    isNonNegativeNumber(value.requestStartMs) &&
    (value.firstTokenMs === undefined || isNonNegativeNumber(value.firstTokenMs)) &&
    (value.lastOutputMs === undefined || isNonNegativeNumber(value.lastOutputMs))
  );
}

const parseWorkspaceLockResult = (value: Record<string, unknown>): AgentWorkerEvent | null => {
  return hasOnlyKeys(value, ['type', 'requestId', 'ok', 'error']) &&
    isNonEmptyString(value.requestId) &&
    (value.ok === true
      ? value.error === undefined
      : value.ok === false && isNonEmptyString(value.error))
    ? (value as unknown as AgentWorkerEvent)
    : null;
};
const parseParentLifecycleEnd = requireEventIdentity(
  'parent',
  (value: Record<string, unknown>): AgentWorkerEvent | null => {
    return hasOnlyKeys(value, ['type', 'identity', 'seq', 'reason', 'instanceId']) &&
      isNonEmptyString(value.reason) &&
      (value.instanceId === undefined || isUuid(value.instanceId))
      ? (value as unknown as AgentWorkerEvent)
      : null;
  }
);

const parseChildLifecycleEnd = requireEventIdentity(
  'child',
  (value: Record<string, unknown>): AgentWorkerEvent | null => {
    return isNonEmptyString(value.reason) ? (value as unknown as AgentWorkerEvent) : null;
  }
);
const parseDeliveryOutcome = requireEventIdentity(
  'any',
  (value: Record<string, unknown>): AgentWorkerEvent | null => {
    return hasExactKeys(value, ['type', 'identity', 'seq', 'deliveryId']) &&
      isDeliveryId(value.deliveryId)
      ? (value as unknown as AgentWorkerEvent)
      : null;
  }
);

const parseTaskEvent = requireEventIdentity(
  'any',
  (value: Record<string, unknown>): AgentWorkerEvent | null => {
    return isNonEmptyString(value.taskId) ? (value as unknown as AgentWorkerEvent) : null;
  }
);
const agentWorkerEventParsers = {
  'privacy-mask-ledger': (value: Record<string, unknown>): AgentWorkerEvent | null => {
    const record = parsePrivacyMaskRecord(value.record);
    return hasExactKeys(value, ['type', 'record']) && record
      ? { type: 'privacy-mask-ledger', record }
      : null;
  },
  'oauth-pool-select': (value: Record<string, unknown>): AgentWorkerEvent | null => {
    return hasOnlyKeys(value, [
      'type',
      'requestId',
      'settingsProviderId',
      'modelId',
      'failed',
      'excludedAccountKeys',
    ]) &&
      isNonEmptyString(value.requestId) &&
      isNonEmptyString(value.settingsProviderId) &&
      isNonEmptyString(value.modelId) &&
      (value.excludedAccountKeys === undefined ||
        (Array.isArray(value.excludedAccountKeys) &&
          value.excludedAccountKeys.length <= 100 &&
          value.excludedAccountKeys.every(isCodexAccountKey))) &&
      (value.failed === undefined || parseOauthPoolFailure(value.failed) !== null)
      ? (value as unknown as AgentWorkerEvent)
      : null;
  },
  'workspace-lock-result': parseWorkspaceLockResult,
  'workspace-unlock-result': parseWorkspaceLockResult,
  'plugin-mcp-result': (value: Record<string, unknown>): AgentWorkerEvent | null => {
    if (!isNonEmptyString(value.requestId)) return null;
    if (value.ok === true)
      return hasExactKeys(value, ['type', 'requestId', 'ok', 'value'])
        ? (value as unknown as AgentWorkerEvent)
        : null;
    return value.ok === false &&
      hasExactKeys(value, ['type', 'requestId', 'ok', 'error']) &&
      isNonEmptyString(value.error)
      ? (value as unknown as AgentWorkerEvent)
      : null;
  },
  'plugin-agent-event': (value: Record<string, unknown>): AgentWorkerEvent | null => {
    if (!hasExactKeys(value, ['type', 'requestId', 'event']) || !isNonEmptyString(value.requestId))
      return null;
    const event = parsePluginAgentRunEvent(value.event);
    return event ? { type: 'plugin-agent-event', requestId: value.requestId, event } : null;
  },
  'session-reloaded': (value: Record<string, unknown>): AgentWorkerEvent | null => {
    if (
      !hasExactKeys(value, ['type', 'requestId', 'result']) ||
      !isNonEmptyString(value.requestId) ||
      !isRecord(value.result)
    )
      return null;
    const result = value.result;
    const valid =
      result.ok === true
        ? hasExactKeys(result, ['ok', 'snapshot', 'seq']) &&
          parseSessionSnapshot(result.snapshot) !== null &&
          isSequence(result.seq)
        : result.ok === false &&
          hasExactKeys(result, ['ok', 'error']) &&
          isNonEmptyString(result.error);
    return valid ? (value as unknown as AgentWorkerEvent) : null;
  },
  snapshot: (value: Record<string, unknown>): AgentWorkerEvent | null => {
    return Array.isArray(value.sessions) &&
      value.sessions.every((session) => parseSessionSnapshot(session) !== null)
      ? (value as unknown as AgentWorkerEvent)
      : null;
  },
  'mcp-status': (value: Record<string, unknown>): AgentWorkerEvent | null => {
    // 该事件会广播到全部窗口，字段白名单 + 逐项类型都要卡死
    return hasOnlyKeys(value, [
      'type',
      'serverId',
      'serverName',
      'state',
      'toolCount',
      'error',
      'scopeChallenge',
    ]) &&
      (value.scopeChallenge === undefined || isMcpScopeChallenge(value.scopeChallenge)) &&
      isNonEmptyString(value.serverName) &&
      (value.serverId === undefined || isNonEmptyString(value.serverId)) &&
      (value.toolCount === undefined || isSequence(value.toolCount)) &&
      (value.error === undefined || typeof value.error === 'string') &&
      MCP_CONNECTION_STATES.includes(value.state as McpConnectionState)
      ? (value as unknown as AgentWorkerEvent)
      : null;
  },
  'mcp-oauth-refresh': (value: Record<string, unknown>): AgentWorkerEvent | null => {
    return hasOnlyKeys(value, ['type', 'requestId', 'serverId', 'rejected']) &&
      isNonEmptyString(value.requestId) &&
      isNonEmptyString(value.serverId) &&
      (value.rejected === undefined || isNonEmptyString(value.rejected))
      ? (value as unknown as AgentWorkerEvent)
      : null;
  },
  'title-generated': (value: Record<string, unknown>): AgentWorkerEvent | null => {
    return hasExactKeys(value, ['type', 'conversationId', 'title']) &&
      isNonEmptyString(value.conversationId) &&
      isNonEmptyString(value.title)
      ? (value as unknown as AgentWorkerEvent)
      : null;
  },
  'title-failed': (value: Record<string, unknown>): AgentWorkerEvent | null => {
    return hasExactKeys(value, ['type', 'conversationId', 'error']) &&
      isNonEmptyString(value.conversationId) &&
      isNonEmptyString(value.error)
      ? (value as unknown as AgentWorkerEvent)
      : null;
  },
  'tool-batch-completed': (value: Record<string, unknown>): AgentWorkerEvent | null => {
    return hasExactKeys(value, ['type', 'identity', 'digest']) &&
      parseSessionIdentity(value.identity) &&
      parseToolBatchDigest(value.digest)
      ? (value as unknown as AgentWorkerEvent)
      : null;
  },
  'graceful-restart-deferred': (value: Record<string, unknown>): AgentWorkerEvent | null => {
    return hasExactKeys(value, ['type', 'sessions']) &&
      Array.isArray(value.sessions) &&
      value.sessions.every(
        (entry) =>
          isRecord(entry) &&
          Object.keys(entry).every((key) => DEFERRED_SESSION_KEYS.has(key)) &&
          (entry.undetachableTasks === undefined ||
            (Array.isArray(entry.undetachableTasks) &&
              entry.undetachableTasks.every(isNonEmptyString))) &&
          (entry.toolNames === undefined ||
            (Array.isArray(entry.toolNames) && entry.toolNames.every(isNonEmptyString))) &&
          (entry.reply === undefined || isRestartReplyProgress(entry.reply)) &&
          parseSessionIdentity(entry.identity) &&
          (entry.reason === 'tool-in-flight' ||
            entry.reason === 'turn-in-progress' ||
            entry.reason === 'session-starting') &&
          Array.isArray(entry.toolsInFlight) &&
          entry.toolsInFlight.every(isNonEmptyString)
      )
      ? (value as unknown as AgentWorkerEvent)
      : null;
  },
  // 断点内容由 Main 用 parseRestartCheckpoint 细验（该函数带 node:fs，渲染层不能引）
  'graceful-restart-ready': (value: Record<string, unknown>): AgentWorkerEvent | null => {
    return hasExactKeys(value, ['type', 'checkpoint']) &&
      isRecord(value.checkpoint) &&
      Array.isArray(value.checkpoint.sessions)
      ? (value as unknown as AgentWorkerEvent)
      : null;
  },
  'background-tasks-detached': (value: Record<string, unknown>): AgentWorkerEvent | null => {
    return hasExactKeys(value, ['type', 'detached']) &&
      typeof value.detached === 'number' &&
      Number.isInteger(value.detached) &&
      value.detached >= 0
      ? (value as unknown as AgentWorkerEvent)
      : null;
  },
  'session-wake-requested': (value: Record<string, unknown>): AgentWorkerEvent | null => {
    return hasExactKeys(value, ['type', 'sessionId']) && isNonEmptyString(value.sessionId)
      ? (value as unknown as AgentWorkerEvent)
      : null;
  },
  'session-reminder-due': (value: Record<string, unknown>): AgentWorkerEvent | null => {
    return hasExactKeys(value, ['type', 'sessionId']) && isNonEmptyString(value.sessionId)
      ? (value as unknown as AgentWorkerEvent)
      : null;
  },
  'session-reminders-changed': (value: Record<string, unknown>): AgentWorkerEvent | null => {
    if (
      !hasExactKeys(value, ['type', 'sessionId', 'reminders']) ||
      !isNonEmptyString(value.sessionId) ||
      !Array.isArray(value.reminders)
    ) {
      return null;
    }
    for (const item of value.reminders) {
      if (
        !isRecord(item) ||
        !hasOnlyKeys(item, ['id', 'dueAt', 'label']) ||
        !isNonEmptyString(item.id) ||
        typeof item.dueAt !== 'number' ||
        !Number.isFinite(item.dueAt) ||
        item.dueAt < 0 ||
        (item.label !== undefined && typeof item.label !== 'string')
      ) {
        return null;
      }
    }
    return value as unknown as AgentWorkerEvent;
  },
  'unopened-background-tasks': (value: Record<string, unknown>): AgentWorkerEvent | null => {
    return hasExactKeys(value, ['type', 'sessionId', 'tasks']) &&
      isNonEmptyString(value.sessionId) &&
      Array.isArray(value.tasks) &&
      value.tasks.every((task) => isRecord(task) && isNonEmptyString(task.taskId))
      ? (value as unknown as AgentWorkerEvent)
      : null;
  },
  'text-delta': (value: Record<string, unknown>): AgentWorkerEvent | null => {
    return hasOnlyKeys(value, ['type', 'requestId', 'text', 'thinking']) &&
      isNonEmptyString(value.requestId) &&
      typeof value.text === 'string' &&
      (value.thinking === undefined || typeof value.thinking === 'string')
      ? (value as unknown as AgentWorkerEvent)
      : null;
  },
  'text-completed': (value: Record<string, unknown>): AgentWorkerEvent | null => {
    return hasExactKeys(value, ['type', 'requestId', 'text']) &&
      isNonEmptyString(value.requestId) &&
      typeof value.text === 'string'
      ? (value as unknown as AgentWorkerEvent)
      : null;
  },
  'text-failed': (value: Record<string, unknown>): AgentWorkerEvent | null => {
    return hasExactKeys(value, ['type', 'requestId', 'error']) &&
      isNonEmptyString(value.requestId) &&
      isNonEmptyString(value.error)
      ? (value as unknown as AgentWorkerEvent)
      : null;
  },
  'choice-classified': (value: Record<string, unknown>): AgentWorkerEvent | null => {
    return hasExactKeys(value, ['type', 'requestId', 'probabilities']) &&
      isNonEmptyString(value.requestId) &&
      isRecord(value.probabilities) &&
      Object.values(value.probabilities).every((p) => typeof p === 'number' && Number.isFinite(p))
      ? (value as unknown as AgentWorkerEvent)
      : null;
  },
  'choice-failed': (value: Record<string, unknown>): AgentWorkerEvent | null => {
    return hasExactKeys(value, ['type', 'requestId', 'error']) &&
      isNonEmptyString(value.requestId) &&
      isNonEmptyString(value.error)
      ? (value as unknown as AgentWorkerEvent)
      : null;
  },
  'parent-ready': requireEventIdentity(
    'parent',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return isNonEmptyString(value.sessionFile) &&
        parseModelRef(value.model) &&
        (value.imageInput === undefined || typeof value.imageInput === 'boolean')
        ? (value as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  'model-changed': requireEventIdentity(
    'parent',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return parseModelRef(value.model) &&
        (value.imageInput === undefined || typeof value.imageInput === 'boolean')
        ? (value as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  'parent-rejected': parseParentLifecycleEnd,
  'parent-ended': parseParentLifecycleEnd,
  'child-rejected': parseChildLifecycleEnd,
  'child-ended': parseChildLifecycleEnd,
  'child-reserved': requireEventIdentity(
    'child',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return isNonEmptyString(value.requestId) && parseChildConversationMetadata(value.metadata)
        ? (value as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  'child-ready': requireEventIdentity(
    'child',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      const proof = parseResolvedChildProfileProof(value.proof);
      const identity = parseChildSessionIdentity(value.identity);
      if (!identity) return null;
      if (
        !hasExactKeys(value, ['type', 'identity', 'seq', 'sessionFile', 'proof']) ||
        !isNonEmptyString(value.sessionFile) ||
        !proof ||
        !('typeKey' in identity) ||
        proof.typeKey !== identity.typeKey
      ) {
        return null;
      }
      return value as unknown as AgentWorkerEvent;
    }
  ),
  'request-body': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      const identity = parseAnySessionIdentity(value.identity);
      if (!identity || !isSequence(value.seq)) return null;
      const usage = parseRequestBodyUsage(value.usage);
      return hasExactKeys(value, ['type', 'identity', 'seq', 'usage']) && usage
        ? { type: 'request-body', identity, seq: value.seq, usage }
        : null;
    }
  ),
  'agent-control-invoke': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return hasExactKeys(value, ['type', 'identity', 'seq', 'requestId', 'request']) &&
        isNonEmptyString(value.requestId) &&
        parseAgentControlToolRequest(value.request)
        ? (value as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  'agent-control-cancel': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return hasExactKeys(value, ['type', 'identity', 'seq', 'requestId', 'kind']) &&
        isNonEmptyString(value.requestId) &&
        (value.kind === 'abort' || value.kind === 'detach')
        ? (value as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  'browser-invoke': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return hasExactKeys(value, ['type', 'identity', 'seq', 'requestId', 'op', 'params']) &&
        isNonEmptyString(value.requestId) &&
        BROWSER_OPS.includes(value.op as BrowserOp)
        ? (value as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  'memory-invoke': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return hasExactKeys(value, ['type', 'identity', 'seq', 'requestId', 'op', 'params']) &&
        isNonEmptyString(value.requestId) &&
        MEMORY_OPS.includes(value.op as MemoryOp)
        ? (value as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  'delegation-invoke': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return hasExactKeys(value, ['type', 'identity', 'seq', 'requestId', 'op', 'params']) &&
        parseSessionIdentity(value.identity) &&
        isNonEmptyString(value.requestId) &&
        (value.op === 'delegate' ||
          value.op === 'check_delegation' ||
          value.op === 'retry_delegation' ||
          value.op === 'group_tasks' ||
          value.op === 'group_history' ||
          value.op === 'routine_propose' ||
          value.op === 'send_image' ||
          value.op === 'report_blocked')
        ? (value as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  'secretary-invoke': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return hasExactKeys(value, ['type', 'identity', 'seq', 'requestId', 'op', 'params']) &&
        parseSessionIdentity(value.identity) &&
        isNonEmptyString(value.requestId) &&
        ((SECRETARY_OPS as readonly string[]).includes(value.op as string) ||
          (SECRETARY_INTERNAL_OPS as readonly string[]).includes(value.op as string))
        ? (value as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  'computer-invoke': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return hasExactKeys(value, ['type', 'identity', 'seq', 'requestId', 'op', 'params']) &&
        isNonEmptyString(value.requestId) &&
        COMPUTER_OPS.includes(value.op as ComputerOp)
        ? (value as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  'computer-cancel': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return hasExactKeys(value, ['type', 'identity', 'seq', 'requestId']) &&
        isNonEmptyString(value.requestId)
        ? (value as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  'plugin-tool-invoke': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return hasPluginAgentKeys(value, [
        'type',
        'identity',
        'seq',
        'requestId',
        'toolName',
        'args',
      ]) &&
        isNonEmptyString(value.requestId) &&
        typeof value.toolName === 'string' &&
        parsePluginToolName(value.toolName) !== null
        ? (value as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  'plugin-tool-cancel': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return hasExactKeys(value, ['type', 'identity', 'seq', 'requestId']) &&
        isNonEmptyString(value.requestId)
        ? (value as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  'plugin-event': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return hasPluginAgentKeys(value, ['type', 'identity', 'seq', 'event', 'data']) &&
        parseSessionIdentity(value.identity) &&
        typeof value.event === 'string' &&
        (PLUGIN_EVENTS as readonly string[]).includes(value.event) &&
        // 主会话的 before_compact 要等插件，走 plugin-intercept；只有子会话的只通知
        (value.event === 'before_compact'
          ? value.agent !== undefined && isPluginInterceptPayload(value.event, value.data)
          : isPluginObserveData(value.event, value.data))
        ? (value as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  'plugin-intercept': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return hasPluginAgentKeys(value, [
        'type',
        'identity',
        'seq',
        'requestId',
        'event',
        'payload',
      ]) &&
        parseSessionIdentity(value.identity) &&
        isNonEmptyString(value.requestId) &&
        (value.event === 'before_compact' ||
          (typeof value.event === 'string' && isInterceptEvent(value.event))) &&
        typeof value.event === 'string' &&
        (value.agent === undefined || isChildInterceptEvent(value.event)) &&
        isPluginInterceptPayload(value.event, value.payload)
        ? (value as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  'workspace-branch-context-consumed': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return hasExactKeys(value, ['type', 'identity', 'seq', 'requestId']) &&
        isNonEmptyString(value.requestId)
        ? (value as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  'delivery-settled': parseDeliveryOutcome,
  'delivery-rejected': (value) => {
    const { reason, ...rest } = value;
    return (reason === undefined || reason === 'turn-stuck') && parseDeliveryOutcome(rest)
      ? (value as unknown as AgentWorkerEvent)
      : null;
  },
  'delivery-deferred': parseDeliveryOutcome,
  status: requireEventIdentity('any', (value: Record<string, unknown>): AgentWorkerEvent | null => {
    return (value.status === 'idle' || value.status === 'running' || value.status === 'failed') &&
      (value.turnId === undefined || isNonEmptyString(value.turnId))
      ? (value as unknown as AgentWorkerEvent)
      : null;
  }),
  'message-upsert': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return isSequence(value.index) &&
        isRecord(value.message) &&
        hasValidProjectedMetadata(value.message)
        ? (value as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  'turn-completed': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return isNonEmptyString(value.turnId) &&
        (value.digest === undefined || parseTurnDigest(value.digest)) &&
        (value.report === undefined || parseTurnReport(value.report)) &&
        (value.aborted === undefined || value.aborted === true) &&
        (value.silent === undefined || value.silent === true) &&
        (value.requestBudgetStop === undefined || value.requestBudgetStop === true) &&
        (value.requestBudgetError === undefined ||
          (value.requestBudgetStop === true && isNonEmptyString(value.requestBudgetError))) &&
        (value.continues === undefined || isNonEmptyString(value.continues)) &&
        (value.awaitingTasks === undefined || value.awaitingTasks === true) &&
        (value.awaitingReminder === undefined || value.awaitingReminder === true) &&
        (value.awaitingBackground === undefined || value.awaitingBackground === true) &&
        (value.provider === undefined || isNonEmptyString(value.provider))
        ? (value as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  'turn-failed': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return isNonEmptyString(value.turnId) &&
        isNonEmptyString(value.error) &&
        (value.retryExhausted === undefined || value.retryExhausted === true) &&
        (value.aborted === undefined || value.aborted === true) &&
        (value.continues === undefined || isNonEmptyString(value.continues)) &&
        (value.provider === undefined || isNonEmptyString(value.provider))
        ? (value as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  'turn-retry': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return Number.isInteger(value.attempt) &&
        (value.attempt as number) >= 1 &&
        Number.isInteger(value.maxAttempts) &&
        (value.maxAttempts as number) >= 0 &&
        isSequence(value.delayMs) &&
        isNonEmptyString(value.error)
        ? (value as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  'retry-skipped': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return hasExactKeys(value, ['type', 'identity', 'seq', 'reason']) &&
        RETRY_SKIPPED_REASONS.includes(value.reason as RetrySkippedReason)
        ? (value as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  'messages-truncated': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return isSequence(value.length) ? (value as unknown as AgentWorkerEvent) : null;
    }
  ),
  'rewind-done': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      const editorImages =
        value.editorImages === undefined ? undefined : parseAttachedImages(value.editorImages);
      return (value.editorText === undefined || typeof value.editorText === 'string') &&
        editorImages !== null &&
        (value.filesRestored === undefined || typeof value.filesRestored === 'boolean')
        ? (value as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  'fork-done': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return isUuid(value.targetConversationId) &&
        (value.sessionFile === undefined || typeof value.sessionFile === 'string') &&
        (value.entryId === undefined || isNonEmptyString(value.entryId)) &&
        (value.error === undefined || typeof value.error === 'string')
        ? (value as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  compaction: requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return (value.state === 'queued' || value.state === 'start' || value.state === 'end') &&
        (value.error === undefined || typeof value.error === 'string') &&
        (value.abandoned === undefined || value.abandoned === true)
        ? (value as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  commands: requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return Array.isArray(value.commands) ? (value as unknown as AgentWorkerEvent) : null;
    }
  ),
  'session-meta': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      const occupancy =
        value.occupancy === undefined ? undefined : parseContextOccupancy(value.occupancy);
      if (value.occupancy !== undefined && !occupancy) return null;
      const { usageTotals: rawTotals, ...rest } = value;
      const usageTotals = parseSessionUsageTotals(rawTotals);
      return (value.sessionFile === undefined || typeof value.sessionFile === 'string') &&
        (value.contextWindow === undefined ||
          (typeof value.contextWindow === 'number' && value.contextWindow > 0))
        ? ({
            ...rest,
            ...(occupancy ? { occupancy } : {}),
            ...(usageTotals ? { usageTotals } : {}),
          } as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  'approval-request': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return isRecord(value.request) &&
        isNonEmptyString(value.request.requestId) &&
        isNonEmptyString(value.request.tool) &&
        (value.request.kind === 'command' ||
          value.request.kind === 'file-edit' ||
          value.request.kind === 'file-write' ||
          value.request.kind === 'mcp') &&
        typeof value.request.summary === 'string' &&
        (value.request.filePaths === undefined ||
          (Array.isArray(value.request.filePaths) &&
            value.request.filePaths.every(isNonEmptyString))) &&
        (value.request.protected === undefined ||
          (PROTECTED_ACTION_CATEGORIES as readonly unknown[]).includes(value.request.protected)) &&
        isOptionalTimestamp(value.request.expiresAt) &&
        (value.request.reviewFallback === undefined ||
          APPROVAL_REVIEW_FALLBACKS.includes(value.request.reviewFallback as never)) &&
        (value.request.guard === undefined || isDcgGuardHit(value.request.guard))
        ? (value as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  'approval-resolved': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return isNonEmptyString(value.requestId) ? (value as unknown as AgentWorkerEvent) : null;
    }
  ),
  'ask-resolved': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return isNonEmptyString(value.requestId) &&
        (value.by === undefined || (ASK_ANSWER_BY as readonly unknown[]).includes(value.by)) &&
        (value.answer === undefined || typeof value.answer === 'string') &&
        (value.name === undefined || isNonEmptyString(value.name))
        ? (withAskLink(value) as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  'ask-request': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return isRecord(value.ask) &&
        isNonEmptyString(value.ask.requestId) &&
        isNonEmptyString(value.ask.question) &&
        isOptionalTimestamp(value.ask.expiresAt) &&
        (value.ask.recommended === undefined ||
          (Array.isArray(value.ask.options) &&
            value.ask.options.includes(value.ask.recommended))) &&
        (value.ask.relay === undefined ||
          (isRecord(value.ask.relay) && isNonEmptyString(value.ask.relay.name)))
        ? (value as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  'subagent-update': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return isRecord(value.agent) ? (value as unknown as AgentWorkerEvent) : null;
    }
  ),
  'coworker-update': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return isRecord(value.coworker) && isNonEmptyString(value.coworker.id)
        ? (value as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  'goal-signal': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      if (
        (value.kind !== 'complete' && value.kind !== 'blocked' && value.kind !== 'wait') ||
        typeof value.note !== 'string'
      ) {
        return null;
      }
      if (!('result' in value)) return value as unknown as AgentWorkerEvent;
      const parsed = parseGoalResult(value.result);
      if (!parsed.ok) {
        const rest = { ...value };
        delete rest.result;
        return rest as unknown as AgentWorkerEvent;
      }
      return { ...value, result: parsed.value } as unknown as AgentWorkerEvent;
    }
  ),
  'plan-state': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      const state = parsePlanState(value.state);
      return hasExactKeys(value, ['type', 'identity', 'seq', 'state']) && state
        ? ({ ...value, state } as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  'workflow-status': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      const run = parseWorkflowRunSnapshot(value.run);
      return hasExactKeys(value, ['type', 'identity', 'seq', 'run']) && run
        ? ({ ...value, run } as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  'tool-output': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return isNonEmptyString(value.toolCallId) &&
        typeof value.output === 'string' &&
        (value.startedAt === undefined || typeof value.startedAt === 'number') &&
        (value.deadlineAt === undefined || Number.isFinite(value.deadlineAt)) &&
        (value.ended === undefined || value.ended === 'ok' || value.ended === 'error') &&
        (value.todos === undefined || (value.ended !== undefined && isTodoList(value.todos)))
        ? (value as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  'task-started': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return isRecord(value.task) ? (value as unknown as AgentWorkerEvent) : null;
    }
  ),
  'task-output': parseTaskEvent,
  'task-ended': parseTaskEvent,
  'background-tasks-level': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return Array.isArray(value.tasks) &&
        value.tasks.every((task) => isRecord(task) && isNonEmptyString(task.taskId))
        ? (value as unknown as AgentWorkerEvent)
        : null;
    }
  ),
  'session-custom-entry': requireEventIdentity(
    'any',
    (value: Record<string, unknown>): AgentWorkerEvent | null => {
      return parseAgentSessionCustomEntry(value.entry)
        ? (value as unknown as AgentWorkerEvent)
        : null;
    }
  ),
} satisfies Record<AgentWorkerEvent['type'], ClosedParser<AgentWorkerEvent>>;

/** 收窄 worker → Main/Renderer 统一事件；缺 generation 的旧事件拒绝。 */
export function parseAgentWorkerEvent(value: unknown): AgentWorkerEvent | null {
  if (!isRecord(value) || !isNonEmptyString(value.type)) return null;
  return parseClosed(agentWorkerEventParsers, value.type, value);
}
