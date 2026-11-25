import {
  nextUpstreamRetryAt,
  type ProviderHealthSnapshot,
  parseGoalUpstreamRetry,
  QUOTA_MAX_WINDOW_MS,
  TRANSIENT_MAX_WINDOW_MS,
  type UpstreamErrorKind,
} from '@shared/upstreamRecovery';

export type RecoveryWaiterKind = 'session' | 'subagent';

export interface RecoveryWaiter {
  id: string;
  kind: RecoveryWaiterKind;
  provider: string;
  errorKind: Exclude<UpstreamErrorKind, 'permanent'>;
  attempt: number;
  since: number;
  nextAt: number;
  lastError: string;
  resetAt?: number;
  probing?: boolean;
  /** provider 已恢复、正在限流抖动队列等待放行 */
  recovering?: boolean;
}

export interface ReportFailureInput {
  id: string;
  kind: RecoveryWaiterKind;
  provider: string;
  errorKind: Exclude<UpstreamErrorKind, 'permanent'>;
  lastError: string;
  resetAt?: number;
  /** 如果会话行已有持久化状态（如恢复探针再次失败），可显式传入沿用 */
  since?: number;
  previousAttempt?: number;
}

export type ReportFailureResult =
  | { action: 'wait'; waiter: RecoveryWaiter }
  | { action: 'exhausted'; attempt: number; since: number };

export interface UpstreamWakeEvent {
  reason: 'probe' | 'recovered' | 'manual';
  waiter: RecoveryWaiter;
}

export interface UpstreamHealthGateOptions {
  /** 恢复后每批同时唤醒的等待者上限 */
  wakeConcurrency?: number;
  /** 恢复后首批随机抖动上限（ms） */
  wakeBaseJitterMs?: number;
  /** 恢复后相邻唤醒批次的错峰间隔（ms） */
  wakeStaggerMs?: number;
  random?: () => number;
}

interface ProviderBucket {
  state: 'degraded' | 'probing';
  since: number;
  errorKind: Exclude<UpstreamErrorKind, 'permanent'>;
  lastError: string;
  probingWaiterId?: string;
}

const DEFAULT_WAKE_CONCURRENCY = 2;
const DEFAULT_WAKE_BASE_JITTER_MS = 1_500;
const DEFAULT_WAKE_STAGGER_MS = 3_000;

/**
 * 按 provider 维度的上游健康闸门（纯状态机，无定时器）：
 * - 同 provider 降级时只放 1 个等待者做探测，其余继续等；
 * - 任一同 provider 会话成功即判恢复，剩余等待者按限并发 + 抖动错峰唤醒；
 * - 手动取消立刻移除并释放探针槽位，后续绝不再唤醒。
 */
export class UpstreamHealthGate {
  private readonly providers = new Map<string, ProviderBucket>();
  private readonly waiters = new Map<string, RecoveryWaiter>();
  private readonly wakeConcurrency: number;
  private readonly wakeBaseJitterMs: number;
  private readonly wakeStaggerMs: number;
  private readonly random: () => number;

  constructor(options: UpstreamHealthGateOptions = {}) {
    this.wakeConcurrency = Math.max(1, options.wakeConcurrency ?? DEFAULT_WAKE_CONCURRENCY);
    this.wakeBaseJitterMs = Math.max(0, options.wakeBaseJitterMs ?? DEFAULT_WAKE_BASE_JITTER_MS);
    this.wakeStaggerMs = Math.max(0, options.wakeStaggerMs ?? DEFAULT_WAKE_STAGGER_MS);
    this.random = options.random ?? Math.random;
  }

  reportFailure(input: ReportFailureInput, now: number): ReportFailureResult {
    const existing = this.waiters.get(input.id);
    const since = existing?.since ?? input.since ?? now;
    const attempt = (existing?.attempt ?? input.previousAttempt ?? 0) + 1;
    const resetAt = input.resetAt ?? existing?.resetAt;

    const bucket = this.providers.get(input.provider);
    if (bucket?.probingWaiterId === input.id) {
      bucket.probingWaiterId = undefined;
      bucket.state = 'degraded';
    }

    const nextAt = nextUpstreamRetryAt({
      kind: input.errorKind,
      attempt,
      since,
      now,
      ...(resetAt !== undefined ? { resetAt } : {}),
    });

    if (nextAt === null) {
      this.waiters.delete(input.id);
      this.pruneEmptyProvider(input.provider);
      return { action: 'exhausted', attempt, since };
    }

    const waiter: RecoveryWaiter = {
      id: input.id,
      kind: input.kind,
      provider: input.provider,
      errorKind: input.errorKind,
      attempt,
      since,
      nextAt,
      lastError: input.lastError,
      ...(resetAt !== undefined ? { resetAt } : {}),
      probing: false,
      recovering: false,
    };
    this.waiters.set(input.id, waiter);

    if (bucket) {
      bucket.errorKind = input.errorKind;
      bucket.lastError = input.lastError;
    } else {
      this.providers.set(input.provider, {
        state: 'degraded',
        since: now,
        errorKind: input.errorKind,
        lastError: input.lastError,
      });
    }

    return { action: 'wait', waiter: { ...waiter } };
  }

  reportSuccess(provider: string, waiterId: string | undefined, now: number): void {
    if (waiterId) {
      this.waiters.delete(waiterId);
    }
    const hadDegraded = this.providers.delete(provider);
    const remaining = this.waitersForProvider(provider).sort((a, b) => a.since - b.since);
    if (remaining.length === 0) return;
    if (!hadDegraded && remaining.every((w) => w.recovering)) return;

    // 限并发 + 随机抖动错峰排期，避免恢复瞬间惊群
    for (let index = 0; index < remaining.length; index++) {
      const waiter = remaining[index]!;
      const batch = Math.floor(index / this.wakeConcurrency);
      const jitter = Math.floor(this.random() * this.wakeBaseJitterMs);
      waiter.probing = false;
      waiter.recovering = true;
      waiter.nextAt = now + jitter + batch * this.wakeStaggerMs;
    }
  }

  takeDue(now: number): UpstreamWakeEvent[] {
    const out: UpstreamWakeEvent[] = [];

    // 1. 降级 provider：每个 provider 至多放 1 个到点的探测者
    for (const [provider, bucket] of this.providers) {
      if (bucket.state === 'probing' && bucket.probingWaiterId) {
        if (this.waiters.has(bucket.probingWaiterId)) continue;
        bucket.probingWaiterId = undefined;
        bucket.state = 'degraded';
      }
      const candidates = this.waitersForProvider(provider)
        .filter((w) => !w.probing && w.nextAt <= now)
        .sort((a, b) => a.nextAt - b.nextAt || a.since - b.since);
      const chosen = candidates[0];
      if (!chosen) continue;
      chosen.probing = true;
      bucket.state = 'probing';
      bucket.probingWaiterId = chosen.id;
      out.push({ reason: 'probe', waiter: { ...chosen } });
    }

    // 2. 已恢复 provider 的错峰唤醒队列
    const recoveringDue = [...this.waiters.values()]
      .filter((w) => w.recovering && !this.providers.has(w.provider) && w.nextAt <= now)
      .sort((a, b) => a.nextAt - b.nextAt || a.since - b.since);
    for (const waiter of recoveringDue) {
      this.waiters.delete(waiter.id);
      out.push({ reason: 'recovered', waiter: { ...waiter } });
    }

    return out;
  }

  retryNow(waiterId: string, now: number): UpstreamWakeEvent | null {
    const waiter = this.waiters.get(waiterId);
    if (!waiter) return null;
    const bucket = this.providers.get(waiter.provider);
    if (bucket) {
      waiter.probing = true;
      waiter.recovering = false;
      waiter.nextAt = now;
      bucket.state = 'probing';
      bucket.probingWaiterId = waiter.id;
      return { reason: 'manual', waiter: { ...waiter } };
    }
    this.waiters.delete(waiterId);
    return { reason: 'manual', waiter: { ...waiter, nextAt: now } };
  }

  cancel(waiterId: string): boolean {
    const waiter = this.waiters.get(waiterId);
    if (!waiter) return false;
    this.waiters.delete(waiterId);
    const bucket = this.providers.get(waiter.provider);
    if (bucket?.probingWaiterId === waiterId) {
      bucket.probingWaiterId = undefined;
      bucket.state = 'degraded';
    }
    this.pruneEmptyProvider(waiter.provider);
    return true;
  }

  /**
   * 唤醒无人接住（探测从未真正发起）时把 waiter 按原退避进度放回等待队列：
   * 不重置 since/attempt，下一次到点再试。probe 槽位一并释放，避免 provider 卡在 probing。
   *
   * probe 的 waiter 在 takeDue 后仍留在闸门里（probing 标记）：若探测从未真正发生，
   * 它会永远卡在 probing——nextDeadline 跳过它，倒计时就此空转。requeue 清掉标记重新排期；
   * recovered 队列的 waiter 已被摘除，重新登记。
   */
  requeue(waiter: RecoveryWaiter, now: number): boolean {
    const existing = this.waiters.get(waiter.id);
    if (existing && !existing.probing) return false;
    const bucket = this.providers.get(waiter.provider);
    if (bucket?.probingWaiterId === waiter.id) {
      bucket.probingWaiterId = undefined;
      bucket.state = 'degraded';
    }
    // 恢复队列里掉出来的：provider 已不在降级表，放回也永远不会到点——直接放弃
    if (!bucket) return false;
    const nextAt = nextUpstreamRetryAt({
      kind: waiter.errorKind,
      attempt: waiter.attempt,
      since: waiter.since,
      now,
      ...(waiter.resetAt !== undefined ? { resetAt: waiter.resetAt } : {}),
    });
    if (nextAt === null) return false;
    this.waiters.set(waiter.id, {
      ...waiter,
      probing: false,
      recovering: false,
      nextAt,
    });
    return true;
  }

  nextDeadline(): number | null {
    let earliest: number | null = null;
    for (const waiter of this.waiters.values()) {
      if (waiter.probing) continue;
      const bucket = this.providers.get(waiter.provider);
      if (bucket?.state === 'probing' && bucket.probingWaiterId) continue;
      if (earliest === null || waiter.nextAt < earliest) earliest = waiter.nextAt;
    }
    return earliest;
  }

  getWaiter(waiterId: string): RecoveryWaiter | undefined {
    const waiter = this.waiters.get(waiterId);
    return waiter ? { ...waiter } : undefined;
  }

  allWaiters(): RecoveryWaiter[] {
    return [...this.waiters.values()].map((w) => ({ ...w }));
  }

  snapshot(provider: string): ProviderHealthSnapshot | undefined {
    const bucket = this.providers.get(provider);
    if (!bucket) return undefined;
    const list = this.waitersForProvider(provider);
    let nextProbeAt: number | undefined;
    for (const waiter of list) {
      if (waiter.probing) continue;
      if (nextProbeAt === undefined || waiter.nextAt < nextProbeAt) {
        nextProbeAt = waiter.nextAt;
      }
    }
    return {
      provider,
      state: bucket.state,
      since: bucket.since,
      errorKind: bucket.errorKind,
      lastError: bucket.lastError,
      ...(bucket.probingWaiterId ? { probingWaiterId: bucket.probingWaiterId } : {}),
      waitingCount: list.length,
      ...(nextProbeAt !== undefined ? { nextProbeAt } : {}),
    };
  }

  snapshots(): ProviderHealthSnapshot[] {
    const out: ProviderHealthSnapshot[] = [];
    for (const provider of this.providers.keys()) {
      const snap = this.snapshot(provider);
      if (snap) out.push(snap);
    }
    return out.sort((a, b) => a.since - b.since);
  }

  private waitersForProvider(provider: string): RecoveryWaiter[] {
    const out: RecoveryWaiter[] = [];
    for (const waiter of this.waiters.values()) {
      if (waiter.provider === provider) out.push(waiter);
    }
    return out;
  }

  private pruneEmptyProvider(provider: string): void {
    if (this.waitersForProvider(provider).length === 0) {
      this.providers.delete(provider);
    }
  }
}

export interface UpstreamRecoveryServiceOptions extends UpstreamHealthGateOptions {
  now?: () => number;
  /**
   * 唤醒投递。返回 false 表示无人接住（会话已不在/运行状态拒绝接管），
   * service 会把 waiter 按原退避进度重排，倒计时继续走而不是空转消失；
   * 返回 true/undefined 表示已接管（或调用方已自行取消，不该再重排）。
   */
  onWake: (event: UpstreamWakeEvent) => boolean | undefined;
  onHealthChange?: (snapshots: ProviderHealthSnapshot[]) => void;
}

export interface UpstreamRecoveryService {
  reportFailure(input: ReportFailureInput): ReportFailureResult;
  reportSuccess(provider: string, waiterId?: string): void;
  retryNow(waiterId: string): UpstreamWakeEvent | null;
  cancel(waiterId: string): boolean;
  getWaiter(waiterId: string): RecoveryWaiter | undefined;
  snapshots(): ProviderHealthSnapshot[];
  dispose(): void;
}

export function createUpstreamRecoveryService(
  options: UpstreamRecoveryServiceOptions
): UpstreamRecoveryService {
  const now = options.now ?? (() => Date.now());
  const gate = new UpstreamHealthGate(options);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSnapshotsJson = '[]';

  function emitHealthIfChanged(): void {
    const snaps = gate.snapshots();
    const serialized = JSON.stringify(snaps);
    if (serialized === lastSnapshotsJson) return;
    lastSnapshotsJson = serialized;
    options.onHealthChange?.(snaps);
  }

  function schedule(): void {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    const deadline = gate.nextDeadline();
    if (deadline === null) return;
    const delay = Math.max(0, deadline - now());
    timer = setTimeout(() => {
      timer = undefined;
      const due = gate.takeDue(now());
      for (const event of due) {
        const handled = options.onWake(event);
        if (handled === false) {
          gate.requeue(event.waiter, now());
        }
      }
      emitHealthIfChanged();
      schedule();
    }, delay);
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref();
    }
  }

  return {
    reportFailure(input) {
      const result = gate.reportFailure(input, now());
      emitHealthIfChanged();
      schedule();
      return result;
    },
    reportSuccess(provider, waiterId) {
      gate.reportSuccess(provider, waiterId, now());
      emitHealthIfChanged();
      schedule();
    },
    retryNow(waiterId) {
      const event = gate.retryNow(waiterId, now());
      if (event) {
        const handled = options.onWake(event);
        if (handled === false) {
          gate.requeue(event.waiter, now());
        }
      }
      emitHealthIfChanged();
      schedule();
      return event;
    },
    cancel(waiterId) {
      const removed = gate.cancel(waiterId);
      if (removed) {
        emitHealthIfChanged();
        schedule();
      }
      return removed;
    },
    getWaiter(waiterId) {
      return gate.getWaiter(waiterId);
    },
    snapshots() {
      return gate.snapshots();
    },
    dispose() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

/**
 * 重启后闸门内存是空的：把磁盘上还挂着 waiting(upstream) 目标的会话重新登记，
 * 沿用 since/attempt 退避进度，倒计时到点真正发起重试。
 * 已超出退避总窗口的会话不再登记（它们的 goal 会在下一次失败时按 exhausted 收敛）。
 * 返回重新登记的会话数。
 */
export function reseatUpstreamWaiters(
  recovery: UpstreamRecoveryService,
  rows: Record<string, unknown>,
  now: number
): number {
  let count = 0;
  for (const [conversationId, row] of Object.entries(rows)) {
    if (!row || typeof row !== 'object') continue;
    const goal = (row as Record<string, unknown>).goal;
    if (!goal || typeof goal !== 'object') continue;
    const record = goal as Record<string, unknown>;
    if (record.status !== 'waiting') continue;
    const retry = parseGoalUpstreamRetry(record.retry);
    if (!retry) continue;
    const maxWindow = retry.kind === 'quota' ? QUOTA_MAX_WINDOW_MS : TRANSIENT_MAX_WINDOW_MS;
    if (now >= retry.since + maxWindow) continue;
    const result = recovery.reportFailure({
      id: conversationId,
      kind: 'session',
      provider: retry.provider,
      errorKind: retry.kind,
      lastError: retry.lastError,
      ...(retry.resetAt !== undefined ? { resetAt: retry.resetAt } : {}),
      since: retry.since,
      previousAttempt: retry.attempt - 1,
    });
    if (result.action === 'wait') count += 1;
  }
  return count;
}
