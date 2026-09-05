export const GENERATION_STALL_TIMEOUT_MINUTES = [0, 2, 5, 10, 20] as const;
export const MAX_STALL_RETRIES = 3;

export function shouldAbortStalledGeneration(input: {
  status: string;
  spawning?: boolean;
  lastOutputAt?: number;
  runStartedAt?: number;
  now: number;
  timeoutMs: number;
  hasLiveWork?: boolean;
}): boolean {
  if (input.timeoutMs <= 0 || input.spawning || input.status !== 'running') return false;
  if (input.hasLiveWork) return false;
  const since = input.lastOutputAt ?? input.runStartedAt;
  if (since === undefined) return false;
  return input.now - since >= input.timeoutMs;
}

export function hasLiveGenerationWork(input: {
  pendingApprovals: number;
  pendingAsks: number;
  runningBackgroundTasks: boolean;
  runningSubagents: boolean;
  hasToolOutput: boolean;
  liveCoworker: boolean;
  inFlightTools?: boolean;
}): boolean {
  return (
    input.pendingApprovals > 0 ||
    input.pendingAsks > 0 ||
    input.runningBackgroundTasks ||
    input.runningSubagents ||
    input.hasToolOutput ||
    input.liveCoworker ||
    Boolean(input.inFlightTools)
  );
}

type StallMessage = {
  role?: string;
  content?: ReadonlyArray<{ type?: string; id?: string; name?: string }>;
  toolCallId?: string;
};

/** 本轮末 assistant 已发出、尚未收到 toolResult 的调用（如 bash / coworker wait）。 */
export function hasInFlightToolCalls(messages: readonly StallMessage[]): boolean {
  let lastTurnIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== 'toolResult') {
      lastTurnIndex = i;
      break;
    }
  }
  if (lastTurnIndex < 0 || messages[lastTurnIndex]?.role !== 'assistant') return false;
  const done = new Set<string>();
  for (let i = lastTurnIndex + 1; i < messages.length; i++) {
    const id = messages[i]?.toolCallId;
    if (id) done.add(id);
  }
  return (messages[lastTurnIndex].content ?? []).some(
    (part) => part.type === 'toolCall' && typeof part.id === 'string' && !done.has(part.id)
  );
}

export type StallWatchAction = 'abort' | 'retry' | 'give-up' | 'none';

export function nextStallWatchAction(input: {
  shouldAbort: boolean;
  status: string;
  spawning?: boolean;
  pendingRetry: boolean;
  attempts: number;
}): StallWatchAction {
  if (input.pendingRetry && input.status !== 'running' && !input.spawning) {
    return input.attempts >= MAX_STALL_RETRIES ? 'give-up' : 'retry';
  }
  if (input.shouldAbort) return 'abort';
  return 'none';
}
