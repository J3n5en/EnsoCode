import path from 'node:path';
import { app } from '@platform';
import {
  DEFAULT_CLAIM_IDLE_LEASE_MS,
  type EventClaimAcquireResult,
  type EventClaimCandidate,
  type EventClaimRecord,
  type EventClaimView,
  parseClaimGroup,
  parseClaimKey,
  parseClaimLabel,
  parseClaimSubscribedAt,
} from '@shared/types/eventClaims';
import { readJson, writeJsonAtomic } from './bots/files';

const HEARTBEAT_PERSIST_INTERVAL_MS = 5_000;

export interface EventClaimStoreOptions {
  filePath?: string;
  now?: () => number;
  idleLeaseMs?: number;
  heartbeatPersistIntervalMs?: number;
  isSessionProtected?: (sessionId: string) => boolean;
  resolvePreferredOwner?: (key: string) => string | null;
}

export interface EventClaimAcquireInput {
  key: string;
  sessionId: string;
  pluginId: string;
  label?: string;
  group?: string;
  subscribedAt?: number;
  candidates?: readonly EventClaimCandidate[];
  preferredSessionId?: string;
}

export interface EventClaimListFilter {
  prefix?: string;
  sessionId?: string;
  pluginId?: string;
}

type ClaimListener = () => void;

export class EventClaimStore {
  private readonly filePath?: string;
  private readonly now: () => number;
  private readonly idleLeaseMs: number;
  private readonly heartbeatPersistIntervalMs: number;
  private readonly isSessionProtected?: (sessionId: string) => boolean;
  private readonly resolvePreferredOwner?: (key: string) => string | null;
  private readonly claims = new Map<string, EventClaimRecord>();
  private readonly bySession = new Map<string, Set<string>>();
  private readonly listeners = new Set<ClaimListener>();
  private lastPersistAt = 0;

  constructor(options: EventClaimStoreOptions = {}) {
    this.filePath = options.filePath;
    this.now = options.now ?? Date.now;
    this.idleLeaseMs = options.idleLeaseMs ?? DEFAULT_CLAIM_IDLE_LEASE_MS;
    this.heartbeatPersistIntervalMs =
      options.heartbeatPersistIntervalMs ?? HEARTBEAT_PERSIST_INTERVAL_MS;
    this.isSessionProtected = options.isSessionProtected;
    this.resolvePreferredOwner = options.resolvePreferredOwner;
    this.load();
  }

  acquire(input: EventClaimAcquireInput): EventClaimAcquireResult {
    const now = this.now();
    const existing = this.claims.get(input.key);
    if (existing && !this.isExpired(existing, now)) {
      if (existing.sessionId === input.sessionId) {
        this.touch(existing, now, input);
        this.persist(true);
        this.emit();
        return {
          acquired: true,
          status: 'renewed',
          ownerSessionId: existing.sessionId,
          claim: viewOf(existing),
        };
      }
      return {
        acquired: false,
        status: 'held-by-other',
        ownerSessionId: existing.sessionId,
        claim: viewOf(existing),
      };
    }

    const winnerId = this.pickWinner(input);
    const candidate = input.candidates?.find((item) => item.sessionId === winnerId);
    const record = this.fresh(input, winnerId, candidate, now);
    this.put(record);
    this.persist(true);
    this.emit();
    if (winnerId === input.sessionId) {
      return { acquired: true, status: 'claimed', ownerSessionId: winnerId, claim: viewOf(record) };
    }
    return {
      acquired: false,
      status: 'held-by-other',
      ownerSessionId: winnerId,
      claim: viewOf(record),
    };
  }

  renew(key: string, sessionId: string): EventClaimView | null {
    const now = this.now();
    const record = this.claims.get(key);
    if (!record || record.sessionId !== sessionId || this.isExpired(record, now)) return null;
    record.lastHeartbeatAt = now;
    record.leaseUntil = now + this.idleLeaseMs;
    record.active = true;
    this.persist(true);
    this.emit();
    return viewOf(record);
  }

  heartbeat(sessionId: string): boolean {
    const now = this.now();
    let changed = false;
    for (const key of this.bySession.get(sessionId) ?? []) {
      const record = this.claims.get(key);
      if (!record || this.isExpired(record, now)) continue;
      record.lastHeartbeatAt = now;
      record.leaseUntil = now + this.idleLeaseMs;
      record.active = true;
      changed = true;
    }
    if (!changed) return false;
    if (this.persist(false)) this.emit();
    return true;
  }

  release(key: string, sessionId?: string): boolean {
    const record = this.claims.get(key);
    if (!record) return false;
    if (sessionId !== undefined && record.sessionId !== sessionId) return false;
    this.unlink(record);
    this.claims.delete(key);
    this.persist(true);
    this.emit();
    return true;
  }

  releaseSession(sessionId: string): number {
    const keys = [...(this.bySession.get(sessionId) ?? [])];
    if (keys.length === 0) return 0;
    for (const key of keys) {
      const record = this.claims.get(key);
      if (record) this.unlink(record);
      this.claims.delete(key);
    }
    this.persist(true);
    this.emit();
    return keys.length;
  }

  list(filter?: EventClaimListFilter): EventClaimView[] {
    const now = this.now();
    return [...this.claims.values()]
      .filter((record) => !this.isExpired(record, now))
      .filter((record) => !filter?.prefix || record.key.startsWith(filter.prefix))
      .filter((record) => !filter?.sessionId || record.sessionId === filter.sessionId)
      .filter((record) => !filter?.pluginId || record.pluginId === filter.pluginId)
      .sort((a, b) => a.claimedAt - b.claimedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map(viewOf);
  }

  ownerOf(key: string): EventClaimView | null {
    const record = this.claims.get(key);
    if (!record || this.isExpired(record, this.now())) return null;
    return viewOf(record);
  }

  onChanged(listener: ClaimListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private pickWinner(input: EventClaimAcquireInput): string {
    const preferred = input.preferredSessionId ?? this.resolvePreferredOwner?.(input.key) ?? null;
    const candidates = input.candidates;
    const ranked = candidates !== undefined && candidates.length > 0 ? candidates : null;
    if (preferred && (ranked === null || ranked.some((item) => item.sessionId === preferred))) {
      return preferred;
    }
    if (!ranked) return input.sessionId;
    let winner = ranked[0];
    let winnerAt = ranked[0]?.subscribedAt;
    for (let index = 1; index < ranked.length; index += 1) {
      const item = ranked[index];
      if (!item) continue;
      const itemActive = item.active === true;
      const winnerActive = winner.active === true;
      if (itemActive !== winnerActive) {
        if (itemActive) {
          winner = item;
          winnerAt = item.subscribedAt;
        }
        continue;
      }
      const itemAt = item.subscribedAt;
      if (itemAt === undefined) continue;
      if (winnerAt === undefined || itemAt < winnerAt) {
        winner = item;
        winnerAt = itemAt;
      }
    }
    return winner?.sessionId ?? input.sessionId;
  }

  private fresh(
    input: EventClaimAcquireInput,
    sessionId: string,
    candidate: EventClaimCandidate | undefined,
    now: number
  ): EventClaimRecord {
    const subscribedAt = candidate?.subscribedAt ?? input.subscribedAt;
    return {
      key: input.key,
      sessionId,
      pluginId: input.pluginId,
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.group !== undefined ? { group: input.group } : {}),
      ...(subscribedAt !== undefined ? { subscribedAt } : {}),
      claimedAt: now,
      lastHeartbeatAt: now,
      leaseUntil: now + this.idleLeaseMs,
      active: true,
    };
  }

  private touch(record: EventClaimRecord, now: number, input: EventClaimAcquireInput): void {
    record.lastHeartbeatAt = now;
    record.leaseUntil = now + this.idleLeaseMs;
    record.active = true;
    record.pluginId = input.pluginId;
    if (input.label !== undefined) record.label = input.label;
    if (input.group !== undefined) record.group = input.group;
    if (input.subscribedAt !== undefined) record.subscribedAt = input.subscribedAt;
  }

  private isExpired(record: EventClaimRecord, now: number): boolean {
    if (this.isSessionProtected?.(record.sessionId) === true) return false;
    return now >= record.leaseUntil;
  }

  private put(record: EventClaimRecord): void {
    const previous = this.claims.get(record.key);
    if (previous && previous.sessionId !== record.sessionId) this.unlink(previous);
    this.claims.set(record.key, record);
    const keys = this.bySession.get(record.sessionId) ?? new Set<string>();
    keys.add(record.key);
    this.bySession.set(record.sessionId, keys);
  }

  private unlink(record: EventClaimRecord): void {
    const keys = this.bySession.get(record.sessionId);
    if (!keys) return;
    keys.delete(record.key);
    if (keys.size === 0) this.bySession.delete(record.sessionId);
  }

  private load(): void {
    if (!this.filePath) return;
    for (const record of parseStoredClaims(readJson(this.filePath))) this.put(record);
  }

  private persist(force: boolean): boolean {
    if (!this.filePath) return false;
    const now = this.now();
    if (
      !force &&
      this.lastPersistAt !== 0 &&
      now - this.lastPersistAt < this.heartbeatPersistIntervalMs
    ) {
      return false;
    }
    writeJsonAtomic(this.filePath, {
      version: 1,
      claims: [...this.claims.values()].map(viewOf),
    });
    this.lastPersistAt = now;
    return true;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // 订阅方出错不能挡住认领
      }
    }
  }
}

function viewOf(record: EventClaimRecord): EventClaimView {
  return {
    key: record.key,
    sessionId: record.sessionId,
    pluginId: record.pluginId,
    ...(record.label !== undefined ? { label: record.label } : {}),
    ...(record.group !== undefined ? { group: record.group } : {}),
    ...(record.subscribedAt !== undefined ? { subscribedAt: record.subscribedAt } : {}),
    claimedAt: record.claimedAt,
    lastHeartbeatAt: record.lastHeartbeatAt,
    leaseUntil: record.leaseUntil,
    active: record.active,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseStoredClaims(raw: unknown): EventClaimRecord[] {
  if (!isRecord(raw) || !Array.isArray(raw.claims)) return [];
  const claims: EventClaimRecord[] = [];
  for (const item of raw.claims) {
    const record = parseStoredClaim(item);
    if (record) claims.push(record);
  }
  return claims;
}

function parseStoredClaim(raw: unknown): EventClaimRecord | null {
  if (!isRecord(raw)) return null;
  const key = parseClaimKey(raw.key);
  const sessionId = parseClaimKey(raw.sessionId);
  const pluginId = parseClaimKey(raw.pluginId);
  if (!key || !sessionId || !pluginId) return null;
  const label = parseClaimLabel(raw.label);
  const group = parseClaimGroup(raw.group);
  const subscribedAt = parseClaimSubscribedAt(raw.subscribedAt);
  if (label === null || group === null || subscribedAt === null) return null;
  if (!isTime(raw.claimedAt) || !isTime(raw.lastHeartbeatAt) || !isTime(raw.leaseUntil))
    return null;
  if (typeof raw.active !== 'boolean') return null;
  return {
    key,
    sessionId,
    pluginId,
    ...(label !== undefined ? { label } : {}),
    ...(group !== undefined ? { group } : {}),
    ...(subscribedAt !== undefined ? { subscribedAt } : {}),
    claimedAt: raw.claimedAt,
    lastHeartbeatAt: raw.lastHeartbeatAt,
    leaseUntil: raw.leaseUntil,
    active: raw.active,
  };
}

let singleton: EventClaimStore | null = null;
let preferredOwner: ((key: string) => string | null) | null = null;
let sessionProtected: ((sessionId: string) => boolean) | null = null;

export function getEventClaimStore(): EventClaimStore {
  if (!singleton) {
    singleton = new EventClaimStore({
      filePath: path.join(app.getPath('userData'), 'event-claims.json'),
      isSessionProtected: (sessionId) => sessionProtected?.(sessionId) === true,
      resolvePreferredOwner: (key) => preferredOwner?.(key) ?? null,
    });
  }
  return singleton;
}

export function peekEventClaimStore(): EventClaimStore | null {
  return singleton;
}

export function setEventClaimStore(store: EventClaimStore | null): void {
  singleton = store;
}

export function setPreferredClaimOwnerResolver(
  resolver: ((key: string) => string | null) | null
): void {
  preferredOwner = resolver;
}

export function setClaimSessionProtectedCheck(
  check: ((sessionId: string) => boolean) | null
): void {
  sessionProtected = check;
}
