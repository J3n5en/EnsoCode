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

type StallConversation = {
  toolOutputs?: Record<string, string> | null;
  pendingApprovals?: readonly unknown[] | null;
  pendingAsks?: readonly unknown[] | null;
  backgroundTasks?: ReadonlyArray<{ status?: string }> | null;
  subagents?: ReadonlyArray<{ status?: string }> | null;
};

/** persist 回灌可能缺运行态集合；缺省 / null 一律当空。 */
export function stallLiveWorkFlags(conversation: StallConversation): {
  pendingApprovals: number;
  pendingAsks: number;
} {
  const pendingApprovals = conversation.pendingApprovals ?? [];
  const pendingAsks = conversation.pendingAsks ?? [];
  return {
    pendingApprovals: pendingApprovals.length,
    pendingAsks: pendingAsks.length,
  };
}

export function hasLiveGenerationWork(input: {
  pendingApprovals: number;
  pendingAsks: number;
  spawningCoworker?: boolean;
}): boolean {
  return input.pendingApprovals > 0 || input.pendingAsks > 0 || Boolean(input.spawningCoworker);
}

type StallBeat = {
  lastOutputAt?: number;
  runStartedAt?: number;
  toolDeadlineAt?: Record<string, number> | null;
};

type StallSession = StallBeat & { coworkerIds?: readonly string[] };

type StallChild = StallBeat & { spawning?: boolean; status?: string };

function ownHeartbeatAt(session: StallBeat): number | undefined {
  let at = session.lastOutputAt ?? session.runStartedAt;
  for (const deadline of Object.values(session.toolDeadlineAt ?? {})) {
    if (at === undefined || deadline > at) at = deadline;
  }
  return at;
}

/**
 * 父会话等 coworker 时沿用子会话可见心跳；运行中前台命令以其超时截止为心跳，过期后照常计时。
 * 无截止时间的静默工具 / subagent 不另开豁免。
 */
export function stallHeartbeatAt(
  conversation: StallSession,
  conversations: Record<string, StallChild | undefined>
): number | undefined {
  let at = ownHeartbeatAt(conversation);
  for (const id of conversation.coworkerIds ?? []) {
    const child = conversations[id];
    if (!child || child.spawning || child.status !== 'running') continue;
    const childAt = ownHeartbeatAt(child);
    if (childAt !== undefined && (at === undefined || childAt > at)) at = childAt;
  }
  return at;
}

export type StallWatchAction = 'abort' | 'retry' | 'give-up' | 'none';

/**
 * 睡眠期间墙钟照走但定时器停跑：醒来拿跨睡眠的 Date.now() 差值判静默必误报。
 * 把运行中会话的心跳重置到唤醒时刻，给一个完整超时窗口重新计时；真卡住的会话
 * 窗口过后照常中止。toolDeadlineAt 不动：仍在未来的 deadline 本来就会经 max
 * 继续作为心跳，已过期的无需续命。
 */
export function shiftHeartbeatsAfterResume<T extends { status?: string; lastOutputAt?: number }>(
  conversations: Record<string, T>,
  now: number
): Record<string, { lastOutputAt: number }> {
  const shifted: Record<string, { lastOutputAt: number }> = {};
  for (const [id, conversation] of Object.entries(conversations)) {
    if (conversation.status !== 'running') continue;
    if (!conversation.lastOutputAt) continue;
    shifted[id] = { lastOutputAt: now };
  }
  return shifted;
}

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
