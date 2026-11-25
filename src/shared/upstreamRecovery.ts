const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export type UpstreamErrorKind = 'transient' | 'quota' | 'permanent';

export type UpstreamPermanentReason = 'ip-blocked' | 'auth' | 'model' | 'bad-request' | 'unknown';

export interface UpstreamErrorInput {
  error?: string;
  statusCode?: number;
  retryExhausted?: boolean;
}

export interface UpstreamErrorClassification {
  kind: UpstreamErrorKind;
  reason: string;
  /** 面向用户的简短建议（i18n key 或可读文案） */
  hint?: string;
  /** 配额错误附带的重置时间戳（epoch ms） */
  resetAt?: number;
}

export interface GoalUpstreamRetry {
  reason: 'upstream';
  kind: 'transient' | 'quota';
  provider: string;
  attempt: number;
  since: number;
  at: number;
  lastError: string;
  resetAt?: number;
}

export type ProviderHealthState = 'ok' | 'degraded' | 'probing';

export interface ProviderHealthSnapshot {
  provider: string;
  /** 用户可读的供应商名（设置里的 name / 订阅账号标签）；Main 出口处填，可能缺失 */
  providerName?: string;
  state: Exclude<ProviderHealthState, 'ok'>;
  since: number;
  errorKind: 'transient' | 'quota';
  lastError: string;
  probingWaiterId?: string;
  waitingCount: number;
  nextProbeAt?: number;
}

/** 瞬态退避：1、2、5、10、15 分钟，之后维持 15 分钟 */
export const TRANSIENT_BACKOFF_MS = [
  1 * MINUTE_MS,
  2 * MINUTE_MS,
  5 * MINUTE_MS,
  10 * MINUTE_MS,
  15 * MINUTE_MS,
] as const;

/** 瞬态错误总退避上限：6 小时 */
export const TRANSIENT_MAX_WINDOW_MS = 6 * HOUR_MS;

/** 配额错误探测间隔：30 分钟 */
export const QUOTA_RETRY_INTERVAL_MS = 30 * MINUTE_MS;

/** 配额错误总退避上限：24 小时 */
export const QUOTA_MAX_WINDOW_MS = 24 * HOUR_MS;

/** Provider 给出重置时间时额外留 1 分钟缓冲，避免时钟偏差 */
export const QUOTA_RESET_BUFFER_MS = 1 * MINUTE_MS;

/** 待派发 / 排队启动瞬态失败最多重试 5 次 */
export const PENDING_DISPATCH_MAX_RETRIES = 5;
export const PENDING_DISPATCH_BACKOFF_MS = [
  30_000,
  1 * MINUTE_MS,
  2 * MINUTE_MS,
  5 * MINUTE_MS,
  10 * MINUTE_MS,
] as const;

const QUOTA_PATTERNS: readonly RegExp[] = [
  /\b(?:weekly|daily|monthly|hourly)\s+usage\s+limit(?:\s+exceeded|\s+reached)?\b/i,
  /\busage[_\s-]+limit(?:[_\s-]+(?:exceeded|reached))?\b/i,
  /\binsufficient[_\s-]+quota\b/i,
  /\b(?:exceeded\s+your\s+current\s+quota|quota[_\s-]+exceeded)\b/i,
  /\bbilling[_\s-]+(?:hard[_\s-]+limit|not[_\s-]+active|limit|error)\b/i,
  /\b(?:credit\s+balance\s+is\s+too\s+low|out\s+of\s+credits?|payment\s+required)\b/i,
];

const IP_BLOCKED_PATTERNS: readonly RegExp[] = [
  /\byour\s+ip\b[^\n]{0,80}\b(?:recorded|blocked|banned|restricted|denied|blacklisted)\b/i,
  /\bip(?:\s+address)?\b[^\n]{0,60}\b(?:recorded|blocked|banned|restricted|blacklisted)\b/i,
  /\baccess\s+denied\b[^\n]{0,60}\bip\b/i,
];

const AUTH_PATTERNS: readonly RegExp[] = [
  /\binvalid[_\s-]+api[_\s-]+key\b/i,
  /\bincorrect[_\s-]+api[_\s-]+key\b/i,
  /\bapi[_\s-]+key\s+(?:expired|revoked|invalid|missing)\b/i,
  /\bauthentication[_\s-]+(?:error|failed)\b/i,
  /\bunauthorized\b/i,
  /\binvalid[_\s-]+(?:token|credentials|auth)\b/i,
];

const MODEL_PATTERNS: readonly RegExp[] = [
  /\bmodel[_\s-]+not[_\s-]+found\b/i,
  /\bmodel\b[^.\n]{0,60}\b(?:does\s+not\s+exist|not\s+found|is\s+not\s+supported|unavailable\s+for\s+your)\b/i,
  /\binvalid[_\s-]+model\b/i,
];

const BAD_REQUEST_PATTERNS: readonly RegExp[] = [
  /\binvalid[_\s-]+request[_\s-]+error\b/i,
  /\bcontext[_\s-]+length[_\s-]+exceeded\b/i,
  /\bmaximum\s+context\s+length\b/i,
  /\bprompt\s+is\s+too\s+long\b/i,
  /\bbad\s+request\b/i,
];

const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /\bno\s+available(?:\s+\w+){0,4}\s+accounts?\b/i,
  /\bupstream\s+service\s+temporarily\s+unavailable\b/i,
  /\bservice\s+temporarily\s+unavailable\b/i,
  /\btemporarily\s+unavailable\b/i,
  /\bservice\s+unavailable\b/i,
  /\bbad\s+gateway\b/i,
  /\bgateway\s+timeout\b/i,
  /\binternal\s+server\s+error\b/i,
  /\bserver[_\s-]+error\b/i,
  /\boverloaded(?:[_\s-]+error)?\b/i,
  /\btoo\s+many\s+requests\b/i,
  /\brate[_\s-]+limit(?:ed|\s+exceeded)?\b/i,
  /\bthrottl(?:ed|ing)\b/i,
  /\b(?:econnreset|etimedout|econnrefused|enotfound|eai_again|epipe|ehostunreach)\b/i,
  /\bsocket\s+hang\s+up\b/i,
  /\bfetch\s+failed\b/i,
  /\bnetwork\s+error\b/i,
  /\b(?:timed?\s*out|timeout)\b/i,
  /\bstream\s+ended\s+unexpectedly\b/i,
  /\bpremature\s+close\b/i,
  /\bconnection\s+(?:reset|closed|refused|terminated)\b/i,
];

const TRANSIENT_STATUS_CODES = new Set([
  408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529,
]);

const HTTP_STATUS_RE =
  /(?:^|[^\d])(400|401|402|403|404|408|429|500|502|503|504|520|521|522|523|524|529)(?:[^\d]|$)/;

function extractStatusCode(input: UpstreamErrorInput): number | undefined {
  if (typeof input.statusCode === 'number' && Number.isInteger(input.statusCode)) {
    return input.statusCode;
  }
  if (!input.error) return undefined;
  const match = HTTP_STATUS_RE.exec(input.error);
  return match ? Number(match[1]) : undefined;
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function parseResetAt(text: string, now: number): number | undefined {
  const iso =
    /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))\b/i.exec(text);
  if (iso) {
    const parsed = Date.parse(iso[1]!);
    if (Number.isFinite(parsed)) return parsed;
  }
  const rel =
    /\b(?:try\s+again|resets?|available|retry)\s+in\s+(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b/i.exec(
      text
    );
  if (rel) {
    const value = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    if (Number.isFinite(value) && value > 0) {
      const multiplier = unit.startsWith('s')
        ? 1_000
        : unit.startsWith('m')
          ? MINUTE_MS
          : unit.startsWith('h')
            ? HOUR_MS
            : 24 * HOUR_MS;
      return now + value * multiplier;
    }
  }
  return undefined;
}

export function classifyUpstreamError(
  input: UpstreamErrorInput,
  now = Date.now()
): UpstreamErrorClassification {
  const text = input.error?.trim() ?? '';
  const status = extractStatusCode(input);

  // 1. 先判配额：避免 403 weekly usage limit 或 429 insufficient_quota 被误归为永久/普通瞬态
  if (status === 402 || matchesAny(text, QUOTA_PATTERNS)) {
    const resetAt = parseResetAt(text, now);
    return {
      kind: 'quota',
      reason: status === 402 ? 'payment-required' : 'usage-limit',
      hint: 'Quota exhausted; wait for reset or switch account/model',
      ...(resetAt !== undefined ? { resetAt } : {}),
    };
  }

  // 2. 再判明确永久错误（即使 retryExhausted 也不误重试）
  if (matchesAny(text, IP_BLOCKED_PATTERNS)) {
    return {
      kind: 'permanent',
      reason: 'ip-blocked',
      hint: 'IP restricted by upstream; switch proxy/node or check network egress',
    };
  }
  if (status === 401 || matchesAny(text, AUTH_PATTERNS)) {
    return {
      kind: 'permanent',
      reason: 'auth',
      hint: 'Authentication failed; check your API key or sign in again',
    };
  }
  if (status === 404 || matchesAny(text, MODEL_PATTERNS)) {
    return {
      kind: 'permanent',
      reason: 'model',
      hint: 'Model or endpoint not found; check your model configuration',
    };
  }
  if (status === 400 || matchesAny(text, BAD_REQUEST_PATTERNS)) {
    return {
      kind: 'permanent',
      reason: 'bad-request',
      hint: 'Request rejected by upstream; inspect parameters or context size',
    };
  }
  if (status === 403 && !matchesAny(text, TRANSIENT_PATTERNS)) {
    return {
      kind: 'permanent',
      reason: 'auth',
      hint: 'Access denied by upstream; check permissions, API key, or network node',
    };
  }

  // 3. 瞬态错误：5xx、429、超时、网络断开、No available accounts、pi 重试耗尽
  if (
    (status !== undefined && TRANSIENT_STATUS_CODES.has(status)) ||
    matchesAny(text, TRANSIENT_PATTERNS) ||
    input.retryExhausted === true
  ) {
    return {
      kind: 'transient',
      reason:
        status !== undefined
          ? `http-${status}`
          : input.retryExhausted
            ? 'retry-exhausted'
            : 'transient',
    };
  }

  // 4. 未知错误按永久处理，避免盲目空转
  return {
    kind: 'permanent',
    reason: 'unknown',
    hint: 'Upstream request failed; check provider status and configuration',
  };
}

export function nextUpstreamRetryAt(input: {
  kind: 'transient' | 'quota';
  attempt: number;
  since: number;
  now: number;
  resetAt?: number;
}): number | null {
  const { kind, attempt, since, now, resetAt } = input;
  const maxWindow = kind === 'quota' ? QUOTA_MAX_WINDOW_MS : TRANSIENT_MAX_WINDOW_MS;
  const deadline = since + maxWindow;
  if (now >= deadline) return null;

  let candidate: number;
  if (kind === 'quota') {
    if (resetAt !== undefined && resetAt > now && resetAt + QUOTA_RESET_BUFFER_MS <= deadline) {
      candidate = resetAt + QUOTA_RESET_BUFFER_MS;
    } else {
      candidate = now + QUOTA_RETRY_INTERVAL_MS;
    }
  } else {
    const idx = Math.max(0, Math.min(attempt - 1, TRANSIENT_BACKOFF_MS.length - 1));
    candidate = now + TRANSIENT_BACKOFF_MS[idx]!;
  }

  if (candidate > deadline) return null;
  return candidate;
}

export function nextPendingRetryDelayMs(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > PENDING_DISPATCH_MAX_RETRIES) {
    return null;
  }
  const idx = Math.min(attempt - 1, PENDING_DISPATCH_BACKOFF_MS.length - 1);
  return PENDING_DISPATCH_BACKOFF_MS[idx]!;
}

export function isUpstreamWaitingGoal(
  goal: { status?: string; retry?: GoalUpstreamRetry } | undefined
): goal is { status: 'waiting'; retry: GoalUpstreamRetry } {
  return goal?.status === 'waiting' && goal.retry?.reason === 'upstream';
}

export function parseGoalUpstreamRetry(value: unknown): GoalUpstreamRetry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (row.reason !== 'upstream') return undefined;
  if (row.kind !== 'transient' && row.kind !== 'quota') return undefined;
  if (typeof row.provider !== 'string' || !row.provider) return undefined;
  if (typeof row.attempt !== 'number' || !Number.isInteger(row.attempt) || row.attempt < 1) {
    return undefined;
  }
  if (typeof row.since !== 'number' || !Number.isFinite(row.since)) return undefined;
  if (typeof row.at !== 'number' || !Number.isFinite(row.at)) return undefined;
  if (typeof row.lastError !== 'string') return undefined;
  const resetAt =
    typeof row.resetAt === 'number' && Number.isFinite(row.resetAt) ? row.resetAt : undefined;
  return {
    reason: 'upstream',
    kind: row.kind,
    provider: row.provider,
    attempt: row.attempt,
    since: row.since,
    at: row.at,
    lastError: row.lastError,
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

export function formatRetryClock(at: number): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function upstreamContinuationText(objective: string): string {
  return (
    `<goal-continuation>\nUpstream recovered. Continue working toward the session goal: ${objective}\n` +
    'Inspect what was already completed before the interruption and take the next concrete step without repeating finished side effects. ' +
    'When done call goal_complete with evidence; if blocked call goal_blocked; if waiting on something external call goal_wait.\n</goal-continuation>'
  );
}
