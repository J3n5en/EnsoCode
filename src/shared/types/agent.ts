import {
  type AgentTypeKey,
  type ChildSessionIdentity,
  ENSO_LOCKED_PROFILE_ID,
  ENSO_LOCKED_TOOL_IDS,
  isSameChildSessionIdentity,
  isUuid,
  parseAgentTypeKey,
  parseChildSessionIdentity,
  parseSessionIdentity,
  type SessionIdentity,
} from '../builtinAgents';
import {
  type CapabilityExecutionEnvelope,
  type CapabilityReceipt,
  type CapabilityResult,
  parseCapabilityExecutionEnvelope,
  parseCapabilityReceipt,
  parseCapabilityResult,
} from '../capabilities/types';
import { type CompactStrategy, parseCompactStrategy } from '../compactStrategy';
import type { DefaultModelRef } from '../defaultModel';
import { parseMaxActiveCoworkers } from '../maxActiveCoworkers';
import { PRODUCT_SURFACE_INVENTORY, type ProductSurfaceId } from '../productSurfaces';
import { parseSmartCompactMode } from '../smartCompactMode';
import { WINDOWS_LOCAL_SHELLS, type WindowsLocalShell } from '../windowsLocalShell';
import {
  MODEL_API_KINDS,
  type ModelApiKind,
  type ModelCapabilityOverrides,
  type ModelReasoningOverride,
  type ModelThinkingLevelOverride,
} from './llm';
import { type AgentDispatchTask, parseAgentDispatchTask } from './mentions';

export type { ChildSessionIdentity, SessionIdentity } from '../builtinAgents';
export { parseChildSessionIdentity, parseSessionIdentity } from '../builtinAgents';

/** 会话状态。waiting/done 属权限门与 subagent 刀，M1 不引入 */
export type NodeStatus = 'idle' | 'running' | 'failed';

/** 一轮结束时 worker 切出的压缩摘要；三段均已在 worker 侧按上限截断 */
export interface TurnDigest {
  /** 会话首条 user 文本（清洗后截头）：滚动总结的主旨锚点，防止单轮动作劫持标题；无 user 时为空串 */
  firstUserText: string;
  /** 本轮全部 user 文本（清洗后 '\n' 拼接，截头） */
  userText: string;
  /** 本轮最后一条含 text 的 assistant 文本（截尾） */
  assistantText: string;
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
}

/** 思考努力档位（reasoning 开启时有效），值域对齐 pi 的 ThinkingLevel。off 由 reasoningEnabled 表达 */
export const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** 审批档位：supervised 全审 / auto-edits 免文件 / assistant 助手代审 / full 全放行 */
export const APPROVAL_MODES = ['supervised', 'auto-edits', 'full', 'assistant'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** 审批请求的操作类别 */
export type ApprovalKind = 'command' | 'file-edit' | 'file-write' | 'mcp';

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
export const MEMORY_OPS = ['search', 'capture', 'crystallize'] as const;
export type MemoryOp = (typeof MEMORY_OPS)[number];

/** 待审批请求（worker → 渲染层） */
export interface ApprovalRequestInfo {
  requestId: string;
  tool: string;
  kind: ApprovalKind;
  /** 命令全文 / 文件路径 / 参数预览 */
  summary: string;
  /** 对应 toolCall.id，代审中徽章挂到时间线该行 */
  toolCallId?: string;
  /** reviewing = 代审模型评审中（不弹真人按钮）；缺省 = 等人决策 */
  phase?: 'reviewing';
}

/** agent 向用户的提问（ask_user 工具,阻塞等答复） */
export interface AskRequestInfo {
  requestId: string;
  question: string;
  /** 可选快捷选项（用户也可自由输入） */
  options?: string[];
}

/** 审批决策 */
export type ApprovalDecision = 'allow' | 'allowSession' | 'deny';

/** 后台任务状态（渲染层胶囊/面板与 snapshot 共用） */
export interface BackgroundTaskInfo {
  taskId: string;
  command: string;
  status: 'running' | 'done' | 'failed';
  /** 输出尾部快照（覆盖式,≤8KB） */
  tail: string;
  startedAt: number;
  exitCode?: number;
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
 * name 是给 LLM 看的唯一键（`{provider.name}/{modelId}`，冲突时追加 #n）；
 * description 是用户写的选型依据，注入工具参数说明。
 */
export interface SubagentModelOption {
  name: string;
  config: SpawnModelConfig;
  description?: string;
}

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

/** MCP OAuth 凭据（Main 加密持有，spawn 时下发；worker 只读用并可 refresh） */
export interface McpOAuthTokens {
  access_token: string;
  token_type?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

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
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  /** 已授权的 OAuth 凭据（http/sse 远程 server） */
  oauth?: McpOAuthTokens;
  /** 连接 + listTools；缺省 10s */
  connectTimeoutMs?: number;
  /** 单次 callTool；缺省 120s */
  callTimeoutMs?: number;
}

export interface ModelRef {
  providerId: string;
  modelId: string;
}

export type ProjectKind = 'local' | 'ssh';

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
  // Retained for persisted context-occupancy snapshots; project memory has been removed.
  'projectMemory',
  'reminders',
] as const;

export type ContextOccupancyBucketId = (typeof CONTEXT_OCCUPANCY_BUCKETS)[number];

export type ContextOccupancyBuckets = Record<ContextOccupancyBucketId, number>;

export interface ContextOccupancy {
  buckets: ContextOccupancyBuckets;
  used: number;
  estimated: boolean;
  compactedMessageCount: number;
  compactionModelMismatch: boolean;
  contextWindow?: number;
  percent?: number;
  compactionEntryId?: string;
}

export interface ConversationForkOrigin {
  conversationId: string;
  entryId: string;
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
  tools: 'all' | 'readonly' | 'enso-locked';
  skillPaths: readonly string[];
  skillBindingIds: readonly string[];
  mcpServers: readonly McpServerSpawnConfig[];
  mcpBindingIds: readonly string[];
  systemPromptHash: string;
  lockedProfileId?: typeof ENSO_LOCKED_PROFILE_ID;
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
  lockedProfileId?: typeof ENSO_LOCKED_PROFILE_ID;
}

export interface SafeChildRef {
  sessionId: string;
  generation: string;
  instanceId: string;
  instanceName: string;
  typeKey: AgentTypeKey;
}

export type AgentSessionCustomEntry =
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
  | { kind: 'capability-receipt'; receipt: CapabilityReceipt };

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
  | { ok: true; messages: ProjectedMessage[]; baseIndex: number }
  | { ok: false; code: 'not-found' | 'unavailable'; error: string };

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
  | { type: 'lock-workspace'; requestId: string; conversationIds: string[] }
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
      /** 探后折叠工具 + context 折叠 */
      exploreFoldEnabled?: boolean;
      /** 拦截 cat/grep/sed -i 等，强制走 read/grep/edit/write/find；缺省关 */
      bashInterceptEnabled?: boolean;
      /** Hashline 行锚点 read/edit；缺省关 */
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
      instruction?: { path: string; content: string };
      approvalMode?: ApprovalMode;
      /** 助手代审模型；仅 approvalMode=assistant 时有意义 */
      approvalReviewer?: SpawnModelConfig;
      agentTypes?: AgentTypeSpawnConfig[];
      subagentModels?: SubagentModelOption[];
      disabledTools?: string[];
      /** Windows 本地命令壳偏好；缺省 auto。远程会话忽略。 */
      windowsLocalShell?: WindowsLocalShell;
      /** ssh 项目：工具执行切到远端。Main 从项目权威派生，不信任 renderer。 */
      remote?: AgentRemoteConfig;
    }
  | {
      type: 'spawn-child';
      identity: ChildSessionIdentity;
      cwd: string;
      config: ResolvedAgentTypeSpawnConfig;
      resumeFile?: string;
    }
  | {
      type: 'prompt-child';
      identity: ChildSessionIdentity;
      requestId: string;
      task: AgentDispatchTask;
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
  | { type: 'prompt'; identity: SessionIdentity; text: string; images?: AttachedImage[] }
  | { type: 'steer'; identity: SessionIdentity; text: string; images?: AttachedImage[] }
  | { type: 'set-model'; identity: SessionIdentity; model: SpawnModelConfig }
  | { type: 'set-thinking'; identity: SessionIdentity; level: ThinkingLevel }
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
  | { type: 'set-approval-mode'; identity: SessionIdentity; mode: ApprovalMode }
  | { type: 'set-approval-reviewer'; model?: SpawnModelConfig }
  | { type: 'set-max-active-coworkers'; limit: number }
  | { type: 'compact'; identity: SessionIdentity; instructions?: string }
  | { type: 'ask-respond'; identity: SessionIdentity; requestId: string; answer: string }
  | {
      type: 'capability-result';
      child: ChildSessionIdentity;
      turnId: string;
      requestId: string;
      envelope: CapabilityExecutionEnvelope;
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
      type: 'memory-result';
      identity: SessionIdentity | ChildSessionIdentity;
      requestId: string;
      ok: boolean;
      result?: unknown;
      error?: string;
    }
  | { type: 'task-stop'; identity: SessionIdentity; taskId: string }
  | { type: 'subagent-stop'; identity: SessionIdentity; agentId: string }
  | {
      type: 'rewind';
      identity: SessionIdentity;
      userIndexFromEnd: number;
      restoreFiles?: boolean;
    }
  | {
      type: 'fork';
      identity: SessionIdentity;
      targetConversationId: string;
      entryId?: string;
      userIndexFromEnd?: number;
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
      /** 通用一次性文本补全（记忆蒸馏用）：同 summarize-title 的候选链语义，结果经 text-completed / text-failed 按 requestId 回流 */
      type: 'complete-text';
      requestId: string;
      systemPrompt: string;
      userText: string;
      candidates: SpawnModelConfig[];
      timeoutMs: number;
      maxTokens?: number;
    }
  | { type: 'abort-retry'; identity: SessionIdentity }
  | { type: 'retry'; identity: SessionIdentity }
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
  /** 运行中同步代理 env；null 表示删除该键 */
  | { type: 'set-proxy-env'; env: Record<string, string | null> };

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
  /** step 开始：message_start 到达时刻 */
  stepStartMs: number;
  /** 首 token：首个 message_update 时刻 */
  firstTokenMs?: number;
  /** 思考结束：首个非 thinking 的可见输出（正文/工具调用）出现时刻 */
  thinkingEndMs?: number;
  /** step 完成：message_end 时刻 */
  completedMs?: number;
}

/** todo 工具的清单项（toolResult.details 透出，整表替换语义） */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** 渲染层可见的消息投影：pi AgentMessage 的白名单克隆 */
export interface ProjectedMessage {
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
  /** pi-ai 在流上打的首 token 延迟（ms）；优先于本地 timing */
  ttft?: number;
  /** pi-ai 整次请求墙钟（ms，含 TTFT/思考） */
  duration?: number;
  /** 该 step 的计时打点（仅 assistant 消息带） */
  timing?: MessageTiming;
  /** todo 工具 toolResult 的清单快照 */
  todos?: TodoItem[];
  /** 工具执行耗时（仅 toolResult 消息带；worker 按 tool_execution_start/end 打点，不含排队） */
  toolDurationMs?: number;
  /** subagent 工具 toolResult 的执行元数据 */
  subagentMeta?: { modelId?: string; outputTokens?: number; steps?: number };
  /** Hashline edit 成功结果：补丁前后全文（不含 patch） */
  editDiff?: { oldText: string; newText: string };
  /** compactionSummary 消息：压缩前的上下文 token 数 */
  tokensBefore?: number;
  /** 摘要来自 Enso compact hook，不是原生 summarizer */
  verified?: boolean;
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
  pendingApprovals?: ApprovalRequestInfo[];
  pendingAsks?: AskRequestInfo[];
  backgroundTasks?: BackgroundTaskInfo[];
  subagents?: SubagentInfo[];
  child?: ChildConversationMetadata;
  customEntries?: AgentSessionCustomEntry[];
  safeJournal?: SafeJournalProjection;
  /** 压缩进度：重连/刷新后重建投影用（compaction 是瞬时事件，不重放） */
  compaction?: 'queued' | 'running';
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
}

export interface AgentActionResult {
  ok: boolean;
  error?: string;
}

export type ParentLifecycleEvent =
  | {
      type: 'parent-ready';
      identity: SessionIdentity;
      seq: number;
      sessionFile: string;
      model: ModelRef;
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
    }
  | {
      type: 'parent-rejected';
      identity: SessionIdentity;
      seq: number;
      reason: string;
    }
  | { type: 'parent-ended'; identity: SessionIdentity; seq: number; reason: string };

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
      ChildLifecycleEvent | McpWorkerEvent | WorkspaceLockEvent | { type: 'session-reloaded' }
    >
  | RendererChildLifecycleEvent
  | { type: 'worker-exited' };

export function workspaceBranchChangedNote(branch: string): string {
  return `<workspace-branch-changed>\nThe current workspace is now on Git branch ${JSON.stringify(branch)}. The directory is unchanged, but file contents may differ. Re-read relevant files before relying on earlier observations or edits. This is background information only, not a task or goal.\n</workspace-branch-changed>`;
}

export type WorkspaceLockEvent =
  | { type: 'workspace-lock-result'; requestId: string; ok: boolean; error?: string }
  | { type: 'workspace-unlock-result'; requestId: string; ok: boolean; error?: string };

export type AgentWorkerEvent =
  | WorkspaceLockEvent
  | ParentLifecycleEvent
  | ChildLifecycleEvent
  | {
      type: 'workspace-branch-context-consumed';
      identity: SessionIdentity;
      seq: number;
      requestId: string;
    }
  | { type: 'status'; identity: SessionIdentity; seq: number; status: NodeStatus; error?: string }
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
    }
  | {
      type: 'turn-failed';
      identity: SessionIdentity;
      seq: number;
      turnId: string;
      error: string;
      /** 消息从未提交给 pi（僵尸轮超时等）：renderer 应收回乐观回显并把文本退回输入框 */
      undelivered?: true;
    }
  | {
      /** 瞬态错误后 pi 将自动重试：非终态，不 settle 轮次；下一个 status/turn-* 事件清除 */
      type: 'turn-retry';
      identity: SessionIdentity;
      seq: number;
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      error: string;
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
  | {
      type: 'session-meta';
      identity: SessionIdentity;
      seq: number;
      sessionFile?: string;
      contextWindow?: number;
      occupancy?: ContextOccupancy;
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
  | { type: 'ask-resolved'; identity: SessionIdentity; seq: number; requestId: string }
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
      type: 'capability-invoke';
      child: ChildSessionIdentity;
      seq: number;
      turnId: string;
      requestId: string;
      capabilityId: ProductSurfaceId;
      params: unknown;
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
      type: 'goal-signal';
      identity: SessionIdentity;
      seq: number;
      kind: 'complete' | 'blocked' | 'wait';
      note: string;
    }
  | { type: 'task-started'; identity: SessionIdentity; seq: number; task: BackgroundTaskInfo }
  | {
      /** 标题总结完成：无 identity/seq（不属于任何 worker 会话），渲染层按 conversationId 写回 */
      type: 'title-generated';
      conversationId: string;
      title: string;
    }
  | {
      /** 标题总结全部候选均失败：同为旁路事件；error 为人可读的最后一次失败原因（含模型标识） */
      type: 'title-failed';
      conversationId: string;
      error: string;
    }
  | { type: 'text-completed'; requestId: string; text: string }
  | { type: 'text-failed'; requestId: string; error: string }
  | {
      type: 'task-output';
      identity: SessionIdentity;
      seq: number;
      taskId: string;
      tail: string;
      status: BackgroundTaskInfo['status'];
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
      type: 'session-custom-entry';
      identity: SessionIdentity;
      seq: number;
      entry: AgentSessionCustomEntry;
    }
  | McpWorkerEvent
  /** sessionId：targeted 快照回带请求目标；sessions 为空时 renderer 据此收回 started */
  | { type: 'snapshot'; sessions: SessionSnapshot[]; partial?: boolean; sessionId?: string }
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
    }
  /** SDK 自动 refresh 后回传 Main 持久化 */
  | { type: 'mcp-tokens-refreshed'; serverId: string; tokens: McpOAuthTokens };

export type McpStatusEvent = Extract<McpWorkerEvent, { type: 'mcp-status' }>;

/** Main → 渲染层的 MCP 状态推送：cleared 用于 worker 退出后清残留 */
export type McpStatusPush = McpStatusEvent | { type: 'mcp-status-cleared' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && hasOnlyKeys(value, keys);

const isSequence = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0;

/**
 * worker 回传的 token：白名单外的字段（SDK 会保留 id_token）**裁掉而不是整条判负——
 * 否则服务端轮换 refresh_token 时刷新结果会被静默丢弃，本地凭据直接作废。
 * expires_in 是相对秒数，当前只原样存盘不参与判断（SDK 自己按 401 重试 refresh）。
 */
export function parseMcpOAuthTokens(value: unknown): McpOAuthTokens | null {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.access_token) ||
    (value.token_type !== undefined && typeof value.token_type !== 'string') ||
    (value.refresh_token !== undefined && typeof value.refresh_token !== 'string') ||
    (value.expires_in !== undefined && typeof value.expires_in !== 'number') ||
    (value.scope !== undefined && typeof value.scope !== 'string')
  ) {
    return null;
  }
  return {
    access_token: value.access_token,
    ...(value.token_type !== undefined ? { token_type: value.token_type } : {}),
    ...(value.refresh_token !== undefined ? { refresh_token: value.refresh_token } : {}),
    ...(value.expires_in !== undefined ? { expires_in: value.expires_in } : {}),
    ...(value.scope !== undefined ? { scope: value.scope } : {}),
  };
}

/** turn-completed.digest 的形状校验：三段必须是字符串（允许空），不允许多余键 */
export function parseTurnDigest(value: unknown): TurnDigest | null {
  if (!isRecord(value) || !hasExactKeys(value, ['firstUserText', 'userText', 'assistantText'])) {
    return null;
  }
  if (
    typeof value.firstUserText !== 'string' ||
    typeof value.userText !== 'string' ||
    typeof value.assistantText !== 'string'
  ) {
    return null;
  }
  return value as unknown as TurnDigest;
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
  if (
    !isSequence(value.used) ||
    !isSequence(value.compactedMessageCount) ||
    typeof value.compactionModelMismatch !== 'boolean' ||
    (value.contextWindow !== undefined &&
      !(typeof value.contextWindow === 'number' && value.contextWindow > 0)) ||
    (value.percent !== undefined && !isSequence(value.percent)) ||
    (value.compactionEntryId !== undefined && !isNonEmptyString(value.compactionEntryId))
  ) {
    return null;
  }
  return value as unknown as ContextOccupancy;
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

function parseSpawnModelConfig(value: unknown): SpawnModelConfig | null {
  if (!isRecord(value)) return null;
  if (
    !hasOnlyKeys(value, [
      'api',
      'baseUrl',
      'apiKey',
      'modelId',
      'settingsProviderId',
      'oauthAccountKey',
      'reasoning',
      'thinkingLevel',
      'contextWindow',
      'maxTokens',
    ]) ||
    !MODEL_API_KINDS.includes(value.api as ModelApiKind) ||
    typeof value.baseUrl !== 'string' ||
    typeof value.apiKey !== 'string' ||
    !isNonEmptyString(value.modelId) ||
    !isNonEmptyString(value.settingsProviderId) ||
    (value.oauthAccountKey !== undefined && !isNonEmptyString(value.oauthAccountKey))
  ) {
    return null;
  }
  return value as unknown as SpawnModelConfig;
}

function parseSubagentModelOption(value: unknown): SubagentModelOption | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['name', 'config', 'description']) ||
    !isNonEmptyString(value.name) ||
    !parseSpawnModelConfig(value.config) ||
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
    !hasOnlyKeys(value, ['host', 'auth', 'port', 'password']) ||
    !isNonEmptyString(value.host) ||
    (value.auth !== 'key' && value.auth !== 'password')
  ) {
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
  return value as unknown as ConversationAuthority;
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
    !hasExactKeys(value, ['requestId', 'conversationId', 'version']) ||
    !isNonEmptyString(value.requestId) ||
    !isUuid(value.conversationId) ||
    !isSequence(value.version)
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
    (typeKey === 'agent:enso' && value.lockedProfileId !== ENSO_LOCKED_PROFILE_ID) ||
    (typeKey !== 'agent:enso' && value.lockedProfileId !== undefined)
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

export function parseAgentSessionCustomEntry(value: unknown): AgentSessionCustomEntry | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'capability-receipt') {
    if (!hasExactKeys(value, ['kind', 'receipt'])) return null;
    const receipt = parseCapabilityReceipt(value.receipt);
    return receipt ? { kind: 'capability-receipt', receipt } : null;
  }
  const child = parseSafeChildRef(value.child);
  if (!child || typeof value.at !== 'number' || !Number.isFinite(value.at)) return null;
  if (value.kind === 'agent-dispatch' && hasExactKeys(value, ['kind', 'child', 'at'])) {
    return value as unknown as AgentSessionCustomEntry;
  }
  if (
    value.kind === 'agent-completed' &&
    hasOnlyKeys(value, ['kind', 'child', 'receiptSummary', 'at']) &&
    (value.receiptSummary === undefined || typeof value.receiptSummary === 'string')
  ) {
    return value as unknown as AgentSessionCustomEntry;
  }
  if (
    value.kind === 'agent-failed' &&
    hasExactKeys(value, ['kind', 'child', 'errorCode', 'message', 'at']) &&
    isNonEmptyString(value.errorCode) &&
    isNonEmptyString(value.message)
  ) {
    return value as unknown as AgentSessionCustomEntry;
  }
  return null;
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
  if (
    value.typeKey === 'agent:enso' &&
    (value.toolIds.length !== ENSO_LOCKED_TOOL_IDS.length ||
      value.toolIds.some((toolId, index) => toolId !== ENSO_LOCKED_TOOL_IDS[index]) ||
      value.loadedSkillBindingIds.length !== 0 ||
      value.loadedMcpBindingIds.length !== 0)
  ) {
    return null;
  }
  return value as unknown as ResolvedChildProfileProof;
}

export function parseSafeJournalRecord(value: unknown): SafeJournalRecord | null {
  if (!isRecord(value) || typeof value.at !== 'number' || !Number.isFinite(value.at)) {
    return null;
  }
  switch (value.type) {
    case 'safe-user-text':
    case 'safe-assistant-text':
      return hasExactKeys(value, ['type', 'text', 'at']) && typeof value.text === 'string'
        ? (value as unknown as SafeJournalRecord)
        : null;
    case 'enso-operation':
      return hasExactKeys(value, ['type', 'operationId', 'capabilityId', 'toolCallId', 'at']) &&
        isNonEmptyString(value.operationId) &&
        isProductSurfaceId(value.capabilityId) &&
        isNonEmptyString(value.toolCallId)
        ? (value as unknown as SafeJournalRecord)
        : null;
    case 'safe-model-result':
      return hasExactKeys(value, ['type', 'toolCallId', 'modelResult', 'at']) &&
        isNonEmptyString(value.toolCallId) &&
        parseCapabilityResult(value.modelResult)
        ? (value as unknown as SafeJournalRecord)
        : null;
    case 'capability-receipt':
      return hasExactKeys(value, ['type', 'receipt', 'at']) && parseCapabilityReceipt(value.receipt)
        ? (value as unknown as SafeJournalRecord)
        : null;
    default:
      return null;
  }
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
      'skillPaths',
      'skillBindingIds',
      'mcpServers',
      'mcpBindingIds',
      'systemPromptHash',
      'lockedProfileId',
    ]) ||
    Object.keys(value).length < 12
  ) {
    return null;
  }
  const typeKey = parseAgentTypeKey(value.typeKey);
  const model = parseSpawnModelConfig(value.model);
  const skillPaths = Array.isArray(value.skillPaths) ? value.skillPaths : null;
  const mcpServers = Array.isArray(value.mcpServers) ? value.mcpServers : null;
  const skillBindingIds = Array.isArray(value.skillBindingIds) ? value.skillBindingIds : null;
  const mcpBindingIds = Array.isArray(value.mcpBindingIds) ? value.mcpBindingIds : null;
  if (
    !typeKey ||
    !model ||
    !isUuid(value.spawnSpecId) ||
    !isNonEmptyString(value.displayName) ||
    typeof value.description !== 'string' ||
    typeof value.systemPrompt !== 'string' ||
    (value.tools !== 'all' && value.tools !== 'readonly' && value.tools !== 'enso-locked') ||
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
  if (
    (typeKey === 'agent:enso' &&
      (value.lockedProfileId !== ENSO_LOCKED_PROFILE_ID ||
        value.tools !== 'enso-locked' ||
        skillPaths.length !== 0 ||
        skillBindingIds.length !== 0 ||
        mcpServers.length !== 0 ||
        mcpBindingIds.length !== 0)) ||
    (typeKey !== 'agent:enso' &&
      (value.lockedProfileId !== undefined || value.tools === 'enso-locked'))
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
    ]) ||
    !parseAnySessionIdentity(value.identity) ||
    (value.status !== 'idle' && value.status !== 'running' && value.status !== 'failed') ||
    !Array.isArray(value.messages) ||
    value.messages.some((message) => !isRecord(message)) ||
    !Array.isArray(value.commands) ||
    value.commands.some(
      (command) =>
        !isRecord(command) ||
        !isNonEmptyString(command.name) ||
        typeof command.description !== 'string'
    ) ||
    (value.child !== undefined && parseChildConversationMetadata(value.child) === null) ||
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

/** 收窄 Main → worker 命令。旧 global/builtin session shape 一律拒绝。 */
export function parseAgentCommand(value: unknown): AgentCommand | null {
  if (!isRecord(value) || !isNonEmptyString(value.type)) return null;
  switch (value.type) {
    case 'lock-workspace':
    case 'unlock-workspace':
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
    case 'spawn-parent': {
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
          'exploreFoldEnabled',
          'bashInterceptEnabled',
          'hashlineEditEnabled',
          'compactStrategy',
          'smartCompactEnabled',
          'smartCompactSummaryModel',
          'smartCompactMode',
          'memoryLanguage',
          'skillPaths',
          'mcpServers',
          'instruction',
          'approvalMode',
          'approvalReviewer',
          'agentTypes',
          'subagentModels',
          'disabledTools',
          'windowsLocalShell',
          'remote',
        ]) ||
        !parseSessionIdentity(value.identity) ||
        typeof value.cwd !== 'string' ||
        !parseSpawnModelConfig(value.model) ||
        (value.resumeFile !== undefined && !isNonEmptyString(value.resumeFile)) ||
        (value.loadHarnessAssets !== undefined && typeof value.loadHarnessAssets !== 'boolean') ||
        (value.windowsLocalShell !== undefined &&
          !(WINDOWS_LOCAL_SHELLS as readonly string[]).includes(
            value.windowsLocalShell as string
          )) ||
        (value.exploreFoldEnabled !== undefined && typeof value.exploreFoldEnabled !== 'boolean') ||
        (value.bashInterceptEnabled !== undefined &&
          typeof value.bashInterceptEnabled !== 'boolean') ||
        (value.hashlineEditEnabled !== undefined &&
          typeof value.hashlineEditEnabled !== 'boolean') ||
        (value.compactStrategy !== undefined &&
          parseCompactStrategy(value.compactStrategy) === null) ||
        (value.smartCompactEnabled !== undefined &&
          typeof value.smartCompactEnabled !== 'boolean') ||
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
          parseSpawnModelConfig(value.approvalReviewer) === null)
      ) {
        return null;
      }
      return value as unknown as AgentCommand;
    }
    case 'spawn-child':
      return hasOnlyKeys(value, ['type', 'identity', 'cwd', 'config', 'resumeFile']) &&
        parseChildSessionIdentity(value.identity) &&
        typeof value.cwd === 'string' &&
        parseResolvedAgentTypeSpawnConfig(value.config) &&
        (value.resumeFile === undefined || isNonEmptyString(value.resumeFile))
        ? (value as unknown as AgentCommand)
        : null;
    case 'prompt-child':
      return hasExactKeys(value, ['type', 'identity', 'requestId', 'task']) &&
        parseChildSessionIdentity(value.identity) &&
        isNonEmptyString(value.requestId) &&
        parseAgentDispatchTask(value.task)
        ? (value as unknown as AgentCommand)
        : null;
    case 'dismiss-child': {
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
    }
    case 'dismiss-coworker': {
      const parent = parseSessionIdentity(value.parent);
      return hasOnlyKeys(value, ['type', 'parent', 'coworkerId', 'notify']) &&
        parent &&
        isNonEmptyString(value.coworkerId) &&
        // 归属校验：coworker id 恒为 `父id::cw-…`，防跨会话误解雇
        value.coworkerId.startsWith(`${parent.sessionId}::cw-`) &&
        (value.notify === undefined || typeof value.notify === 'boolean')
        ? (value as unknown as AgentCommand)
        : null;
    }
    case 'resume-coworker': {
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
    }
    case 'complete-text':
      return (hasExactKeys(value, [
        'type',
        'requestId',
        'systemPrompt',
        'userText',
        'candidates',
        'timeoutMs',
      ]) ||
        hasExactKeys(value, [
          'type',
          'requestId',
          'systemPrompt',
          'userText',
          'candidates',
          'timeoutMs',
          'maxTokens',
        ])) &&
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
        Array.isArray(value.candidates) &&
        value.candidates.length >= 1 &&
        value.candidates.length <= TITLE_SUMMARY_MAX_CANDIDATES &&
        value.candidates.every((candidate) => parseSpawnModelConfig(candidate))
        ? (value as unknown as AgentCommand)
        : null;
    case 'summarize-title':
      return hasExactKeys(value, ['type', 'conversationId', 'input', 'candidates']) &&
        isNonEmptyString(value.conversationId) &&
        parseTitleSummaryInput(value.input) &&
        Array.isArray(value.candidates) &&
        value.candidates.length >= 1 &&
        value.candidates.length <= TITLE_SUMMARY_MAX_CANDIDATES &&
        value.candidates.every((candidate) => parseSpawnModelConfig(candidate))
        ? (value as unknown as AgentCommand)
        : null;
    case 'prompt':
    case 'steer': {
      const images = value.images === undefined ? [] : parseAttachedImages(value.images);
      return hasOnlyKeys(value, ['type', 'identity', 'text', 'images']) &&
        parseAnySessionIdentity(value.identity) &&
        typeof value.text === 'string' &&
        images !== null &&
        (value.text.length > 0 || images.length > 0)
        ? (value as unknown as AgentCommand)
        : null;
    }
    case 'set-model':
      return hasExactKeys(value, ['type', 'identity', 'model']) &&
        parseAnySessionIdentity(value.identity) &&
        parseSpawnModelConfig(value.model)
        ? (value as unknown as AgentCommand)
        : null;
    case 'set-thinking':
      return hasExactKeys(value, ['type', 'identity', 'level']) &&
        parseAnySessionIdentity(value.identity) &&
        THINKING_LEVELS.includes(value.level as ThinkingLevel)
        ? (value as unknown as AgentCommand)
        : null;
    case 'set-reasoning':
      return hasOnlyKeys(value, ['type', 'identity', 'enabled', 'level']) &&
        parseAnySessionIdentity(value.identity) &&
        typeof value.enabled === 'boolean' &&
        (value.level === undefined || THINKING_LEVELS.includes(value.level as ThinkingLevel))
        ? (value as unknown as AgentCommand)
        : null;
    case 'approval-respond':
      return hasExactKeys(value, ['type', 'identity', 'requestId', 'decision']) &&
        parseAnySessionIdentity(value.identity) &&
        isNonEmptyString(value.requestId) &&
        (value.decision === 'allow' ||
          value.decision === 'allowSession' ||
          value.decision === 'deny')
        ? (value as unknown as AgentCommand)
        : null;
    case 'set-approval-mode':
      return hasExactKeys(value, ['type', 'identity', 'mode']) &&
        parseAnySessionIdentity(value.identity) &&
        APPROVAL_MODES.includes(value.mode as ApprovalMode)
        ? (value as unknown as AgentCommand)
        : null;
    case 'set-approval-reviewer':
      return hasOnlyKeys(value, ['type', 'model']) &&
        (value.model === undefined || parseSpawnModelConfig(value.model))
        ? (value as unknown as AgentCommand)
        : null;
    case 'set-max-active-coworkers':
      return hasExactKeys(value, ['type', 'limit']) && parseMaxActiveCoworkers(value.limit) !== null
        ? (value as unknown as AgentCommand)
        : null;
    case 'ask-respond':
      return hasExactKeys(value, ['type', 'identity', 'requestId', 'answer']) &&
        parseAnySessionIdentity(value.identity) &&
        isNonEmptyString(value.requestId) &&
        isNonEmptyString(value.answer)
        ? (value as unknown as AgentCommand)
        : null;
    case 'capability-result':
      return hasExactKeys(value, ['type', 'child', 'turnId', 'requestId', 'envelope']) &&
        parseChildSessionIdentity(value.child) &&
        isNonEmptyString(value.turnId) &&
        isNonEmptyString(value.requestId) &&
        parseCapabilityExecutionEnvelope(value.envelope)
        ? (value as unknown as AgentCommand)
        : null;
    case 'browser-result':
    case 'memory-result': {
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
    }
    case 'task-stop':
      return hasExactKeys(value, ['type', 'identity', 'taskId']) &&
        parseAnySessionIdentity(value.identity) &&
        isNonEmptyString(value.taskId)
        ? (value as unknown as AgentCommand)
        : null;
    case 'subagent-stop':
      return hasExactKeys(value, ['type', 'identity', 'agentId']) &&
        parseAnySessionIdentity(value.identity) &&
        isNonEmptyString(value.agentId)
        ? (value as unknown as AgentCommand)
        : null;
    case 'compact':
      return hasOnlyKeys(value, ['type', 'identity', 'instructions']) &&
        parseAnySessionIdentity(value.identity) &&
        (value.instructions === undefined || isNonEmptyString(value.instructions))
        ? (value as unknown as AgentCommand)
        : null;
    case 'rewind':
      return hasOnlyKeys(value, ['type', 'identity', 'userIndexFromEnd', 'restoreFiles']) &&
        parseAnySessionIdentity(value.identity) &&
        isSequence(value.userIndexFromEnd) &&
        (value.restoreFiles === undefined || typeof value.restoreFiles === 'boolean')
        ? (value as unknown as AgentCommand)
        : null;
    case 'fork': {
      const hasEntry = typeof value.entryId === 'string';
      const hasIndex = typeof value.userIndexFromEnd === 'number';
      return hasOnlyKeys(value, [
        'type',
        'identity',
        'targetConversationId',
        'entryId',
        'userIndexFromEnd',
      ]) &&
        parseAnySessionIdentity(value.identity) &&
        isUuid(value.targetConversationId) &&
        (hasEntry
          ? !hasIndex && isNonEmptyString(value.entryId)
          : hasIndex && isSequence(value.userIndexFromEnd))
        ? (value as unknown as AgentCommand)
        : null;
    }
    case 'abort':
    case 'abort-retry':
    case 'retry':
    case 'release-parent':
      return hasExactKeys(value, ['type', 'identity']) && parseAnySessionIdentity(value.identity)
        ? (value as unknown as AgentCommand)
        : null;
    case 'append-session-custom-entry':
      return hasExactKeys(value, ['type', 'identity', 'entry']) &&
        parseAnySessionIdentity(value.identity) &&
        parseAgentSessionCustomEntry(value.entry)
        ? (value as unknown as AgentCommand)
        : null;
    case 'reload-session':
      return hasExactKeys(value, ['type', 'requestId', 'sessionId']) &&
        isNonEmptyString(value.requestId) &&
        isNonEmptyString(value.sessionId)
        ? (value as unknown as AgentCommand)
        : null;
    case 'snapshot':
      if (hasExactKeys(value, ['type'])) return { type: 'snapshot' };
      return hasExactKeys(value, ['type', 'sessionId']) && isNonEmptyString(value.sessionId)
        ? { type: 'snapshot', sessionId: value.sessionId }
        : null;
    case 'pin-sessions':
      return hasExactKeys(value, ['type', 'sessionIds']) &&
        Array.isArray(value.sessionIds) &&
        value.sessionIds.every((id) => typeof id === 'string')
        ? { type: 'pin-sessions', sessionIds: value.sessionIds }
        : null;
    case 'warm-mcp':
      return hasExactKeys(value, ['type', 'servers']) && Array.isArray(value.servers)
        ? (value as unknown as AgentCommand)
        : null;
    case 'set-proxy-env': {
      if (!hasExactKeys(value, ['type', 'env']) || !isRecord(value.env)) return null;
      for (const entry of Object.values(value.env)) {
        if (entry !== null && typeof entry !== 'string') return null;
      }
      return value as unknown as AgentCommand;
    }
    default:
      return null;
  }
}

function parseLifecycleEvent(value: Record<string, unknown>): AgentWorkerEvent | null {
  const identity =
    value.type === 'child-reserved' ||
    value.type === 'child-ready' ||
    value.type === 'child-rejected' ||
    value.type === 'child-ended'
      ? parseChildSessionIdentity(value.identity)
      : parseSessionIdentity(value.identity);
  if (!identity || !isSequence(value.seq)) return null;
  switch (value.type) {
    case 'parent-ready':
      return isNonEmptyString(value.sessionFile) && parseModelRef(value.model)
        ? (value as unknown as AgentWorkerEvent)
        : null;
    case 'model-changed':
      return parseModelRef(value.model) ? (value as unknown as AgentWorkerEvent) : null;
    case 'parent-rejected':
    case 'parent-ended':
    case 'child-rejected':
    case 'child-ended':
      return isNonEmptyString(value.reason) ? (value as unknown as AgentWorkerEvent) : null;
    case 'child-reserved':
      return isNonEmptyString(value.requestId) && parseChildConversationMetadata(value.metadata)
        ? (value as unknown as AgentWorkerEvent)
        : null;
    case 'child-ready': {
      const proof = parseResolvedChildProfileProof(value.proof);
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
    default:
      return null;
  }
}

/** 收窄 worker → Main/Renderer 统一事件；缺 generation 的旧事件拒绝。 */
export function parseAgentWorkerEvent(value: unknown): AgentWorkerEvent | null {
  if (!isRecord(value) || !isNonEmptyString(value.type)) return null;
  if (
    value.type === 'parent-ready' ||
    value.type === 'model-changed' ||
    value.type === 'parent-rejected' ||
    value.type === 'parent-ended' ||
    value.type === 'child-reserved' ||
    value.type === 'child-ready' ||
    value.type === 'child-rejected' ||
    value.type === 'child-ended'
  ) {
    return parseLifecycleEvent(value);
  }
  if (value.type === 'workspace-lock-result' || value.type === 'workspace-unlock-result') {
    return hasOnlyKeys(value, ['type', 'requestId', 'ok', 'error']) &&
      isNonEmptyString(value.requestId) &&
      (value.ok === true
        ? value.error === undefined
        : value.ok === false && isNonEmptyString(value.error))
      ? (value as unknown as AgentWorkerEvent)
      : null;
  }
  if (value.type === 'session-reloaded') {
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
  }
  if (value.type === 'snapshot') {
    return Array.isArray(value.sessions) &&
      value.sessions.every((session) => parseSessionSnapshot(session) !== null)
      ? (value as unknown as AgentWorkerEvent)
      : null;
  }
  if (value.type === 'capability-invoke') {
    return parseChildSessionIdentity(value.child) &&
      isSequence(value.seq) &&
      isNonEmptyString(value.turnId) &&
      isNonEmptyString(value.requestId) &&
      isProductSurfaceId(value.capabilityId) &&
      Object.hasOwn(value, 'params')
      ? (value as unknown as AgentWorkerEvent)
      : null;
  }
  if (value.type === 'mcp-status') {
    // 该事件会广播到全部窗口，字段白名单 + 逐项类型都要卡死
    return hasOnlyKeys(value, ['type', 'serverId', 'serverName', 'state', 'toolCount', 'error']) &&
      isNonEmptyString(value.serverName) &&
      (value.serverId === undefined || isNonEmptyString(value.serverId)) &&
      (value.toolCount === undefined || isSequence(value.toolCount)) &&
      (value.error === undefined || typeof value.error === 'string') &&
      MCP_CONNECTION_STATES.includes(value.state as McpConnectionState)
      ? (value as unknown as AgentWorkerEvent)
      : null;
  }
  if (value.type === 'mcp-tokens-refreshed') {
    if (!hasOnlyKeys(value, ['type', 'serverId', 'tokens']) || !isNonEmptyString(value.serverId)) {
      return null;
    }
    const tokens = parseMcpOAuthTokens(value.tokens);
    return tokens ? { type: 'mcp-tokens-refreshed', serverId: value.serverId, tokens } : null;
  }
  if (value.type === 'title-generated') {
    return hasExactKeys(value, ['type', 'conversationId', 'title']) &&
      isNonEmptyString(value.conversationId) &&
      isNonEmptyString(value.title)
      ? (value as unknown as AgentWorkerEvent)
      : null;
  }
  if (value.type === 'title-failed') {
    return hasExactKeys(value, ['type', 'conversationId', 'error']) &&
      isNonEmptyString(value.conversationId) &&
      isNonEmptyString(value.error)
      ? (value as unknown as AgentWorkerEvent)
      : null;
  }
  if (value.type === 'text-completed') {
    return hasExactKeys(value, ['type', 'requestId', 'text']) &&
      isNonEmptyString(value.requestId) &&
      typeof value.text === 'string'
      ? (value as unknown as AgentWorkerEvent)
      : null;
  }
  if (value.type === 'text-failed') {
    return hasExactKeys(value, ['type', 'requestId', 'error']) &&
      isNonEmptyString(value.requestId) &&
      isNonEmptyString(value.error)
      ? (value as unknown as AgentWorkerEvent)
      : null;
  }
  const identity = parseAnySessionIdentity(value.identity);
  if (!identity || !isSequence(value.seq)) return null;
  switch (value.type) {
    case 'browser-invoke':
      return hasExactKeys(value, ['type', 'identity', 'seq', 'requestId', 'op', 'params']) &&
        isNonEmptyString(value.requestId) &&
        BROWSER_OPS.includes(value.op as BrowserOp)
        ? (value as unknown as AgentWorkerEvent)
        : null;
    case 'memory-invoke':
      return hasExactKeys(value, ['type', 'identity', 'seq', 'requestId', 'op', 'params']) &&
        isNonEmptyString(value.requestId) &&
        MEMORY_OPS.includes(value.op as MemoryOp)
        ? (value as unknown as AgentWorkerEvent)
        : null;
    case 'workspace-branch-context-consumed':
      return hasExactKeys(value, ['type', 'identity', 'seq', 'requestId']) &&
        isNonEmptyString(value.requestId)
        ? (value as unknown as AgentWorkerEvent)
        : null;
    case 'status':
      return value.status === 'idle' || value.status === 'running' || value.status === 'failed'
        ? (value as unknown as AgentWorkerEvent)
        : null;
    case 'message-upsert':
      return isSequence(value.index) && isRecord(value.message)
        ? (value as unknown as AgentWorkerEvent)
        : null;
    case 'turn-completed':
      return isNonEmptyString(value.turnId) &&
        (value.digest === undefined || parseTurnDigest(value.digest))
        ? (value as unknown as AgentWorkerEvent)
        : null;
    case 'turn-failed':
      return isNonEmptyString(value.turnId) &&
        isNonEmptyString(value.error) &&
        (value.undelivered === undefined || value.undelivered === true)
        ? (value as unknown as AgentWorkerEvent)
        : null;
    case 'turn-retry':
      return Number.isInteger(value.attempt) &&
        (value.attempt as number) >= 1 &&
        Number.isInteger(value.maxAttempts) &&
        (value.maxAttempts as number) >= 1 &&
        isSequence(value.delayMs) &&
        isNonEmptyString(value.error)
        ? (value as unknown as AgentWorkerEvent)
        : null;
    case 'messages-truncated':
      return isSequence(value.length) ? (value as unknown as AgentWorkerEvent) : null;
    case 'rewind-done': {
      const editorImages =
        value.editorImages === undefined ? undefined : parseAttachedImages(value.editorImages);
      return (value.editorText === undefined || typeof value.editorText === 'string') &&
        editorImages !== null &&
        (value.filesRestored === undefined || typeof value.filesRestored === 'boolean')
        ? (value as unknown as AgentWorkerEvent)
        : null;
    }
    case 'fork-done':
      return isUuid(value.targetConversationId) &&
        (value.sessionFile === undefined || typeof value.sessionFile === 'string') &&
        (value.entryId === undefined || isNonEmptyString(value.entryId)) &&
        (value.error === undefined || typeof value.error === 'string')
        ? (value as unknown as AgentWorkerEvent)
        : null;
    case 'compaction':
      return (value.state === 'queued' || value.state === 'start' || value.state === 'end') &&
        (value.error === undefined || typeof value.error === 'string') &&
        (value.abandoned === undefined || value.abandoned === true)
        ? (value as unknown as AgentWorkerEvent)
        : null;
    case 'commands':
      return Array.isArray(value.commands) ? (value as unknown as AgentWorkerEvent) : null;
    case 'session-meta': {
      const occupancy =
        value.occupancy === undefined ? undefined : parseContextOccupancy(value.occupancy);
      if (value.occupancy !== undefined && !occupancy) return null;
      return (value.sessionFile === undefined || typeof value.sessionFile === 'string') &&
        (value.contextWindow === undefined ||
          (typeof value.contextWindow === 'number' && value.contextWindow > 0))
        ? ({ ...value, ...(occupancy ? { occupancy } : {}) } as unknown as AgentWorkerEvent)
        : null;
    }
    case 'approval-request':
      return isRecord(value.request) && isNonEmptyString(value.request.requestId)
        ? (value as unknown as AgentWorkerEvent)
        : null;
    case 'approval-resolved':
    case 'ask-resolved':
      return isNonEmptyString(value.requestId) ? (value as unknown as AgentWorkerEvent) : null;
    case 'ask-request':
      return isRecord(value.ask) &&
        isNonEmptyString(value.ask.requestId) &&
        isNonEmptyString(value.ask.question)
        ? (value as unknown as AgentWorkerEvent)
        : null;
    case 'subagent-update':
      return isRecord(value.agent) ? (value as unknown as AgentWorkerEvent) : null;
    case 'coworker-update':
      return isRecord(value.coworker) && isNonEmptyString(value.coworker.id)
        ? (value as unknown as AgentWorkerEvent)
        : null;
    case 'goal-signal':
      return (value.kind === 'complete' || value.kind === 'blocked' || value.kind === 'wait') &&
        typeof value.note === 'string'
        ? (value as unknown as AgentWorkerEvent)
        : null;
    case 'tool-output':
      return isNonEmptyString(value.toolCallId) &&
        typeof value.output === 'string' &&
        (value.startedAt === undefined || typeof value.startedAt === 'number')
        ? (value as unknown as AgentWorkerEvent)
        : null;
    case 'task-started':
      return isRecord(value.task) ? (value as unknown as AgentWorkerEvent) : null;
    case 'task-output':
    case 'task-ended':
      return isNonEmptyString(value.taskId) ? (value as unknown as AgentWorkerEvent) : null;
    case 'session-custom-entry':
      return parseAgentSessionCustomEntry(value.entry)
        ? (value as unknown as AgentWorkerEvent)
        : null;
    default:
      return null;
  }
}
