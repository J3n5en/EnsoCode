export const GENERATION_STALL_TIMEOUT_MINUTES = [0, 2, 5, 10, 20] as const;
export const MAX_STALL_RETRIES = 3;

export function shouldAbortStalledGeneration(input: {
  status: string;
  spawning?: boolean;
  lastOutputAt?: number;
  runStartedAt?: number;
  now: number;
  timeoutMs: number;
}): boolean {
  if (input.timeoutMs <= 0 || input.spawning || input.status !== 'running') return false;
  const since = input.lastOutputAt ?? input.runStartedAt;
  if (since === undefined) return false;
  return input.now - since >= input.timeoutMs;
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
