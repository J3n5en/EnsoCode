/**
 * 线协议类型：手机 ↔ Electron 经中继交换的帧。
 * pair 包自包含，不反向依赖应用源码；与 @shared/types/agent 的枚举取值保持一致，
 * main 侧解密后按结构校验再交给现有 sendCommand / IPC。
 */

// 与 @shared/types/agent 对齐的最小重定义（保持字面量一致以便结构兼容）
export interface AttachedImage {
  data: string;
  mimeType: string;
}
export type ThinkingLevel = 'low' | 'medium' | 'high' | 'max';
export type ApprovalMode = 'supervised' | 'auto-edits' | 'full';
export type ApprovalDecision = 'allow' | 'allowSession' | 'deny';

// ── 中继明文控制帧（中继可见，不加密）──────────────────────────────────
export type PairControl =
  | { type: 'host-online' }
  | { type: 'host-offline' }
  | { type: 'peer-joined' }
  | { type: 'peer-left' };

// ── 上行：手机 → Electron（加密 payload，白名单）─────────────────────────
export type PhoneToHost =
  | { type: 'prompt'; sessionId: string; text: string; images?: AttachedImage[] }
  | { type: 'steer'; sessionId: string; text: string; images?: AttachedImage[] }
  | { type: 'abort'; sessionId: string }
  | { type: 'approval-respond'; sessionId: string; requestId: string; decision: ApprovalDecision }
  | { type: 'ask-respond'; sessionId: string; requestId: string; answer: string }
  | { type: 'snapshot' }
  | { type: 'subscribe'; sessionId: string | null; sinceIndex?: number }
  | {
      type: 'spawn';
      sessionId: string;
      projectId: string;
      providerId: string;
      modelId: string;
      presetId?: string;
      approvalMode?: ApprovalMode;
      reasoningEnabled?: boolean;
      thinkingLevel?: ThinkingLevel;
    };

/** 手机命令白名单：main 只接受这些 type，其余（spawn 之外的 set-approval-mode、设置写入等）拒绝 */
export const PHONE_COMMAND_TYPES = [
  'prompt',
  'steer',
  'abort',
  'approval-respond',
  'ask-respond',
  'snapshot',
  'subscribe',
  'spawn',
] as const satisfies readonly PhoneToHost['type'][];

export function isPhoneCommand(value: unknown): value is PhoneToHost {
  return (
    typeof value === 'object' &&
    value !== null &&
    (PHONE_COMMAND_TYPES as readonly string[]).includes(
      (value as { type?: unknown }).type as string
    )
  );
}

// ── 下行：Electron → 手机（加密 payload）────────────────────────────────
export interface CatalogEntry {
  id: string;
  title: string;
  projectName: string;
  projectId: string;
  status: string;
  parentId?: string;
  /** 最后活动时间（末条消息或创建时间），手机端显示相对时间 */
  updatedAt?: number;
}
export interface ProjectEntry {
  id: string;
  name: string;
  path: string;
}
/** provider 剥密后下发，只够手机做 provider/model 选择 */
export interface ProviderEntry {
  id: string;
  name: string;
  models: { id: string; label?: string }[];
}

/** 下行信封：pair 自有的目录类帧 + 透传的现有 RendererAgentEvent（此处不重定义，按 unknown 透传） */
export type HostToPhone =
  | { type: 'catalog'; entries: CatalogEntry[] }
  | { type: 'projects'; projects: ProjectEntry[] }
  | { type: 'providers'; providers: ProviderEntry[] }
  | { type: 'agent-event'; event: unknown };
