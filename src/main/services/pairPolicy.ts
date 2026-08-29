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
      // 推理字段可选，但给了就必须合法（pairHost 会直接透传给 spawn）
      if (v.reasoningEnabled !== undefined && typeof v.reasoningEnabled !== 'boolean') {
        return { ok: false, error: 'invalid reasoningEnabled' };
      }
      if (
        v.thinkingLevel !== undefined &&
        v.thinkingLevel !== 'low' &&
        v.thinkingLevel !== 'medium' &&
        v.thinkingLevel !== 'high' &&
        v.thinkingLevel !== 'max'
      ) {
        return { ok: false, error: 'invalid thinkingLevel' };
      }
      return { ok: true, command: value as PhoneToHost };
    case 'set-model':
      if (!isStr(v.sessionId) || !isStr(v.providerId) || !isStr(v.modelId)) {
        return { ok: false, error: 'missing set-model fields' };
      }
      return { ok: true, command: value as PhoneToHost };
    case 'set-reasoning':
      if (!isStr(v.sessionId)) return { ok: false, error: 'missing sessionId' };
      if (typeof v.enabled !== 'boolean') return { ok: false, error: 'invalid enabled' };
      return { ok: true, command: value as PhoneToHost };
    case 'set-thinking':
      if (!isStr(v.sessionId)) return { ok: false, error: 'missing sessionId' };
      if (v.level !== 'low' && v.level !== 'medium' && v.level !== 'high' && v.level !== 'max') {
        return { ok: false, error: 'invalid level' };
      }
      return { ok: true, command: value as PhoneToHost };
    case 'history':
      if (!isStr(v.sessionId)) return { ok: false, error: 'missing sessionId' };
      if (typeof v.beforeIndex !== 'number' || v.beforeIndex < 0) {
        return { ok: false, error: 'invalid beforeIndex' };
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

/** set-model 业务校验：与 spawn 同一白名单，provider/model 不在下发集合内直接拒绝 */
export function checkSetModel(
  command: Extract<PhoneToHost, { type: 'set-model' }>,
  whitelist: SpawnWhitelist
): { ok: true } | { ok: false; error: string } {
  const provider = whitelist.providers.find((p) => p.id === command.providerId);
  if (!provider) return { ok: false, error: `unknown providerId: ${command.providerId}` };
  if (!provider.models.some((m) => m.id === command.modelId)) {
    return { ok: false, error: `model not enabled: ${command.modelId}` };
  }
  return { ok: true };
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
const SESSION_SCOPED = new Set(['message-upsert']);

/**
 * snapshot 是批量事件（{ sessions: SessionSnapshot[] }，本身无 sessionId），
 * 需裁成只含订阅会话，避免把全部会话正文推给手机。返回 null 表示不转发。
 *
 * 消息只发尾窗（条数 + 字节双预算）：中继对超过 MAX_FRAME_BYTES(1MB) 的帧
 * 直接丢弃且不通知发送方，长对话的全量快照会静默消失——手机端表现为
 * 「历史加载不出、新消息却正常」。更早的消息由 history 命令分页拉取。
 */
export const SNAPSHOT_TAIL_MESSAGES = 60;
/** 加密封帧还会膨胀（base64 图片已在消息体内），预算须显著低于中继 1MB 上限 */
const SNAPSHOT_BYTE_BUDGET = 600_000;

interface SnapshotSession {
  /** 旧格式扁平 id；worker 新格式嵌在 identity 里，归一化后两者都有 */
  sessionId?: string;
  identity?: { sessionId?: string; generation?: string };
  messages?: unknown[];
}

/** worker 事件的会话归属：新格式在 identity.sessionId，旧格式在顶层 sessionId */
function sessionIdOf(value: {
  sessionId?: string;
  identity?: { sessionId?: string; generation?: string };
}): string | undefined {
  return value.identity?.sessionId ?? value.sessionId;
}

/** 从尾部往前取，直到条数或字节预算耗尽；至少保 1 条（单条超预算也发，交给中继裁决） */
function takeTail(
  messages: unknown[],
  endIndex: number
): { messages: unknown[]; baseIndex: number } {
  let bytes = 0;
  let start = endIndex;
  while (start > 0 && endIndex - start < SNAPSHOT_TAIL_MESSAGES) {
    const size = JSON.stringify(messages[start - 1]).length;
    if (bytes + size > SNAPSHOT_BYTE_BUDGET && start < endIndex) break;
    bytes += size;
    start--;
    if (bytes > SNAPSHOT_BYTE_BUDGET) break;
  }
  return { messages: messages.slice(start, endIndex), baseIndex: start };
}

export function narrowSnapshot(
  event: { type: string; sessions?: SnapshotSession[] },
  subscribedId: string | null
): { type: 'snapshot'; sessions: SnapshotSession[] } | null {
  if (!Array.isArray(event.sessions)) return null;
  if (!subscribedId) return null;
  const sessions = event.sessions
    .filter((s) => sessionIdOf(s) === subscribedId)
    .map((s) => {
      // 手机端按扁平 sessionId 消费（线上 PWA 不随桌面版同步发布），归一化补上
      const base = { ...s, sessionId: subscribedId };
      if (!Array.isArray(s.messages)) return { ...base, baseIndex: 0 };
      const tail = takeTail(s.messages, s.messages.length);
      return { ...base, messages: tail.messages, baseIndex: tail.baseIndex };
    });
  return sessions.length > 0 ? { type: 'snapshot', sessions } : null;
}

/** history 分页：取 beforeIndex 之前的一页（同尾窗双预算），baseIndex 标注绝对起点 */
export function sliceHistory(
  messages: unknown[],
  beforeIndex: number
): { messages: unknown[]; baseIndex: number } {
  const end = Math.max(0, Math.min(beforeIndex, messages.length));
  if (end === 0) return { messages: [], baseIndex: 0 };
  return takeTail(messages, end);
}

/**
 * 按订阅过滤下行，避免把全部会话的 message-upsert 都推给手机。
 * subscribedId 为 null 表示手机在列表页，不看任何会话正文。
 */
export function shouldForward(
  event: {
    type: string;
    sessionId?: string;
    identity?: { sessionId?: string; generation?: string };
    index?: number;
  },
  subscribedId: string | null,
  sinceIndex?: number
): boolean {
  if (ALWAYS_FORWARD.has(event.type)) return true;
  // snapshot 由 narrowSnapshot 单独裁剪后转发，不走这里
  if (event.type === 'snapshot') return false;
  const sessionId = sessionIdOf(event);
  if (SESSION_SCOPED.has(event.type)) {
    if (!subscribedId || sessionId !== subscribedId) return false;
    // 增量续传：手机已有的旧消息不重发
    if (typeof sinceIndex === 'number' && typeof event.index === 'number') {
      return event.index > sinceIndex;
    }
    return true;
  }
  // 其余事件（subagent 更新、任务进度等）按会话归属过滤，无 sessionId 的放行
  if (typeof sessionId === 'string') return sessionId === subscribedId;
  return true;
}
