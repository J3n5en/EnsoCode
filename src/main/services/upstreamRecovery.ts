import {
  nextUpstreamRetryAt,
  type ProviderHealthSnapshot,
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
  onWake: (event: UpstreamWakeEvent) => void;
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
      emitHealthIfChanged();
      schedule();
      for (const event of due) {
        options.onWake(event);
      }
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
      emitHealthIfChanged();
      schedule();
      if (event) options.onWake(event);
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
