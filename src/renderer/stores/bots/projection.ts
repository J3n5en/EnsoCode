import type { ProjectedMessage, RendererAgentEvent } from '@shared/types/agent';
import {
  applyAgentEvent,
  type SessionProjection,
  truncatedNeedsSnapshotResync,
  upsertOutOfRange,
} from '@/stores/sessions/reducer';

/** conversationId → 投影；只含 Bot 模式跟踪的会话（sessions store 不认识它们） */
export type BotSessions = Record<string, SessionProjection>;

export interface BotEventResult {
  sessions: BotSessions;
  /** 正文已与 worker 脱节，需要 targeted snapshot 的会话 */
  resync: string[];
}

function eventSessionId(event: RendererAgentEvent): { id: string; generation: string } | null {
  if (!('identity' in event) || !event.identity) return null;
  const identity = event.identity as { sessionId?: unknown; generation?: unknown };
  return typeof identity.sessionId === 'string' && typeof identity.generation === 'string'
    ? { id: identity.sessionId, generation: identity.generation }
    : null;
}

/** 复用 sessions reducer 的归并逻辑；Main 换代（驱逐后 resume）时保留正文领养新代。 */
export function applyBotAgentEvent(
  sessions: BotSessions,
  event: RendererAgentEvent,
  now: number = Date.now()
): BotEventResult {
  if (event.type === 'worker-exited') {
    const next: BotSessions = {};
    for (const [id, state] of Object.entries(sessions))
      next[id] = applyAgentEvent(state, id, event, now);
    return { sessions: next, resync: [] };
  }
  if (event.type === 'snapshot') {
    let next = sessions;
    for (const snapshot of event.sessions) {
      const id = snapshot.identity.sessionId;
      const state = sessions[id];
      if (!state) continue;
      if (next === sessions) next = { ...sessions };
      next[id] = applyAgentEvent(state, id, event, now);
    }
    return { sessions: next, resync: [] };
  }
  const target = eventSessionId(event);
  const state = target ? sessions[target.id] : undefined;
  if (!target || !state) return { sessions, resync: [] };
  const { id, generation } = target;

  let base = state;
  const resync: string[] = [];
  if (state.generation !== undefined && state.generation !== generation) {
    if (event.type !== 'parent-ready') return { sessions, resync: [id] };
    base = { ...state, generation, lastSeq: 0 };
    resync.push(id);
  }
  if (
    event.type === 'message-upsert' &&
    upsertOutOfRange(base.messages, event.index, base.historyBaseIndex)
  ) {
    resync.push(id);
  }
  if (
    event.type === 'messages-truncated' &&
    truncatedNeedsSnapshotResync(base.historyBaseIndex, event.length)
  ) {
    resync.push(id);
  }
  const applied = applyAgentEvent(base, id, event, now);
  if (applied === state) return { sessions, resync };
  return { sessions: { ...sessions, [id]: applied }, resync };
}

/** 首次打开：事件流尚未带来正文时，用 jsonl 尾窗补齐 */
export function seedHistory(
  state: SessionProjection,
  page: { baseIndex: number; messages: readonly ProjectedMessage[] }
): SessionProjection {
  if (state.generation !== undefined || state.messages.length > 0) return state;
  return {
    ...state,
    messages: [...page.messages],
    historyBaseIndex: page.baseIndex > 0 ? page.baseIndex : undefined,
  };
}
