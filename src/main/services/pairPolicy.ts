import type { PhoneToHost } from '@enso/pair';

/**
 * 手机上行命令的结构校验 + 下行事件过滤。
 * 纯函数，与 Electron 解耦，便于单测；pairHost 解密后先过这里再碰 agentHost。
 */

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** spawn 需要的白名单上下文：手机只能在这些集合内选，cwd 由 main 反查，不接受手机传路径 */
export interface SpawnWhitelist {
  projects: { id: string; path: string }[];
  providers: { id: string; models: { id: string }[] }[];
}

export type CommandCheck = { ok: true; command: PhoneToHost } | { ok: false; error: string };

/** 结构校验：类型白名单 + 必填字段。通过后仍需业务校验（spawn 见 checkSpawn） */
export function parsePhoneCommand(value: unknown): CommandCheck {
  if (typeof value !== 'object' || value === null) return { ok: false, error: 'not an object' };
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case 'prompt':
    case 'steer': {
      if (!isStr(v.sessionId)) return { ok: false, error: 'missing sessionId' };
      if (typeof v.text !== 'string') return { ok: false, error: 'missing text' };
      const images = v.images;
      if (images !== undefined) {
        if (
          !Array.isArray(images) ||
          !images.every(
            (i) =>
              typeof i === 'object' &&
              i !== null &&
              isStr((i as Record<string, unknown>).data) &&
              isStr((i as Record<string, unknown>).mimeType)
          )
        ) {
          return { ok: false, error: 'invalid images' };
        }
      }
      if (v.text.length === 0 && !(Array.isArray(images) && images.length > 0)) {
        return { ok: false, error: 'empty message' };
      }
      return { ok: true, command: value as PhoneToHost };
    }
    case 'abort':
      if (!isStr(v.sessionId)) return { ok: false, error: 'missing sessionId' };
      return { ok: true, command: value as PhoneToHost };
    case 'approval-respond':
      if (!isStr(v.sessionId) || !isStr(v.requestId)) return { ok: false, error: 'missing ids' };
      if (v.decision !== 'allow' && v.decision !== 'allowSession' && v.decision !== 'deny') {
        return { ok: false, error: 'invalid decision' };
      }
      return { ok: true, command: value as PhoneToHost };
    case 'ask-respond':
      if (!isStr(v.sessionId) || !isStr(v.requestId)) return { ok: false, error: 'missing ids' };
      if (typeof v.answer !== 'string') return { ok: false, error: 'missing answer' };
      return { ok: true, command: value as PhoneToHost };
    case 'snapshot':
      return { ok: true, command: value as PhoneToHost };
    case 'subscribe':
      if (v.sessionId !== null && !isStr(v.sessionId)) {
        return { ok: false, error: 'invalid sessionId' };
      }
      if (v.sinceIndex !== undefined && typeof v.sinceIndex !== 'number') {
        return { ok: false, error: 'invalid sinceIndex' };
      }
      return { ok: true, command: value as PhoneToHost };
    case 'spawn':
      if (!isStr(v.sessionId) || !isStr(v.projectId) || !isStr(v.providerId) || !isStr(v.modelId)) {
        return { ok: false, error: 'missing spawn fields' };
      }
      // 显式拒绝手机传路径/密钥：cwd 只能由 main 反查
      if ('cwd' in v || 'apiKey' in v || 'baseUrl' in v) {
        return { ok: false, error: 'cwd/apiKey/baseUrl not accepted from phone' };
      }
      return { ok: true, command: value as PhoneToHost };
    default:
      return { ok: false, error: `command not allowed: ${String(v.type)}` };
  }
}

export interface SpawnResolved {
  cwd: string;
}

/** spawn 业务校验：projectId/providerId/modelId 必须在下发集合内，不匹配直接拒绝（不回退默认） */
export function checkSpawn(
  command: Extract<PhoneToHost, { type: 'spawn' }>,
  whitelist: SpawnWhitelist
): { ok: true; resolved: SpawnResolved } | { ok: false; error: string } {
  const project = whitelist.projects.find((p) => p.id === command.projectId);
  if (!project) return { ok: false, error: `unknown projectId: ${command.projectId}` };
  const provider = whitelist.providers.find((p) => p.id === command.providerId);
  if (!provider) return { ok: false, error: `unknown providerId: ${command.providerId}` };
  if (!provider.models.some((m) => m.id === command.modelId)) {
    return { ok: false, error: `model not enabled: ${command.modelId}` };
  }
  return { ok: true, resolved: { cwd: project.path } };
}

// ── 下行过滤 ──────────────────────────────────────────────────────────

/** 始终转发的事件（与订阅无关：目录/审批/状态/结束/崩溃） */
const ALWAYS_FORWARD = new Set([
  'status',
  'approval-request',
  'ask-request',
  'turn-completed',
  'turn-failed',
  'worker-exited',
]);

/** 仅当前订阅会话才转发的事件（大帧：消息投影） */
const SESSION_SCOPED = new Set(['message-upsert', 'snapshot-message']);

/**
 * 按订阅过滤下行，避免把全部会话的 message-upsert 都推给手机。
 * subscribedId 为 null 表示手机在列表页，不看任何会话正文。
 */
export function shouldForward(
  event: { type: string; sessionId?: string; index?: number },
  subscribedId: string | null,
  sinceIndex?: number
): boolean {
  if (ALWAYS_FORWARD.has(event.type)) return true;
  if (SESSION_SCOPED.has(event.type)) {
    if (!subscribedId || event.sessionId !== subscribedId) return false;
    // 增量续传：手机已有的旧消息不重发
    if (typeof sinceIndex === 'number' && typeof event.index === 'number') {
      return event.index > sinceIndex;
    }
    return true;
  }
  // 其余事件（subagent 更新、任务进度等）按会话归属过滤，无 sessionId 的放行
  if (typeof event.sessionId === 'string') return event.sessionId === subscribedId;
  return true;
}
