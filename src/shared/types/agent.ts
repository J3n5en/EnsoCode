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
import type { DefaultModelRef } from '../defaultModel';
import { PRODUCT_SURFACE_INVENTORY, type ProductSurfaceId } from '../productSurfaces';
import { MODEL_API_KINDS, type ModelApiKind, type ModelCapabilityOverrides } from './llm';
import { type AgentDispatchTask, parseAgentDispatchTask } from './mentions';

export type { ChildSessionIdentity, SessionIdentity } from '../builtinAgents';
export { parseChildSessionIdentity, parseSessionIdentity } from '../builtinAgents';

/** 会话状态。waiting/done 属权限门与 subagent 刀，M1 不引入 */
export type NodeStatus = 'idle' | 'running' | 'failed';

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

/** 审批档位：supervised 写操作全审 / auto-edits 仅命令与 MCP 审 / full 全放行 */
export const APPROVAL_MODES = ['supervised', 'auto-edits', 'full'] as const;
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

/** 待审批请求（worker → 渲染层） */
export interface ApprovalRequestInfo {
  requestId: string;
  tool: string;
  kind: ApprovalKind;
  /** 命令全文 / 文件路径 / 参数预览 */
  summary: string;
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
  /** 精选注入的 skill 目录（main 已按 id 解析） */
  skillPaths?: string[];
  /** 精选注入的 MCP server（main 已按 id 解析） */
  mcpServers?: McpServerSpawnConfig[];
  /** 绑定模型；缺省 = 跟随父会话 */
  model?: SpawnModelConfig;
  /** 是否允许主 agent 覆盖模型（'agent_pick' 允许/必须主 agent 选型；固定模型或跟随会话时为 false，不允许自选覆盖） */
  allowModelOverride?: boolean;
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

/** spawn 下发的 MCP server 配置（McpServerEntry 的运行子集，不带 id/source） */
export interface McpServerSpawnConfig {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
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
  'projectMemory',
  'reminders',
] as const;

export type ContextOccupancyBucketId = (typeof CONTEXT_OCCUPANCY_BUCKETS)[number];

export type ContextOccupancyBuckets = Record<ContextOccupancyBucketId, number>;

export interface ContextOccupancy {
  buckets: ContextOccupancyBuckets;
  used: number;
  estimated: true;
  compactedMessageCount: number;
  compactionModelMismatch: boolean;
  contextWindow?: number;
  percent?: number;
  compactionEntryId?: string;
}

export interface ConversationAuthority {
  conversationId: string;
  projectId: string;
  kind: 'root';
  lifecycle: 'draft' | 'ready' | 'ended';
  version: number;
  sessionFile?: string;
  selection?: DefaultModelRef & { revision: number };
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
      type: 'spawn-parent';
      identity: SessionIdentity;
      cwd: string;
      model: SpawnModelConfig;
      resumeFile?: string;
      reasoningEnabled?: boolean;
      thinkingLevel?: ThinkingLevel;
      loadLocalSkills?: boolean;
      skillPaths?: string[];
      mcpServers?: McpServerSpawnConfig[];
      instruction?: { path: string; content: string };
      approvalMode?: ApprovalMode;
      agentTypes?: AgentTypeSpawnConfig[];
      subagentModels?: SubagentModelOption[];
      disabledTools?: string[];
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
  | { type: 'task-stop'; identity: SessionIdentity; taskId: string }
  | {
      type: 'rewind';
      identity: SessionIdentity;
      userIndexFromEnd: number;
      restoreFiles?: boolean;
    }
  | { type: 'abort'; identity: SessionIdentity }
  | {
      /** 标题总结：一次性补全，不创建会话、不落盘；失败静默（不回事件） */
      type: 'summarize-title';
      conversationId: string;
      text: string;
      model: SpawnModelConfig;
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
   * 整轮墙钟耗时（ms）：本轮首 step 开始→本 step 完成。
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
  /** 该 step 的计时打点（仅 assistant 消息带） */
  timing?: MessageTiming;
  /** todo 工具 toolResult 的清单快照 */
  todos?: TodoItem[];
  /** 工具执行耗时（仅 toolResult 消息带；worker 按 tool_execution_start/end 打点） */
  toolDurationMs?: number;
  /** subagent 工具 toolResult 的执行元数据 */
  subagentMeta?: { modelId?: string; outputTokens?: number; steps?: number };
  /** compactionSummary 消息：压缩前的上下文 token 数 */
  tokensBefore?: number;
}

export interface SessionSnapshot {
  identity: SessionIdentity;
  status: NodeStatus;
  messages: ProjectedMessage[];
  /**
   * messages 的绝对起始 index。仅手机链路（pairPolicy 裁尾窗）会设置：
   * 长对话只发最近一段，手机按 baseIndex+i 幂等写入。worker 全量快照恒缺省（=0）。
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
}

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
  | Exclude<AgentWorkerEvent, ChildLifecycleEvent>
  | RendererChildLifecycleEvent
  | { type: 'worker-exited' };

export type AgentWorkerEvent =
  | ParentLifecycleEvent
  | ChildLifecycleEvent
  | { type: 'status'; identity: SessionIdentity; seq: number; status: NodeStatus; error?: string }
  | {
      type: 'message-upsert';
      identity: SessionIdentity;
      seq: number;
      index: number;
      message: ProjectedMessage;
    }
  | { type: 'turn-completed'; identity: SessionIdentity; seq: number; turnId: string }
  | {
      type: 'turn-failed';
      identity: SessionIdentity;
      seq: number;
      turnId: string;
      error: string;
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
  | { type: 'messages-truncated'; identity: SessionIdentity; seq: number; length: number }
  | {
      type: 'rewind-done';
      identity: SessionIdentity;
      seq: number;
      editorText?: string;
      filesRestored?: boolean;
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
  | { type: 'snapshot'; sessions: SessionSnapshot[]; partial?: boolean };

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

export function parseContextOccupancy(value: unknown): ContextOccupancy | null {
  if (!isRecord(value) || !isRecord(value.buckets) || value.estimated !== true) return null;
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
    !hasOnlyKeys(value, ['requestId', 'projectId', 'projectVersion', 'conversationId']) ||
    !isNonEmptyString(value.requestId) ||
    !isUuid(value.projectId) ||
    !isSequence(value.projectVersion) ||
    (value.conversationId !== undefined && !isUuid(value.conversationId))
  ) {
    return null;
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
      'commands',
      'pendingApprovals',
      'pendingAsks',
      'backgroundTasks',
      'subagents',
      'safeJournal',
      'child',
      'customEntries',
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
        value.customEntries.some((entry) => parseAgentSessionCustomEntry(entry) === null)))
  ) {
    return null;
  }
  return value as unknown as SessionSnapshot;
}

/** 收窄 Main → worker 命令。旧 global/builtin session shape 一律拒绝。 */
export function parseAgentCommand(value: unknown): AgentCommand | null {
  if (!isRecord(value) || !isNonEmptyString(value.type)) return null;
  switch (value.type) {
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
          'skillPaths',
          'mcpServers',
          'instruction',
          'approvalMode',
          'agentTypes',
          'subagentModels',
          'disabledTools',
          'remote',
        ]) ||
        !parseSessionIdentity(value.identity) ||
        typeof value.cwd !== 'string' ||
        !parseSpawnModelConfig(value.model) ||
        (value.resumeFile !== undefined && !isNonEmptyString(value.resumeFile)) ||
        (value.remote !== undefined && parseAgentRemoteConfig(value.remote) === null) ||
        (value.subagentModels !== undefined &&
          (!Array.isArray(value.subagentModels) ||
            value.subagentModels.some((entry) => parseSubagentModelOption(entry) === null)))
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
    case 'summarize-title':
      return hasExactKeys(value, ['type', 'conversationId', 'text', 'model']) &&
        isNonEmptyString(value.conversationId) &&
        isNonEmptyString(value.text) &&
        parseSpawnModelConfig(value.model)
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
    case 'browser-result': {
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
    case 'rewind':
      return hasOnlyKeys(value, ['type', 'identity', 'userIndexFromEnd', 'restoreFiles']) &&
        parseAnySessionIdentity(value.identity) &&
        isSequence(value.userIndexFromEnd) &&
        (value.restoreFiles === undefined || typeof value.restoreFiles === 'boolean')
        ? (value as unknown as AgentCommand)
        : null;
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
  if (value.type === 'title-generated') {
    return hasExactKeys(value, ['type', 'conversationId', 'title']) &&
      isNonEmptyString(value.conversationId) &&
      isNonEmptyString(value.title)
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
    case 'status':
      return value.status === 'idle' || value.status === 'running' || value.status === 'failed'
        ? (value as unknown as AgentWorkerEvent)
        : null;
    case 'message-upsert':
      return isSequence(value.index) && isRecord(value.message)
        ? (value as unknown as AgentWorkerEvent)
        : null;
    case 'turn-completed':
      return isNonEmptyString(value.turnId) ? (value as unknown as AgentWorkerEvent) : null;
    case 'turn-failed':
      return isNonEmptyString(value.turnId) && isNonEmptyString(value.error)
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
    case 'rewind-done':
      return (value.editorText === undefined || typeof value.editorText === 'string') &&
        (value.filesRestored === undefined || typeof value.filesRestored === 'boolean')
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
