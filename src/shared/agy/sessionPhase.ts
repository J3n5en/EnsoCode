import type { AgySessionEvent, AgySessionFields, AgySessionPhase } from './types';

export function initialAgySession(): AgySessionPhase {
  return { phase: 'closed' };
}

function readyFields(event: AgySessionEvent & AgySessionFields): AgySessionFields {
  return {
    sessionId: event.sessionId,
    version: event.version,
    canAppendSystemPrompt: event.canAppendSystemPrompt,
    configOptions: event.configOptions,
    modes: event.modes,
  };
}

/** 非法事件保持原状态。close 从任何阶段回到 closed。 */
export function transitionAgySession(
  state: AgySessionPhase,
  event: AgySessionEvent
): AgySessionPhase {
  if (event.type === 'close') return { phase: 'closed' };
  if (event.type === 'fail') return { phase: 'failed', message: event.message };
  switch (state.phase) {
    case 'closed':
    case 'failed':
      return event.type === 'spawn' ? { phase: 'spawning' } : state;
    case 'spawning':
      return event.type === 'initialized'
        ? {
            phase: 'initialized',
            version: event.version,
            canAppendSystemPrompt: event.canAppendSystemPrompt,
          }
        : state;
    case 'initialized':
      return event.type === 'session-ready'
        ? { phase: 'session-ready', ...readyFields(event) }
        : state;
    case 'session-ready':
      return event.type === 'prompt-started' ? { ...state, phase: 'prompting' } : state;
    case 'prompting':
      return event.type === 'prompt-finished' ? { ...state, phase: 'session-ready' } : state;
  }
}
