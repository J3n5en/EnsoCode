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

/** Main → worker 命令 */
export type AgentCommand =
  | { type: 'spawn'; sessionId: string; cwd: string; model: SpawnModelConfig }
  | { type: 'prompt'; sessionId: string; text: string }
  | { type: 'steer'; sessionId: string; text: string }
  | { type: 'abort'; sessionId: string }
  | { type: 'snapshot' };

/** 渲染层可见的消息内容片段。白名单投影，未识别的类型收敛为 unknown */
export type ProjectedPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'toolCall'; id: string; name: string; arguments?: unknown }
  | { type: 'unknown' };

/** 渲染层可见的消息投影：pi AgentMessage 的白名单克隆 */
export interface ProjectedMessage {
  role: string;
  content: ProjectedPart[];
  /** toolResult 消息附带 */
  toolName?: string;
  isError?: boolean;
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
}

export interface SessionSnapshot {
  sessionId: string;
  status: NodeStatus;
  messages: ProjectedMessage[];
}

/** Renderer 发起开会话的请求。apiKey 由 Main 从 settings 补全，不经过 Renderer */
export interface AgentSpawnRequest {
  sessionId: string;
  providerId: string;
  modelId: string;
  cwd: string;
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
  | { type: 'snapshot'; sessions: SessionSnapshot[] };

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
    case 'steer':
      if (isNonEmptyString(value.sessionId) && isNonEmptyString(value.text)) {
        return value as unknown as AgentCommand;
      }
      return null;
    case 'abort':
      return isNonEmptyString(value.sessionId) ? (value as unknown as AgentCommand) : null;
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
