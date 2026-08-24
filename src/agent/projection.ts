import type { ProjectedMessage, ProjectedPart } from '@shared/types/agent';

/**
 * 把 pi 的 AgentMessage 投影为渲染层可见的白名单结构。
 * 白名单克隆同时承担脱敏：未列出的字段（provider 原始数据等）不会出 worker。
 * 脏输入返回 null，不抛。
 */
export function projectMessage(value: unknown): ProjectedMessage | null {
  if (!isRecord(value) || typeof value.role !== 'string') return null;

  const projected: ProjectedMessage = {
    role: value.role,
    content: projectContent(value.content),
  };
  if (typeof value.toolName === 'string') projected.toolName = value.toolName;
  if (typeof value.isError === 'boolean') projected.isError = value.isError;
  if (typeof value.stopReason === 'string') projected.stopReason = value.stopReason;
  if (typeof value.errorMessage === 'string') projected.errorMessage = value.errorMessage;
  if (typeof value.timestamp === 'number') projected.timestamp = value.timestamp;
  return projected;
}

function projectContent(content: unknown): ProjectedPart[] {
  // user 消息的 content 可以是纯字符串
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.map(projectPart);
}

function projectPart(part: unknown): ProjectedPart {
  if (!isRecord(part)) return { type: 'unknown' };
  switch (part.type) {
    case 'text':
      return { type: 'text', text: typeof part.text === 'string' ? part.text : '' };
    case 'thinking':
      return { type: 'thinking', text: typeof part.thinking === 'string' ? part.thinking : '' };
    case 'toolCall': {
      const projected: ProjectedPart = {
        type: 'toolCall',
        id: typeof part.id === 'string' ? part.id : '',
        name: typeof part.name === 'string' ? part.name : '',
      };
      if ('arguments' in part) {
        projected.arguments = structuredCloneSafe(part.arguments);
      }
      return projected;
    }
    default:
      return { type: 'unknown' };
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** 断开与源对象的引用；不可序列化的参数收敛为 undefined */
function structuredCloneSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}
