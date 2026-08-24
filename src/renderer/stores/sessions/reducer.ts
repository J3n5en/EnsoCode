import type {
  NodeStatus,
  ProjectedMessage,
  RendererAgentEvent,
  SlashCommand,
} from '@shared/types/agent';

export interface SessionProjection {
  status: NodeStatus;
  error?: string;
  messages: ProjectedMessage[];
  commands: SlashCommand[];
  lastSeq: number;
}

export const emptyProjection: SessionProjection = {
  status: 'idle',
  messages: [],
  commands: [],
  lastSeq: 0,
};

/**
 * 把 agent 事件归并进会话投影。纯函数。
 * seq 单调守卫：过期事件（seq <= lastSeq）直接丢弃，重连/重放时保证不回退。
 */
export function applyAgentEvent(
  state: SessionProjection,
  sessionId: string,
  event: RendererAgentEvent
): SessionProjection {
  if (event.type === 'worker-exited') {
    return { ...state, status: 'failed', error: 'agent worker exited' };
  }
  if (event.type === 'snapshot') {
    const snapshot = event.sessions.find((s) => s.sessionId === sessionId);
    if (!snapshot) return state;
    return {
      status: snapshot.status,
      messages: snapshot.messages,
      commands: snapshot.commands,
      lastSeq: 0,
    };
  }
  if (event.sessionId !== sessionId || event.seq <= state.lastSeq) return state;

  switch (event.type) {
    case 'status':
      return {
        ...state,
        status: event.status,
        error: event.error,
        lastSeq: event.seq,
      };
    case 'message-upsert': {
      const messages = state.messages.slice();
      messages[event.index] = event.message;
      return { ...state, messages, lastSeq: event.seq };
    }
    case 'turn-completed':
      return { ...state, lastSeq: event.seq };
    case 'messages-truncated':
      return { ...state, messages: state.messages.slice(0, event.length), lastSeq: event.seq };
    case 'commands':
      return { ...state, commands: event.commands, lastSeq: event.seq };
    case 'turn-failed':
      return { ...state, status: 'failed', error: event.error, lastSeq: event.seq };
    default:
      return state;
  }
}
