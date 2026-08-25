import type { ModelApiKind } from './llm';

/** 会话状态。waiting/done 属权限门与 subagent 刀，M1 不引入 */
export type NodeStatus = 'idle' | 'running' | 'failed';

/** spawn 下发的模型配置。apiKey 只在 Main → worker 方向出现，事件类型不给 auth 位置 */
export interface SpawnModelConfig {
  api: ModelApiKind;
  baseUrl: string;
  apiKey: string;
  modelId: string;
}

/** 思考努力档位（reasoning 开启时有效），值域对齐 pi 的 ThinkingLevel。off 由 reasoningEnabled 表达 */
export const THINKING_LEVELS = ['low', 'medium', 'high', 'max'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** spawn 下发的 MCP server 配置（McpServerEntry 的运行子集，不带 id/source） */
export interface McpServerSpawnConfig {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

/** Main → worker 命令 */
export type AgentCommand =
  | {
      type: 'spawn';
      sessionId: string;
      cwd: string;
      model: SpawnModelConfig;
      /** 从既有 jsonl 恢复会话（app 重启后 resume） */
      resumeFile?: string;
      /** 是否开启推理；关闭时注册模型 reasoning:false，pi 完全不发 thinking */
      reasoningEnabled?: boolean;
      thinkingLevel?: ThinkingLevel;
      /** 是否加载本机 skill（.agents/skills、.pi/skills）；默认 true */
      loadLocalSkills?: boolean;
      /** 应用内登记的 skill 目录（设置里启用的条目），注入给 pi 的 resourceLoader */
      skillPaths?: string[];
      /** 应用内登记的 MCP server（设置里启用的条目），工具注入会话 */
      mcpServers?: McpServerSpawnConfig[];
    }
  | { type: 'prompt'; sessionId: string; text: string; images?: AttachedImage[] }
  | { type: 'steer'; sessionId: string; text: string; images?: AttachedImage[] }
  | { type: 'set-thinking'; sessionId: string; level: ThinkingLevel }
  | { type: 'set-reasoning'; sessionId: string; enabled: boolean; level?: ThinkingLevel }
  | { type: 'abort'; sessionId: string }
  | { type: 'snapshot' };

/** 随消息附带的图片（base64） */
export interface AttachedImage {
  data: string;
  mimeType: string;
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

/** 一轮的性能读数，挂在该轮最后一条 assistant 消息上（供 hover 操作条显示） */
export interface TurnPerf {
  /** 整轮墙钟耗时（ms） */
  runMs: number;
  /** 首 token 延迟（ms） */
  ttftMs?: number;
  /** 解码吞吐（tok/s） */
  tps?: number;
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
  /** 该轮性能（仅每轮最后一条 assistant 消息带） */
  perf?: TurnPerf;
}

export interface SessionSnapshot {
  sessionId: string;
  status: NodeStatus;
  messages: ProjectedMessage[];
  commands: SlashCommand[];
}

/** 会话可用的斜杠命令（pi 的 skills 与 prompt templates），name 含 / 前缀 */
export interface SlashCommand {
  name: string;
  description: string;
}

/** Renderer 发起开会话的请求。apiKey 由 Main 从 settings 补全，不经过 Renderer */
export interface AgentSpawnRequest {
  sessionId: string;
  providerId: string;
  modelId: string;
  cwd: string;
  /** 从既有 jsonl 恢复（app 重启后 resume） */
  resumeFile?: string;
  reasoningEnabled?: boolean;
  thinkingLevel?: ThinkingLevel;
  loadLocalSkills?: boolean;
  /** 注入组合预设；缺省/default 走各条目 enabled 过滤（现行为） */
  presetId?: string;
}

export interface AgentActionResult {
  ok: boolean;
  error?: string;
}

/** Renderer 收到的事件流：worker 事件 + Main 合成的 worker 退出通知 */
export type RendererAgentEvent = AgentWorkerEvent | { type: 'worker-exited' };

/**
 * worker → Main → Renderer 事件。seq 为 per-session 单调递增，接收端丢弃过期事件。
 * message-upsert 携带该位置消息的完整投影（消息级快照，不做 delta），按 index 幂等写入。
 */
export type AgentWorkerEvent =
  | { type: 'status'; sessionId: string; seq: number; status: NodeStatus; error?: string }
  | {
      type: 'message-upsert';
      sessionId: string;
      seq: number;
      index: number;
      message: ProjectedMessage;
    }
  | { type: 'turn-completed'; sessionId: string; seq: number }
  | { type: 'turn-failed'; sessionId: string; seq: number; error: string }
  | { type: 'messages-truncated'; sessionId: string; seq: number; length: number }
  | { type: 'commands'; sessionId: string; seq: number; commands: SlashCommand[] }
  | { type: 'session-meta'; sessionId: string; seq: number; sessionFile?: string }
  | { type: 'snapshot'; sessions: SessionSnapshot[]; partial?: boolean };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/** 收窄 Main → worker 命令。脏输入返回 null，不抛 */
export function parseAgentCommand(value: unknown): AgentCommand | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case 'spawn': {
      const model = value.model;
      if (
        isNonEmptyString(value.sessionId) &&
        typeof value.cwd === 'string' &&
        (value.resumeFile === undefined || isNonEmptyString(value.resumeFile)) &&
        isRecord(model) &&
        isNonEmptyString(model.api) &&
        typeof model.baseUrl === 'string' &&
        typeof model.apiKey === 'string' &&
        isNonEmptyString(model.modelId)
      ) {
        return value as unknown as AgentCommand;
      }
      return null;
    }
    case 'prompt':
    case 'steer': {
      const hasImages =
        Array.isArray(value.images) &&
        value.images.length > 0 &&
        value.images.every(
          (image) =>
            isRecord(image) && isNonEmptyString(image.data) && isNonEmptyString(image.mimeType)
        );
      if (
        isNonEmptyString(value.sessionId) &&
        typeof value.text === 'string' &&
        (value.text.length > 0 || hasImages) &&
        (value.images === undefined || hasImages)
      ) {
        return value as unknown as AgentCommand;
      }
      return null;
    }
    case 'abort':
      return isNonEmptyString(value.sessionId) ? (value as unknown as AgentCommand) : null;
    case 'set-thinking':
      if (
        isNonEmptyString(value.sessionId) &&
        THINKING_LEVELS.includes(value.level as ThinkingLevel)
      ) {
        return value as unknown as AgentCommand;
      }
      return null;
    case 'set-reasoning':
      if (
        isNonEmptyString(value.sessionId) &&
        typeof value.enabled === 'boolean' &&
        (value.level === undefined || THINKING_LEVELS.includes(value.level as ThinkingLevel))
      ) {
        return value as unknown as AgentCommand;
      }
      return null;
    case 'snapshot':
      return { type: 'snapshot' };
    default:
      return null;
  }
}

/** 收窄 worker → Main 事件。脏输入返回 null，不抛 */
export function parseAgentWorkerEvent(value: unknown): AgentWorkerEvent | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case 'status':
      if (
        isNonEmptyString(value.sessionId) &&
        typeof value.seq === 'number' &&
        (value.status === 'idle' || value.status === 'running' || value.status === 'failed')
      ) {
        return value as unknown as AgentWorkerEvent;
      }
      return null;
    case 'message-upsert':
      if (
        isNonEmptyString(value.sessionId) &&
        typeof value.seq === 'number' &&
        typeof value.index === 'number' &&
        value.index >= 0 &&
        isRecord(value.message)
      ) {
        return value as unknown as AgentWorkerEvent;
      }
      return null;
    case 'turn-completed':
      if (isNonEmptyString(value.sessionId) && typeof value.seq === 'number') {
        return value as unknown as AgentWorkerEvent;
      }
      return null;
    case 'messages-truncated':
      if (
        isNonEmptyString(value.sessionId) &&
        typeof value.seq === 'number' &&
        typeof value.length === 'number' &&
        value.length >= 0
      ) {
        return value as unknown as AgentWorkerEvent;
      }
      return null;
    case 'commands':
      if (
        isNonEmptyString(value.sessionId) &&
        typeof value.seq === 'number' &&
        Array.isArray(value.commands)
      ) {
        return value as unknown as AgentWorkerEvent;
      }
      return null;
    case 'session-meta':
      if (
        isNonEmptyString(value.sessionId) &&
        typeof value.seq === 'number' &&
        (value.sessionFile === undefined || typeof value.sessionFile === 'string')
      ) {
        return value as unknown as AgentWorkerEvent;
      }
      return null;
    case 'turn-failed':
      if (
        isNonEmptyString(value.sessionId) &&
        typeof value.seq === 'number' &&
        typeof value.error === 'string'
      ) {
        return value as unknown as AgentWorkerEvent;
      }
      return null;
    case 'snapshot':
      return Array.isArray(value.sessions) ? (value as unknown as AgentWorkerEvent) : null;
    default:
      return null;
  }
}
