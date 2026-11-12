import {
  type AgentWorkerEvent,
  parseChildSessionIdentity,
  parseSessionIdentity,
} from '@shared/types/agent';

const PARENT_TYPES = new Set(['spawn-parent', 'prompt', 'steer', 'retry']);
const CHILD_TYPES = new Set(['spawn-child', 'prompt', 'steer', 'retry']);

/**
 * 解析失败的会话命令回发拒绝事件：静默丢弃会让会话没建成，
 * 下一条 prompt 只能报 stale generation，真实原因（契约不符）被掩盖。
 */
export function rejectUnparsableCommand(data: unknown): AgentWorkerEvent | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const { type, identity, instanceId } = data as Record<string, unknown>;
  if (typeof type !== 'string') return null;
  const reason = `invalid ${type} command: rejected by worker contract`;
  const child = parseChildSessionIdentity(identity);
  if (child) {
    return CHILD_TYPES.has(type)
      ? { type: 'child-rejected', identity: child, seq: 0, reason }
      : null;
  }
  const parent = parseSessionIdentity(identity);
  if (!parent || !PARENT_TYPES.has(type)) return null;
  return {
    type: 'parent-rejected',
    identity: parent,
    seq: 0,
    reason,
    ...(typeof instanceId === 'string' && instanceId ? { instanceId } : {}),
  };
}
